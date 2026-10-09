// server/tests/orchestrator-restart-guard.test.ts: a restart waits for a chat move.
//
// WHY (2026-10-08): a peer session restarted the daemon 23 minutes into a 9-chat migrate_batch.
// The batch died with the daemon, two chats were left on their new account and still unarchived on
// the old one, and seven were never tried. /api/daemon/restart asks moveRestartRefusal before it
// relaunches; these pin what it refuses and what it lets through.
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  moveRestartRefusal,
  resetOrchestratorOperationsForTests,
  runOrchestrator,
} from '../src/orchestrator'

const ROOT = mkdtempSync(join(tmpdir(), 'orch-restart-root-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function fakeOrchestratorDir(): string {
  const dir = mkdtempSync(join(ROOT, 'orch-restart-'))
  writeFileSync(join(dir, 'orch.py'), '# stub\n')
  return dir
}

const never = () => new Promise<never>(() => {})

// The held runs below never settle, so the locks must be handed back here (see orchestrator-stale-lock).
afterEach(() => resetOrchestratorOperationsForTests())

test('a running move refuses a restart, names itself and the repair, and force restarts past it', async () => {
  void runOrchestrator(
    { script: 'migrate_batch', timeoutMs: 600_000 },
    { dir: fakeOrchestratorDir(), spawn: never },
  )
  await Bun.sleep(10)

  const why = moveRestartRefusal(false)
  expect(why).toContain('migrate_batch')
  expect(why).toContain('migrate_reconcile --finish')
  expect(moveRestartRefusal(true)).toBeNull()
})

test('a toolbox run that moves nothing does not hold a restart', async () => {
  void runOrchestrator(
    { script: 'chats', timeoutMs: 600_000 },
    { dir: fakeOrchestratorDir(), spawn: never },
  )
  await Bun.sleep(10)

  expect(moveRestartRefusal(false)).toBeNull()
})
