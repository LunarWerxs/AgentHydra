// server/src/core/climayte-queue-sync.ts — share the CliMayte queue between the owner's PCs through
// the login sync's store (cloud/login-sync-worker), so two PCs both running CliMayte see each other's
// work and do not override each other (owner, 2026-10-02: "if I have my two computers running they can
// see the CliMayte queue and not override each other ... it just shows ones from my other computer
// with a little cloud icon").
//
// Each PC uploads ONE snapshot of its own queue under its own id and downloads the others'. They sit
// in the store's `queues` table, never in `logins`: every AgentHydra lands a `logins` row it does not
// know as a CLI login, so a queue there would become a junk login on a PC running an older version.
//
// WHAT A SNAPSHOT HOLDS: the workers that are queued, running, waiting or checking, and the ones
// finished in the last 24 hours, each cut down to what a reader of the list needs (RemoteWorker:
// never the prompt, results, logs or paths), and this PC's newest live usage reading per account. It
// is gzipped, then AES-256-GCM encrypted under the sync's own key with `climayte-queue:<pc>` as
// associated data, so a blob cannot be passed off as another PC's. Over the store's 256 KB cap the
// oldest finished workers go first; the active ones never do.
//
// HOW IT IS USED: climayte-remote.ts keeps what the other PCs shared, in memory. Placement counts their
// running workers toward each account's cap and takes their newer usage readings; the CliMayte view
// lists them apart (GET /api/corch/remote). Nothing of theirs is written to this PC's workers.json.
//
// Failures here (a Worker without the queue routes, a conflict, the network) are the queue's own: the
// caller keeps them in `queueError` and never in the logins' status.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { liveByAccount, workers } from '../climayte-core'
import { type CliMayteWorker, ranSeconds } from '../climayte-lib'
import {
  keepRemote,
  type QueueSnapshot,
  type RemoteLive,
  type RemoteWorker,
  remoteSnapshots,
  remoteVersion,
  setRemote,
} from '../climayte-remote'
import { MIRROR_FRESH_MS, type StoreMirror } from './login-sync-mirror'
import { ownBuild } from './own-build'

/** The store's cap on a queue blob (cloud/login-sync-worker/worker.js). */
export const QUEUE_MAX_BLOB = 256 * 1024
/** Workers finished longer ago than this are not shared. */
export const FINISHED_KEEP_MS = 24 * 60 * 60_000
/** An unchanged queue is uploaded at least this often, so the other PC can tell this one is alive
 *  (climayte-remote.ts REMOTE_STALE_MS is well over it). Measured 2026-10-03: a 60 s heartbeat plus an
 *  upload on every usage reading cost the store about 2,300 rows read an hour with both PCs idle. */
export const HEARTBEAT_MS = 15 * 60_000
/** A change in the live readings alone (no worker changed) uploads at most this often. */
export const LIVE_GATE_MS = 10 * 60_000
/** sessionPct and weekPct count as changed only when they cross a step of this many points. */
export const LIVE_BUCKET = 5

const PC_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const aad = (pc: string): Buffer => Buffer.from(`climayte-queue:${pc}`, 'utf8')

const isFinished = (s: string): boolean => s === 'done' || s === 'failed' || s === 'cancelled'

function reduce(w: CliMayteWorker, now: number): RemoteWorker {
  const ref = [...w.attempts].reverse().find((a) => a.account.id === w.accountId)?.account
  const v = w.verdicts?.at(-1)?.verdict
  return {
    id: w.id,
    title: w.title,
    group: w.group,
    status: w.status,
    kind: w.kind ?? null,
    model: w.model,
    effort: w.effort,
    account: ref ? { id: ref.id, num: ref.num, name: ref.name } : null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    activeS: ranSeconds(w, now),
    costUsd: w.costUsd,
    lastActivity: w.lastActivity,
    error: w.error,
    verdict: v === 'pass' || v === 'fail' ? v : null,
  }
}

/** This PC's queue as it is shared now: active workers and the last day's finished ones, newest
 *  first, and the newest live reading per account. */
