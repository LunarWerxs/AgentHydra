import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { claudeProjectRoots, encodeProjectDir, findSessionJsonl, readTail, sessionJsonlItems } from '../../src/bridge/session-jsonl'
import { historyToItems, parseJsonl } from '../../src/engine/normalize'

const temps: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'desk-jsonl-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const SID = '02b95209-e131-404d-9fc7-6033f2d04adf'
const ANSWER = 'It now looks like Claude Code Desktop.\n\n**What’s done:**\n\n- **Sidebar.** Grouped.\n- **Checks.** All pass.\n\n## What I did\n\n```ts\nconst a = 1\n```'

function lines(): string {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s)).toISOString()
  return [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'how does it look?' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
    { type: 'attachment', uuid: 'x1', timestamp: at(2) },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')
}

describe('outside session .jsonl', () => {
  test('encodes a cwd the way Claude Code names its project folder', () => {
    expect(encodeProjectDir('C:\\Users\\me\\Desktop\\Project\\Connections')).toBe('C--Users-me-Desktop-Project-Connections')
    expect(encodeProjectDir('C:/Users/me/Desktop/Project/Agent Hydra/desk')).toBe('C--Users-me-Desktop-Project-Agent-Hydra-desk')
  })

  test('finds the projects folders of the default login, Desktop instances and given config dirs', () => {
    const home = temp()
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-instances', 'eek', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-instances', 'empty'), { recursive: true })
    mkdirSync(join(home, 'cli-68', 'projects'), { recursive: true })
    expect(claudeProjectRoots([join(home, 'cli-68'), join(home, 'missing')], home)).toEqual([
      join(home, '.claude', 'projects'),
      join(home, '.claude-instances', 'eek', 'projects'),
      join(home, 'cli-68', 'projects'),
    ])
  })

  test('finds the newest file for a session id, the cwd folder first, and refuses a path-looking id', () => {
    const home = temp()
    const a = join(home, 'one', 'projects')
    const b = join(home, 'two', 'projects')
    mkdirSync(join(a, 'C--x'), { recursive: true })
    mkdirSync(join(b, 'C--y'), { recursive: true })
    writeFileSync(join(a, 'C--x', `${SID}.jsonl`), lines())
    writeFileSync(join(b, 'C--y', `${SID}.jsonl`), lines())
    utimesSync(join(a, 'C--x', `${SID}.jsonl`), new Date(2026, 0, 1), new Date(2026, 0, 1))
    expect(findSessionJsonl(SID, [a, b])).toBe(join(b, 'C--y', `${SID}.jsonl`))
    expect(findSessionJsonl(SID, [a, b], 'C:/x')).toBe(join(a, 'C--x', `${SID}.jsonl`))
    expect(findSessionJsonl('nope-nope-nope', [a, b])).toBeNull()
    expect(findSessionJsonl('..\\..\\secrets', [a, b])).toBeNull()
    expect(findSessionJsonl('../C--x/' + SID, [a, b])).toBeNull()
  })

  test('reads only the tail; a cut first line is skipped', () => {
    const dir = temp()
    const f = join(dir, 's.jsonl')
    const body = lines()
    writeFileSync(f, body)
    expect(readTail(f, 10)).toBe(body.slice(-10))
    const lastTwo = body.split('\n').slice(-2).join('\n')
    const items = sessionJsonlItems(f)
    expect(items.length).toBe(2)
    expect(readTail(f, lastTwo.length + 5).endsWith(lastTwo)).toBe(true)
  })

  test('keeps the full text of an answer: newlines, lists, headings and fences', () => {
    const dir = temp()
    const f = join(dir, `${SID}.jsonl`)
    writeFileSync(f, lines())
    const items = sessionJsonlItems(f)
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant_text'])
    expect((items[1] as Extract<TranscriptItem, { kind: 'assistant_text' }>).text).toBe(ANSWER)
  })

  test('a growing file read after every append gives the items one read of the whole file gives', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 11, 0, s)).toISOString()
    const recs = [
      { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'list the files' } },
      { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'ls will do' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: at(2), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', uuid: 'u2', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }] } },
      { type: 'assistant', uuid: 'a3', timestamp: at(4), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
    ].map((r) => JSON.stringify(r))
    const upTo = (n: number): TranscriptItem[] => historyToItems(parseJsonl(recs.slice(0, n).join('\n')))
    const f = join(temp(), `${SID}.jsonl`)
    // Whole lines, a last line with no newline yet, and a line cut mid-write.
    writeFileSync(f, `${recs[0]}\n${recs[1]}`)
    expect(sessionJsonlItems(f)).toEqual(upTo(2))
    appendFileSync(f, `\n${recs[2]}\n${recs[3]!.slice(0, 40)}`)
    expect(sessionJsonlItems(f)).toEqual(upTo(3))
    appendFileSync(f, `${recs[3]!.slice(40)}\n${recs[4]}\n`)
    expect(sessionJsonlItems(f)).toEqual(upTo(5))
    expect(upTo(5).map((i) => i.kind)).toEqual(['user', 'thinking', 'tool_use', 'assistant_text'])
  })

  test('after the first read only the appended bytes are read', () => {
    const f = join(temp(), `${SID}.jsonl`)
    const said = (): unknown[] => sessionJsonlItems(f).map((i) => (i as { text?: string }).text)
    const first = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-03T12:00:00Z', message: { role: 'user', content: 'AAAA' } })
    writeFileSync(f, `${first}\n`)
    expect(said()).toEqual(['AAAA'])
    // The first line changes in place (same length), then a line is appended: a read from the start would see BBBB.
    const fd = openSync(f, 'r+')
    writeSync(fd, first.replace('AAAA', 'BBBB'), 0)
    closeSync(fd)
    appendFileSync(f, `${JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-10-03T12:00:01Z', message: { role: 'user', content: 'next' } })}\n`)
    expect(said()).toEqual(['AAAA', 'next'])
  })

  test("a chat's many sessions read in turn stay remembered, however many there are", () => {
    const dir = temp()
    const files = Array.from({ length: 12 }, (_, i) => join(dir, `s${i}.jsonl`))
    const line = (text: string) => JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-03T12:00:00Z', message: { role: 'user', content: text } })
    const said = (f: string): unknown => (sessionJsonlItems(f)[0] as { text?: string }).text
    for (const f of files) writeFileSync(f, `${line('AAAA')}\n`)
    expect(files.map(said)).toEqual(files.map(() => 'AAAA'))
    // Each changes in place: a file read afresh (forgotten since its last read) would say BBBB.
    for (const f of files) writeFileSync(f, `${line('BBBB')}\n`)
    expect(files.map(said)).toEqual(files.map(() => 'AAAA'))
  })

  test('a file that shrank was rewritten and is read again', () => {
    const f = join(temp(), `${SID}.jsonl`)
    writeFileSync(f, lines())
    expect(sessionJsonlItems(f).length).toBe(2)
    writeFileSync(f, `${JSON.stringify({ type: 'user', uuid: 'u9', timestamp: '2026-10-03T12:00:00Z', message: { role: 'user', content: 'fresh' } })}\n`)
    expect(sessionJsonlItems(f).map((i) => (i as { text?: string }).text)).toEqual(['fresh'])
  })
})
