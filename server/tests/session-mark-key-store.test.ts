// server/tests/session-mark-key-store.test.ts — audit AH-35 follow-up.
//
// sessionMarkKey used to key a non-claude done-mark on TOOL alone once it differed from source,
// which is enough to tell apart two PRODUCTS of one format (Kilo vs MiMo Code) but not two STORES
// of the same product: two Hermes profiles both report `tool: 'hermes'` yet are separate `state.db`
// files. Marking one profile's session "done" used to also mark the other profile's session under
// the same id. sessionMarkKey now keys on the locator's storeKey (session-locator.ts's
// storeKeyOf) instead, and legacyMarkKey preserves read access to marks written before this fix.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import { getSession, legacyMarkKey, sessionMarkKey } from '../src/sessions'
import { listTranscriptFiles } from '../src/transcript'

function writeMark(key: string, done: boolean): void {
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) ' +
      'on conflict(session_id) do update set done = ?, updated_at = ?',
  ).run(key, done ? 1 : 0, Date.now(), done ? 1 : 0, Date.now())
}

function readMark(key: string): boolean {
  const row = db
    .query<{ done: number }, [string]>('select done from session_marks where session_id = ?')
    .get(key)
  return !!row?.done
}

test('two Hermes profiles sharing a session id get distinct mark keys, and marking one does not mark the other', () => {
  const sid = `ses_${crypto.randomUUID()}`
  const profileA = { tool: 'hermes', path: 'C:/hermes/profiles/a/state.db' }
  const profileB = { tool: 'hermes', path: 'C:/hermes/profiles/b/state.db' }
  const keyA = sessionMarkKey('hermes', sid, profileA)
  const keyB = sessionMarkKey('hermes', sid, profileB)
  expect(keyA).not.toBe(keyB)

  writeMark(keyA, true)
  try {
    expect(readMark(keyA)).toBe(true)
    // The other profile's own key was never written, so it must not read as done.
    expect(readMark(keyB)).toBe(false)
  } finally {
    db.query('delete from session_marks where session_id in (?, ?)').run(keyA, keyB)
  }
})

test('a file-backed format (claude/codex/foreign) keeps its old key shape exactly', () => {
  // storeKeyOf reduces to the tool id (or source) for file-backed formats, so this change is a
  // no-op for them: the produced key is byte-for-byte what sessionMarkKey always returned.
  const sid = `ses_${crypto.randomUUID()}`
  expect(sessionMarkKey('foreign', sid, { tool: 'zed', path: '/anything' })).toBe(
    `foreign:zed:${sid}`,
  )
  expect(legacyMarkKey('foreign', sid, 'zed')).toBe(`foreign:zed:${sid}`)
})

test('an OpenCode-format store now keys on its database path, not just tool (audit AH-35 follow-up)', () => {
  // opencode is db-backed, so storeKeyOf resolves to the path even when the tool (Kilo) already
  // differs from the source — two Kilo installs pointed at different databases must not share a
  // mark. The pre-fix shape (tool only) is preserved by legacyMarkKey for the read-time fallback.
  const sid = `ses_${crypto.randomUUID()}`
  const path = 'C:/kilo/opencode.db'
  expect(sessionMarkKey('opencode', sid, { tool: 'kilo', path })).toBe(`opencode:${path}:${sid}`)
  expect(legacyMarkKey('opencode', sid, 'kilo')).toBe(`opencode:kilo:${sid}`)
})

test('a mark set under the old tool-only key is still found via the legacy fallback', () => {
  const sid = `ses_${crypto.randomUUID()}`
  const tf = { tool: 'hermes', path: 'C:/hermes/profiles/a/state.db' }
  // Pre-fix, a Hermes mark had no path component at all: tool === source collapses to the bare
  // source:id form, exactly what a mark written before this change looks like on disk today.
  const oldKey = legacyMarkKey('hermes', sid, tf.tool)
  expect(oldKey).toBe(`hermes:${sid}`)
  const newKey = sessionMarkKey('hermes', sid, tf)
  expect(newKey).not.toBe(oldKey)

  writeMark(oldKey, true)
  try {
    // The read sites in sessions.ts check the new key first, then fall back to the old one — do
    // not lose a mark set before this fix just because it now computes a different key.
    const found = readMark(newKey) || readMark(legacyMarkKey('hermes', sid, tf.tool))
    expect(found).toBe(true)
  } finally {
    db.query('delete from session_marks where session_id = ?').run(oldKey)
  }
})

test('a caller with no resolved row falls back to the plain source:id key, unchanged', () => {
  const sid = `ses_${crypto.randomUUID()}`
  expect(sessionMarkKey('hermes', sid)).toBe(`hermes:${sid}`)
  expect(sessionMarkKey('claude', sid)).toBe(sid)
  expect(sessionMarkKey('claude', sid, { tool: 'claude-code', path: '/x.jsonl' })).toBe(sid)
})

// Regression (2026-10-03): when HSwarm replaced ZSwarm, each swarm job row's tool id was renamed
// from `zswarm` to `hswarm`, which moved its mark key from `zswarm:<id>` to `zswarm:hswarm:<id>`
// (the legacy read built the same new key), so a job a person had marked done read as not done.
// The row keeps tool `zswarm` (transcript.ts hswarmRow). Read through getSession, the same index
// row and mark lookup the Sessions view uses, on a scratch HSWARM_HOME holding one real job.json.
test('a swarm job marked done under its zswarm:<id> key still reads as done', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-swarm-mark-'))
  const jobId = `swarm-mark-${crypto.randomUUID().slice(0, 8)}`
  mkdirSync(join(home, 'jobs', jobId), { recursive: true })
  writeFileSync(
    join(home, 'jobs', jobId, 'job.json'),
    JSON.stringify({
      summary: {
        job_id: jobId,
        label: 'mark-check',
        state: 'done',
        created: '2024-07-15T05:16:22+00:00',
        finished: '2024-07-15T05:16:25+00:00',
      },
      tasks: [{ id: 't', prompt: 'Say ok.', cwd: home }],
      results: {
        t: {
          id: 't',
          status: 'ok',
          answer: 'ok',
          started: '2024-07-15T05:16:22+00:00',
          finished: '2024-07-15T05:16:25+00:00',
        },
      },
    }),
  )
  const previousHome = process.env.HSWARM_HOME
  process.env.HSWARM_HOME = home
  // The key every swarm job's mark was written under before the rename.
  const key = `zswarm:${jobId}`
  writeMark(key, true)
  try {
    listTranscriptFiles(true)
    const session = await getSession(jobId, 'zswarm')
    expect(session).not.toBeNull()
    expect(session?.done).toBe(true)
  } finally {
    db.query('delete from session_marks where session_id = ?').run(key)
    if (previousHome === undefined) delete process.env.HSWARM_HOME
    else process.env.HSWARM_HOME = previousHome
    listTranscriptFiles(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)
