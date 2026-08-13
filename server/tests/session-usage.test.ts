// server/tests/session-usage.test.ts — per-session tokens + cost (server/src/session-usage.ts).
//
// Fixtures are hand-written JSONL in a temp dir: no real session data, no secrets.

import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { sessionUsage } from '../src/session-usage'
import type { TranscriptFile } from '../src/transcript'
import type { SessionSource } from '../src/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Writes `lines` as a transcript and returns the TranscriptFile the daemon would hand us. */
function fixture(lines: string[], source: SessionSource = 'claude'): TranscriptFile {
  const dir = mkdtempSync(join(os.tmpdir(), 'agh-session-usage-'))
  dirs.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return {
    session_id: 'sess-1',
    source,
    path,
    project: 'proj',
    mtime_ms: Date.now(),
    size_bytes: 0,
    archived: false,
  }
}

const turn = (model: string, usage: Record<string, unknown>, when = '2026-08-10T12:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: when, message: { model, usage } })

describe('sessionUsage', () => {
  test('totals every turn in the file, with no time window', async () => {
    const tf = fixture([
      turn('claude-opus-5', { input_tokens: 100, output_tokens: 10 }, '2020-01-01T00:00:00.000Z'),
      turn('claude-opus-5', { input_tokens: 50, output_tokens: 5 }),
    ])
    const u = await sessionUsage(tf)
    expect(u.status).toBe('ok')
    expect(u.tokens.turns).toBe(2)
    expect(u.tokens.input).toBe(150)
    expect(u.tokens.output).toBe(15)
    expect(u.tokens.total).toBe(165)
  })

  test('prices cache reads and both cache-write TTLs at their own rates', async () => {
    const tf = fixture([
      turn('claude-opus-5', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      }),
    ])
    const u = await sessionUsage(tf)
    // 5 + 25 + 0.5 + 6.25 + 10 — the same arithmetic as pricing.test.ts, end to end.
    expect(u.costUsd).toBeCloseTo(46.75, 10)
    expect(u.tokens.cacheRead).toBe(1_000_000)
    expect(u.tokens.cacheCreation).toBe(2_000_000)
    expect(u.pricedModels).toEqual(['claude-opus-5'])
  })

  test('an unpriced model still contributes tokens, and is named', async () => {
    const tf = fixture([
      turn('claude-opus-5', { output_tokens: 1_000_000 }),
      turn('mystery-model', { output_tokens: 400 }),
    ])
    const u = await sessionUsage(tf)
    expect(u.tokens.output).toBe(1_000_400)
    expect(u.costUsd).toBeCloseTo(25, 10) // a LOWER bound; the UI says so
    expect(u.unpricedModels).toEqual(['mystery-model'])
  })

  test('no priced model at all: tokens, but no dollar figure', async () => {
    const tf = fixture([turn('mystery-model', { input_tokens: 10, output_tokens: 20 })])
    const u = await sessionUsage(tf)
    expect(u.tokens.total).toBe(30)
    expect(u.costUsd).toBeNull()
    expect(u.unpricedModels).toEqual(['mystery-model'])
  })

  test('an introductory rate is billed as of the session, not as of today', async () => {
    // Sonnet 5's introductory rate ran to 2026-08-31. A session from after that date must not be
    // repriced at the intro rate just because the table still lists it.
    const during = fixture([
      turn('claude-sonnet-5', { output_tokens: 1_000_000 }, '2026-08-10T12:00:00.000Z'),
    ])
    const after = fixture([
      turn('claude-sonnet-5', { output_tokens: 1_000_000 }, '2026-10-10T12:00:00.000Z'),
    ])
    expect((await sessionUsage(during)).costUsd).toBeCloseTo(10, 10)
    expect((await sessionUsage(after)).costUsd).toBeCloseTo(15, 10)
  })

  test('malformed lines, user echoes and non-turn records are skipped, not fatal', async () => {
    const tf = fixture([
      '{not json',
      JSON.stringify({ type: 'queue-operation', op: 'dequeue' }),
      // a user turn echoing a usage block: counting it would double-count the same spend
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-10T12:00:00.000Z',
        message: { model: 'claude-opus-5', usage: { input_tokens: 9999 } },
      }),
      turn('claude-opus-5', { input_tokens: 7 }),
    ])
    const u = await sessionUsage(tf)
    expect(u.status).toBe('ok')
    expect(u.tokens.input).toBe(7)
    expect(u.tokens.turns).toBe(1)
  })

  test('an empty transcript is a real zero, not an error', async () => {
    const u = await sessionUsage(fixture([]))
    expect(u.status).toBe('ok')
    expect(u.tokens.total).toBe(0)
    expect(u.costUsd).toBeNull() // no model seen, so nothing to price
  })

  test('a non-Claude source says why instead of showing a zero', async () => {
    for (const source of ['codex', 'opencode'] as const) {
      const u = await sessionUsage(fixture([turn('claude-opus-5', { input_tokens: 5 })], source))
      expect(u.status).toBe('source-unsupported')
      expect(u.tokens.total).toBe(0)
      expect(u.costUsd).toBeNull()
    }
  })

  test('a vanished transcript reports unreadable rather than throwing', async () => {
    const tf = fixture([turn('claude-opus-5', { input_tokens: 5 })])
    rmSync(tf.path)
    const u = await sessionUsage(tf)
    expect(u.status).toBe('unreadable')
  })

  test('a growing transcript is re-read — a live session must not report stale numbers', async () => {
    const tf = fixture([turn('claude-opus-5', { input_tokens: 10 })])
    expect((await sessionUsage(tf)).tokens.input).toBe(10)
    appendFileSync(tf.path, `${turn('claude-opus-5', { input_tokens: 25 })}\n`)
    expect((await sessionUsage(tf)).tokens.input).toBe(35)
  })

  test('an unchanged transcript is served from cache, not re-streamed', async () => {
    // Proven by making the cached answer disagree with the file: overwrite with a same-length,
    // different-value line and restore the original mtime, so (mtime, size) — the cache key — is
    // unchanged. A cache miss would report 99.
    // Stamped explicitly on both writes: restoring a filesystem-generated mtime does not round-trip
    // exactly (sub-millisecond precision), which would look like a changed file.
    const stamp = new Date('2026-08-10T12:00:00.000Z')
    const tf = fixture([turn('claude-opus-5', { input_tokens: 10 })])
    utimesSync(tf.path, stamp, stamp)
    const before = statSync(tf.path)
    expect((await sessionUsage(tf)).tokens.input).toBe(10)

    writeFileSync(tf.path, `${turn('claude-opus-5', { input_tokens: 99 })}\n`)
    utimesSync(tf.path, stamp, stamp)
    expect(statSync(tf.path).size).toBe(before.size) // same length, or the test proves nothing

    expect((await sessionUsage(tf)).tokens.input).toBe(10)
  })

  test('every answer carries the price-table date', async () => {
    const u = await sessionUsage(fixture([turn('claude-opus-5', { input_tokens: 1 })]))
    expect(u.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
