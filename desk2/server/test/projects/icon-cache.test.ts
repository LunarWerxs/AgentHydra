import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { serveProjectIcon, THUMB_PX } from '../../src/projects/icon-cache'

const root = mkdtempSync(join(tmpdir(), 'ah-icon-cache-'))
const home = join(root, 'home')
const icons = join(root, 'icons')
mkdirSync(icons, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

function pngFile(name: string, width: number, height: number, red: number): string {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = red
    png.data[i + 1] = 80
    png.data[i + 2] = 200
    png.data[i + 3] = 255
  }
  const file = join(icons, name)
  writeFileSync(file, PNG.sync.write(png))
  return file
}

function icon(file: string, pinned: boolean, ifNoneMatch?: string): Promise<Response> {
  const headers: Record<string, string> = ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
  return serveProjectIcon(new Request('http://127.0.0.1/api/projects/icon', { headers }), file, home, pinned)
}

describe('project icons', () => {
  test('a large PNG is a 64 px thumbnail, pinned by version and sent with an ETag', async () => {
    const res = await icon(pngFile('wide.png', 300, 200, 200), true)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{40}"$/)
    expect(res.headers.get('content-type')).toBe('image/png')
    const thumb = PNG.sync.read(Buffer.from(await res.arrayBuffer()))
    expect(thumb.width).toBe(THUMB_PX)
    expect(thumb.height).toBe(43)
    expect(readdirSync(join(home, 'cache', 'project-icons')).some((f) => f.endsWith('.png'))).toBe(true)
  })

  test('an unpinned URL is not kept by the browser', async () => {
    const res = await icon(pngFile('plain.png', 200, 200, 90), false)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('If-None-Match with the current ETag answers 304 and no bytes', async () => {
    const file = pngFile('again.png', 300, 300, 40)
    const etag = (await icon(file, true)).headers.get('etag') ?? ''
    const again = await icon(file, true, etag)
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
    expect(await again.text()).toBe('')
  })

  test('a changed icon gets a new ETag and a new thumbnail', async () => {
    const file = pngFile('changed.png', 300, 300, 10)
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    const before = (await icon(file, true)).headers.get('etag')
    pngFile('changed.png', 256, 256, 200)
    utimesSync(file, 1_700_000_100, 1_700_000_100)
    const after = await icon(file, true)
    expect(after.headers.get('etag')).not.toBe(before)
    const thumb = PNG.sync.read(Buffer.from(await after.arrayBuffer()))
    expect(thumb.width).toBe(THUMB_PX)
    expect(thumb.height).toBe(THUMB_PX)
  })

  test('an SVG and a small PNG are served as they are', async () => {
    const svg = join(icons, 'mark.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>')
    const svgRes = await icon(svg, true)
    expect(svgRes.headers.get('content-type')).toBe('image/svg+xml')
    expect(Buffer.from(await svgRes.arrayBuffer()).equals(readFileSync(svg))).toBe(true)

    const small = pngFile('tiny.png', 16, 16, 30)
    const smallRes = await icon(small, true)
    expect(Buffer.from(await smallRes.arrayBuffer()).equals(readFileSync(small))).toBe(true)
  })

  test('a missing icon file answers 404', async () => {
    expect((await icon(join(icons, 'gone.png'), true)).status).toBe(404)
  })
})
