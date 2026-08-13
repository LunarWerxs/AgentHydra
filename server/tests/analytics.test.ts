// server/src/analytics.ts — what one transcript totals up to.
//
// These pin the extractor, not the SQL: given a transcript, does it count the right things? The
// cases that matter are the ones where a plausible implementation is quietly wrong — a failure
// streak that keeps counting after a success, wall-clock time passed off as engaged time, and
// tool-result usage echoes double-counting a turn's spend.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyticsCacheKey, refreshAnalytics, scanSessionAnalytics } from '../src/analytics'
import { db } from '../src/db'

const dir = mkdtempSync(join(tmpdir(), 'ah-analytics-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function transcript(lines: unknown[]): string {
  const path = join(dir, `t${n++}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  return path
}

const assistant = (at: string, usage: Record<string, number>, model = 'claude-opus-5') => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', model, usage },
})
const tools = (at: string, blocks: unknown[]) => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', content: blocks },
})
const results = (at: string, blocks: unknown[]) => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: blocks },
})

const U = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }

describe('tokens and time', () => {
  test('per-model totals come out of the assistant turns', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-08-10T10:00:00.000Z', U),
        assistant('2026-08-10T10:01:00.000Z', U, 'claude-sonnet-5'),
        assistant('2026-08-10T10:02:00.000Z', U),
      ]),
      'claude',
    )
    expect(Object.keys(a.tokens).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(a.tokens['claude-opus-5']?.turns).toBe(2)
    expect(a.tokens['claude-sonnet-5']?.turns).toBe(1)
    expect(a.tokens['claude-opus-5']?.input).toBe(200)
  })

  test('a user turn carrying a usage echo does not double-count the spend', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-08-10T10:00:00.000Z', U),
        {
          type: 'user',
          timestamp: '2026-08-10T10:00:30.000Z',
          message: { role: 'user', usage: U },
        },
      ]),
      'claude',
    )
    expect(a.tokens['claude-opus-5']?.turns).toBe(1)
  })

  test('engaged time caps each gap, so an overnight pause is not counted as work', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-08-10T10:00:00.000Z', U),
        assistant('2026-08-10T10:02:00.000Z', U), // 2 min: real
        assistant('2026-08-11T09:00:00.000Z', U), // ~23 h: capped at 5 min
      ]),
      'claude',
    )
    // 2 minutes + the 5-minute cap, not 23 hours.
    expect(Math.round(a.activeMs / 60_000)).toBe(7)
  })

  test('the day and hour histograms follow the turns, not the file', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-08-10T10:00:00.000Z', U),
        assistant('2026-08-10T11:00:00.000Z', U),
        assistant('2026-08-11T10:00:00.000Z', U),
      ]),
      'claude',
    )
    // Keys are LOCAL dates, so the count is what is pinned rather than the labels.
    expect(Object.keys(a.days).length).toBeGreaterThanOrEqual(1)
    expect(Object.values(a.days).reduce((x, y) => x + y, 0)).toBeGreaterThan(0)
    expect(Object.values(a.hours).reduce((x, y) => x + y, 0)).toBe(3)
    for (const k of Object.keys(a.hours)) {
      expect(Number(k)).toBeGreaterThanOrEqual(0)
      expect(Number(k)).toBeLessThan(168)
    }
  })
})

describe('tools, failures and edits', () => {
  test('tool uses are counted by name', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        tools('2026-08-10T10:00:00.000Z', [
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
        ]),
      ]),
      'claude',
    )
    expect(a.tools).toEqual({ Bash: 2, Read: 1 })
  })

  test('a failure streak RESETS on a success, which is the whole point of a streak', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        results('2026-08-10T10:00:00.000Z', [
          { type: 'tool_result', is_error: true },
          { type: 'tool_result', is_error: true },
          { type: 'tool_result' }, // success: the run of failures ends here
          { type: 'tool_result', is_error: true },
        ]),
      ]),
      'claude',
    )
    expect(a.toolErrors).toBe(3)
    expect(a.toolErrorStreak).toBe(2)
  })

  test('edits are the file-changing tools only, and carry their path', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        tools('2026-08-10T10:00:00.000Z', [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/x/a.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: 'D:/x/b.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'D:/x/c.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ]),
      ]),
      'claude',
    )
    expect(a.editCount).toBe(2)
    expect(a.edits.map((e) => e.path)).toEqual(['D:/x/a.ts', 'D:/x/b.ts'])
  })

  test('an edit tool with no path is not counted, rather than logged as an empty file', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        tools('2026-08-10T10:00:00.000Z', [{ type: 'tool_use', name: 'Edit', input: {} }]),
      ]),
      'claude',
    )
    expect(a.editCount).toBe(0)
  })

  test('compactions are counted', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        { type: 'user', isCompactSummary: true, message: { role: 'user', content: [] } },
        assistant('2026-08-10T10:00:00.000Z', U),
        { type: 'user', isCompactSummary: true, message: { role: 'user', content: [] } },
      ]),
      'claude',
    )
    expect(a.compactions).toBe(2)
  })
})

describe('the edges', () => {
  test('an empty transcript totals to nothing rather than throwing', async () => {
    const a = await scanSessionAnalytics(transcript([]), 'claude')
    expect(a.tokens).toEqual({})
    expect(a.firstTs).toBeNull()
    expect(a.activeMs).toBe(0)
  })

  test('a half-written line is skipped, not fatal', async () => {
    const path = transcript([assistant('2026-08-10T10:00:00.000Z', U)])
    writeFileSync(path, `${'{"type":"assistant","mess'}\n`, { flag: 'a' })
    const a = await scanSessionAnalytics(path, 'claude')
    expect(a.tokens['claude-opus-5']?.turns).toBe(1)
  })

  test('OpenCode records no per-turn usage, so it totals to nothing rather than zeros', async () => {
    const a = await scanSessionAnalytics(
      transcript([assistant('2026-08-10T10:00:00.000Z', U)]),
      'opencode',
    )
    expect(a.tokens).toEqual({})
  })
})

describe('the placeholder row can never be mistaken for a parsed session', () => {
  // THE BUG THIS PINS. Analytics and the session list both write session_scan_cache, and analytics
  // may reach a transcript first. It therefore inserts a placeholder row to hang its totals on. The
  // first version stamped that row with the file's REAL mtime and size — which is exactly what the
  // list scanner validates its own cache against, so the list accepted the placeholder as a finished
  // parse: title = a uuid, substantive_turns = 0. A session with zero substantive turns is dropped
  // from the list outright, so warming analytics would have silently deleted sessions from the
  // sessions view. The placeholder now carries an impossible (-1, -1) revision, which the list can
  // only ever treat as stale.
  test('a row written by the analytics pass is stale to the list scanner by construction', async () => {
    const path = transcript([assistant('2026-08-10T10:00:00.000Z', U)])
    const tf = {
      source: 'claude' as const,
      session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      path,
      project: 'test-project',
      cwd: 'D:/test',
      mtime_ms: 1_700_000_000_000,
      size_bytes: 4096,
      title: '',
      archived: false,
      created_at: null,
    }
    await refreshAnalytics([tf as never], { budgetMs: 5_000, concurrency: 1 })

    const row = db
      .query<{ mtime_ms: number; size_bytes: number; substantive_turns: number }, [string]>(
        'select mtime_ms, size_bytes, substantive_turns from session_scan_cache where cache_key = ?',
      )
      .get(analyticsCacheKey(tf as never))
    expect(row).toBeTruthy()
    // The list's freshness test is `row.mtime_ms !== tf.mtime_ms || row.size_bytes !== tf.size_bytes`
    // (see sessions.ts readScanCache). Both must differ, so that test can only ever say "stale".
    expect(row?.mtime_ms).not.toBe(tf.mtime_ms)
    expect(row?.size_bytes).not.toBe(tf.size_bytes)

    // ...and the analytics were still stored, on their own revision stamp.
    const a = db
      .query<{ analytics_at: number | null; analytics_mtime_ms: number | null }, [string]>(
        'select analytics_at, analytics_mtime_ms from session_scan_cache where cache_key = ?',
      )
      .get(analyticsCacheKey(tf as never))
    expect(a?.analytics_at).toBeGreaterThan(0)
    expect(a?.analytics_mtime_ms).toBe(tf.mtime_ms)
  })
})

describe('a Codex conversation is more than one file', () => {
  // THE BUG THIS PINS. Codex writes one rollout per execution thread and identifies the owning chat
  // by session_id, so a conversation is routinely hundreds of files — 4,716 of the 4,860 archived
  // rollouts on the machine this was built against are subagent threads. The session LIST correctly
  // shows one row per conversation, and the totals were reading only that row's single file, so
  // Codex spend was reported at a fraction of the truth: 12.2B tokens against a real 637.7B.
  //
  // Each file carries its OWN running cumulative, which is why every one needs a fresh reader:
  // continuing one across files would read the next file's opening total as one enormous delta.
  const rollout = (at: string, totals: Array<[number, number]>) =>
    transcript([
      { type: 'turn_context', timestamp: at, payload: { model: 'gpt-5.6-sol' } },
      ...totals.map(([input, output]) => ({
        type: 'event_msg',
        timestamp: at,
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
            },
          },
        },
      })),
    ])

  test('a conversation is the LARGEST of its rollouts, never the sum', async () => {
    // THE BUG THIS PINS, which shipped before it was understood. Codex's `total_token_usage` is a
    // session-wide counter and every execution thread replays the whole counter into its own file,
    // so files are copies of one series rather than separate spend. Measured on a real conversation:
    // the main rollout and three subagent rollouts all open at exactly the same totals, and three
    // subagents that ran inside a nine-minute window each record 5,090 counter events reaching 552
    // million tokens. Summing them turned 11.9B store-wide into 637B.
    const main = rollout('2026-08-10T10:00:00.000Z', [
      [100, 10],
      [300, 30],
    ])
    const replay1 = rollout('2026-08-10T10:01:00.000Z', [
      [100, 10],
      [250, 25],
    ])
    const replay2 = rollout('2026-08-10T10:02:00.000Z', [[200, 20]])

    const alone = await scanSessionAnalytics(main, 'codex', 'sess')
    expect(alone.tokens['gpt-5.6-sol']?.input).toBe(300)

    const together = await scanSessionAnalytics(main, 'codex', 'sess', [replay1, replay2])
    expect(together.tokens['gpt-5.6-sol']?.input).toBe(300)
    expect(together.tokens['gpt-5.6-sol']?.output).toBe(30)
  })

  test('a sibling that reached further wins, because the counter is the conversation’s', async () => {
    // Two of 109 real conversations end this way: the main rollout stopped being written before a
    // subagent did, so the subagent holds the highest reading of the shared counter.
    const short = rollout('2026-08-10T10:00:00.000Z', [[100, 10]])
    const long = rollout('2026-08-10T10:05:00.000Z', [[900, 90]])
    const both = await scanSessionAnalytics(short, 'codex', 'sess', [long])
    expect(both.tokens['gpt-5.6-sol']?.input).toBe(900)
  })

  test('an unreadable sibling does not lose the conversation', async () => {
    // Codex moves rollouts between sessions/ and archived_sessions/ while the daemon scans, so a
    // file vanishing mid-read is expected rather than exceptional.
    const main = rollout('2026-08-10T10:00:00.000Z', [[100, 10]])
    const other = rollout('2026-08-10T10:01:00.000Z', [[80, 8]])
    const a = await scanSessionAnalytics(main, 'codex', 'sess', [
      join(dir, 'does-not-exist.jsonl'),
      other,
    ])
    expect(a.tokens['gpt-5.6-sol']?.input).toBe(100)
  })
})

describe('a Codex rollout that spends before it names its model', () => {
  // THE BUG THIS PINS. `turn_context` (which names the model) and `token_count` (which carries the
  // spend) are separate lines, and the naming one is NOT reliably first: 2,067 of 4,860 rollouts on
  // the machine this was built against spend tokens beforehand, 331 BILLION of them. Those landed
  // under a placeholder id — "codex" — which is not a model any price table will ever match, so a
  // third of all Codex spend showed as unpriced.
  const tokenLine = (at: string, input: number, output: number) => ({
    type: 'event_msg',
    timestamp: at,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output },
      },
    },
  })
  const ctx = (at: string, model: string) => ({
    type: 'turn_context',
    timestamp: at,
    payload: { model },
  })

  test('the spend is attributed to the model the file names LATER, not to a placeholder', async () => {
    const path = transcript([
      tokenLine('2026-08-10T10:00:00.000Z', 400, 40),
      ctx('2026-08-10T10:01:00.000Z', 'gpt-5.6-sol'),
      tokenLine('2026-08-10T10:01:00.000Z', 900, 90),
    ])
    const out = await scanSessionAnalytics(path, 'codex', 'sess')
    expect(out.tokens['gpt-5.6-sol']?.input).toBe(900)
    expect(out.tokens.codex).toBeUndefined()
  })

  test('a mid-file model switch does not retro-label the earlier turns', async () => {
    // Only the turns BEFORE the first naming are ambiguous. Once a file has said what it is
    // running, a later switch applies from that point on, exactly as it did before.
    const path = transcript([
      tokenLine('2026-08-10T10:00:00.000Z', 100, 10),
      ctx('2026-08-10T10:01:00.000Z', 'gpt-5.6-sol'),
      tokenLine('2026-08-10T10:01:00.000Z', 300, 30),
      ctx('2026-08-10T10:02:00.000Z', 'gpt-5.6-terra'),
      tokenLine('2026-08-10T10:02:00.000Z', 700, 70),
    ])
    const out = await scanSessionAnalytics(path, 'codex', 'sess')
    expect(out.tokens['gpt-5.6-sol']?.input).toBe(300)
    expect(out.tokens['gpt-5.6-terra']?.input).toBe(400)
  })

  test('the fallback is the model the rest of the FILE used', async () => {
    // Attribution is per rollout, because a conversation's totals come from one rollout: the file
    // that reached furthest. A later turn naming the model settles the earlier unnamed ones.
    const path = transcript([
      tokenLine('2026-08-10T10:00:00.000Z', 100, 10),
      ctx('2026-08-10T10:01:00.000Z', 'gpt-5.6-sol'),
      tokenLine('2026-08-10T10:01:00.000Z', 1000, 100),
    ])
    const out = await scanSessionAnalytics(path, 'codex', 'sess')
    expect(out.tokens['gpt-5.6-sol']?.input).toBe(1000)
    expect(out.tokens.codex).toBeUndefined()
  })

  test('when NOTHING in the conversation names a model it stays unknown, not invented', async () => {
    // The honest outcome: an id no price table matches, reported as unpriced. Better than picking
    // a plausible model and printing a dollar figure nobody can check.
    const path = transcript([tokenLine('2026-08-10T10:00:00.000Z', 500, 50)])
    const out = await scanSessionAnalytics(path, 'codex', 'sess')
    expect(out.tokens.codex?.input).toBe(500)
  })

  test('an unnamed turn still lands on the day and hour charts at full weight', async () => {
    // The per-model row is what waits; the timeline is not model-dependent and must not thin out.
    const path = transcript([tokenLine('2026-08-10T10:00:00.000Z', 500, 50)])
    const out = await scanSessionAnalytics(path, 'codex', 'sess')
    expect(Object.values(out.days).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(Object.values(out.hours).reduce((a, b) => a + b, 0)).toBe(1)
  })
})
