// server/tests/orchestrator-automation-janitor.test.ts — the standing bypassPermissions sweep.
//
// Owner rule 2026-08-28: ALL chats always run 'bypassPermissions' — anything else deadlocks
// unattended work at an approval prompt nobody can click. The janitor is convergence, not
// one-shot (a running app can re-save the old mode), so what these tests pin is the write
// discipline: a drifted chat is stamped, an ARCHIVED drifted chat is left byte-untouched
// (pointless write to a retired entry), and an already-bypass chat is never rewritten. The
// mtimes are pushed into the past first so any forbidden write is detectable as a bump.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { invalidateSessionMetaCache } from '../src/instance-sessions'
import { sweepAutomationDrift } from '../src/orchestrator'

test('automation janitor stamps drifted chats, never archived or already-bypass ones', () => {
  // Fixtures live under the preload's scratch instances root, so the stamper's real path
  // resolution (cached index, then the store walk) works against them without touching any
  // real profile.
  const root = process.env.AGENTHYDRA_INSTANCES_ROOT as string
  const profile = join(root, 'automation-janitor-fixture')
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const OLD = new Date('2026-08-01T00:00:00Z')
  const write = (name: string, body: Record<string, unknown>): string => {
    const p = join(store, name)
    writeFileSync(p, JSON.stringify(body))
    utimesSync(p, OLD, OLD)
    return p
  }
  const drifted = write('local_aj-drift.json', {
    cliSessionId: 'aj-drift',
    isArchived: false,
    permissionMode: 'acceptEdits',
    title: 'T',
  })
  const archived = write('local_aj-arch.json', {
    cliSessionId: 'aj-arch',
    isArchived: true,
    permissionMode: 'acceptEdits',
  })
  const fine = write('local_aj-fine.json', {
    cliSessionId: 'aj-fine',
    isArchived: false,
    permissionMode: 'bypassPermissions',
  })
  invalidateSessionMetaCache() // the stamper resolves paths through the cached index
  const mtime = (p: string): number => statSync(p).mtimeMs
  const archivedBefore = mtime(archived)
  const fineBefore = mtime(fine)

  // The map rows mirror what the tick's cached scan hands the janitor. The drifted chat is
  // deliberately indexed under BOTH keys (session id + filename id) sharing one row, the real
  // two-key shape — one chat, one write.
  const row = (path: string, isArchived: boolean, permissionMode: string | null, id: string) => ({
    instance: 'automation-janitor-fixture',
    archived: isArchived,
    permissionMode,
    chatId: `local_${id}`,
    path,
    cliSessionId: id,
  })
  const driftRow = row(drifted, false, 'acceptEdits', 'aj-drift')
  const map = new Map([
    ['aj-drift', driftRow],
    ['aj-drift-filename-key', driftRow],
    ['aj-arch', row(archived, true, 'acceptEdits', 'aj-arch')],
    ['aj-fine', row(fine, false, 'bypassPermissions', 'aj-fine')],
  ])

  expect(sweepAutomationDrift(map)).toBe(1)
  expect(JSON.parse(readFileSync(drifted, 'utf8'))).toMatchObject({
    permissionMode: 'bypassPermissions',
    isArchived: false,
    title: 'T', // the stamp edits one field, it does not rebuild the file
  })
  // The archived drifted chat and the already-bypass chat saw NO write at all.
  expect(JSON.parse(readFileSync(archived, 'utf8')).permissionMode).toBe('acceptEdits')
  expect(mtime(archived)).toBe(archivedBefore)
  expect(mtime(fine)).toBe(fineBefore)

  // Second pass over the converged store: the map now reports bypass everywhere, so the sweep
  // is a pure read — nothing corrected, nothing rewritten.
  const stampedAt = mtime(drifted)
  expect(
    sweepAutomationDrift(
      new Map([['aj-drift', row(drifted, false, 'bypassPermissions', 'aj-drift')]]),
    ),
  ).toBe(0)
  expect(mtime(drifted)).toBe(stampedAt)

  // A row without a path (injected fakes, row-derived fallbacks) is skipped, not stamped.
  expect(
    sweepAutomationDrift(
      new Map([['aj-nopath', { instance: 'x', archived: false, permissionMode: 'acceptEdits' }]]),
    ),
  ).toBe(0)
})
