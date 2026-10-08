import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptItem } from '@shared/protocol'
import type { ServerContext } from '../../src/context'
import { createNormalizer, historyToItems } from '../../src/engine/normalize'
import { createMediaCache, MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, mediaCache, sniffVideo, toStoredImage } from '../../src/media/cache'
import plugin, { byteRange } from '../../src/plugins/35-media'

const temps: string[] = []
const temp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `desk-media-${tag}-`))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

// A 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG = new Uint8Array(Buffer.from(PNG_B64, 'base64'))
const ID_RE = /^\/api\/media\/[0-9a-f]{64}\.png$/

// The first bytes of an MP4 (an ftyp box), a QuickTime MOV (ftyp, brand qt) and a WebM (EBML header), then filler.
const box = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(4), Buffer.from(brand)])
const MP4 = Buffer.concat([box('isom'), Buffer.alloc(4000, 7)])
const MOV = Buffer.concat([box('qt  '), Buffer.alloc(2000, 3)])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 5)])
const VIDEO_RE = (ext: string) => new RegExp(`^/api/media/[0-9a-f]{64}\\.${ext}$`)

type Tool = Extract<TranscriptItem, { kind: 'tool_use' }>
type User = Extract<TranscriptItem, { kind: 'user' }>

describe('media cache', () => {
  test('stores by content hash, once, and looks up only by hash', () => {
    const dir = join(temp('cache'), 'media')
    const c = createMediaCache(dir)
    const a = c.put(PNG, 'dot.png')!
    const b = c.putBase64(PNG_B64)!
    expect(a.url).toMatch(ID_RE)
    expect(b.url).toBe(a.url!)
    expect(a).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, name: 'dot.png' })
    expect(readdirSync(dir)).toHaveLength(1)
    const id = a.url!.slice('/api/media/'.length)
    expect(c.lookup(id)).toMatchObject({ contentType: 'image/png' })
    expect(c.lookup('..\\..\\secret.png')).toBeNull()
    expect(c.lookup('../media/' + id)).toBeNull()
    expect(c.lookup(id.replace('.png', '.svg'))).toBeNull()
    expect(c.lookup('0'.repeat(64) + '.png')).toBeNull()
  })

  test('refuses bytes that are not a picture and pictures over the cap', () => {
    const c = createMediaCache(join(temp('refuse'), 'media'))
    expect(c.put(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull()
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1)
    big.set(PNG.subarray(0, 8))
    expect(c.put(big)).toBeNull()
  })

  test('a named file: pictures cached, svg and others only a card', () => {
    const root = temp('files')
    const c = createMediaCache(join(root, 'media'))
    writeFileSync(join(root, 'shot.png'), PNG)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    writeFileSync(join(root, 'logo.svg'), svg)
    writeFileSync(join(root, 'notes.md'), '# hi')
    writeFileSync(join(root, 'fake.png'), 'not a png')
    expect(c.fileRef(join(root, 'shot.png'))).toMatchObject({ mediaType: 'image/png', name: 'shot.png', bytes: PNG.length })
    expect(c.fileRef(join(root, 'shot.png'))!.url).toMatch(ID_RE)
    expect(c.fileRef(join(root, 'logo.svg'))).toMatchObject({ mediaType: 'image/svg+xml', name: 'logo.svg', bytes: svg.length, path: expect.any(String) })
    expect(c.fileRef(join(root, 'notes.md'))).toMatchObject({ mediaType: 'text/markdown', name: 'notes.md', bytes: 4, path: expect.any(String) })
    expect(c.fileRef(join(root, 'fake.png'))!.url).toBeUndefined()
    expect(c.fileRef(join(root, 'missing.png'))).toBeNull()
    expect(c.fileRef(root)).toBeNull()
  })

  test('the path memo is capped: past 2000 files the oldest is read again', () => {
    const root = temp('cap')
    const c = createMediaCache(join(root, 'media'))
    const first = join(root, 'first.png')
    writeFileSync(first, PNG)
    const when = new Date(Date.now() - 60_000)
    utimesSync(first, when, when)
    const url = c.fileRef(first)!.url
    // Same size and mtime, other bytes: only a memo hit can still answer with the old url.
    const other = Buffer.from(PNG)
    other[other.length - 5] ^= 0xff
    writeFileSync(first, other)
    utimesSync(first, when, when)
    expect(c.fileRef(first)!.url).toBe(url!)
    for (let i = 0; i < 2000; i++) {
      const p = join(root, `n${i}.png`)
      writeFileSync(p, PNG)
      c.fileRef(p)
    }
    expect(c.fileRef(first)!.url).not.toBe(url!)
    // 2000 real files written and read: past bun's 5 s default on a busy Windows disk, HEAD's code included.
  }, 30_000)

  test('a sent image keeps its url, never its base64', () => {
    const c = createMediaCache(join(temp('sent'), 'media'))
    const stored = toStoredImage({ mediaType: 'image/png', dataBase64: PNG_B64, name: 'paste.png' }, c)
    expect(stored.dataBase64).toBeUndefined()
    expect(stored).toMatchObject({ mediaType: 'image/png', name: 'paste.png', bytes: PNG.length })
    expect(stored.url).toMatch(ID_RE)
  })
})

