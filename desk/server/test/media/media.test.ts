import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptItem } from '@shared/protocol'
import type { ServerContext } from '../../src/context'
import { createNormalizer, historyToItems } from '../../src/engine/normalize'
import { createMediaCache, MAX_MEDIA_BYTES, mediaCache, toStoredImage } from '../../src/media/cache'
import plugin from '../../src/plugins/35-media'

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
    expect(c.fileRef(join(root, 'logo.svg'))).toEqual({ mediaType: 'image/svg+xml', name: 'logo.svg', bytes: svg.length })
    expect(c.fileRef(join(root, 'notes.md'))).toEqual({ mediaType: 'text/markdown', name: 'notes.md', bytes: 4 })
    expect(c.fileRef(join(root, 'fake.png'))!.url).toBeUndefined()
    expect(c.fileRef(join(root, 'missing.png'))).toBeNull()
    expect(c.fileRef(root)).toBeNull()
  })

  test('a named picture is read once while its size and time hold; a changed or uncached one is read again', () => {
    const root = temp('known')
    const dir = join(root, 'media')
    const c = createMediaCache(dir)
    const shot = join(root, 'shot.png')
    const at = new Date(Date.UTC(2026, 9, 3, 12, 0, 0))
    writeFileSync(shot, PNG)
    utimesSync(shot, at, at)
    const first = c.fileRef(shot)!.url
    // Other bytes of the same size and time: a read would give another hash.
    const other = PNG.slice()
    other[other.length - 1]! ^= 0xff
    writeFileSync(shot, other)
    utimesSync(shot, at, at)
    expect(c.fileRef(shot)!.url).toBe(first)
    rmSync(join(dir, first!.slice('/api/media/'.length)))
    const second = c.fileRef(shot)!.url
    expect(second).not.toBe(first)
    writeFileSync(shot, PNG)
    expect(c.fileRef(shot)!.url).toBe(first)
  })

  test('a sent image keeps its url, never its base64', () => {
    const c = createMediaCache(join(temp('sent'), 'media'))
    const stored = toStoredImage({ mediaType: 'image/png', dataBase64: PNG_B64, name: 'paste.png' }, c)
    expect(stored.dataBase64).toBeUndefined()
    expect(stored).toMatchObject({ mediaType: 'image/png', name: 'paste.png', bytes: PNG.length })
    expect(stored.url).toMatch(ID_RE)
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

  test('refuses anything that is not a hash id', async () => {
    for (const bad of ['/api/media/..%2F..%2Fsettings.json', '/api/media/%2E%2E%5Csettings.json', '/api/media/settings.json', '/api/media/' + 'a'.repeat(64) + '.png']) {
      const res = await app.request(bad)
      expect(res.status).toBe(404)
    }
  })
})

describe('normalizer pictures', () => {
  const rec = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type,
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-10-03T10:00:00.000Z',
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
    expect(last.result!.images![1]).toEqual({ mediaType: 'text/markdown', name: 'report.md', bytes: 8 })
  })

  test('(d) a markdown image at a local path loads only when this transcript named the file', () => {
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
    expect(text).toContain(`![nope](${other})`)
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
