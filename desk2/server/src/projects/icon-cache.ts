import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PNG } from 'pngjs'

// 28 px drawn at 2x is 56 px; 64 keeps the long side sharp.
export const THUMB_PX = 64

const PINNED = 'public, max-age=31536000, immutable'
const UNPINNED = 'no-cache'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/** The version of an icon file (its time and size), or null when it is gone. A new version is a new URL. */
export function iconVersion(file: string): string | null {
  try {
    const st = statSync(file)
    return `${Math.trunc(st.mtimeMs)}-${st.size}`
  } catch {
    return null
  }
}

/** The icon's bytes: a PNG is a cached thumbnail, anything else (SVG, small images) is the file itself. */
export async function serveProjectIcon(req: Request, file: string, home: string, pinned: boolean): Promise<Response> {
  const version = iconVersion(file)
  if (!version) return new Response('Not Found', { status: 404 })
  const key = sha1(`${file}|${version}|${THUMB_PX}`)
  const etag = `"${key}"`
  const headers = { ETag: etag, 'Cache-Control': pinned ? PINNED : UNPINNED }
  if (notModified(req, etag)) return new Response(null, { status: 304, headers })
  return new Response(Bun.file(await servedPath(file, key, home)), { headers })
}

function notModified(req: Request, etag: string): boolean {
  const seen = req.headers.get('if-none-match')
  return !!seen && seen.split(',').some((t) => t.trim() === etag || t.trim() === '*')
}

async function servedPath(file: string, key: string, home: string): Promise<string> {
  const dir = join(home, 'cache', 'project-icons')
  const thumb = join(dir, `${key}.png`)
  if (await Bun.file(thumb).exists()) return thumb
  try {
    const source = await readFile(file)
    if (!source.subarray(0, 4).equals(PNG_SIGNATURE)) return file
    const png = PNG.sync.read(source)
    if (Math.max(png.width, png.height) <= THUMB_PX) return file
    await mkdir(dir, { recursive: true })
    const tmp = `${thumb}.${randomUUID()}.tmp`
    await writeFile(tmp, PNG.sync.write(downscale(png, THUMB_PX)))
    await rename(tmp, thumb)
    return thumb
  } catch {
    return file
  }
}

/** Box-averages the picture down so its long side is `max` pixels, weighting colour by alpha. */
function downscale(src: PNG, max: number): PNG {
  const scale = max / Math.max(src.width, src.height)
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4
          const alpha = src.data[i + 3]
          r += src.data[i] * alpha
          g += src.data[i + 1] * alpha
          b += src.data[i + 2] * alpha
          a += alpha
          n++
        }
      }
      const o = (y * w + x) * 4
      if (a > 0) {
        out.data[o] = Math.round(r / a)
        out.data[o + 1] = Math.round(g / a)
        out.data[o + 2] = Math.round(b / a)
      }
      out.data[o + 3] = Math.round(a / n)
    }
  }
  return out
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}
