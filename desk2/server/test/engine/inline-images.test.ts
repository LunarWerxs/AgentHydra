import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
