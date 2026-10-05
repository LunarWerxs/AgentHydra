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
// never the prompt, results, logs or paths; its session, origin and wave ids, so the other PC draws it
// under the chat that spawned it, that chat's title as this PC's session list shows it, and the
// worker's earlier session ids: still never a prompt, a path or a Claude home), and this PC's newest live usage reading per account. It
// is gzipped, then AES-256-GCM encrypted under the sync's own key with `climayte-queue:<pc>` as
// associated data, so a blob cannot be passed off as another PC's. Over the store's 256 KB cap the
// oldest finished workers go first; the active ones never do.
//
// HOW IT IS USED: climayte-remote.ts keeps what the other PCs shared, in memory. Placement counts their
// running workers toward each account's cap and takes their newer usage readings; the CliMayte view
// lists them apart (GET /api/corch/remote). Nothing of theirs is written to this PC's workers.json.
//
// WHEN IT UPLOADS (measured 2026-10-04: ~117 uploads an hour, each costing 2 writes and about 7 rows
// the other PC reads): the first shape change after a quiet spell goes up at once; after that the
// snapshot goes up at most once per QUEUE_SHAPE_GAP_MS (3 min) with the newest state, so the other PC
// sees every shape change within 3 min plus its own poll wait (at most 5 min). Volatile fields and live
// readings keep their LIVE_GATE_MS gate; an unchanged queue is never uploaded. Active-hour test
// (40 shape changes in an hour, login-sync-quiet-hour.test.ts): 20 uploads, not 40.
//
// Failures here (a Worker without the queue routes, a conflict, the network) are the queue's own: the
// caller keeps them in `queueError` and never in the logins' status.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib' // the first format
import { liveByAccount, workers } from '../climayte-core'
import { type CliMayteWorker, ranSeconds } from '../climayte-lib'
import {
  keepRemote,
  noteSeen,
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
/** A change in the live readings alone (no worker changed) uploads at most this often. An unchanged
 *  queue is never uploaded again: the other PC reads this one as alive from its changes polls (the
 *  Worker's x-seen, climayte-remote.ts), not from a heartbeat upload (one every 15 min cost ~50 of the
 *  store's 60 rows an hour). */
export const LIVE_GATE_MS = 10 * 60_000
/** A shape change (status, account, verdict, ...) uploads at once after a quiet spell, but this PC's
 *  snapshot goes up at most once per this gap, with the newest state, however many changes came in
 *  between. 3 minutes: a busy hour then makes at most 20 uploads (2 writes plus about 5 rows the other
 *  PC reads each) instead of one per change, while the other PC still sees every change within
 *  3 minutes plus its own poll wait (at most IDLE_MAX_MS), 8 minutes in all. */
export const QUEUE_SHAPE_GAP_MS = 3 * 60_000
/** sessionPct and weekPct count as changed only when they cross a step of this many points. */
export const LIVE_BUCKET = 5

const PC_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const aad = (pc: string): Buffer => Buffer.from(`climayte-queue:${pc}`, 'utf8')

const isFinished = (s: string): boolean => s === 'done' || s === 'failed' || s === 'cancelled'

const TITLE_MAX = 120
/** Most chat titles one pass looks up, and how long a miss waits before it is tried again. */
export const TITLE_LOOKUPS_PER_PASS = 10
export const TITLE_RETRY_MS = 10 * 60_000

/** Chat session id -> its title as the session list shows it (null: not found). Only read by
 *  buildSnapshot; filled by warmOriginTitles at the start of a queue pass. */
const titleCache = new Map<string, { title: string | null; at: number }>()

export type TitleLookup = (sessionId: string) => Promise<string | null | undefined>

/** One session's title from the session index (sessions.ts getSession, the list's own scan cache). */
const indexTitle: TitleLookup = async (sessionId) =>
  (await (await import('../sessions')).getSession(sessionId))?.title

const cleanTitle = (t: string | null | undefined): string | null => {
  const c = typeof t === 'string' ? t.trim().slice(0, TITLE_MAX).trim() : ''
  return c || null
}

/** Looks up the titles of up to TITLE_LOOKUPS_PER_PASS chat origins not cached yet (a miss is cached as
 *  null and retried after TITLE_RETRY_MS), active workers first. A lookup that throws is a miss. */
export async function warmOriginTitles(
  now = Date.now(),
  lookup: TitleLookup = indexTitle,
): Promise<void> {
  const todo: string[] = []
  const rank = [...workers.values()].sort(
    (a, b) =>
      Number(isFinished(a.status)) - Number(isFinished(b.status)) || b.updatedAt - a.updatedAt,
  )
  for (const w of rank) {
    const id = w.origin?.kind === 'chat' ? w.origin.sessionId : null
    if (!id || todo.includes(id)) continue
    const c = titleCache.get(id)
    if (c && (c.title !== null || now - c.at < TITLE_RETRY_MS)) continue
    todo.push(id)
    if (todo.length >= TITLE_LOOKUPS_PER_PASS) break
  }
  for (const id of todo) {
    let title: string | null = null
    try {
      title = cleanTitle(await lookup(id))
    } catch {
      // a miss
    }
    titleCache.set(id, { title, at: now })
  }
}

function reduce(w: CliMayteWorker, now: number): RemoteWorker {
  const ref = [...w.attempts].reverse().find((a) => a.account.id === w.accountId)?.account
  const v = w.verdicts?.at(-1)?.verdict
  // Who dispatched it, as ids only: a chat's origin also holds its Claude home and transcript path.
  const o = w.origin
  const byWorker = o?.kind === 'worker' ? o.workerId : null
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
    sessionId: w.sessionId ?? null,
    originSessionId:
      o?.kind === 'chat'
        ? o.sessionId
        : byWorker
          ? (workers.get(byWorker)?.sessionId ?? null)
          : null,
    originWorkerId: byWorker,
    wave: w.wave ?? null,
    sessions: [...(w.sessions ?? [])],
    originTitle: o?.kind === 'chat' ? (titleCache.get(o.sessionId)?.title ?? null) : null,
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

/** Marks the zstd format: `Z2:` then base64 of iv (12 bytes), GCM tag (16) and the encrypted zstd JSON.
 *  The first format (gzip, base64 of a JSON {v, iv, tag, data}) has no prefix and is still read; an
 *  AgentHydra that only knows it fails to open a `Z2:` blob and reports that, nothing worse. */
const FORMAT_2 = 'Z2:'

/** The encrypted blob for a snapshot, in the zstd format. */
export function sealQueue(key: Buffer, snap: QueueSnapshot): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(snap.pc))
  const data = Buffer.concat([
    cipher.update(Bun.zstdCompressSync(Buffer.from(JSON.stringify(snap)), { level: 12 })),
    cipher.final(),
  ])
  return FORMAT_2 + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

/** A snapshot from the store's blob for PC `pc`, or null (wrong key, another PC's blob, damage). Reads
 *  both formats. */
export function openQueue(key: Buffer, pc: string, blob: string): QueueSnapshot | null {
  try {
    let iv: Buffer
    let tag: Buffer
    let data: Buffer
    let inflate: (b: Uint8Array) => Uint8Array
    if (blob.startsWith(FORMAT_2)) {
      const raw = Buffer.from(blob.slice(FORMAT_2.length), 'base64')
      iv = raw.subarray(0, 12)
      tag = raw.subarray(12, 28)
      data = raw.subarray(28)
      inflate = Bun.zstdDecompressSync
    } else {
      const b = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
        v: number
        iv: string
        tag: string
        data: string
      }
      if (b.v !== 1) return null
      iv = Buffer.from(b.iv, 'base64')
      tag = Buffer.from(b.tag, 'base64')
      data = Buffer.from(b.data, 'base64')
      inflate = gunzipSync
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad(pc))
    decipher.setAuthTag(tag)
    const plain = inflate(Buffer.concat([decipher.update(data), decipher.final()]))
    const snap = JSON.parse(Buffer.from(plain).toString('utf8')) as QueueSnapshot
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
  titleCache.clear()
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

const bucket = (pct: number | null): number | null =>
  typeof pct === 'number' ? Math.floor(pct / LIVE_BUCKET) * LIVE_BUCKET : pct

/** The workers sorted by id: the snapshot lists newest-updated first, and that order moves on every tool
 *  call of a running worker, so a fingerprint must not depend on it. */
const byId = (workers: QueueSnapshot['workers']): QueueSnapshot['workers'] =>
  [...workers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** What a reader of the list sees change: a change here uploads at once and counts as news. */
const shapePrint = (snap: QueueSnapshot): string =>
  hash(
    byId(snap.workers).map((w) => [
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
      w.sessions,
      w.originTitle,
    ]),
  )

/** What moves on every tool call of a running worker (activity, cost, clocks, error, running time): a
 *  change here alone rides the LIVE_GATE_MS gate and is no news. Measured 2026-10-03: with a few
 *  running workers it made an upload every ~21 s. */
const volatilePrint = (snap: QueueSnapshot): string =>
  hash(
    byId(snap.workers).map((w) => [
      w.id,
      w.lastActivity,
      w.costUsd,
      w.updatedAt,
      w.error,
      w.activeS,
    ]),
  )

/** The live readings without their `at`, with the percentages in 5-point steps. */
const livePrint = (snap: QueueSnapshot): string =>
  hash(
    Object.keys(snap.live)
      .sort()
      .map((id) => [id, bucket(snap.live[id].sessionPct), bucket(snap.live[id].weekPct)]),
  )

/** Whether a pass run at `now` would upload this PC's snapshot for news: nothing sent yet, a worker's
 *  shape changed and QUEUE_SHAPE_GAP_MS has passed since the last upload (a change inside the gap waits
 *  for it, and the tick that finds the gap over makes the pass due), or a live bucket moved and LIVE_GATE_MS has passed. Local and free (no store call).
 *  A running worker's activity and cost alone are not news, so they do not make a pass due. */
export function queueUploadPending(pc: string, now = Date.now()): boolean {
  const sent = sentBy.get(pc)
  if (!sent) return true
  const snap = buildSnapshot(pc, '', now)
  if (shapePrint(snap) !== sent.shape) return now - sent.at >= QUEUE_SHAPE_GAP_MS
  return now - sent.at >= LIVE_GATE_MS && livePrint(snap) !== sent.live
}

/** True when the snapshot went up with news in it: a worker's shape or a live bucket changed. A
 *  volatile-only change (activity, cost, clocks, error, running time) goes up only once LIVE_GATE_MS has
 *  passed since the last upload, with the current values, and is not news. */
async function upload(io: QueueIo, own: number, now: number): Promise<boolean> {
  const { blob, snap } = fitSnapshot(io.key, buildSnapshot(io.pc, io.name, now))
  const s = shapePrint(snap)
  const v = volatilePrint(snap)
  const l = livePrint(snap)
  const sent = sentBy.get(io.pc)
  // A shape change goes at once after a quiet spell, else when QUEUE_SHAPE_GAP_MS is up; a live-bucket
  // or volatile change only after LIVE_GATE_MS; else nothing.
  if (sent && sent.shape === s) {
    if ((sent.live === l && sent.volatile === v) || now - sent.at < LIVE_GATE_MS) return false
  } else if (sent && now - sent.at < QUEUE_SHAPE_GAP_MS) return false
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
    noteSeen(io.mirror.lastSeen())
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
 *  LIVE_GATE_MS), download every other PC's that changed. Throws the
 *  first problem after doing all it can. Returns whether anything the queue shares moved: this PC's
 *  snapshot went up with a shape or live-bucket change, or another PC's came down with one (a
 *  volatile-only change is no news; it is still stored). The sync loop polls less often when
 *  nothing moved. */
export async function syncQueue(io: QueueIo, now = Date.now()): Promise<boolean> {
  return (await syncQueueDetail(io, now)).moved
}

/** syncQueue, and whether this PC's snapshot went up with news in it (a shape or live-bucket change): the
 *  sync loop's pace counts that as work this PC did (login-sync-pace.ts); another PC's news that came
 *  down is `moved` but no work of this PC's own. */
export async function syncQueueDetail(
  io: QueueIo,
  now = Date.now(),
): Promise<{ moved: boolean; uploaded: boolean }> {
  let moved = false
  let uploaded = false
  try {
    await warmOriginTitles(now)
  } catch {
    // titles are a nicety: never fail the pass
  }
  const rows = await queueRows(io)
  const own = rows.find((r) => r.pc === io.pc)?.version ?? 0
  let problem: Error | null = null
  try {
    uploaded = await upload(io, own, now)
    moved = uploaded
  } catch (err) {
    problem = err instanceof Error ? err : new Error(String(err))
  }
  const others = rows.filter((r) => r.pc !== io.pc && PC_RE.test(r.pc))
  keepRemote(new Set(others.map((r) => r.pc)))
  for (const row of others) {
    if (remoteVersion(row.pc) === row.version) continue
    try {
      // Through the mirror: a version it already holds is not fetched again.
      const r = io.mirror
        ? await io.mirror.getItem('queues', row.pc)
        : await io.call('GET', `/v1/queues/${row.pc}`)
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
  return { moved, uploaded }
}
