// When CliMayte asks a session to hand off for its conversation's size (climayte-lib.ts).
import { describe, expect, test } from 'bun:test'
import { contextTokens, notConverging, pickAccount, windDownAt } from '../src/climayte-lib'

const now = Date.now()
const reading = (sessionPct: number) => ({
  sessionPct,
  sessionResetsAt: now + 3_600_000,
  weekPct: 10,
  weekResetsAt: null,
  overageAllowed: false,
  at: now - 5_000,
})

describe('a handoff on conversation size', () => {
  test('an account with room hands off once the conversation passes the line, not before', () => {
    // The line is 200k: below it a fresh session's cold start costs more than its smaller reads save.
    expect(windDownAt(reading(10), null, now, 210_000)).toEqual({
      reason: 'context',
      tokens: 210_000,
    })
    expect(windDownAt(reading(10), null, now, 160_000)).toBeNull()
    expect(windDownAt(reading(10), null, now, null)).toBeNull()
    // At its stop line the account is the reason: the next session must start somewhere else.
    expect(windDownAt(reading(85), null, now, 210_000)).toMatchObject({ reason: 'usage', pct: 85 })
  })

  test("the size is the newest main-agent request's, never a subagent's", () => {
    const request = (read: number, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 900,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: 2_000,
        },
      },
    })
    const events = [
      request(90_000),
      request(149_000),
      { type: 'user', message: { content: [] } },
      request(12_000, 'toolu_sub'),
    ]
    // 10 input + 149,000 read + 2,000 written; the output is not part of what it read.
    expect(contextTokens(events)).toBe(151_010)
    expect(contextTokens([{ type: 'system', subtype: 'init' }])).toBeNull()
  })

  test('does not count towards the handoff cap that stops a task going in circles', () => {
    // A long task hands off every 200k: three of those are the plan, not a failure to converge.
    const at = (windDown: { reason?: 'context' }) =>
      ({ account: { id: 'a', num: 1, name: 'a' }, outcome: 'handoff', windDown }) as any
    const w = (attempts: unknown[]) =>
      ({ attempts, model: 'claude-opus-5-5', size: { expected: 10 } }) as any
    const context = { reason: 'context' as const }
    expect(notConverging(w([at(context), at(context), at(context)]))).toBeNull()
    expect(notConverging(w([at(context), at({}), at({}), at({})]))).toMatch(/3 handoffs/)
  })

  test('its next session may start on another account without counting as a move', () => {
    const at = (id: string, outcome: string, windDown?: { reason?: 'context' }) =>
      ({ account: { id, num: 1, name: id }, outcome, windDown }) as any
    const w = (attempts: unknown[]) =>
      ({ attempts, model: 'claude-opus-5-5', size: { expected: 10 } }) as any
    const context = { reason: 'context' as const }
    // Four account changes, each a fresh session after a size handoff: the task is converging.
    const long = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'handoff', context))
    expect(notConverging(w(long))).toBeNull()
    // The same four changes after a limit are the five-minute rule moving it (owner, 2026-10-03), not
    // a move that counts; after a transient failure they are a task bouncing between accounts.
    const limits = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'quota'))
    expect(notConverging(w(limits))).toBeNull()
    const bouncing = ['a', 'b', 'a', 'b', 'a'].map((id) => at(id, 'transient'))
    expect(notConverging(w(bouncing))).toMatch(/4 moves/)
  })

  test('its next session is not pushed off the account it left', () => {
    const acct = (id: string, num: number, sessionPct: number) => ({
      id,
      num,
      name: id,
      configDir: id,
      sessionPct,
      weekPct: 10,
    })
    const accounts = [acct('a', 1, 30), acct('b', 2, 60)]
    const after = (windDown: { reason?: 'context' }) =>
      ({
        accounts: null,
        accountId: 'a',
        attempts: [{ account: { id: 'a', num: 1, name: 'a' }, outcome: 'handoff', windDown }],
      }) as any
    // The account's usage did not ask for it, so the account with the most room is still 'a'.
    expect(pickAccount(after({ reason: 'context' }), accounts, {}, new Map(), 2, now)?.id).toBe('a')
    // A handoff for the account's usage still starts the next session somewhere else.
    expect(pickAccount(after({}), accounts, {}, new Map(), 2, now)?.id).toBe('b')
  })
})
