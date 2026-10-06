// A content-addressed picture cache under the data home (<home>/media/<sha256>.<ext>). Transcripts
// carry ImageRef.url = /api/media/<sha256>.<ext> instead of base64, so large pictures never travel
// over /ws or in /api transcripts, and the route serves only what is in here, looked up by hash.
//
// Nothing outside the cache is ever served: a file reaches it only when a transcript names it (a Read,
// Write or SendUserFile input, a tool result) and normalize.ts copies it in, after checking its
// extension, its size and its first bytes.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ImageRef } from '@shared/protocol'
import { ctx } from '../context'

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024
/** GIFs (screen recordings, demos) may be bigger than other pictures. */
export const MAX_GIF_BYTES = 30 * 1024 * 1024
export const MEDIA_ROUTE = '/api/media/'

type Ext = 'png' | 'jpg' | 'gif' | 'webp'

const CONTENT_TYPE: Record<Ext, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const ID = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/

/** File extensions read into the cache; svg and everything else only ever get a file card. */
export const RENDERABLE = /\.(png|jpe?g|gif|webp)$/i

/** What a file card says a non-picture is (name and size come from the file). */
const CARD_TYPE: Record<string, string> = {
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
  bmp: 'image/bmp',
}

/** The picture type from its first bytes; null when they are not a png, jpeg, gif or webp. */
export function sniff(b: Uint8Array): Ext | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'webp'
  return null
}

export interface MediaCache {
  dir: string
  /** Stores picture bytes; null when they are not a picture or are over the cap. */
  put(bytes: Uint8Array, name?: string): ImageRef | null
  putBase64(data: string, name?: string): ImageRef | null
  /** A file a transcript names: pictures cached with a url, anything else a card (name, size, type) only. */
  fileRef(path: string): ImageRef | null
  /** The cached file for a route id `<sha256>.<ext>`; null for anything else, a path-looking id included. */
  lookup(id: string): { path: string; contentType: string } | null
}

export function createMediaCache(dir: string): MediaCache {
  /** Pictures already hashed, by path: the ref stands while the file's size and mtime do, so a transcript naming it again costs one stat. */
  const seen = new Map<string, { size: number; mtimeMs: number; ref: ImageRef }>()
  const put = (bytes: Uint8Array, name?: string): ImageRef | null => {
    if (!bytes.length || bytes.length > MAX_GIF_BYTES) return null
    const ext = sniff(bytes)
    if (!ext || bytes.length > (ext === 'gif' ? MAX_GIF_BYTES : MAX_MEDIA_BYTES)) return null
    const hash = createHash('sha256').update(bytes).digest('hex')
    const id = `${hash}.${ext}`
    const file = join(dir, id)
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, bytes)
      renameSync(tmp, file)
    }
    const ref: ImageRef = { mediaType: CONTENT_TYPE[ext], url: MEDIA_ROUTE + id, bytes: bytes.length }
    if (name) ref.name = name
    return ref
  }

  return {
    dir,
    put,
    putBase64(data, name) {
      // base64 is 4/3 of the bytes: refuse an over-cap payload before decoding it
      if (!data || (data.length * 3) / 4 > MAX_MEDIA_BYTES + 3) return null
      try {
        return put(new Uint8Array(Buffer.from(data, 'base64')), name)
      } catch {
        return null
      }
    },
    fileRef(path) {
      let size: number
      let mtimeMs: number
      try {
        const st = statSync(path)
        if (!st.isFile()) return null
        size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        return null
      }
      const name = basename(path)
      const ext = extname(name).slice(1).toLowerCase()
      if (RENDERABLE.test(name) && size <= MAX_GIF_BYTES) {
        const hit = seen.get(path)
        if (hit && hit.size === size && hit.mtimeMs === mtimeMs && existsSync(join(dir, hit.ref.url!.slice(MEDIA_ROUTE.length)))) return { ...hit.ref }
        try {
          const ref = put(new Uint8Array(readFileSync(path)), name)
          if (ref) {
            seen.set(path, { size, mtimeMs, ref })
            return { ...ref }
          }
        } catch {
          // unreadable: a card like any other file
        }
      }
      return { mediaType: CARD_TYPE[ext] ?? (RENDERABLE.test(name) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'), name, bytes: size }
    },
    lookup(id) {
      const m = ID.exec(id)
      if (!m) return null
      const path = join(dir, id)
      return existsSync(path) ? { path, contentType: CONTENT_TYPE[m[2] as Ext] } : null
    },
  }
}

const caches = new Map<string, MediaCache>()

/** The cache of a data home: the running server's by default. Null outside a server with no HYDRA_DESK_HOME (a bare unit test). */
export function mediaCache(home: string | undefined = ctx?.home ?? process.env.HYDRA_DESK_HOME): MediaCache | null {
  if (!home) return null
  const dir = join(home, 'media')
  let c = caches.get(dir)
  if (!c) caches.set(dir, (c = createMediaCache(dir)))
  return c
}

/** An image the window sent (base64) as the url form the transcript keeps; dropped bytes when it cannot be cached. */
export function toStoredImage(img: ImageRef, cache: MediaCache | null = mediaCache()): ImageRef {
  if (!img.dataBase64) return img
  const ref = cache?.putBase64(img.dataBase64, img.name)
  const { dataBase64: _d, ...rest } = img
  return ref ? { ...rest, url: ref.url, bytes: ref.bytes } : rest
}
