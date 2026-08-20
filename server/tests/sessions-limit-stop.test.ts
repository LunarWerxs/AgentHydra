// server/tests/sessions-limit-stop.test.ts — "show me the chats a usage limit killed", end to end.
//
// The feature is one filter, but the thing that can go wrong is not the filter — it is the CACHE
// underneath it. Every scan is persisted and trusted on mtime+size alone, so the moment the scanner
// learned to record a usage-wall verdict, every row already in the cache became a row that answers
// "did this hit a wall?" with NULL forever. A NULL there does not read as "unknown", it reads as
// "no" — the filter would quietly return an empty list on a machine with dozens of stopped
// sessions, and nothing would look broken. SCAN_VERSION exists for exactly that, and the last two
// tests here are the ones that prove it works.
//
// Everything runs in a child Bun with its own HOME for the same reason sessions-scan-cache.test.ts
// does: config.ts resolves the store and the database from homedir() at import time, and `bun test`
// shares one process across files, so an in-process env override would lose the race and point
// these assertions at the developer's real ~/.claude.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `ccmui-limitstop-${crypto.randomUUID()}`)
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
}
const SESSIONS = JSON.stringify(join(import.meta.dir, '..', 'src', 'sessions.ts'))
const DB = JSON.stringify(join(import.meta.dir, '..', 'src', 'db.ts'))

// Same allowance and the same reasoning as sessions-scan-cache.test.ts: every test here spawns at
// least one child Bun that imports sessions.ts from source and opens a fresh SQLite file. Nothing
// below is a timing assertion, so a generous ceiling costs a green run nothing.
const SPAWNS_A_CHILD_BUN = 30_000

function child<T>(body: string): T {
  const proc = Bun.spawnSync([process.execPath, '-e', body], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  return JSON.parse(out.slice(out.lastIndexOf('\n') + 1)) as T
}

const NOTICE = "You've hit your weekly limit · resets 3am (America/Chicago)"

const turn = (role: 'user' | 'assistant', text: string, ts: string) =>
  `${JSON.stringify({ type: role, message: { role, content: text }, cwd: 'D:\\demo', timestamp: ts })}\n`

/** The record Claude Code writes when the CLI itself reports the wall. */
const wallTurn = (ts: string) =>
  `${JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    timestamp: ts,
    cwd: 'D:\\demo',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: NOTICE }] },
  })}\n`

function write(sessionId: string, body: string): string {
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, body)
  return path
}

/** listSessions() in a cold process, reduced to id + the fields under test. */
function list(scope: 'all' | 'only' | 'pending'): Array<Record<string, unknown>> {
  return child(`const { listSessions } = await import(${SESSIONS});
    const rows = await listSessions({ limit: 50, sinceMs: null, rateLimited: ${JSON.stringify(scope)} });
    console.log(JSON.stringify(rows.map((r) => ({ id: r.session_id, stop: r.limit_stop, src: r.title_source }))));`)
}

// Three sessions, one of each kind, written once and shared by every test below.
const STOPPED = 'bbbbbbbb-0000-4000-8000-000000000001'
const RESUMED = 'bbbbbbbb-0000-4000-8000-000000000002'
const CLEAN = 'bbbbbbbb-0000-4000-8000-000000000003'
const stoppedPath = write(
  STOPPED,
  turn('user', 'run the migration', '2026-08-19T04:00:00.000Z') +
    wallTurn('2026-08-19T04:10:00.000Z'),
)
write(
  RESUMED,
  turn('user', 'run the other migration', '2026-08-19T05:00:00.000Z') +
    wallTurn('2026-08-19T05:10:00.000Z') +
    turn('user', 'carry on', '2026-08-19T09:00:00.000Z') +
    turn('assistant', 'finished it', '2026-08-19T09:00:05.000Z'),
)
write(
  CLEAN,
  // Quotes the notice in ORDINARY prose. This is the false-positive class the detector is shaped
  // around: a conversation that merely talks about limits must not be listed as stopped by one.
  turn('user', `what does "${NOTICE}" mean?`, '2026-08-19T06:00:00.000Z') +
    turn('assistant', 'It means your weekly quota is spent.', '2026-08-19T06:00:05.000Z'),
)

