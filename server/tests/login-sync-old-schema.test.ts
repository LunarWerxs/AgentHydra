// server/tests/login-sync-old-schema.test.ts — the real login sync Worker opened on a database made
// before the changes feed (no rev column, no store_rev, no tombstones). The shared store of the other
// tests remembers its schema per module, so this one loads its own copy of the Worker over its own
// database and calls it directly.

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { clearCache, d1 } from './login-sync-store'

const token = 'old-schema-token'
const sqlite = new Database(':memory:')
for (const [table, key] of [
  ['logins', 'id'],
  ['queues', 'pc'],
  ['chats', 'id'],
])
  sqlite.run(
    `CREATE TABLE ${table} (${key} TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  )
const oldLogin = crypto.randomUUID()
const oldChat = crypto.randomUUID()
sqlite.run(`INSERT INTO logins VALUES ('${oldLogin}', 4, 'blob', '{"pc":"old"}', 1000)`)
sqlite.run(`INSERT INTO chats VALUES ('${oldChat}', 2, 'blob', '{}', 1000)`)
const worker = (
  await import(
    `${join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js')}?old-schema`
  )
).default as { fetch: (r: Request, env: unknown) => Promise<Response> }
const env = { DB: d1(sqlite), TOKEN_SHA256: createHash('sha256').update(token).digest('hex') }

async function call(method: string, path: string, body?: unknown) {
  const r = await worker.fetch(
    new Request(`http://store${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
  return { status: r.status, rev: r.headers.get('x-store-rev'), json: (await r.json()) as any }
}

test('an old database is upgraded: old rows are listed at rev 0, writes and changes work', async () => {
  const list = await call('GET', '/v1/logins')
  expect(list.status).toBe(200)
  expect(list.rev).toBe('0')
  expect(list.json.logins).toEqual([
    { id: oldLogin, version: 4, meta: { pc: 'old' }, updatedAt: 1000 },
  ])

  const fresh = crypto.randomUUID()
  expect(
    (await call('PUT', `/v1/logins/${fresh}`, { version: 0, blob: 'n', meta: {} })).json,
  ).toEqual({ version: 1 })
  expect(
    (await call('PUT', `/v1/logins/${oldLogin}`, { version: 4, blob: 'n', meta: {} })).json,
  ).toEqual({ version: 5 })
  expect((await call('DELETE', `/v1/chats/${oldChat}?version=2`)).json).toEqual({ ok: true })

  const c = (await call('GET', '/v1/changes?since=0')).json
  expect(c.rev).toBe(3)
  expect(c.logins.map((r: { id: string }) => r.id).sort()).toEqual([fresh, oldLogin].sort())
  expect(c.gone).toEqual([{ table: 'chats', id: oldChat }])
  expect((await call('GET', '/v1/chats')).json.chats).toEqual([])
})

test('a tombstone older than 30 days is pruned by the cron and raises floor', async () => {
  // a database that already holds a 31-day-old tombstone at rev 5 and a fresh one at rev 8
  const db = new Database(':memory:')
  for (const [table, key] of [
    ['logins', 'id'],
    ['queues', 'pc'],
    ['chats', 'id'],
  ])
    db.run(
      `CREATE TABLE ${table} (${key} TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0)`,
    )
  db.run(
    'CREATE TABLE tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (table_name, id))',
  )
  db.run(
    'CREATE TABLE store_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, floor INTEGER NOT NULL)',
  )
  db.run('INSERT INTO store_rev VALUES (1, 9, 0)')
  const old = crypto.randomUUID()
  const recent = crypto.randomUUID()
  db.run(`INSERT INTO tombstones VALUES ('logins', '${old}', 5, ${Date.now() - 31 * 86400000})`)
  db.run(`INSERT INTO tombstones VALUES ('logins', '${recent}', 8, ${Date.now() - 86400000})`)
  const w = (
    await import(
      `${join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js')}?prune`
    )
  ).default as typeof worker & { scheduled: (e: unknown, env: unknown) => Promise<void> }
  const dbEnv = { DB: d1(db), TOKEN_SHA256: env.TOKEN_SHA256 }
  const ask = async (path: string) =>
    (
      await w.fetch(
        new Request(`http://store${path}`, { headers: { authorization: `Bearer ${token}` } }),
        dbEnv,
      )
    ).json() as Promise<any>

  clearCache() // the first test left its head (rev 3) in the shared cache tier under the same host
  // a request alone no longer prunes: the old tombstone is still there
  expect((await ask('/v1/changes?since=3')).gone?.length).toBe(2)
  await w.scheduled({}, dbEnv)
  expect(await ask('/v1/changes?since=3')).toEqual({ rev: 9, full: true })
  expect((await ask('/v1/changes?since=5')).gone).toEqual([{ table: 'logins', id: recent }])
})
