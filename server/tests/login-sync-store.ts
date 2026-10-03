// server/tests/login-sync-store.ts — the login sync store for tests: the real Worker
// (cloud/login-sync-worker/worker.js) on bun:sqlite behind D1's prepare/bind API, served on a local
// port. ONE per test process: the Worker remembers per module that its table exists, so a second
// database behind the same module would never get one.

import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

type Arg = string | number
export type StatementStat = { sql: string; calls: number; rows: number; write: boolean }
type Result = { results: any[]; meta: { changes: number; rows_read: number } }

/**
 * D1's prepare/bind/first/all/run/batch over bun:sqlite: the Worker's storage, nothing more.
 * `meta.rows_read` is, like D1's bill, the rows a statement looked at: a SELECT whose plan walks a
 * whole table counts every row of it, else the rows returned or changed. `rowsRead` totals it since
 * the last `resetRowsRead()`.
 */
export function d1(db: Database) {
  let rowsRead = 0
  const byStatement = new Map<string, StatementStat>()
  const tally = (sql: string, rows: number, write: boolean) => {
    const key = sql.replace(/\s+/g, ' ').trim().slice(0, 150)
    const s = byStatement.get(key) ?? { sql: key, calls: 0, rows: 0, write }
    s.calls++
    s.rows += rows
    byStatement.set(key, s)
  }
  // SCAN walks a whole table or index; a SEARCH using no index (MAX of an unindexed column) does too.
  const scanned = (sql: string, args: Arg[]): number => {
    let n = 0
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>
    for (const { detail } of plan) {
      const m = /^(SCAN|SEARCH) (\w+)(.*)$/.exec(detail)
      if (m && (m[1] === 'SCAN' || !m[3].includes('USING')))
        n += (db.query(`SELECT COUNT(*) AS n FROM ${m[2]}`).get() as { n: number }).n
    }
    return n
  }
  const exec = (sql: string, args: Arg[]): Result => {
    const returns = /^\s*(SELECT|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)
    if (returns) {
      const results = db.query(sql).all(...args) as any[]
      const read = /^\s*SELECT/i.test(sql)
        ? Math.max(results.length, scanned(sql, args))
        : results.length
      rowsRead += read
      tally(sql, read, false)
      return { results, meta: { changes: 0, rows_read: read } }
    }
    const changes = db.query(sql).run(...args).changes
    rowsRead += changes
    tally(sql, changes, true)
    return { results: [], meta: { changes, rows_read: changes } }
  }
  const prepare = (sql: string) => {
    let args: Arg[] = []
    const stmt = {
      bind(...a: Arg[]) {
        args = a
        return stmt
      },
      run: async () => exec(sql, args),
      all: async () => exec(sql, args),
      first: async () => exec(sql, args).results[0] ?? null,
      exec: () => exec(sql, args),
    }
    return stmt
  }
  return {
    prepare,
    /** All statements in one transaction, rolled back together if one throws. */
    async batch(stmts: Array<ReturnType<typeof prepare>>) {
      return db.transaction(() => stmts.map((s) => s.exec()))()
    },
    rowsRead: () => rowsRead,
    resetRowsRead: () => {
      rowsRead = 0
      byStatement.clear()
    },
    /** Every statement run since the last `resetRowsRead()`: calls, and the rows read (or, for a
     *  write, changed), most rows first. */
    statements: (): StatementStat[] => [...byStatement.values()].sort((a, b) => b.rows - a.rows),
  }
}

/**
 * A minimal in-memory `caches.default` (match/put) for the Worker's shared head tier: an entry lives for
 * its `cache-control: max-age` on the test clock (Date.now), so a faked clock ages it too.
 * `clearCache()` empties it (a new colo).
 */
const cacheStore = new Map<string, { at: number; maxAge: number; body: string }>()
const cacheKey = (r: Request | string) => (typeof r === 'string' ? r : r.url)
;(globalThis as any).caches = {
  default: {
    async put(req: Request | string, res: Response) {
      const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
      if (m)
        cacheStore.set(cacheKey(req), {
          at: Date.now(),
          maxAge: Number(m[1]),
          body: await res.text(),
        })
    },
    async match(req: Request | string) {
      const hit = cacheStore.get(cacheKey(req))
      if (!hit) return undefined
      const age = Date.now() - hit.at
      if (age < 0 || age >= hit.maxAge * 1000) {
        cacheStore.delete(cacheKey(req))
        return undefined
      }
      return new Response(hit.body)
    },
  },
}
export const clearCache = () => cacheStore.clear()

export const token = randomBytes(24).toString('base64url')
const worker = (
  await import(join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js'))
).default as { fetch: (r: Request, env: unknown) => Promise<Response>; forgetIsolate: () => void }
/** The Worker's bindings; a test may set CHAT_STORE_MB and must delete it again. */
/** The store's D1, for counting the rows a call reads. */
export const storeDb = d1(new Database(':memory:'))
export const env: {
  DB: unknown
  TOKEN_SHA256: string
  CHAT_STORE_MB?: string
  HEAD_TRUST_S?: string
  HEAD_CACHE_S?: string
} = {
  DB: storeDb,
  TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
}
const server = Bun.serve({ port: 0, fetch: (req) => worker.fetch(req, env) })
server.unref()
/** What a fresh isolate starts without: the Worker's kept head, lists and rows. */
export const freshIsolate = () => worker.forgetIsolate()
export const base = `http://127.0.0.1:${server.port}`

/** A request to the store with the access token. */
export const store = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }))

/** Delete every login row through the Worker's own route, which moves the rev and leaves a tombstone,
 *  so a PC's mirror drops them too. The store is one per test process and every file shares it: a file
 *  that needs a store holding only its own logins empties it first, because another file's rows are
 *  sealed with that file's key and a PC that cannot open a row reports a sync error. Bun runs the files
 *  in directory order, which differs by platform (on Linux desktop-login-sync and
 *  login-sync-quiet-hour ran before cli-login-sync and failed its no-error check). */
export async function emptyLogins() {
  const r = await store('GET', '/v1/logins')
  for (const l of (r.json?.logins ?? []) as Array<{ id: string; version: number }>) {
    const d = await store('DELETE', `/v1/logins/${l.id}?version=${l.version}`)
    if (d.status !== 200) throw new Error(`emptyLogins: DELETE ${l.id} answered ${d.status}`)
  }
}

/** Delete a queue row the way a Worker delete would: bump the rev and leave a tombstone, so the Worker's
 *  kept list and the changes feed drop it (the Worker has no queue DELETE route; a hand-run delete
 *  moves no rev, and a list kept in the isolate would show the row for hours). */
export async function dropQueue(pc: string) {
  await storeDb.batch([
    storeDb.prepare('UPDATE store_rev SET rev = rev + 1, queues_rev = rev + 1 WHERE id = 1'),
    storeDb
      .prepare(
        'INSERT OR REPLACE INTO tombstones (table_name, id, rev, time) SELECT ?, ?, rev, ? FROM store_rev WHERE id = 1',
      )
      .bind('queues', pc, Date.now()),
    storeDb.prepare('DELETE FROM queues WHERE pc = ?').bind(pc),
  ])
}
