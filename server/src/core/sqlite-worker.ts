// server/src/core/sqlite-worker.ts - a read-only SQLite query, run on a worker thread.
//
// ⛔ WHY (2026-09-27). Some databases AgentHydra reads belong to other products, and they are not
// small: this machine's OpenCode store is 8 GB, with single message rows of 160 MB. A query whose
// cost is set by the size of the rows (a LIKE over every message of a session) held the daemon's
// only thread for up to 2.6 s, and the tray watchdog kills a daemon that leaves /api/health
// unanswered. On a worker the query costs the worker's time; the request thread awaits a promise.
//
// Built from source through a blob URL, like stall-sentinel.ts, so the compiled exe carries it
// without a second build entrypoint. The database is opened and closed per query: a handle held
// open between queries would pin another product's file for the life of the daemon.

import { Database } from 'bun:sqlite'

type Param = string | number | null

const WORKER_SOURCE = `
const { Database } = require('bun:sqlite')
self.onmessage = (e) => {
  const { id, path, sql, params } = e.data
  let db = null
  try {
    db = new Database(path, { readonly: true })
    self.postMessage({ id, rows: db.query(sql).all(...params) })
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) })
  } finally {
    if (db) db.close()
  }
}
`

interface Pending {
  resolve: (rows: unknown[]) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
const pending = new Map<number, Pending>()
let nextId = 0

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })))
  // Never what keeps the process alive: the daemon has its server for that, and a test run or a
  // one-shot CLI must be free to exit.
  w.unref()
  w.onmessage = (e: MessageEvent<{ id: number; rows?: unknown[]; error?: string }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.error !== undefined) p.reject(new Error(e.data.error))
    else p.resolve(e.data.rows ?? [])
  }
  w.onerror = (e) => {
    // A dead worker fails what it held and is replaced on the next query.
    worker = null
    failAll(new Error(`sqlite worker failed: ${e.message}`))
    w.terminate()
  }
  worker = w
  return w
}

/** `sql` against the database at `path`, read-only, off the daemon's thread. Rejects on a query
 *  error the way `.all()` would throw. Where no worker can be started it runs inline: slower for
 *  the caller's thread, never a missing answer. */
export function queryInWorker<T>(path: string, sql: string, params: Param[] = []): Promise<T[]> {
  let w: Worker
  try {
    w = ensureWorker()
  } catch {
    return (async () => {
      const db = new Database(path, { readonly: true })
      try {
        return db.query(sql).all(...params) as T[]
      } finally {
        db.close()
      }
    })()
  }
  const id = ++nextId
  return new Promise<T[]>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (rows: unknown[]) => void, reject })
    w.postMessage({ id, path, sql, params })
  })
}
