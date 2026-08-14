import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
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