export function buildSnapshot(pc: string, name: string, now = Date.now()): QueueSnapshot {
  const list = [...workers.values()]
    .filter((w) => !isFinished(w.status) || now - w.updatedAt <= FINISHED_KEEP_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((w) => reduce(w, now))
  const live: Record<string, RemoteLive> = {}
  for (const [id, r] of liveByAccount)
    live[id] = { sessionPct: r.sessionPct, weekPct: r.weekPct, at: r.at }
  return { pc, name, at: now, workers: list, live, build: ownBuild() }
}

/** The encrypted blob for a snapshot: base64 of {v, iv, tag, data}, `data` the gzipped JSON. */
export function sealQueue(key: Buffer, snap: QueueSnapshot): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(snap.pc))
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(snap))), cipher.final()])
  return Buffer.from(
    JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }),
  ).toString('base64')
}

/** A snapshot from the store's blob for PC `pc`, or null (wrong key, another PC's blob, damage). */
export function openQueue(key: Buffer, pc: string, blob: string): QueueSnapshot | null {
  try {
    const b = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
      v: number
      iv: string
      tag: string
      data: string
    }
    if (b.v !== 1) return null
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
    decipher.setAAD(aad(pc))
    decipher.setAuthTag(Buffer.from(b.tag, 'base64'))
    const plain = gunzipSync(
      Buffer.concat([decipher.update(Buffer.from(b.data, 'base64')), decipher.final()]),
    )
    const snap = JSON.parse(plain.toString('utf8')) as QueueSnapshot
    return snap?.pc === pc &&
      Array.isArray(snap.workers) &&
      snap.live &&
      typeof snap.at === 'number'
      ? snap
      : null
  } catch {
    return null
  }
}

/** Seal the snapshot, dropping the oldest finished workers until the blob fits `max`. Every active
 *  worker stays: if they alone do not fit, the blob is still returned (the store will refuse it). */
export function fitSnapshot(
  key: Buffer,
  snap: QueueSnapshot,
  max = QUEUE_MAX_BLOB,
): { blob: string; snap: QueueSnapshot } {
  const active = snap.workers.filter((w) => !isFinished(w.status))
  const finished = snap.workers.filter((w) => isFinished(w.status)) // newest first
  const make = (keep: number): QueueSnapshot => ({
    ...snap,
    workers: [...active, ...finished.slice(0, keep)].sort((a, b) => b.updatedAt - a.updatedAt),
  })
  let blob = sealQueue(key, snap)
  if (blob.length <= max) return { blob, snap }
  // The most finished workers that still fit (the size only grows with the count).
  let lo = 0
  let hi = finished.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sealQueue(key, make(mid)).length <= max) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const fitted = make(best)
  blob = sealQueue(key, fitted)
  return { blob, snap: fitted }
}

export interface QueueIo {
  /** The store mirror of the pass; without one the list route is read directly. */
  mirror?: StoreMirror
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>
  key: Buffer
  /** This PC's id and name. */
  pc: string
  name: string
}

const NO_ROUTES =
  'this store’s Worker has no queue routes yet: redeploy cloud/login-sync-worker/worker.js'

function queueFailure(what: string, r: { status: number; json: any }): Error {
  if (r.status === 404 && !r.json?.pc) return new Error(NO_ROUTES)
  if (r.status === 409)
    return new Error(`${what}: changed in the store meanwhile; next pass retries.`)
  return new Error(
    `${what}: the store answered ${r.status}${r.json?.error ? ` (${r.json.error})` : ''}.`,
  )
}

/** What each PC id last uploaded: fingerprints of its workers' shape, of their volatile fields and of
 *  its live readings (not the clock or reading times) and when. */
const sentBy = new Map<string, { shape: string; volatile: string; live: string; at: number }>()

