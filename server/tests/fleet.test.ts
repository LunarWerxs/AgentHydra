// server/tests/fleet.test.ts - Piece 1 of the rebuild, pinned. Every fact the fleet status
// reports is deterministic, so every fact gets a fixture: each ending class, the torn-first-line
// rule, the adaptive window growing past a giant record, unreadable files, the usage-probe
// filter, and the quietest-first ordering.
import { expect, test } from 'bun:test'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyTranscriptTail, endingFromTailText, fleetStatus } from '../src/fleet'
import type { LiveSession } from '../src/live-registry'

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const userTurn = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const assistantTurn = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
// The CLI's own API-error shape: a synthetic-model assistant record (rate-limit-signal.ts's
// isApiErrorEvent gate). The text decides WHICH error it was.
const apiError = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
})

test('each ending class is classified from tail text', () => {
  expect(endingFromTailText(line(assistantTurn('all done')), true)).toBe('complete')
  expect(endingFromTailText(line(userTurn('[Request interrupted by user]')), true)).toBe(
    'interrupted',
  )
  expect(
    endingFromTailText(line(apiError("Claude's safeguards flagged this message.")), true),
  ).toBe('refused')
  expect(
    endingFromTailText(line(apiError("You've hit your weekly limit · resets 3am")), true),
  ).toBe('usage-limit')
  expect(endingFromTailText(line(apiError('API Error: 529 overloaded')), true)).toBe('overload')
  expect(endingFromTailText(line(apiError('API Error: something else broke')), true)).toBe('error')
})

test('the LAST classifiable record wins, and tool/garbage lines say nothing', () => {
  const text =
    line(userTurn('[Request interrupted by user]')) +
    'not json at all\n' +
    line({ type: 'tool_use', name: 'Bash' }) +
    line(assistantTurn('recovered and finished'))
  expect(endingFromTailText(text, true)).toBe('complete')
})

test('a windowed read drops its torn first line instead of parsing garbage', () => {
  // wholeFile=false: the first line is a slice of some larger record - even if it happens to
  // parse, it must not be trusted. Here it would classify as 'interrupted' if (wrongly) kept.
  const text = line(userTurn('[Request interrupted by user]')) + line(assistantTurn('done'))
  expect(endingFromTailText(text, false)).toBe('complete')
  const onlyTorn = line(userTurn('[Request interrupted by user]'))
  expect(endingFromTailText(onlyTorn, false)).toBe(null)
})

test('classifyTranscriptTail reads a real file and reports quiet time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-'))
  const p = join(dir, 't.jsonl')
  writeFileSync(p, line(userTurn('hi')) + line(assistantTurn('all done')))
  const r = classifyTranscriptTail(p, Date.now() + 5000)
  expect(r.unreadable).toBe(false)
  expect(r.ending).toBe('complete')
  expect(r.quietSecs).toBeGreaterThanOrEqual(4)
  expect(r.quietSecs).toBeLessThanOrEqual(60)
})

test('the adaptive window grows past a record larger than the starting window', () => {
  // One 100KB single-line record AFTER the meaningful turn: a fixed 64KB window would land
  // inside the giant line and see nothing classifiable; the growth pass must find the turn.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-big-'))
  const p = join(dir, 'big.jsonl')
  const giant = { type: 'tool_result', blob: 'x'.repeat(100 * 1024) }
  writeFileSync(p, line(userTurn('[Request interrupted by user]')) + line(giant))
  const r = classifyTranscriptTail(p, Date.now())
  expect(r.unreadable).toBe(false)
  expect(r.ending).toBe('interrupted')
})

test('an unreadable transcript is reported, never hidden', () => {
  const r = classifyTranscriptTail(join(tmpdir(), 'fleet-definitely-missing.jsonl'), Date.now())
  expect(r.unreadable).toBe(true)
  expect(r.ending).toBe(null)
})

function reg(over: Partial<LiveSession> & { pid: number }): LiveSession {
  return {
    sessionId: `sess-${over.pid}`,
    cwd: 'D:\\somewhere',
    name: `peer-${over.pid}`,
    startedAt: 1000,
    transcriptPath: null,
    ...over,
  }
}

test('fleetStatus joins the registry to transcript state and sorts quietest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-join-'))
  const oldPath = join(dir, 'old.jsonl')
  const newPath = join(dir, 'new.jsonl')
  writeFileSync(oldPath, line(assistantTurn('finished long ago')))
  writeFileSync(newPath, line(userTurn('[Request interrupted by user]')))
  // Deterministic quiet times: mtimes are set explicitly, never left to write-timing.
  const now = Date.now()
  utimesSync(oldPath, new Date(now - 300_000), new Date(now - 300_000))
  utimesSync(newPath, new Date(now - 10_000), new Date(now - 10_000))
  const status = fleetStatus({
    nowMs: now,
    registry: () => [
      reg({ pid: 1, transcriptPath: newPath }),
      reg({ pid: 2, transcriptPath: oldPath }),
      reg({ pid: 3 }), // no transcript yet
    ],
    probeCwd: () => null,
  })
  expect(status.count).toBe(3)
  // old.jsonl is 300s quiet, new.jsonl 10s => quietest first.
  expect(status.sessions[0]?.pid).toBe(2)
  expect(status.sessions[0]?.transcript?.ending).toBe('complete')
  expect(status.sessions[1]?.transcript?.ending).toBe('interrupted')
  // The no-transcript session sorts last (nothing read = least evidence of being stuck).
  expect(status.sessions[2]?.pid).toBe(3)
  expect(status.sessions[2]?.transcript).toBe(null)
})

test('the usage probe session is filtered out by its exact cwd, slash/case-insensitively', () => {
  const status = fleetStatus({
    registry: () => [
      reg({ pid: 1, cwd: 'C:\\Users\\x\\.agenthydra\\data\\usage-probe' }),
      reg({ pid: 2, cwd: 'D:\\RealWork' }),
    ],
    probeCwd: () => 'c:/users/x/.agenthydra/data/usage-probe/',
  })
  expect(status.count).toBe(1)
  expect(status.sessions[0]?.pid).toBe(2)
})
