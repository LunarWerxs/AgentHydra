import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import {
  listOpenCodeSearchEvents,
  listOpenCodeSessions,
  readOpenCodeSession,
} from '../src/opencode-sessions'

// This fixture deliberately has NO parent_id column: it is the OpenCode (and Kilo) release one
// behind, and it must still list its sessions. Naming the column unconditionally threw into the
// listing's catch, which returns [] — reporting no sessions at all rather than no subagents.
test('OpenCode SQLite sessions are listed and rendered from message/part rows', () => {
  const path = join(CONFIG_DIR, `opencode-${crypto.randomUUID()}.db`)
  const db = new Database(path)
  db.exec(`
    create table session (
      id text primary key, project_id text, directory text, title text,
      time_created integer, time_updated integer, time_archived integer
    );
    create table message (
      id text primary key, session_id text, time_created integer, data text
    );
    create table part (
      id text primary key, message_id text, session_id text, time_created integer, data text
    );
  `)
  db.query('insert into session values (?, ?, ?, ?, ?, ?, ?)').run(
    'ses_test',
    'project-1',
    'D:\\work',
    'OpenCode test',
    1000,
    4000,
    null,
  )
  db.query('insert into message values (?, ?, ?, ?)').run(
    'msg_user',
    'ses_test',
    2000,
    JSON.stringify({ role: 'user', time: { created: 2000 } }),
  )
  db.query('insert into message values (?, ?, ?, ?)').run(
    'msg_assistant',
    'ses_test',
    3000,
    JSON.stringify({ role: 'assistant', time: { created: 3000, completed: 4000 } }),
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    'part_user',
    'msg_user',
    'ses_test',
    2000,
    JSON.stringify({ type: 'text', text: 'Please fix it.' }),
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    'part_assistant',
    'msg_assistant',
    'ses_test',
    3000,
    JSON.stringify({ type: 'text', text: 'Fixed.' }),
  )
  db.close()

  expect(listOpenCodeSessions(path)).toEqual([
    {
      session_id: 'ses_test',
      project: 'project-1',
      cwd: 'D:\\work',
      title: 'OpenCode test',
      created_at: 1000,
      last_activity_at: 4000,
      archived: false,
      size_bytes: expect.any(Number),
      parent_id: null,
    },
  ])
  const content = readOpenCodeSession('ses_test', path)
  expect(content?.messageCount).toBe(2)
  expect(content?.events.map((event) => [event.role, event.text])).toEqual([
    ['user', 'Please fix it.'],
    ['assistant', 'Fixed.'],
  ])
  expect(listOpenCodeSearchEvents(path).map((event) => event.text)).toEqual([
    'Please fix it.',
    'Fixed.',
  ])
})

test('a subagent session carries the id of the session that spawned it', () => {
  const path = join(CONFIG_DIR, `opencode-${crypto.randomUUID()}.db`)
  const db = new Database(path)
  db.exec(`
    create table session (
      id text primary key, project_id text, directory text, title text,
      time_created integer, time_updated integer, time_archived integer, parent_id text
    );
    create table message (
      id text primary key, session_id text, time_created integer, data text
    );
    create table part (
      id text primary key, message_id text, session_id text, time_created integer, data text
    );
  `)
  const insert = db.query('insert into session values (?, ?, ?, ?, ?, ?, ?, ?)')
  insert.run('ses_parent', 'p1', 'D:\\work', 'Review the engine', 1000, 4000, null, null)
  insert.run(
    'ses_child',
    'p1',
    'D:\\work',
    'Review runtime (@general subagent)',
    2000,
    3000,
    null,
    'ses_parent',
  )
  // An OpenCode old enough to write '' rather than NULL must not make this the child of a session
  // that does not exist.
  insert.run('ses_blank', 'p1', 'D:\\work', 'Blank parentage', 2000, 3000, null, '')
  db.close()

  const byId = new Map(listOpenCodeSessions(path).map((s) => [s.session_id, s]))
  expect(byId.get('ses_parent')?.parent_id).toBe(null)
  expect(byId.get('ses_child')?.parent_id).toBe('ses_parent')
  expect(byId.get('ses_blank')?.parent_id).toBe(null)
  // The child is still LISTED here. It is a real session with its own tokens, and the analytics scan
  // reads it by id; only the conversation list drops it. See withoutOwnedSubagents in sessions.ts.
  expect(byId.size).toBe(3)
})

/** A store with the OpenCode schema and one session in it, closed. */
function storeWithOneSession(): string {
  const path = join(CONFIG_DIR, `opencode-${crypto.randomUUID()}.db`)
  const db = new Database(path)
  db.exec(`
    create table session (
      id text primary key, project_id text, directory text, title text,
      time_created integer, time_updated integer, time_archived integer
    );
    create table message (
      id text primary key, session_id text, time_created integer, data text
    );
    create table part (
      id text primary key, message_id text, session_id text, time_created integer, data text
    );
  `)
  db.query('insert into session values (?, ?, ?, ?, ?, ?, ?)').run(
    'ses_one',
    'p1',
    'D:work',
    'First',
    1000,
    2000,
    null,
  )
  db.close()
  return path
}

