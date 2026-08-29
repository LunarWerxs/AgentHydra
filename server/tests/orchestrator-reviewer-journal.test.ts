// server/tests/orchestrator-reviewer-journal.test.ts - the reviewer is a ROLE, not a chat.
//
// Measured twice on 2026-08-28: the reviewer loop died with its host chat (a phantom archive,
// then a process kill) and the fleet halted until a human typed /orchestrate. The journal + seed
// exist so revival means briefing ANY fresh chat from server state, never resurrecting the dead
// one. Pinned here: (1) the journal reflects a real resolve+verify round-trip - in flight with
// its saved verbatim step while delivered, gone once verified, the ruling on the ledger with the
// reviewer's note; (2) the seed prompt carries the in-flight item ids and the literal
// /orchestrate invocation a successor needs; (3) the no-reviewer feed line names the seed
// endpoint - and ONLY while actually stalled, per the cry-wolf rule.

import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/db'
import { instanceDirForLabel, invalidateSessionMetaCache } from '../src/instance-sessions'
import { addPendingRename, noteReviewerActivity, reviewerHealth } from '../src/orchestrator'
import { buildReviewerJournal, composeReviewerSeed } from '../src/orchestrator-reviewer-journal'
import { resolveWorkItem, verifyWorkItem } from '../src/orchestrator-worklist'
import { decideProposal, proposeAction, reportProposalExecuted } from '../src/proposals'

test('the journal reflects a resolve+verify round-trip', async () => {
  // A REAL rename round-trip through resolveWorkItem/verifyWorkItem, driven off store fixtures
  // alone (a rename touches no live registry and no transcript, so it is the one item kind a
  // test can carry end to end): resolve must leave the item in the journal's inFlight with its
  // saved verbatim step, verify must clear it.
  const dir = instanceDirForLabel('journal-t1')
  const store = join(dir, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const targetMeta = join(store, 'local_jr-target.json')
  writeFileSync(
    targetMeta,
    JSON.stringify({ cliSessionId: 'jr-target', isArchived: false, title: 'Old name' }),
  )
  writeFileSync(
    join(store, 'local_jr-rev.json'),
    JSON.stringify({ cliSessionId: 'jr-rev', isArchived: false, title: 'Reviewer' }),
  )
  addPendingRename(`desktop:${dir}`, 'jr-target', 'Journal proof')
  invalidateSessionMetaCache()

  const res = await resolveWorkItem({
    itemId: 'rename:jr-target',
    reviewerSessionId: 'jr-rev',
    decision: 'approve',
    note: 'prove the journal',
  })
  expect(res.ok).toBe(true)
  expect(res.reviewerSteps?.[0]?.tool).toBe('set_session_title')

  let j = buildReviewerJournal()
  const inFlight = j.inFlight.find((f) => f.itemId === 'rename:jr-target')
  expect(inFlight?.phase).toBe('renamed')
  expect(inFlight?.targetSessionId).toBe('jr-target')

  // The app "performed" the rename (metadata now carries the title); verify closes and clears.
  writeFileSync(
    targetMeta,
    JSON.stringify({ cliSessionId: 'jr-target', isArchived: false, title: 'Journal proof' }),
  )
  invalidateSessionMetaCache()
  const v = await verifyWorkItem('rename:jr-target')
  expect(v.state).toBe('verified')
  j = buildReviewerJournal()
  expect(j.inFlight.some((f) => f.itemId === 'rename:jr-target')).toBe(false)

  // The decision half, through the same ledger calls resolve (decideProposal) and verify
  // (reportProposalExecuted) make for proposal-backed items: the ruling lands in the journal
  // with the reviewer's note - the one thing only a reviewer produces - intact.
  const id = proposeAction({
    kind: 'revive',
    sessionId: 'jr-lineage',
    summary: 'died mid-work',
    evidence: {},
  })
  expect(id).toBeTruthy()
  decideProposal(id as string, true, 'jr-rev', 'lineage genuinely unfinished')
  reportProposalExecuted(id as string, true, 'delivered; engine verified by transcript movement')
  j = buildReviewerJournal()
  const d = j.decisions.find((x) => x.id === id)
  expect(d?.status).toBe('executed')
  expect(d?.decidedBy).toBe('jr-rev')
  expect(d?.note).toBe('lineage genuinely unfinished')
  expect(d?.result).toContain('transcript movement')

  db.query("delete from orchestrator_proposals where session_id = 'jr-lineage'").run()
  rmSync(dir, { recursive: true, force: true })
})

test('the seed prompt carries in-flight ids, standing context and the /orchestrate literal', () => {
  // A seed is only a revival tool if the successor can act from the text alone: the in-flight
  // item ids (verify these FIRST), the standing mode, and the exact loop invocation must all be
  // IN the prompt. The wl: row is written in the exact shape saveState persists (the read side
  // of that shape is what this test pins; the write side is pinned by the round-trip above).
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(
    'wl:seed-proof-1',
    JSON.stringify({
      phase: 'delivered',
      at: '2026-08-28T20:00:00.000Z',
      targetSessionId: 'seed-target-1',
      steps: [{ tool: 'SendMessage', args: { to: 'x', message: 'm' }, why: 'w' }],
    }),
    new Date().toISOString(),
  )
  const journal = buildReviewerJournal()
  const flight = journal.inFlight.find((f) => f.itemId === 'seed-proof-1')
  // The saved verbatim steps ride along - a successor re-issues, never reconstructs.
  expect(flight?.steps?.[0]?.args.to).toBe('x')
  const prompt = composeReviewerSeed(journal)
  expect(prompt.startsWith('[orchestrator]')).toBe(true)
  expect(prompt).toContain('/orchestrate')
  expect(prompt).toContain('seed-proof-1')
  expect(prompt).toContain('verify')
  expect(prompt).toContain(`workMode: ${journal.standing.workMode}`)
  db.query("delete from orchestrator_kv where key = 'wl:seed-proof-1'").run()
})

test('the stalled no-reviewer line names the seed endpoint - and only while stalled', () => {
  const now = Date.parse('2026-08-28T12:00:00Z')
  noteReviewerActivity(now - 8 * 3600 * 1000)
  const dead = reviewerHealth(now, 3)
  expect(dead.stalled).toBe(true)
  expect(dead.fix).toContain('/api/orchestrator/reviewer-seed')
  // A working reviewer, or an empty queue, must not carry the instruction: a fix line that is
  // always present stops being read - the same cry-wolf rule the health check itself lives by.
  noteReviewerActivity(now - 60_000)
  expect(reviewerHealth(now, 3).fix).toBeNull()
  expect(reviewerHealth(now, 0).fix).toBeNull()
})
