// server/tests/orchestrator-operation-miss.test.ts — a miss must say WHY it missed (2026-09-12).
//
// ⛔ WHAT IT COST. A chat-migration batch was launched detached (the documented, RECOMMENDED way
// to run a batch, precisely so the report can be read later). The daemon restarted while it ran.
// The batch's child process outlived the restart and finished its work. Every poll of its id then
// answered a bare `no such operation`, and the recent-operations list came back EMPTY - while the
// MCP descriptions promised an unconditional hour and "nothing is gone". The only honest reading
// of that answer was that the run had never existed, so the per-chat verdicts had to be rebuilt
// from four other tools, and the tempting next move - re-firing a mutating batch - would have been
// the genuinely dangerous one.
//
// The registry stays in memory on purpose (it is reconciliation, not an audit log). What is fixed
// is that a miss now distinguishes "never existed" from "did not survive a restart", names when
// this daemon started, and tells the caller to read the durable ledger instead of re-acting.
import { expect, test } from 'bun:test'
import { getOrchestratorOperation, operationMissReason } from '../src/orchestrator'

test('a miss from a freshly started daemon is reported as a restart, not as a bad id', () => {
  // The registry's clock starts when the module loads, so a test process IS a young daemon.
  const miss = operationMissReason()
  expect(miss.ok).toBe(false)
  expect(miss.reason).toBe('daemon-restarted')
  expect(typeof miss.daemonStartedAt).toBe('number')
  expect(miss.daemonStartedAt).toBeLessThanOrEqual(Date.now())
})

test('the message names the start time, so a caller can compare it with its own run', () => {
  const miss = operationMissReason()
  expect(miss.error).toContain(new Date(miss.daemonStartedAt).toISOString())
  expect(miss.error).toContain('THIS DAEMON STARTED AT')
})

test('it forbids the dangerous move by name rather than leaving it open', () => {
  // Re-firing a mutating batch whose record vanished is the one thing a caller must not do.
  const miss = operationMissReason()
  expect(miss.error).toContain('Do NOT re-fire')
  expect(miss.error.toLowerCase()).toContain('ledger')
  expect(miss.error).toContain('may well have finished')
})

test('once the daemon is older than the retention window, a miss is an unknown id again', () => {
  // Past an hour a record could legitimately have been pruned, so 'restarted' would be a guess.
  const twoHoursOn = Date.now() + 2 * 60 * 60_000
  const miss = operationMissReason(twoHoursOn)
  expect(miss.reason).toBe('unknown-id')
  expect(miss.error).toContain('retention')
  expect(miss.error).not.toContain('Do NOT re-fire')
})

test('it reports how many records are held, so empty is not confused with pruned', () => {
  const miss = operationMissReason()
  expect(miss.held).toBe(0)
  expect(typeof miss.held).toBe('number')
})

test('a genuinely unknown id still returns null from the getter - the miss only explains it', () => {
  expect(getOrchestratorOperation('3f6b0c1e-0000-4000-8000-000000000000')).toBeNull()
})
