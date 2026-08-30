// server/tests/context-size.test.ts - context-pressure detection pinned: it measures the same
// thing the owner's own ctxsize tool measures, treats "unknown" as unknown (never zero), and
// only warns about chats that are actually full.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDOFF_WARN_TOKENS, handoffCandidates, readContextSize } from '../src/context-size'

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-ctx-'))
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return p
}

const turn = (
  input: number,
  cacheRead: number,
  cacheCreate = 0,
  timestamp = '2026-08-30T12:00:00Z',
) => ({
  type: 'assistant',
  timestamp,
  message: {
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    },
  },
})

test('context is input + cache_read + cache_creation - the same sum the ctxsize tool uses', () => {
  // cache_read is the bulk of it and is the whole point: it is the conversation re-sent.
  const p = transcript([turn(1_000, 200_000, 5_000)])
  expect(readContextSize(p).tokens).toBe(206_000)
})

test('the NEWEST record wins - a chat grows, so the last request is the current size', () => {
  const p = transcript([
    turn(1_000, 100_000, 0, '2026-08-30T10:00:00Z'),
    turn(1_000, 500_000, 0, '2026-08-30T11:00:00Z'),
  ])
  const r = readContextSize(p)
  expect(r.tokens).toBe(501_000)
  expect(r.at).toBe('2026-08-30T11:00:00Z')
})

test('no usage record is UNKNOWN, never zero', () => {
  // A fabricated/seeded transcript has turns but no usage. Reporting 0 would read as "empty",
  // and an empty chat is the opposite of one that needs a handoff.
  const p = transcript([{ type: 'user', message: { content: 'hi' } }])
  expect(readContextSize(p).tokens).toBeNull()
  expect(readContextSize(join(tmpdir(), 'nope.jsonl')).tokens).toBeNull()
})

test('a full chat is flagged; a roomy one is not', () => {
  const full = transcript([turn(1_000, HANDOFF_WARN_TOKENS)])
  const roomy = transcript([turn(1_000, 10_000)])
  const out = handoffCandidates([
    { sessionId: 'full', transcriptPath: full },
    { sessionId: 'roomy', transcriptPath: roomy },
  ])
  expect(out.map((o) => o.sessionId)).toEqual(['full'])
  // The advice must say what to DO, not just that a number is big.
  expect(out[0]?.why).toContain('hand the thread off')
})

test('chats with no reading are skipped, not reported as candidates', () => {
  const none = transcript([{ type: 'user', message: { content: 'hi' } }])
  expect(handoffCandidates([{ sessionId: 'x', transcriptPath: none }])).toEqual([])
  expect(handoffCandidates([{ sessionId: 'y', transcriptPath: null }])).toEqual([])
})

test('the fullest chat is reported first, so the most urgent handoff leads', () => {
  const a = transcript([turn(0, 800_000)])
  const b = transcript([turn(0, 900_000)])
  const out = handoffCandidates([
    { sessionId: 'a', transcriptPath: a },
    { sessionId: 'b', transcriptPath: b },
  ])
  expect(out.map((o) => o.sessionId)).toEqual(['b', 'a'])
})

test('the threshold is a parameter, so a different window size is expressible', () => {
  const p = transcript([turn(0, 50_000)])
  expect(handoffCandidates([{ sessionId: 'x', transcriptPath: p }], 40_000).length).toBe(1)
  expect(handoffCandidates([{ sessionId: 'x', transcriptPath: p }], 60_000).length).toBe(0)
})

test("a subagent's turn is not this thread's context", () => {
  // Sidechain usage belongs to a subagent. Counting it would report someone else's fullness
  // as this chat's, and the newest record is often a subagent's in a busy session.
  const p = transcript([
    turn(1_000, 50_000, 0, '2026-08-30T10:00:00Z'),
    { ...turn(1_000, 900_000, 0, '2026-08-30T11:00:00Z'), isSidechain: true },
  ])
  expect(readContextSize(p).tokens).toBe(51_000)
})
