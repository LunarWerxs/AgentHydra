// server/tests/codex-orchestration.test.ts — the OTHER agent this machine runs.
//
// AgentHydra is a unified codebase manager, and the orchestrator watched exactly one of the two
// agents, so a Codex thread that stopped mid-work was invisible to the machinery that babysits
// every Claude chat. These pin the classification (the feed is consumed by an AI that acts on
// it) and, just as importantly, the LIMIT: Codex exposes no message channel, so every item must
// say so rather than inviting a nudge that would go nowhere.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listRecentCodexThreads,
  parseCodexTail,
  readCodexCwd,
} from '../src/codex-orchestration'

const line = (o: unknown) => JSON.stringify(o)
const ev = (type: string, extra: Record<string, unknown> = {}) =>
  line({ timestamp: '2026-08-26T12:00:00.000Z', type: 'event_msg', payload: { type, ...extra } })

test('a finished Codex turn reads as complete, and its recap is captured', () => {
  const raw = [
    ev('task_started'),
    ev('agent_message', { message: '## What I did\n- shipped the parser\n## Am I 100% done?\n- yes' }),
    ev('task_complete'),
    // token_count records land AFTER the real events and are pure bookkeeping; reading one as
    // "the newest thing that happened" would make every finished thread look mid-turn.
    ev('token_count', { total: 1234 }),
  ].join('\n')
  const t = parseCodexTail(raw)
  expect(t.unreadable).toBe(false)
  expect(t.ending).toBe('complete')
  expect(t.recapDetected).toBe(true)
  expect(t.lastAgentText).toContain('shipped the parser')
})

test('an interrupted Codex turn is interrupted, not merely finished', () => {
  // The human pressed stop. Same distinction the Claude side draws, and for the same reason:
  // an interrupted thread must never be auto-resumed.
  const raw = [ev('agent_message', { message: 'working' }), ev('turn_aborted', { reason: 'interrupted' })].join('\n')
  expect(parseCodexTail(raw).ending).toBe('interrupted')
  // Aborted for any OTHER reason is a completed turn, not a human stop.
  const other = [ev('turn_aborted', { reason: 'replaced' })].join('\n')
  expect(parseCodexTail(other).ending).toBe('complete')
})

test('a thread whose newest event is neither completion nor abort is mid-turn', () => {
  const raw = [ev('task_started'), ev('agent_reasoning'), ev('patch_apply_end')].join('\n')
  expect(parseCodexTail(raw).ending).toBe('mid-turn')
})

test('a rollout with nothing parseable says unreadable rather than guessing', () => {
  expect(parseCodexTail('garbage\nmore garbage').unreadable).toBe(true)
  // Bookkeeping alone is not evidence of anything either.
  expect(parseCodexTail(ev('token_count', { total: 1 })).unreadable).toBe(true)
})

test('the store scan finds recent rollouts, reads their cwd, and skips stale ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthydra-codex-'))
  const day = join(home, 'sessions', '2026', '08', '26')
  mkdirSync(day, { recursive: true })
  const id = '019ffc6a-16ea-7703-84d5-557fb1855f22'
  const path = join(day, `rollout-2026-08-26T13-37-21-${id}.jsonl`)
  writeFileSync(
    path,
    [
      line({
        timestamp: '2026-08-26T13:37:21.000Z',
        type: 'session_meta',
        payload: { id, cwd: 'D:\\NEWProjects\\shared\\Connections' },
      }),
      ev('task_complete'),
    ].join('\n'),
  )
  // A directory that is not a date component must not be walked into.
  mkdirSync(join(home, 'sessions', 'notayear'), { recursive: true })

  const found = listRecentCodexThreads(Date.now(), home)
  expect(found).toHaveLength(1)
  expect(found[0].sessionId).toBe(id)
  expect(found[0].cwd).toBe('D:\\NEWProjects\\shared\\Connections')
  expect(readCodexCwd(path)).toBe('D:\\NEWProjects\\shared\\Connections')

  // Far in the future = every rollout is older than the window, so nothing is recent.
  expect(listRecentCodexThreads(Date.now() + 90 * 24 * 3600 * 1000, home)).toHaveLength(0)
  // A store that does not exist is empty, never an exception.
  expect(listRecentCodexThreads(Date.now(), join(home, 'nope'))).toHaveLength(0)
})

test('readCodexCwd refuses to guess when the first record is not session_meta', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthydra-codex-meta-'))
  const p = join(home, 'rollout-x.jsonl')
  writeFileSync(p, [ev('task_complete'), ev('agent_message', { message: 'hi' })].join('\n'))
  expect(readCodexCwd(p)).toBe(null)
})
