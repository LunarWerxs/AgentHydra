import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { BROWSER, deskAppend, MEDIA } from '../../src/engine/desk-prompt'
import { historyToItems } from '../../src/engine/normalize'
import { createMediaCache } from '../../src/media/cache'

const root = mkdtempSync(join(tmpdir(), 'desk-inline-'))
const oldHome = process.env.HYDRA_DESK_HOME
beforeAll(() => {
  process.env.HYDRA_DESK_HOME = join(root, 'home')
})
afterAll(() => {
  if (oldHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = oldHome
  rmSync(root, { recursive: true, force: true })
})

const MB = 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const gif = (mb: number) => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(mb * MB - 6)])

const rec = (type: 'user' | 'assistant', text: string) => ({
  type,
  uuid: `u-${Math.random().toString(36).slice(2)}`,
  timestamp: '2026-10-03T10:00:00.000Z',
  message: { id: `m-${Math.random().toString(36).slice(2)}`, role: type, content: [{ type: 'text', text }] },
})

function render(type: 'user' | 'assistant', markdown: string): string {
  const media = createMediaCache(join(root, 'media'))
  const items = historyToItems([rec(type, markdown)], { media }) as TranscriptItem[]
  const item = items[0] as { text: string }
  return item.text
}

const URL_RE = (ext: string) => new RegExp(`\(/api/media/[0-9a-f]{64}\.${ext}\)`)

describe('inline pictures in assistant text', () => {
  test('an absolute PNG path nothing named earlier renders', () => {
    const p = join(root, 'shot.png')
    writeFileSync(p, PNG)
    expect(render('assistant', `![a shot](${p})`)).toMatch(URL_RE('png'))
  })

  test('a 20 MB GIF renders, a 31 MB GIF stays a chip', () => {
    const ok = join(root, 'ok.gif')
    const big = join(root, 'big.gif')
    writeFileSync(ok, gif(20))
    writeFileSync(big, gif(31))
    expect(render('assistant', `![ok](${ok})`)).toMatch(URL_RE('gif'))
    expect(render('assistant', `![big](${big})`)).toBe(`![big](${big})`)
  })

  test('a .png that is really text stays a chip', () => {
    const p = join(root, 'fake.png')
    writeFileSync(p, 'not a picture at all')
    expect(render('assistant', `![fake](${p})`)).toBe(`![fake](${p})`)
  })

  test('the same markdown in user text is not rewritten', () => {
    const p = join(root, 'mine.png')
    writeFileSync(p, PNG)
    const md = `![mine](${p})`
    expect(render('user', md)).toBe(md)
  })
})

describe('files a reply only names', () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(32)])
  const cwd = join(root, 'proj')
  mkdirSync(join(cwd, 'out'), { recursive: true })
  writeFileSync(join(cwd, 'out', 'demo.mp4'), MP4)
  writeFileSync(join(cwd, 'shot.png'), PNG)

  const named = (text: string, dir: string | null = cwd) => {
    const media = createMediaCache(join(root, 'media'))
    const items = historyToItems([rec('assistant', text)], { media, cwd: dir }) as TranscriptItem[]
    const it = items[0] as Extract<TranscriptItem, { kind: 'assistant_text' }>
    return { text: it.text, media: it.media ?? [] }
  }

  test('a relative .mp4 in inline code becomes a video ref and the text stays', () => {
    const said = 'Ad: rendered at `out/demo.mp4`.'
    const r = named(said)
    expect(r.text).toBe(said)
    expect(r.media).toHaveLength(1)
    expect(r.media[0]!.mediaType).toBe('video/mp4')
    expect(r.media[0]!.url).toMatch(/^\/api\/media\/[0-9a-f]{64}\.mp4$/)
  })

  test('an absolute bare .png in prose becomes a picture ref', () => {
    const r = named(`Saved ${join(cwd, 'shot.png').replaceAll('\\', '/')} for you.`, null)
    expect(r.media.map((m) => m.mediaType)).toEqual(['image/png'])
  })

  test('the target of a plain markdown link is shown', () => {
    expect(named('See [the cut](out/demo.mp4).').media).toHaveLength(1)
  })

  test('a missing file, or a relative path with no folder to resolve against, gives no ref', () => {
    expect(named('Look at `out/nope.mp4` and `gone.png`').media).toEqual([])
    expect(named('Rendered `out/demo.mp4`', null).media).toEqual([])
  })

  test('a .mp4 that is really text gives no ref', () => {
    writeFileSync(join(cwd, 'out', 'fake.mp4'), 'not a video at all, just text')
    expect(named('`out/fake.mp4`').media).toEqual([])
  })

  test('a file a markdown image already embeds, in any spelling, is not repeated', () => {
    const r = named('![demo](out/demo.mp4)\n\nIt is `out/demo.mp4`, also out/demo.mp4 again.')
    expect(r.text).toMatch(URL_RE('mp4'))
    expect(r.media).toEqual([])
  })

  test('the same file named twice is shown once', () => {
    expect(named('`out/demo.mp4` then ./out/demo.mp4').media).toHaveLength(1)
  })

  test('at most 8 files a message', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(cwd, `p${i}.png`), Buffer.concat([PNG, Buffer.from([i])]))
    const r = named(Array.from({ length: 12 }, (_, i) => `\`p${i}.png\``).join(' '))
    expect(r.media).toHaveLength(8)
  })

  test('a relative markdown image target plays in place', () => {
    expect(named('![x](out/demo.mp4)').text).toMatch(URL_RE('mp4'))
  })
})

describe('the browser paragraph', () => {
  test('is in the system prompt append in every mode', () => {
    for (const delegate of [true, false]) {
      const text = deskAppend(delegate)
      expect(text).toContain(BROWSER)
      expect(text).toContain('browser_profile_find')
      expect(text).toContain(MEDIA)
      expect(MEDIA).toContain('![what it shows](C:/absolute/path.mp4)')
      for (const ext of ['png', 'gif', 'mp4', 'mov', 'webm']) expect(MEDIA).toContain(ext)
    }
  })
})
