// server/tests/login-sync-store.ts — the login sync store for tests: the real Worker
// (cloud/login-sync-worker/worker.js) on bun:sqlite behind D1's prepare/bind API, served on a local
// port. ONE per test process: the Worker remembers per module that its table exists, so a second
// database behind the same module would never get one.

import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

type Arg = string | number
type Result = { results: any[]; meta: { changes: number; rows_read: number } }

/**
 * D1's prepare/bind/first/all/run/batch over bun:sqlite: the Worker's storage, nothing more.
 * `meta.rows_read` is, like D1's bill, the rows a statement looked at: a SELECT whose plan walks a
 * whole table counts every row of it, else the rows returned or changed. `rowsRead` totals it since
 * the last `resetRowsRead()`.
 */
export function d1(db: Database) {
  let rowsRead = 0
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
      return { results, meta: { changes: 0, rows_read: read } }
    }
    const changes = db.query(sql).run(...args).changes
    rowsRead += changes
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
    },
  }
}

export const token = randomBytes(24).toString('base64url')
const worker = (
  await import(join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js'))
).default as { fetch: (r: Request, env: unknown) => Promise<Response> }
/** The Worker's bindings; a test may set CHAT_STORE_MB and must delete it again. */
/** The store's D1, for counting the rows a call reads. */
export const storeDb = d1(new Database(':memory:'))
export const env: { DB: unknown; TOKEN_SHA256: string; CHAT_STORE_MB?: string } = {
  DB: storeDb,
  TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
}
const server = Bun.serve({ port: 0, fetch: (req) => worker.fetch(req, env) })
server.unref()
export const base = `http://127.0.0.1:${server.port}`

/** A request to the store with the access token. */
export const store = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }))
