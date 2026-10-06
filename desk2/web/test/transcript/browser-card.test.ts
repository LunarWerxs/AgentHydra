import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import { browserCallsText, COPY_RESULT_MAX } from '../../src/components/transcript/lib/browserCopy'
import { isBlankPixels } from '../../src/components/transcript/lib/browserPreview'
import { groupRows, type ToolItem } from '../../src/components/transcript/lib/groups'

const A = 'mcp__connections__connections_execute'
const nav = (id: string, profile: string | undefined, extra: Partial<ToolItem> = {}): ToolItem => ({
  id,
  ts: 1,
  kind: 'tool_use',
  name: A,
  input: { local: true, tool_name: 'browser_navigate', params: { url: `https://example.com/${id}`, ...(profile ? { profile } : {}) } },
  status: 'done',
  startedAt: 1,
  ...extra,
})
const bash = (id: string): ToolItem => ({ id, ts: 1, kind: 'tool_use', name: 'Bash', input: { command: 'ls' }, status: 'done', startedAt: 1 })
const user = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'user', text: 'hi' })
const note = (id: string): TranscriptItem => ({ id, ts: 1, kind: 'note', text: 'n' }) as TranscriptItem
const rowIds = (items: TranscriptItem[]) => groupRows(items).map((r) => r.id)

describe('one Browser card per browser per turn', () => {
  test('calls of one profile split by a command row are one card at the newest call; the command row keeps its place', () => {
    const rows = groupRows([user('u'), nav('1', 'shop'), nav('2', 'shop'), bash('b'), nav('3', 'shop'), nav('4', 'shop')])
    expect(rows.map((r) => r.id)).toEqual(['u', 'tools:b', 'browser:1'])
    const card = rows[2]
    expect(card.kind === 'browser' && card.items.map((i) => i.id)).toEqual(['1', '2', '3', '4'])
  })

  test('a different profile, or a user message between, starts another card', () => {
    expect(rowIds([nav('1', 'shop'), bash('b'), nav('2', 'bank'), nav('3', 'shop')])).toEqual(['tools:b', 'browser:2', 'browser:1'])
    expect(rowIds([nav('1', 'shop'), user('u'), nav('2', 'shop')])).toEqual(['browser:1', 'u', 'browser:2'])
    expect(rowIds([nav('1', 'shop'), note('n'), nav('2', 'shop')])).toEqual(['browser:1', 'n', 'browser:2'])
  })

  test('the default browser merges too, and prose between calls does not split the turn', () => {
    const text: TranscriptItem = { id: 't', ts: 1, kind: 'assistant_text', text: 'ok', streaming: false }
    const rows = groupRows([nav('1', undefined), text, nav('2', undefined)])
    expect(rows.map((r) => r.id)).toEqual(['t', 'browser:1'])
  })
})

describe('browserCallsText', () => {
  test('tool name, params as JSON and result per call; pictures are [image], long text is cut', () => {
    const one = nav('1', 'shop', { result: { text: `Done ${'A'.repeat(300)}`, images: [{ id: 'x' } as never], isError: false } })
    const two = nav('2', 'shop', { result: { text: 'ab '.repeat(COPY_RESULT_MAX / 3 + 30).slice(0, COPY_RESULT_MAX + 50), isError: false } })
    const out = browserCallsText([one, two])
    expect(out).toContain('browser_navigate\n{')
    expect(out).toContain('"url": "https://example.com/1"')
    expect(out).toContain('[image]')
    expect(out).not.toContain('A'.repeat(200))
    expect(out).toContain('50 more characters')
    expect(out.split('\n\nbrowser_navigate').length).toBe(2)
  })

  test('base64 and data addresses in a result never reach the clipboard', () => {
    const b64 = 'QUJD'.repeat(100)
    const c = nav('1', 'shop', { result: { text: `shot data:image/png;base64,${b64} and ${b64}`, isError: false } })
    const out = browserCallsText([c])
    expect(out).not.toContain('QUJDQUJD')
    expect(out).toContain('[image]')
  })

  test('a screenshot whose text is only "[image]" says [image] once per picture', () => {
    const c = nav('1', 'shop', { result: { text: '[image]', images: [{ id: 'x' } as never], isError: false } })
    expect(browserCallsText([c]).endsWith('Result: [image]')).toBe(true)
  })
})

describe('isBlankPixels', () => {
  test('one flat colour is a blank page, dark (about:blank in dark mode, 18,18,18) or white; a page with anything on it is not', () => {
    const px = (v: number, n = 16) => Array.from({ length: n }, () => [v, v, v, 255]).flat()
    expect(isBlankPixels(px(18))).toBe(true)
    expect(isBlankPixels(px(255))).toBe(true)
    expect(isBlankPixels([...px(20, 15), 23, 16, 18, 255])).toBe(true)
    expect(isBlankPixels([...px(18, 15), 80, 80, 80, 255])).toBe(false)
    expect(isBlankPixels([...px(255, 15), 255, 255, 200, 255])).toBe(false)
    expect(isBlankPixels([])).toBe(false)
  })
})
