// server/tests/session-search.test.ts — the completeness half of body search
// (server/src/session-search.ts).
//
// The hits themselves were never the risky part. The risk is a PARTIAL answer that looks total: the
// search runs under a wall-clock budget, so without a flag saying it gave up, an empty result reads
// as "that text is nowhere on this machine". These tests pin the flag, not the matching.
//
// Fixtures are hand-written JSONL in a temp dir: no real session data, no secrets.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { searchOneFile, searchSessionBodies } from '../src/session-search'
import type { TranscriptFile } from '../src/transcript'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const say = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    timestamp: '2026-08-10T12:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  })

function fixture(lines: string[]): TranscriptFile {
  const dir = mkdtempSync(join(os.tmpdir(), 'agh-session-search-'))
  dirs.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return {
    session_id: 'sess-1',
    source: 'claude',
    path,
    project: 'proj',
    mtime_ms: Date.now(),
    size_bytes: 0,
    archived: false,
  }
}

/** Substring matcher, the same contract buildMatcher() produces: match index, or -1. */
const contains = (needle: string) => (haystack: string) => haystack.indexOf(needle)
const FOREVER = performance.now() + 60_000

describe('searchOneFile', () => {
  test('finds matches and reports the file as fully read', async () => {
    const tf = fixture([
      say('user', 'where is the postcode validator'),
      say('assistant', 'the postcode rule lives in checkout'),
      say('assistant', 'unrelated reply'),
    ])
    const { hit, stoppedEarly } = await searchOneFile(tf, contains('postcode'), 5, FOREVER)
    expect(stoppedEarly).toBe(false)
    expect(hit?.match_count).toBe(2)
    expect(hit?.snippets.length).toBe(2)
    expect(hit?.truncated).toBe(false)
  })

  test('a file with no match is a miss, not an early stop', async () => {
    const tf = fixture([say('user', 'nothing of interest here')])
    const { hit, stoppedEarly } = await searchOneFile(tf, contains('postcode'), 5, FOREVER)
    expect(hit).toBeNull()
    expect(stoppedEarly).toBe(false)
  })

  test('per-file snippet cap marks the hit truncated without losing the count', async () => {
    const tf = fixture(Array.from({ length: 6 }, (_, i) => say('user', `postcode ${i}`)))
    const { hit } = await searchOneFile(tf, contains('postcode'), 2, FOREVER)
    expect(hit?.snippets.length).toBe(2)
    expect(hit?.match_count).toBe(6)
    expect(hit?.truncated).toBe(true) // "there are more matches than shown"
  })

  // The case the whole feature exists for: the budget expires while this file is still being read,
  // so its answer is an undercount and the caller must be able to say so.
  test('an expired budget stops the read and says it stopped', async () => {
    const tf = fixture([say('user', 'postcode')])
    const { hit, stoppedEarly } = await searchOneFile(tf, contains('postcode'), 5, -1)
    expect(stoppedEarly).toBe(true)
    expect(hit).toBeNull() // nothing was read, so nothing was found — NOT proof of absence
  })

  test('an unreadable file is skipped silently, and is not reported as an early stop', async () => {
    const tf = fixture([say('user', 'postcode')])
    rmSync(tf.path)
    const { hit, stoppedEarly } = await searchOneFile(tf, contains('postcode'), 5, FOREVER)
    expect(hit).toBeNull()
    expect(stoppedEarly).toBe(false)
  })
})

describe('searchSessionBodies', () => {
  // A blank query is the one input that can be tested without a transcript store, and the property
  // worth pinning is that it answers with the same SHAPE as a real search: a caller that has to
  // branch on "did I get a list or an object?" will eventually branch wrong.
  test('a blank query answers with a complete, empty response', async () => {
    for (const query of ['', '   ']) {
      const r = await searchSessionBodies({ query })
      expect(r.results).toEqual([])
      expect(r.budgetExhausted).toBe(false)
      expect(r.limitReached).toBe(false)
      expect(r.filesSearched).toBe(0)
      expect(r.filesTotal).toBe(0)
    }
  })

  test('an unsafe regex is rejected rather than risking a hang', async () => {
    expect(searchSessionBodies({ query: '(a+)+$', regex: true })).rejects.toThrow()
  })
})
