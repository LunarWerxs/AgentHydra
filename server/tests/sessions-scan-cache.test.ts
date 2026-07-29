// server/tests/sessions-scan-cache.test.ts — the sessions list must not re-read the world.
//
// Guards the two halves of a real regression (measured on a store of ~1,100 transcripts): one cold
// `GET /api/sessions` took 4.6 s and pushed the daemon from 101 MB to 3.1 GB resident, because
// listSessions opened up to 200 transcripts AT ONCE (Promise.all over the whole batch, each holding
// a 12 MB tail) and because the parse cache was in-memory only, so every restart paid it again.
//
// Three properties are therefore load-bearing and tested here:
//   1. the parse is persisted, stamped with the exact file revision it describes;
//   2. a COLD process reuses that row instead of re-reading the transcript — but never once the
//      transcript has grown;
//   3. the scan pool has a real ceiling.
//
// Everything runs in a child Bun with its own HOME, because config.ts resolves the transcript store
// and the database from homedir() at import time and `bun test` shares one process across test
// files — so an in-process env override would lose the race to whichever file imported config first
// and silently point these assertions at the developer's own ~/.claude.
import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `ccmui-scan-${crypto.randomUUID()}`)
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })
// Codex/OpenCode roots are globbed unconditionally by listTranscriptFiles; give them somewhere real
// to find nothing, so these tests are about the Claude path only.
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  CCMANAGERUI_HOME: join(home, '.ccmanagerui'),
  CCMANAGERUI_DB: join(home, 'test.db'),
  CCMANAGERUI_RUN_LOG_DIR: join(home, 'run-logs'),
}
const SESSIONS = JSON.stringify(join(import.meta.dir, '..', 'src', 'sessions.ts'))
const DB = JSON.stringify(join(import.meta.dir, '..', 'src', 'db.ts'))

/** Run a snippet in a fresh Bun against the throwaway home, and parse whatever it prints. */
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

/** listSessions() in a cold process, reduced to the one row we care about. */
function listOne(id: string): Record<string, unknown> | null {
  return child(`const { listSessions } = await import(${SESSIONS});
    const s = (await listSessions(50)).find((x) => x.session_id === ${JSON.stringify(id)});
    console.log(JSON.stringify(s ?? null));`)
}

function turn(role: 'user' | 'assistant', text: string, ts: string): string {
  return `${JSON.stringify({ type: role, message: { role, content: text }, cwd: 'D:\\demo', timestamp: ts })}\n`
}

function write(sessionId: string, body: string): string {
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, body)
  return path
}

test('a transcript is parsed into a scan-cache row stamped with its exact revision', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000001'
  const path = write(
    id,
    turn('user', 'first question', '2026-07-28T10:00:00.000Z') +
      turn('assistant', 'first answer', '2026-07-28T10:00:01.000Z'),
  )

  const listed = listOne(id)
  expect(listed?.title).toBe('first question')
  expect(listed?.last_text_preview).toBe('first answer')
  expect(listed?.message_count).toBe(2)

  // mtime+size are the only thing standing between a restarted daemon and a stale title.
  const st = statSync(path)
  const row = child<{ title: string; mtime_ms: number; size_bytes: number } | null>(
    `const { db } = await import(${DB});
     console.log(JSON.stringify(db.query('select title, mtime_ms, size_bytes from session_scan_cache where cache_key = ?').get(${JSON.stringify(`claude:${id}:${path}`)}) ?? null));`,
  )
  expect(row?.title).toBe('first question')
  expect(row?.mtime_ms).toBe(st.mtimeMs)
  expect(row?.size_bytes).toBe(st.size)
})

test('a cold process serves the cached parse instead of re-reading the transcript', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000002'
  const path = write(id, turn('user', 'cache me', '2026-07-28T11:00:00.000Z'))
  expect(listOne(id)?.title).toBe('cache me')

  // Plant a title no parse could ever produce. A fresh process has an empty in-memory cache, so
  // reading it back proves the persisted row — not the file — answered.
  child(`const { db } = await import(${DB});
    db.query('update session_scan_cache set title = ? where cache_key = ?')
      .run('planted-by-the-test', ${JSON.stringify(`claude:${id}:${path}`)});
    console.log('null');`)
  expect(listOne(id)?.title).toBe('planted-by-the-test')

  // ...and that the planted row is dropped the moment the transcript grows.
  appendFileSync(path, turn('assistant', 'a brand new reply', '2026-07-28T11:00:05.000Z'))
  const after = listOne(id)
  expect(after?.title).toBe('cache me')
  expect(after?.last_text_preview).toBe('a brand new reply')
  expect(after?.message_count).toBe(2)
})

test('a transcript with no substantive turn stays out of the list', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000003'
  write(id, `${JSON.stringify({ type: 'summary', summary: 'scaffolding only' })}\n`)
  expect(listOne(id)).toBeNull()
})

test('the scan pool never runs more than its ceiling at once, and keeps input order', () => {
  const result = child<{ ceiling: number; peak: number; ordered: boolean }>(
    `const { mapPooled, SCAN_CONCURRENCY } = await import(${SESSIONS});
     let live = 0, peak = 0;
     const items = Array.from({ length: 200 }, (_, i) => i);
     const out = await mapPooled(items, 4, async (i) => {
       live++; peak = Math.max(peak, live);
       await Bun.sleep(1);
       live--; return i * 2;
     });
     console.log(JSON.stringify({
       ceiling: SCAN_CONCURRENCY,
       peak,
       ordered: out.every((v, i) => v === i * 2),
     }));`,
  )
  expect(result.peak).toBeLessThanOrEqual(4)
  expect(result.ordered).toBe(true)
  // The whole point of the pool: a finite, small ceiling. 200-at-once is what cost 3 GB.
  expect(result.ceiling).toBeGreaterThan(0)
  expect(result.ceiling).toBeLessThan(64)
})