export function resetQueueSync(): void {
  sentBy.clear()
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

const bucket = (pct: number | null): number | null =>
  typeof pct === 'number' ? Math.floor(pct / LIVE_BUCKET) * LIVE_BUCKET : pct

/** What a reader of the list sees change: a change here uploads at once and counts as news. */
const shapePrint = (snap: QueueSnapshot): string =>
  hash(
    snap.workers.map((w) => [
      w.id,
      w.title,
      w.group,
      w.status,
      w.kind,
      w.model,
      w.effort,
      w.account,
      w.createdAt,
      w.verdict,
    ]),
  )

/** What moves on every tool call of a running worker (activity, cost, clocks, error, running time): a
 *  change here alone rides the LIVE_GATE_MS gate and is no news. Measured 2026-10-03: with a few
 *  running workers it made an upload every ~21 s. */
const volatilePrint = (snap: QueueSnapshot): string =>
  hash(snap.workers.map((w) => [w.id, w.lastActivity, w.costUsd, w.updatedAt, w.error, w.activeS]))

/** The live readings without their `at`, with the percentages in 5-point steps. */
const livePrint = (snap: QueueSnapshot): string =>
  hash(
    Object.keys(snap.live)
      .sort()
      .map((id) => [id, bucket(snap.live[id].sessionPct), bucket(snap.live[id].weekPct)]),
  )

/** True when the snapshot went up with news in it: a worker's shape or a live bucket changed. A
 *  volatile-only change (activity, cost, clocks, error, running time) goes up only once LIVE_GATE_MS has
 *  passed since the last upload, with the current values, and is not news; nor is a heartbeat. */
async function upload(io: QueueIo, own: number, now: number): Promise<boolean> {
  const { blob, snap } = fitSnapshot(io.key, buildSnapshot(io.pc, io.name, now))
  const s = shapePrint(snap)
  const v = volatilePrint(snap)
  const l = livePrint(snap)
  const sent = sentBy.get(io.pc)
  // A shape change goes at once; a live-bucket or volatile change only after LIVE_GATE_MS; else the
  // heartbeat.
  if (sent && sent.shape === s) {
    const age = now - sent.at
    if (age < HEARTBEAT_MS && ((sent.live === l && sent.volatile === v) || age < LIVE_GATE_MS))
      return false
  }
  const body = (version: number) => ({
    version,
    blob,
    meta: { name: io.name, at: now, count: snap.workers.length },
  })
  let r = await io.call('PUT', `/v1/queues/${io.pc}`, body(own))
  if (r.status === 409 && typeof r.json?.current?.version === 'number')
    r = await io.call('PUT', `/v1/queues/${io.pc}`, body(r.json.current.version))
  if (r.status !== 200) throw queueFailure('Uploading this PC’s queue', r)
  sentBy.set(io.pc, { shape: s, volatile: v, live: l, at: now })
  return !sent || sent.shape !== s || sent.live !== l
}

async function queueRows(io: QueueIo): Promise<Array<{ pc: string; version: number }>> {
  if (io.mirror) {
    await io.mirror.refresh({ tables: ['queues'], maxAgeMs: MIRROR_FRESH_MS })
    const v = io.mirror.view('queues')
    if (!v.ok) throw queueFailure('Reading the queues', v.reply)
    return v.rows as Array<{ pc: string; version: number }>
  }
  const list = await io.call('GET', '/v1/queues')
  if (list.status !== 200 || !Array.isArray(list.json?.queues))
    throw queueFailure('Reading the queues', list)
  return list.json.queues
}

/** One queue pass: upload this PC's snapshot when a worker's shape changed, when the live readings
 *  moved a bucket or a worker's activity, cost or clocks changed (those two at most every
 *  LIVE_GATE_MS) or when the heartbeat is due, download every other PC's that changed. Throws the
 *  first problem after doing all it can. Returns whether anything the queue shares moved: this PC's
 *  snapshot went up with a shape or live-bucket change, or another PC's came down with one (a heartbeat
 *  or a volatile-only change is no news; it is still stored). The sync loop polls less often when
 *  nothing moved. */
export async function syncQueue(io: QueueIo, now = Date.now()): Promise<boolean> {
  let moved = false
  const rows = await queueRows(io)
  const own = rows.find((r) => r.pc === io.pc)?.version ?? 0
  let problem: Error | null = null
  try {
    moved = await upload(io, own, now)
  } catch (err) {
    problem = err instanceof Error ? err : new Error(String(err))
  }
  const others = rows.filter((r) => r.pc !== io.pc && PC_RE.test(r.pc))
  keepRemote(new Set(others.map((r) => r.pc)))
  for (const row of others) {
    if (remoteVersion(row.pc) === row.version) continue
    try {
      const r = await io.call('GET', `/v1/queues/${row.pc}`)
      if (r.status !== 200 || typeof r.json?.blob !== 'string')
        throw queueFailure('Downloading the other PC’s queue', r)
      const snap = openQueue(io.key, row.pc, r.json.blob)
      if (!snap) throw new Error('The other PC’s queue does not open with this PC’s key.')
      const prev = remoteSnapshots().find((s) => s.pc === row.pc)
      if (!prev || shapePrint(prev) !== shapePrint(snap) || livePrint(prev) !== livePrint(snap))
        moved = true
      setRemote(snap, r.json.version ?? row.version)
    } catch (err) {
      problem ??= err instanceof Error ? err : new Error(String(err))
    }
  }
  if (problem) throw problem
  return moved
}
