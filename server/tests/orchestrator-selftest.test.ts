// server/tests/orchestrator-selftest.test.ts — the self-test must be honest and harmless.
//
// A self-test is only worth having if a real failure turns it red, and only safe to run against
// a live fleet if it cannot touch anything real. Both properties are easy to lose silently: a
// check written as `expect(x || true)` passes forever, and a check that reaches for "the first
// desktop chat" would archive someone's work. So these pin the two things about the self-test
// that matter more than any individual check inside it.
import { expect, test } from 'bun:test'
import { db } from '../src/db'
import { runOrchestratorSelfTest } from '../src/orchestrator-selftest'

test('the self-test reports per-check results and a truthful summary', async () => {
  const report = await runOrchestratorSelfTest()
  expect(report.checks.length).toBeGreaterThan(5)
  expect(report.deep).toBe(false) // never touches the app unless deep is asked for
  // It must never imply it looked at a screen. Everything it checks is on disk, and the one
  // time this feature claimed more than it had verified, a chat sat dead in front of the owner
  // for five hours while being reported as running.
  expect(report.visualChecks).toBe(false)
  // The summary must be derived from the checks, not asserted independently: a report claiming
  // ok:true with a failed check in it is the exact lie this whole file guards against.
  expect(report.passed).toBe(report.checks.filter((c) => c.ok).length)
  expect(report.failed).toBe(report.checks.filter((c) => !c.ok).length)
  expect(report.ok).toBe(report.failed === 0)
  expect(report.passed + report.failed).toBe(report.checks.length)
  // Every check explains itself on PASS as well as fail — "how did it pass" is what tells you
  // whether it passed for the right reason.
  for (const c of report.checks) {
    expect(c.id.length).toBeGreaterThan(0)
    expect(c.what.length).toBeGreaterThan(0)
    expect(c.detail.length).toBeGreaterThan(0)
  }
  // No duplicate ids, or a run-to-run comparison silently compares the wrong pair.
  expect(new Set(report.checks.map((c) => c.id)).size).toBe(report.checks.length)
})

test('the checks that must never be vacuous actually assert something', async () => {
  const report = await runOrchestratorSelfTest()
  const byId = new Map(report.checks.map((c) => [c.id, c]))
  // These four are the ones that encode real bugs from the field. If any is missing, the
  // self-test has been quietly gutted.
  for (const id of [
    'residency-created-shape', // the 98.7%-blind lookup, in archive AND the guard
    'guard-allows-non-desktop', // the inverse, so the guard cannot just refuse everything
    'gate-refuses-undecided', // acting before the AI has ruled
    'automation-stamp', // the permission mode that freezes revived chats
    'screen-lag', // how much is on disk but possibly not yet on screen
  ]) {
    expect(byId.has(id)).toBe(true)
  }
  // The gate check must exercise BOTH directions, and its pass detail says which happened.
  expect(byId.get('gate-refuses-undecided')?.detail).toContain('refused')
})

test('the self-test leaves no sacrificial rows behind in the live tables', async () => {
  const before = db
    .query<{ n: number }, []>(
      "select count(*) as n from orchestrator_proposals where session_id like 'selftest-%'",
    )
    .get()?.n
  await runOrchestratorSelfTest()
  const after = db
    .query<{ n: number }, []>(
      "select count(*) as n from orchestrator_proposals where session_id like 'selftest-%'",
    )
    .get()?.n
  expect(after).toBe(before ?? 0)
  // And no sacrificial queue rows either — those would be dispatched by the scheduler later.
  const queued = db
    .query<{ n: number }, []>("select count(*) as n from queue_items where id like 'selftest-%'")
    .get()?.n
  expect(queued).toBe(0)
})
