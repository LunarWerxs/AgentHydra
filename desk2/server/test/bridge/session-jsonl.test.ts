import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { claudeProjectRoots, createJsonlReader, encodeProjectDir, findSessionJsonl, readTail, sessionJsonlItems, sessionJsonlWork, workerJsonlItems } from '../../src/bridge/session-jsonl'

const temps: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'desk-jsonl-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s % 60)).toISOString()
const userRec = (n: number, text: string) => JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: at(n), message: { role: 'user', content: text } })

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

  test('reads on from where it stopped: an appended line, a line finished later, a byte that is not UTF-8', () => {
    const f = join(temp(), 'grow.jsonl')
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const texts = () => sessionJsonlItems(f).map((i) => (i.kind === 'user' ? i.text : i.kind))
    // Line 2 holds a byte that is not UTF-8 (0xFF): one byte in the file, three once decoded.
    const [before, after] = rec(2, 'bad #').split('#')
    writeFileSync(f, Buffer.concat([Buffer.from(`${rec(1, 'one')}\n${before}`), Buffer.from([0xff]), Buffer.from(`${after}\n`)]))
    expect(texts()).toEqual(['one', 'bad �'])
    const four = rec(4, 'four')
    appendFileSync(f, `${rec(3, 'three')}\n${four.slice(0, 20)}`)
    expect(texts()).toEqual(['one', 'bad �', 'three'])
    appendFileSync(f, `${four.slice(20)}\n`)
    expect(texts()).toEqual(['one', 'bad �', 'three', 'four'])
  })

  test('a file rewritten in place, to the same size or larger, is read again from the start', () => {
    const f = join(temp(), 'rewrite.jsonl')
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const texts = () => sessionJsonlItems(f).map((i) => (i.kind === 'user' ? i.text : i.kind))
    const write = (body: string, at: number) => {
      writeFileSync(f, body)
      utimesSync(f, new Date(at), new Date(at))
    }
    write(`${rec(1, 'old one')}\n${rec(2, 'old two')}\n`, Date.UTC(2026, 9, 3, 10, 0, 0))
    expect(texts()).toEqual(['old one', 'old two'])
    write(`${rec(1, 'new one')}\n${rec(2, 'new two')}\n`, Date.UTC(2026, 9, 3, 10, 0, 10))
    expect(texts()).toEqual(['new one', 'new two'])
    write(`${rec(1, 'newer one')}\n${rec(2, 'newer two')}\n${rec(3, 'newer three')}\n`, Date.UTC(2026, 9, 3, 10, 0, 20))
    expect(texts()).toEqual(['newer one', 'newer two', 'newer three'])
  })

  test('a chat with many past sessions: an unchanged file answers for a stat, a changed one is read again', () => {
    // A CliMayte chat reads every session it has had at each poll (one had 94); a cap on what is remembered
    // re-parsed them all every few seconds on the server's one thread, and every click waited behind it.
    const dir = temp()
    const rec = (n: number, text: string) =>
      JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(), message: { role: 'user', content: text } })
    const files = Array.from({ length: 40 }, (_, i) => {
      const f = join(dir, `past-${i}.jsonl`)
      writeFileSync(f, `${rec(1, `session ${i}`)}\n`)
      return f
    })
    const first = files.map((f) => sessionJsonlItems(f))
    files.forEach((f, i) => expect(sessionJsonlItems(f)).toBe(first[i]!))
    appendFileSync(files[0]!, `${rec(2, 'later')}\n`)
    expect(sessionJsonlItems(files[0]!).map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(['session 0', 'later'])
  })

  test('worker files: 20 growing files are each read from only their new bytes', () => {
    // Every running worker of a CliMayte chat is polled and each grows between two polls; with 8 files remembered
    // a pass over 20 parsed an 8 MiB tail apiece, all in one stretch of the server's one thread.
    const dir = temp()
    const files = Array.from({ length: 20 }, (_, i) => {
      const f = join(dir, `running-${i}.jsonl`)
      writeFileSync(f, Array.from({ length: 60 }, (_, n) => userRec(n, `worker ${i} line ${n} ${'x'.repeat(1500)}`)).join('\n') + '\n')
      return f
    })
    files.forEach((f) => workerJsonlItems(f))
    files.forEach((f, i) => appendFileSync(f, `${userRec(100, `worker ${i} later`)}\n`))
    const before = sessionJsonlWork.parsedBytes
    const last = files.map((f) => workerJsonlItems(f).at(-1))
    const parsed = sessionJsonlWork.parsedBytes - before
    last.forEach((item, i) => expect(item?.kind === 'user' && item.text).toBe(`worker ${i} later`))
    expect(parsed).toBeLessThan(20 * 400)
  })

  test('an async read answers what a sync read answers, and lets the loop run while it parses', async () => {
    const dir = temp()
    const f = join(dir, 'long.jsonl')
    writeFileSync(f, Array.from({ length: 350 }, (_, n) => userRec(n, `slice ${n}`)).join('\n') + '\n')
    const options = { tailBytes: 1024 * 1024, keepBytes: 1024 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 }
    let ticks = 0
    setImmediate(() => { ticks += 1 })
    const answer = await createJsonlReader(options).readAsync(f)
    expect(ticks).toBe(1)
    expect(answer).toEqual(createJsonlReader(options)(f))
  })

  test('a windowed reader answers the whole tail once, then only the records it keeps', () => {
    const dir = temp()
    const f = join(dir, 'big.jsonl')
    writeFileSync(f, Array.from({ length: 200 }, (_, n) => userRec(n, `line ${n} ${'y'.repeat(1000)}`)).join('\n') + '\n')
    const read = createJsonlReader({ tailBytes: 1024 * 1024, keepBytes: 20 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 })
    expect(read(f)).toHaveLength(200)
    expect(read(f).length).toBeLessThanOrEqual(21)
    appendFileSync(f, `${userRec(300, 'newest')}\n`)
    const next = read(f)
    expect(next.length).toBeLessThanOrEqual(22)
    expect(next.at(-1)).toMatchObject({ kind: 'user', text: 'newest' })
  })

  test('a windowed reader keeps the launch of a running tool, so its result still settles it', () => {
    const dir = temp()
    const launch = JSON.stringify({ type: 'assistant', uuid: 'a-tool', timestamp: at(0), message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 60' } }] } })
    const result = JSON.stringify({ type: 'user', uuid: 'u-result', timestamp: at(50), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } })
    const options = { tailBytes: 1024 * 1024, keepBytes: 10 * 1024, pinBytes: 200 * 1024, maxFiles: 4, maxBytes: 1024 * 1024, settledFiles: 8, settledBytes: 1024 * 1024 }
    const run = (fillerLines: number) => {
      const f = join(dir, `tool-${fillerLines}.jsonl`)
      writeFileSync(f, [launch, ...Array.from({ length: fillerLines }, (_, n) => userRec(n, `filler ${n} ${'z'.repeat(1000)}`))].join('\n') + '\n')
      const read = createJsonlReader(options)
      expect(read(f).find((i) => i.id === 'toolu_1')).toMatchObject({ kind: 'tool_use', status: 'running' })
      appendFileSync(f, `${result}\n`)
      return read(f).find((i) => i.id === 'toolu_1')
    }
    // More than keepBytes of other records came between, within pinBytes: the result still settles the tool.
    expect(run(100)).toMatchObject({ kind: 'tool_use', status: 'done' })
    // Past pinBytes the launch is let go (a tool that long unanswered must not keep a file's history in memory) and its result is skipped.
    expect((run(300) as { status?: string } | undefined)?.status).not.toBe('done')
  })

  test('the outside-session reader still answers the whole tail, not a window', () => {
    const dir = temp()
    const f = join(dir, 'outside.jsonl')
    writeFileSync(f, Array.from({ length: 400 }, (_, n) => userRec(n, `line ${n} ${'w'.repeat(3000)}`)).join('\n') + '\n')
    expect(sessionJsonlItems(f)).toHaveLength(400)
    appendFileSync(f, `${userRec(500, 'newest')}\n`)
    expect(sessionJsonlItems(f)).toHaveLength(401)
  })

  test('keeps the full text of an answer: newlines, lists, headings and fences', () => {
    const dir = temp()
    const f = join(dir, `${SID}.jsonl`)
    writeFileSync(f, lines())
    const items = sessionJsonlItems(f)
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant_text'])
    expect((items[1] as Extract<TranscriptItem, { kind: 'assistant_text' }>).text).toBe(ANSWER)
  })
})