/** Add a second session to a closed store, the way OpenCode would. */
function addSecondSession(path: string): void {
  const again = new Database(path)
  again
    .query('insert into session values (?, ?, ?, ?, ?, ?, ?)')
    .run('ses_two', 'p1', 'D:work', 'Second', 3000, 4000, null)
  again.close()
}

/**
 * Put the store's last-write time at an instant the test chose, on the database and on its `-wal`.
 *
 * Every question the listing cache asks is about (mtime, size), and a filesystem issues mtimes from
 * a clock far coarser than its field suggests: measured here, 200 back-to-back writes produced 13
 * distinct values. Left to the machine, the tests below would be asserting on whichever side of a
 * tick boundary a run happened to land — which is exactly how this file used to flake, roughly one
 * full-suite run in three. Naming the instant makes the distance between two stamps a number the
 * test set rather than one the scheduler did.
 */
function stampAt(path: string, when: Date): void {
  for (const p of [path, `${path}-wal`]) {
    try {
      utimesSync(p, when, when)
    } catch {
      // Usually no -wal at all: SQLite checkpoints and removes it on close, so between calls the
      // database alone carries the stamp.
    }
  }
}

// Sizing a session costs two correlated subqueries, so this listing walks the whole `message` and
// `part` tables once PER SESSION — the store sets the cost, not the session count. Measured at
// 939 ms for 110 sessions, and a whole-store sweep runs on a timer, so a database nobody has
// written to must not be re-queried. These pin that the shortcut is taken and that it lets go.
test('an unchanged OpenCode store is listed from the last query, and a written one is not', () => {
  const path = storeWithOneSession()

  // Let the store settle a minute into the past before anything reads it. Two things follow that
  // were previously left to chance: the listing is old enough to be remembered at all, and the
  // write below lands a full minute away from this stamp instead of trusting a tick to elapse.
  stampAt(path, new Date(Date.now() - 60_000))

  const first = listOpenCodeSessions(path)
  expect(first.map((s) => s.session_id)).toEqual(['ses_one'])

  // Re-listed with nothing touched: same answer, and the same ARRAY, which is what proves the
  // query did not run again rather than merely returning an equal result.
  expect(listOpenCodeSessions(path)).toBe(first)

  // A real write, and the mtime it really receives is what has to give it away. (Close checkpoints
  // the `-wal` away, so here the database alone carries the stamp; in production, where OpenCode
  // holds the store open with write-ahead logging on, the log is the half that moves.)
  addSecondSession(path)

  expect(
    listOpenCodeSessions(path)
      .map((s) => s.session_id)
      .sort(),
  ).toEqual(['ses_one', 'ses_two'])
})

// ...and the case the pair cannot see at all. A SQLite insert moves NEITHER half: the row fits in
// pages the file already had, so the byte count holds, and a filesystem hands a write that lands
// close behind the one we stamped the very same last-write time. Measured on this machine, a
// session added to a just-read store moved nothing at all in 10% of attempts.
//
// A missed sweep would be survivable if the stamp caught up later. It never does — nothing bumps an
// mtime that is already written — so a list remembered across that collision is stale for good, and
// the session stays invisible until some unrelated write happens to move the file. For a
// conversation nobody returns to, that is forever. The cache therefore may not remember an answer
// it read before the store's stamp had settled, which is what this pins.
test('a write that cannot move the stamp is still not lost to the cache', () => {
  const path = storeWithOneSession()

  // Stamp the store ahead of the clock: that instant has not elapsed, so a write is still to come
  // that would be handed exactly this time. Same condition as a store written a tick ago, with the
  // window widened from milliseconds to a minute so no scheduling hiccup can decide the outcome.
  const unelapsed = new Date(Date.now() + 60_000)
  stampAt(path, unelapsed)
  const before = statSync(path)
  const hadWal = existsSync(`${path}-wal`)

  expect(listOpenCodeSessions(path).map((s) => s.session_id)).toEqual(['ses_one'])

  addSecondSession(path)
  // Put the stamp back exactly as the listing above saw it — which is all the tick collision does.
  stampAt(path, unelapsed)

  // The premise, asserted rather than assumed: with the mtimes restored, these are the only things
  // left that could give the write away. If a future SQLite ever grew the file or left a log
  // behind, the stamp would differ and the assertion below would pass without testing anything.
  expect(statSync(path).size).toBe(before.size)
  expect(existsSync(`${path}-wal`)).toBe(hadWal)

  expect(
    listOpenCodeSessions(path)
      .map((s) => s.session_id)
      .sort(),
  ).toEqual(['ses_one', 'ses_two'])
})
