// server/tests/login-sync-store.ts — the login sync store for tests: the real Worker
// (cloud/login-sync-worker/worker.js) on bun:sqlite behind D1's prepare/bind API, served on a local
// port. ONE per test process: the Worker remembers per module that its table exists, so a second
// database behind the same module would never get one.

import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** D1's prepare/bind/first/all/run over bun:sqlite: the Worker's storage, nothing more. */
function d1(db: Database) {
  return {
    prepare(sql: string) {
      let args: Array<string | number> = []
      const stmt = {
        bind(...a: Array<string | number>) {
          args = a
          return stmt
        },
        first: async () => db.query(sql).get(...args) ?? null,
        all: async () => ({ results: db.query(sql).all(...args) }),
        run: async () => ({ meta: { changes: db.query(sql).run(...args).changes } }),
      }
      return stmt
    },
  }
}

export const token = randomBytes(24).toString('base64url')
const worker = (
  await import(join(import.meta.dir, '..', '..', 'cloud', 'login-sync-worker', 'worker.js'))
).default as { fetch: (r: Request, env: unknown) => Promise<Response> }
/** The Worker's bindings; a test may set CHAT_STORE_MB and must delete it again. */
export const env: { DB: unknown; TOKEN_SHA256: string; CHAT_STORE_MB?: string } = {
  DB: d1(new Database(':memory:')),
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
