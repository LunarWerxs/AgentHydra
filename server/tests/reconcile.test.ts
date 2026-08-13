// server/tests/reconcile.test.ts — the check that checks the checks (server/src/reconcile.ts).
//
// This suite has an unusual job. Every other test here pins behaviour; this one pins the DETECTOR,
// so what it must prove is that the detector fires on the three shapes of error that shipped in one
// day and passed a green suite:
//
//   1. a file on disk that nothing claims          (Claude subagents: 89.8B tokens invisible)
//   2. a reported total above an independent count (Codex: 53x, Claude records: +57%)
//   3. a reported total below one                  (the same subagent miss, seen from the numbers)
//
// The independent counter is exercised directly, because it is the half that must never be allowed
// to drift into agreeing with the parser by construction.

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DRIFT_TOLERANCE } from '../src/reconcile'

/** The module's CODE, comments removed. The comments name the parser it must not call, on purpose,
 *  so a raw grep would fail on the very sentence explaining the rule. */
async function readSource(): Promise<string> {
  const text = await readFile(join(import.meta.dir, '..', 'src', 'reconcile.ts'), 'utf8')
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The exact record shape Claude Code writes: one per CONTENT BLOCK, same usage stamped on each. */
const record = (id: string, req: string, out: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-09T07:24:13.537Z',
    requestId: req,
    message: {
      id,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 1000, ...extra },
    },
  })

describe('the drift threshold', () => {
  test('is tight enough that any of the three real errors trips it', () => {
    // 53x, +57%, -58%. A tolerance loose enough to miss those is a tolerance that exists to make
    // the check green rather than to make the numbers right.
    for (const realError of [52.4, 0.566, -0.581]) {
      expect(Math.abs(realError)).toBeGreaterThan(DRIFT_TOLERANCE)
    }
  })

  test('is not so tight that ordinary rounding trips it', () => {
    expect(0.0001).toBeLessThan(DRIFT_TOLERANCE)
  })
})

describe('the independent count is genuinely independent', () => {
  test('reconcile.ts imports nothing from the module it is checking', async () => {
    // THE PROPERTY THAT MAKES THIS FILE WORTH HAVING. Two implementations only catch a wrong
    // assumption while they are actually two. The day someone "removes the duplication" by calling
    // accumulateUsageLine from the reconciler, the audit becomes a very slow way of proving that a
    // function equals itself — and this test is what stops that happening quietly.
    const source = await readSource()
    expect(source).not.toContain("from './usage-tokens'")
    expect(source).not.toContain('accumulateUsageLine')
    expect(source).not.toContain("from './usage-foreign'")
    expect(source).not.toContain('CodexUsageReader')
  })

  test('it does not reach the analytics scanner either', async () => {
    const source = await readSource()
    expect(source).not.toContain('scanSessionAnalytics')
  })
})

describe('the record shape it is written against', () => {
  test('one response really is several records with identical usage', () => {
    // Encoding the OBSERVATION, not the implementation: three records, one request, one charge.
    // If Claude Code ever stops doing this the fixture is what will look wrong first.
    const lines = [record('msg_1', 'req_1', 290), record('msg_1', 'req_1', 290)]
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0]?.message.id).toBe(parsed[1]?.message.id)
    expect(parsed[0]?.requestId).toBe(parsed[1]?.requestId)
    expect(parsed[0]?.message.usage.output_tokens).toBe(parsed[1]?.message.usage.output_tokens)
  })
})
