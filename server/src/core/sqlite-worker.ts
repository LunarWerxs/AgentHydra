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
//
// The deadline and the worker-death cap below are adapted from stablyai/orca's worker-thread
// request queue (MIT). The idea is theirs; this is written fresh.

import { Database } from 'bun:sqlite'

type Param = string | number | null

// A query that has reached the worker gets this long. Past it the query is a hang, not a slow one:
// the worker is replaced, so its caller's promise cannot stay pending forever.
let DEADLINE_MS = 20_000
// This many worker deaths in a row (a crash or a timeout) stop respawning for COOL_DOWN_MS. A
// database that reliably kills the worker would otherwise cost the daemon a fresh worker per query.
const CRASH_LOOP_LIMIT = 3
let COOL_DOWN_MS = 60_000

/** Tests: a deadline and cool-down short enough to reach in a test run, and the death count cleared.
 *  Called with nothing, it restores the production values. */
export function setSqliteWorkerLimitsForTests(
  limits: { deadlineMs?: number; coolDownMs?: number } = {},
): void {
  DEADLINE_MS = limits.deadlineMs ?? 20_000
  COOL_DOWN_MS = limits.coolDownMs ?? 60_000
  consecutiveDeaths = 0
  coolDownUntil = 0
}

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

interface Job {
  id: number
  path: string
  sql: string
  params: Param[]
  resolve: (rows: unknown[]) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
// The worker runs one message at a time, so holding the others here loses no throughput. It also
// means a deadline is armed only when its query reaches the worker, not while it waits behind one.
let inFlight: Job | null = null
const queue: Job[] = []
let nextId = 0
let consecutiveDeaths = 0
let coolDownUntil = 0

/** The worker is gone. Fail the query it held and the queued ones, and count the death. A reply
 *  from a live worker resets the count, so only deaths in a row reach the cap. */
function markDead(w: Worker, reason: string): void {
  if (worker === w) worker = null
  w.terminate()
  consecutiveDeaths++
  if (consecutiveDeaths >= CRASH_LOOP_LIMIT) coolDownUntil = Date.now() + COOL_DOWN_MS
  const held = inFlight
  inFlight = null
  if (held) {
    clearTimeout(held.timer)
    held.reject(new Error(reason))
  }
  for (const job of queue.splice(0)) {
    job.reject(new Error(`sqlite worker was terminated while this query was queued: ${reason}`))
  }
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })))
  // Never what keeps the process alive: the daemon has its server for that, and a test run or a
  // one-shot CLI must be free to exit.
  w.unref()
  w.onmessage = (e: MessageEvent<{ id: number; rows?: unknown[]; error?: string }>) => {
    if (worker !== w || !inFlight || e.data.id !== inFlight.id) return
    const job = inFlight
    inFlight = null
    clearTimeout(job.timer)
    consecutiveDeaths = 0
    if (e.data.error !== undefined) job.reject(new Error(e.data.error))
    else job.resolve(e.data.rows ?? [])
    pump()
  }
  w.onerror = (e) => {
    if (worker !== w) return
    markDead(w, `sqlite worker failed: ${e.message}`)
  }
  worker = w
  return w
}

/** Runs one query on the daemon's own thread: the fallback when no worker can start. */
function runInline(job: Job): void {
  let db: Database | null = null
  try {
    db = new Database(job.path, { readonly: true })
    job.resolve(db.query(job.sql).all(...job.params))
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    db?.close()
  }
}

/** Sends the next queued query to the worker and arms its deadline. */
function pump(): void {
  if (inFlight) return
  const job = queue.shift()
  if (!job) return
  let w: Worker
  try {
    w = ensureWorker()
  } catch {
    // No worker can be started, so answer inline: slower for the caller's thread, never missing.
    runInline(job)
    pump()
    return
  }
  inFlight = job
  job.timer = setTimeout(() => {
    if (inFlight !== job) return
    markDead(w, `sqlite query timed out after ${DEADLINE_MS} ms; its worker was terminated`)
  }, DEADLINE_MS)
  w.postMessage({ id: job.id, path: job.path, sql: job.sql, params: job.params })
}

/** `sql` against the database at `path`, read-only, off the daemon's thread. Rejects on a query
 *  error the way `.all()` would throw, and on a query that does not return within the deadline.
 *  Where no worker can be started it runs inline. After repeated worker deaths it rejects without
 *  running inline: the inline run would be this same query on the daemon's thread, the hang and
 *  crash the worker keeps off it, so it waits out the cool-down instead. */
export function queryInWorker<T>(path: string, sql: string, params: Param[] = []): Promise<T[]> {
  if (Date.now() < coolDownUntil) {
    const wait = Math.ceil((coolDownUntil - Date.now()) / 1000)
    return Promise.reject(
      new Error(
        `sqlite worker is cooling down after ${consecutiveDeaths} deaths in a row; retry in ${wait} s`,
      ),
    )
  }
  return new Promise<T[]>((resolve, reject) => {
    queue.push({
      id: ++nextId,
      path,
      sql,
      params,
      resolve: resolve as (rows: unknown[]) => void,
      reject,
    })
    pump()
  })
}