test(
  'every session is listed by default, and each carries its own verdict',
  () => {
    const rows = list('all')
    const by = Object.fromEntries(rows.map((r) => [r.id as string, r]))
    expect(by[STOPPED]?.stop).toEqual({
      notice: NOTICE,
      pending: true,
      at: Date.parse('2026-08-19T04:10:00.000Z'),
    })
    expect(by[RESUMED]?.stop).toMatchObject({ notice: NOTICE, pending: false })
    // The one that only DISCUSSED a limit gets no verdict at all.
    expect(by[CLEAN]?.stop).toBeNull()
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  '"only" narrows to the sessions a wall actually stopped',
  () => {
    const ids = list('only').map((r) => r.id)
    expect(ids).toContain(STOPPED)
    expect(ids).toContain(RESUMED)
    expect(ids).not.toContain(CLEAN)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  '"pending" narrows again to the ones still sitting at the wall',
  () => {
    // The actionable half. A session that hit a limit in March and was finished in April is history;
    // one whose transcript ENDS at the notice is work waiting to be picked back up.
    const ids = list('pending').map((r) => r.id)
    expect(ids).toEqual([STOPPED])
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'the verdict is persisted, so a cold process does not re-read the transcript to know it',
  () => {
    const row = child<{ limit_notice: string; limit_pending: number; scan_version: number } | null>(
      `const { db } = await import(${DB});
       console.log(JSON.stringify(db.query('select limit_notice, limit_pending, scan_version from session_scan_cache where cache_key = ?').get(${JSON.stringify(`claude:${STOPPED}:${stoppedPath}`)}) ?? null));`,
    )
    expect(row?.limit_notice).toBe(NOTICE)
    expect(row?.limit_pending).toBe(1)
    expect(row?.scan_version).toBeGreaterThanOrEqual(2)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a row left behind by an older scanner is re-parsed, not believed',
  () => {
    // THE regression this feature could ship with and nobody would notice. Simulate the upgrade
    // path exactly: an existing cache row for an unchanged file, written before the scanner knew
    // what a usage wall was — right mtime, right size, and NULL where the verdict belongs.
    child(`const { db } = await import(${DB});
      db.query('update session_scan_cache set limit_notice = null, limit_pending = null, limit_at = null, scan_version = 1 where cache_key = ?')
        .run(${JSON.stringify(`claude:${STOPPED}:${stoppedPath}`)});
      console.log('null');`)

    // Without the version gate this returns [] — the filter would report a clean machine while a
    // stopped session sat right there, and the empty list would look like good news.
    expect(list('pending').map((r) => r.id)).toEqual([STOPPED])

    // And the re-parse writes the row back at the current version rather than re-doing it forever.
    const row = child<{ limit_notice: string; scan_version: number } | null>(
      `const { db } = await import(${DB});
       console.log(JSON.stringify(db.query('select limit_notice, scan_version from session_scan_cache where cache_key = ?').get(${JSON.stringify(`claude:${STOPPED}:${stoppedPath}`)}) ?? null));`,
    )
    expect(row?.limit_notice).toBe(NOTICE)
    expect(row?.scan_version).toBeGreaterThanOrEqual(2)
  },
  SPAWNS_A_CHILD_BUN,
)

test(
  'a title says where it came from',
  () => {
    // Every one of these fixtures is titled from its first message, which is the ordinary case.
    // The interesting one (an envelope name) is unit-tested in tests/session-title.test.ts; what
    // matters here is that the provenance survives the scan cache round trip at all.
    for (const r of list('all')) expect(r.src).toBe('message')
  },
  SPAWNS_A_CHILD_BUN,
)
