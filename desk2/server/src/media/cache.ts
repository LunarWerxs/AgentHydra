// A content-addressed picture and video cache under the data home (<home>/media/<sha256>.<ext>).
// Transcripts carry ImageRef.url = /api/media/<sha256>.<ext> instead of base64, so large pictures never
// travel over /ws or in /api transcripts, and the route serves only what is in here, looked up by hash.
//
// Nothing outside the cache is ever served: a file reaches it only when a transcript names it (a Read,
// Write or SendUserFile input, a tool result, a markdown image in a reply) and normalize.ts copies it in,
// after checking its extension, its size and its first bytes.

import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ImageRef } from '@shared/protocol'
import { ctx } from '../context'
import { flushFile, renameOver, writeFlushed } from '../write-flushed'

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024
/** GIFs (screen recordings, demos) may be bigger than other pictures. */
export const MAX_GIF_BYTES = 30 * 1024 * 1024
/** Videos (screen recordings, test runs) are copied in, never read whole: they may be far bigger. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
/** How many picture files fileRef remembers. */
const KNOWN_MAX = 2000
export const MEDIA_ROUTE = '/api/media/'

type Ext = 'png' | 'jpg' | 'gif' | 'webp' | 'mp4' | 'webm'

const CONTENT_TYPE: Record<Ext, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
const ID = /^([0-9a-f]{64})\.(png|jpg|gif|webp|mp4|webm)$/

/** Video extensions copied into the cache (a .mov is QuickTime's MP4 family and plays as one). */
export const VIDEO = /\.(mp4|m4v|mov|webm)$/i
/** File extensions read into the cache; svg and everything else only ever get a file card. */
export const RENDERABLE = /\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i

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
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  eml: 'message/rfc822',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  log: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
}

/** The media type a file card gives a file by its name: the known type, else an image type for a picture, else octet-stream. */
export function cardTypeOf(name: string): string {
  const ext = extname(name).slice(1).toLowerCase()
  return CARD_TYPE[ext] ?? (RENDERABLE.test(name) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream')
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

/** The video type from its first bytes: an ISO media box (MP4, M4V, MOV) or an EBML header (WebM); else null. */
export function sniffVideo(b: Uint8Array): 'mp4' | 'webm' | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'
  if (b.length >= 8) {
    const box = String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!)
    if (box === 'ftyp' || box === 'moov' || box === 'wide') return 'mp4'
  }
  return null
}

export interface MediaCache {
  dir: string
  /** Stores picture bytes; null when they are not a picture or are over the cap. */
  put(bytes: Uint8Array, name?: string): ImageRef | null
  putBase64(data: string, name?: string): ImageRef | null
  /** A file a transcript names: pictures and videos cached with a url, anything else a card (name, size, type) only. */
  fileRef(path: string): ImageRef | null
  /** The cached file for a route id `<sha256>.<ext>`; null for anything else, a path-looking id included. */
  lookup(id: string): { path: string; contentType: string } | null
  /** The local file a cached id was made from (the last one a transcript named); null when this run has not seen it. */
  sourceOf(id: string): string | null
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
      writeFlushed(tmp, bytes)
      renameOver(tmp, file)
    }
    const ref: ImageRef = { mediaType: CONTENT_TYPE[ext], url: MEDIA_ROUTE + id, bytes: bytes.length }
    if (name) ref.name = name
    return ref
  }

  /**
   * A video file, copied in by the filesystem. Its id hashes where it is and which version (path, size,
   * mtime) instead of every byte, so a long recording costs one stat and 64 bytes read each time a
   * transcript names it; a changed file is a new version and a new copy, so an id still means one set of bytes.
   */
  const putVideo = (path: string, size: number, mtimeMs: number, name: string): ImageRef | null => {
    const head = new Uint8Array(64)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
    const ext = sniffVideo(head)
    if (!ext) return null
    const where = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    const hash = createHash('sha256').update(`video|${where}|${size}|${mtimeMs}`).digest('hex')
    const id = `${hash}.${ext}`
    const file = join(dir, id)
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      copyFileSync(path, tmp)
      // Written to while it was copied: no cache entry that is not the version its id names.
      if (statSync(tmp).size !== size) {
        rmSync(tmp, { force: true })
        return null
      }
      flushFile(tmp)
      renameOver(tmp, file)
    }
    return { mediaType: CONTENT_TYPE[ext], url: MEDIA_ROUTE + id, bytes: size, name }
  }

  /** Where each cached id came from, so the window can show the original in Explorer; lost on a restart until a chat is shown again. */
  const sources = new Map<string, string>()
  const SOURCES_MAX = 5000

  return {
    dir,
    put,
    sourceOf: (id) => sources.get(id) ?? null,
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
      const ref = refOf(path)
      if (!ref) return null
      const full = resolve(path)
      ref.path = full
      if (ref.url) {
        const id = ref.url.slice(MEDIA_ROUTE.length)
        sources.delete(id)
        sources.set(id, full)
        if (sources.size > SOURCES_MAX) sources.delete(sources.keys().next().value!)
      }
      return ref
    },
    lookup(id) {
      const m = ID.exec(id)
      if (!m) return null
      const path = join(dir, id)
      return existsSync(path) ? { path, contentType: CONTENT_TYPE[m[2] as Ext] } : null
    },
  }

  function refOf(path: string): ImageRef | null {
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
    let ref: ImageRef | null = null
    if (VIDEO.test(name)) ref = size && size <= MAX_VIDEO_BYTES ? videoRef(path, size, mtimeMs, name) : null
    else if (RENDERABLE.test(name) && size <= MAX_GIF_BYTES) ref = imageRef(path, size, mtimeMs, name)
    return ref ?? cardRef(name, size)
  }

  function videoRef(path: string, size: number, mtimeMs: number, name: string): ImageRef | null {
    try {
      return putVideo(path, size, mtimeMs, name) || null
    } catch {
      return null // unreadable: a card like any other file
    }
  }

  function imageRef(path: string, size: number, mtimeMs: number, name: string): ImageRef | null {
    const hit = seen.get(path)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs && existsSync(join(dir, hit.ref.url!.slice(MEDIA_ROUTE.length)))) return { ...hit.ref }
    try {
      const ref = put(new Uint8Array(readFileSync(path)), name)
      if (!ref) return null
      // Delete first so the newest path goes to the end; past the cap the oldest one is dropped.
      seen.delete(path)
      seen.set(path, { size, mtimeMs, ref })
      if (seen.size > KNOWN_MAX) seen.delete(seen.keys().next().value!)
      return { ...ref }
    } catch {
      return null // unreadable: a card like any other file
    }
  }

  function cardRef(name: string, size: number): ImageRef {
    return { mediaType: cardTypeOf(name), name, bytes: size }
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
