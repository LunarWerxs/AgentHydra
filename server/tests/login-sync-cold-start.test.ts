// server/tests/login-sync-cold-start.test.ts — what the login sync Worker asks D1 when an isolate
// starts cold: a database already at the current schema costs at most 2 statements before the route
// runs, and tombstones are pruned by scheduled(), not by a request. Each test loads its own copy of
// the Worker (the shared store remembers its schema per module).

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { d1 } from './login-sync-store'

const token = 'cold-start-token'
const tokenHash = createHash('sha256').update(token).digest('hex')
type W = {
  fetch: (r: Request, env: unknown) => Promise<Response>
  scheduled: (e: unknown, env: unknown) => Promise<void>
}
const load = async (tag: string) =>
  (
    await import(
      `${join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js')}?${tag}`
    )
  ).default as W
const ask = (w: W, db: ReturnType<typeof d1>, path: string) =>
  w.fetch(new Request(`http://store${path}`, { headers: { authorization: `Bearer ${token}` } }), {
    DB: db,
    TOKEN_SHA256: tokenHash,
  })

test('a cold isolate on a migrated database runs at most 2 statements before the route', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  expect((await ask(await load('cold-a'), db, '/v1/health')).status).toBe(200)
  // first ever request migrates the empty database
  expect((await ask(await load('cold-a'), db, '/v1/logins')).status).toBe(200)

  // a new isolate (a new module copy) against the migrated database
  const cold = await load('cold-b')
  db.resetRowsRead()
  expect((await ask(cold, db, '/v1/logins')).status).toBe(200)
  const sql = db.statements().map((s) => s.sql)
  console.log('cold first request statements:', sql.length, JSON.stringify(sql))
  const schemaStatements = sql.filter((q) => /PRAGMA|CREATE|ALTER|tombstones/i.test(q))
  expect(schemaStatements.length).toBeLessThanOrEqual(2)
  expect(sql.some((q) => /DELETE FROM tombstones/i.test(q))).toBe(false)
  expect(sql.some((q) => /FROM tombstones WHERE time/i.test(q))).toBe(false)
})

test('scheduled() prunes tombstones older than 30 days, raises floor, by the time index', async () => {
  const sqlite = new Database(':memory:')
  const db = d1(sqlite)
  const w = await load('cron')
  await ask(w, db, '/v1/logins') // migrate
  const old = crypto.randomUUID()
  const recent = crypto.randomUUID()
  sqlite.run('UPDATE store_rev SET rev = 9 WHERE id = 1')
  sqlite.run(`INSERT INTO tombstones VALUES ('logins', '${old}', 5, ${Date.now() - 31 * 86400000})`)
  sqlite.run(`INSERT INTO tombstones VALUES ('logins', '${recent}', 8, ${Date.now() - 86400000})`)

  db.resetRowsRead()
  await w.scheduled({}, { DB: db, TOKEN_SHA256: tokenHash })
  expect(sqlite.query('SELECT id FROM tombstones').all()).toEqual([{ id: recent }])
  expect(sqlite.query('SELECT floor FROM store_rev').get()).toEqual({ floor: 5 })
  // one old row read twice (floor, delete): the index on time keeps the recent row out of it
  expect(db.rowsRead()).toBeLessThanOrEqual(4)
})