describe('videos', () => {
  test('first bytes: an ISO media box or an EBML header, nothing else', () => {
    expect(sniffVideo(MP4)).toBe('mp4')
    expect(sniffVideo(MOV)).toBe('mp4')
    expect(sniffVideo(WEBM)).toBe('webm')
    expect(sniffVideo(PNG)).toBeNull()
    expect(sniffVideo(new TextEncoder().encode('<html><body>not a video</body></html>'))).toBeNull()
  })

  test('an mp4, mov or webm a transcript names is copied in and served by id; a fake one is a card', () => {
    const root = temp('video')
    const dir = join(root, 'media')
    const c = createMediaCache(dir)
    writeFileSync(join(root, 'run.mp4'), MP4)
    writeFileSync(join(root, 'Screen Recording.mov'), MOV)
    writeFileSync(join(root, 'clip.webm'), WEBM)
    writeFileSync(join(root, 'fake.mp4'), 'not a video at all')
    const mp4 = c.fileRef(join(root, 'run.mp4'))!
    expect(mp4).toMatchObject({ mediaType: 'video/mp4', name: 'run.mp4', bytes: MP4.length })
    expect(mp4.url).toMatch(VIDEO_RE('mp4'))
    expect(c.fileRef(join(root, 'Screen Recording.mov'))).toMatchObject({ mediaType: 'video/mp4', url: expect.stringMatching(VIDEO_RE('mp4')) })
    expect(c.fileRef(join(root, 'clip.webm'))).toMatchObject({ mediaType: 'video/webm', url: expect.stringMatching(VIDEO_RE('webm')) })
    expect(c.fileRef(join(root, 'fake.mp4'))).toMatchObject({ mediaType: 'video/mp4', name: 'fake.mp4', bytes: 18 })
    expect(c.lookup(mp4.url!.slice('/api/media/'.length))).toMatchObject({ contentType: 'video/mp4' })
    expect(readdirSync(dir)).toHaveLength(3)
  })

  test('named again it is the same copy; a changed file is a new one', () => {
    const root = temp('video-again')
    const dir = join(root, 'media')
    const c = createMediaCache(dir)
    const p = join(root, 'run.mp4')
    writeFileSync(p, MP4)
    const first = c.fileRef(p)!.url
    expect(createMediaCache(dir).fileRef(p)!.url).toBe(first!)
    writeFileSync(p, Buffer.concat([MP4, Buffer.alloc(10)]))
    utimesSync(p, new Date(), new Date(Date.now() + 5000))
    const second = c.fileRef(p)!.url
    expect(second).toMatch(VIDEO_RE('mp4'))
    expect(second).not.toBe(first!)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  test('a video over the cap stays a card and is never copied', () => {
    const root = temp('video-big')
    const dir = join(root, 'media')
    const p = join(root, 'huge.mp4')
    writeFileSync(p, MP4)
    truncateSync(p, MAX_VIDEO_BYTES + 1)
    expect(createMediaCache(dir).fileRef(p)).toMatchObject({ mediaType: 'video/mp4', name: 'huge.mp4', bytes: MAX_VIDEO_BYTES + 1 })
    expect(() => readdirSync(dir)).toThrow()
  })
})

describe('byteRange', () => {
  test('reads one bytes= range and refuses one past the end', () => {
    expect(byteRange(undefined, 100)).toBeNull()
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
    expect(byteRange('bytes=-300', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(byteRange('items=0-1', 100)).toBeNull()
  })
})

describe('GET /api/media/:id', () => {
  const home = temp('route')
  const app = new Hono()
  plugin(app, { home } as ServerContext)
  const ref = mediaCache(home)!.put(PNG)!

  test('serves a cache entry with its type, immutable caching and nosniff', async () => {
    const res = await app.request(ref.url!)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  test('a video is served whole or by range, so the player can seek', async () => {
    const root = temp('route-video')
    writeFileSync(join(root, 'run.mp4'), MP4)
    const url = mediaCache(home)!.fileRef(join(root, 'run.mp4'))!.url!
    const whole = await app.request(url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array(MP4))
    const part = await app.request(url, { headers: { range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${MP4.length}`)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array(MP4.subarray(100, 200)))
    const tail = await app.request(url, { headers: { range: 'bytes=-16' } })
    expect(tail.status).toBe(206)
    expect((await tail.arrayBuffer()).byteLength).toBe(16)
    const past = await app.request(url, { headers: { range: `bytes=${MP4.length}-` } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${MP4.length}`)
  })

  test('refuses anything that is not a hash id', async () => {
    for (const bad of ['/api/media/..%2F..%2Fsettings.json', '/api/media/%2E%2E%5Csettings.json', '/api/media/settings.json', '/api/media/' + 'a'.repeat(64) + '.png', '/api/media/' + 'a'.repeat(64) + '.mov']) {
      const res = await app.request(bad)
      expect(res.status).toBe(404)
    }
  })
})

describe('normalizer pictures', () => {
  const rec = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type,
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: '2020-10-03T10:00:00.000Z',
    message: { id: `m-${Math.random().toString(36).slice(2)}`, role: type, content },
    ...extra,
  })
  const noBase64 = (items: TranscriptItem[]) => expect(JSON.stringify(items)).not.toContain(PNG_B64.slice(0, 40))

  test('(a) a pasted image in a user message: a thumbnail url in the bubble', () => {
    const media = createMediaCache(join(temp('a'), 'media'))
    const items = historyToItems(
      [rec('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }, { type: 'text', text: 'what is this?' }])],
      { media },
    )
    const user = items[0] as User
    expect(user.text).toBe('what is this?')
    expect(user.images).toHaveLength(1)
    expect(user.images![0].url).toMatch(ID_RE)
    noBase64(items)
  })

  test('(b) a tool result that carries a picture: listed under the tool, text keeps [image]', () => {
    const media = createMediaCache(join(temp('b'), 'media'))
    const items = historyToItems(
      [
        rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\shots\\side.png' } }]),
        rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] }]),
      ],
      { media },
    )
    const tool = items.find((i) => i.kind === 'tool_use') as Tool
    expect(tool.status).toBe('done')
    expect(tool.result!.text).toBe('[image]')
    expect(tool.result!.images![0].url).toMatch(ID_RE)
    noBase64(items)
  })

  test('(c) SendUserFile: a renderable picture gets a url, any file a card', () => {
    const root = temp('c')
    const media = createMediaCache(join(root, 'media'))
    writeFileSync(join(root, 'live-round1.png'), PNG)
    writeFileSync(join(root, 'report.md'), '# report')
    const n = createNormalizer({ now: () => 1, media })
    const out = [
      ...n.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 's1', name: 'SendUserFile', input: { files: [join(root, 'live-round1.png'), join(root, 'report.md')], display: 'render' } }] } } as unknown as SDKMessage),
      ...n.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Sent 2 files' }] } } as unknown as SDKMessage),
    ]
    const last = out.filter((e) => e.type === 'upsert').map((e) => (e as { item: TranscriptItem }).item).pop() as Tool
    expect(last.result!.images).toHaveLength(2)
    expect(last.result!.images![0]).toMatchObject({ mediaType: 'image/png', name: 'live-round1.png', bytes: PNG.length })
    expect(last.result!.images![0].url).toMatch(ID_RE)
    expect(last.result!.images![1]).toMatchObject({ mediaType: 'text/markdown', name: 'report.md', bytes: 8, path: expect.any(String) })
  })

  test('(d) a markdown image at a local picture path loads, named by the transcript or not', () => {
    const root = temp('d')
    const media = createMediaCache(join(root, 'media'))
    mkdirSync(join(root, 'shots'))
    const named = join(root, 'shots', 'after.png')
    const other = join(root, 'shots', 'secret.png')
    writeFileSync(named, PNG)
    writeFileSync(other, PNG)
    const items = historyToItems(
      [
        rec('assistant', [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: 'shot' } }]),
        rec('user', [{ type: 'tool_result', tool_use_id: 'w1', content: `saved ${named}` }]),
        rec('assistant', [{ type: 'text', text: `Here:\n\n![after](${named})\n\n![nope](${other})` }]),
      ],
      { media },
    )
    const text = (items.find((i) => i.kind === 'assistant_text') as { text: string }).text
    expect(text).toMatch(/!\[after\]\(\/api\/media\/[0-9a-f]{64}\.png\)/)
    expect(text).toMatch(/!\[nope\]\(\/api\/media\/[0-9a-f]{64}\.png\)/)
  })

  test('(e) a markdown video and a SendUserFile video get a url; a missing one stays as written', () => {
    const root = temp('e')
    const media = createMediaCache(join(root, 'media'))
    const clip = join(root, 'after-fix.mp4')
    writeFileSync(clip, MP4)
    const gone = join(root, 'gone.webm')
    const items = historyToItems(
      [
        rec('assistant', [{ type: 'text', text: `Here is the run:\n\n![the run](${clip})\n\n![old](${gone})` }]),
        rec('assistant', [{ type: 'tool_use', id: 's2', name: 'SendUserFile', input: { files: [clip], display: 'render' } }]),
        rec('user', [{ type: 'tool_result', tool_use_id: 's2', content: 'Sent 1 file' }]),
      ],
      { media },
    )
    const text = (items.find((i) => i.kind === 'assistant_text') as { text: string }).text
    expect(text).toMatch(/!\[the run\]\(\/api\/media\/[0-9a-f]{64}\.mp4\)/)
    expect(text).toContain(`![old](${gone})`)
    const sent = items.find((i) => i.kind === 'tool_use') as Tool
    expect(sent.result!.images![0]).toMatchObject({ mediaType: 'video/mp4', name: 'after-fix.mp4', url: expect.stringMatching(VIDEO_RE('mp4')) })
  })

  test('without a cache, pictures are left out, never inlined', () => {
    const items = historyToItems(
      [rec('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }, { type: 'text', text: 'hi' }])],
      { media: null },
    )
    expect((items[0] as User).images).toBeUndefined()
    noBase64(items)
  })
})
