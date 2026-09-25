// The MCP behavioural eval (scripts/mcp-eval): an agent must be able to REACH a known answer
// through the real stdio server, against a frozen fleet. The first case is the eval itself, so a
// renamed tool, a changed argument or a reshaped result on any question's path turns this red.
// The others prove the eval can fail at all: a wrong answer and a mutating path are both caught.

import { describe, expect, test } from 'bun:test'
import {
  loadQaPairs,
  REFERENCE,
  runReferenceEval,
  scoreAnswers,
} from '../../scripts/mcp-eval/harness'

// Each run spawns the real stdio server once; a cold CI box is far slower than a dev machine.
const SPAWN_TIMEOUT_MS = 60_000

describe('mcp eval over the real stdio server', () => {
  test(
    'the reference agent reaches every known answer, read-only, and each answer costs tool calls',
    async () => {
      const report = await runReferenceEval()
      const misses = report.tasks.filter((t) => !t.correct)
      expect(misses).toEqual([])
      expect(report.total).toBe(loadQaPairs().length)
      expect(report.mutationsRefused).toEqual([])
      for (const t of report.tasks) expect(t.toolCalls).toBeGreaterThan(0)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'a path that lands on the wrong answer fails, and one that reaches for a MUTATES: tool is refused',
    async () => {
      const report = await runReferenceEval(
        [
          { id: 'session-trap', question: 'Most weekly room?', answer: '2' },
          { id: 'mutates', question: 'Ack the billing incident.', answer: 'ok' },
        ],
        {
          // Ranks by the 5-hour session % instead of the binding weekly %: the fixture's trap.
          'session-trap': async (call) => {
            const { rows } = (await call('list_usage')) as {
              rows: { num: number; result: { snapshot: { session: { pct: number } } } }[]
            }
            const idlest = rows.reduce((a, b) =>
              b.result.snapshot.session.pct < a.result.snapshot.session.pct ? b : a,
            )
            return String(idlest.num)
          },
          mutates: async (call) => {
            await call('ack_incident', { id: 'inc-1' })
            return 'ok'
          },
        },
      )
      expect(report.correct).toBe(0)
      expect(report.tasks[0].actual).toBe('4')
      expect(report.tasks[1].error).toContain('read-only')
      expect(report.mutationsRefused).toEqual(['tool ack_incident'])
    },
    SPAWN_TIMEOUT_MS,
  )

  test('a question with no reference solution is refused, not silently skipped', async () => {
    await expect(
      runReferenceEval([{ id: 'unsolved', question: 'q', answer: 'a' }], REFERENCE),
    ).rejects.toThrow('no reference solution for: unsolved')
  })
})

describe('scoring an agent answers file', () => {
  test('answers compare loosely, a missing answer is wrong, and feedback is kept', () => {
    const pairs = loadQaPairs()
    const report = scoreAnswers(pairs, [
      { id: 'most-weekly-headroom', answer: '#2', toolCalls: 1, feedback: 'list_usage was enough' },
      { id: 'instance-4-email', answer: ' "Batch@Example.com." ' },
      { id: 'codex-instance-number', answer: '4' },
    ])
    const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t]))
    expect(byId['most-weekly-headroom'].correct).toBe(true)
    expect(byId['most-weekly-headroom'].feedback).toBe('list_usage was enough')
    expect(byId['instance-4-email'].correct).toBe(true)
    expect(byId['codex-instance-number'].correct).toBe(false)
    expect(byId['open-incident-count'].error).toBe('not answered')
    expect(report.correct).toBe(2)
    expect(report.total).toBe(pairs.length)
  })
})
