// server/tests/desktop-import-delivery.test.ts — a finished run's delivery into the desktop app.
//
// The bug this pins: importing REFUSES a target instance that is not running, because firing the
// import URL at a closed instance would boot that account. That refusal is correct, but it used to
// be terminal — one console.error, and the finished work never appeared anywhere while the queue
// row still read 'completed'. A migrated run can finish hours after its target was picked (usually
// overnight, which is precisely when the app is shut), so "closed right then" silently lost the
// whole delivery. It now stays pending and lands when that app is next open.
import { expect, test } from 'bun:test'
import { db } from '../src/db'
import { attemptDesktopImport, deliverPendingImports } from '../src/dispatch'

function insertCompletedRun(
  id: string,
  opts: {
    importTo?: string | null
    importTitle?: string | null
    importState?: string | null
    finishedAt?: string | null
  } = {},
): void {
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at, import_to, import_title, import_state, finished_at)
     values (?, ?, 'Delivered run', 'D:\\demo', 'work', null, null, null, null, null, 0, 0, 'completed', 1, null, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `sess-${id}`,
    Date.now(),
    // `in`, not `??`: these fields are nullable and an explicit null is a case under test, which
    // `?? default` would silently turn back into the default.
    'importTo' in opts ? (opts.importTo ?? null) : 'desktop:c:\\i\\target',
    'importTitle' in opts ? (opts.importTitle ?? null) : 'Ship the parser',
    'importState' in opts ? (opts.importState ?? null) : 'pending',
    'finishedAt' in opts ? (opts.finishedAt ?? null) : new Date().toISOString(),
  )
}

function stateOf(id: string): { import_state: string | null; import_error: string | null } {
  return (
    db
      .query<{ import_state: string | null; import_error: string | null }, [string]>(
        'select import_state, import_error from queue_items where id = ?',
      )
      .get(id) ?? { import_state: null, import_error: null }
  )
}

test('a refused import stays pending instead of being lost', async () => {
  insertCompletedRun('imp-1')
  await attemptDesktopImport('imp-1', async () => ({
    ok: false,
    reason: 'instance-not-running: importing would boot that instance',
  }))
  const s = stateOf('imp-1')
  expect(s.import_state).toBe('pending')
  expect(s.import_error).toContain('instance-not-running')
})

test('the sweep delivers what an earlier attempt could not, with the real session and title', async () => {
  insertCompletedRun('imp-2', { importTitle: 'Ship the parser' })
  await attemptDesktopImport('imp-2', async () => ({ ok: false, reason: 'instance-not-running' }))
  expect(stateOf('imp-2').import_state).toBe('pending')

  // The instance is open now — which is the whole point: nobody had to re-trigger anything.
  const seen: { sessionId: string; instanceDir: string; title?: string | null }[] = []
  await deliverPendingImports(async (opts) => {
    seen.push(opts)
    return { ok: true, titled: true }
  })
  expect(stateOf('imp-2').import_state).toBe('done')
  expect(stateOf('imp-2').import_error).toBe(null)
  const mine = seen.find((s) => s.sessionId === 'sess-imp-2')
  expect(mine).toBeTruthy()
  // 'desktop:' is stripped: the importer takes a directory, not a ref.
  expect(mine?.instanceDir).toBe('c:\\i\\target')
  expect(mine?.title).toBe('Ship the parser')
})

test('a delivery that could not be TITLED is still delivered, with the caveat recorded', async () => {
  insertCompletedRun('imp-3')
  // The chat is in the app; only the metadata write missed. Re-firing the URL would not name it
  // any better, so this is done, not pending.
  await attemptDesktopImport('imp-3', async () => ({ ok: true, titled: false }))
  const s = stateOf('imp-3')
  expect(s.import_state).toBe('done')
  expect(s.import_error).toContain('title')
})

test('past the deadline it gives up, and says why rather than going quiet', async () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  insertCompletedRun('imp-4', { finishedAt: twoDaysAgo })
  await attemptDesktopImport('imp-4', async () => ({ ok: false, reason: 'instance-not-running' }))
  const s = stateOf('imp-4')
  expect(s.import_state).toBe('gave_up')
  expect(s.import_error).toContain('instance-not-running')
  // And a gave_up row is never picked up again: a sweep that would deliver anything it touched
  // leaves this one exactly as it was.
  await deliverPendingImports(async () => ({ ok: true }))
  expect(stateOf('imp-4').import_state).toBe('gave_up')
})

test('an importer that throws is a refusal, not a crashed sweep', async () => {
  insertCompletedRun('imp-5')
  await attemptDesktopImport('imp-5', async () => {
    throw new Error('spawn EACCES')
  })
  const s = stateOf('imp-5')
  expect(s.import_state).toBe('pending')
  expect(s.import_error).toContain('spawn EACCES')
})

test('rows with nothing to deliver are left alone', async () => {
  insertCompletedRun('imp-6', { importState: null })
  await attemptDesktopImport('imp-6', async () => ({ ok: true }))
  expect(stateOf('imp-6').import_state).toBe(null)

  // Armed but with no desktop target: give up rather than retry a nonsense ref forever.
  insertCompletedRun('imp-7', { importTo: 'cli:some-instance' })
  await attemptDesktopImport('imp-7', async () => ({ ok: true }))
  expect(stateOf('imp-7').import_state).toBe('gave_up')
})
