// server/src/climayte-ping.ts — pings to the chat that dispatched CliMayte work (docs/CLIMAYTE.md
// "Pings to the dispatching chat").
//
// WHY (owner, 2026-10-03): "when a CliMayte worker finishes, stops, or is five-hour/weekly limited
// and moved, the orchestrator chat that started it is pinged, so that chat knows without polling."
// Until now the chat learned only by polling (climayte_status, or a background climayte_wait it had
// to remember to start, and restart after every wake).
//
// HOW: every worker change is diffed against the last snapshot of that worker (pingEvents). What the
// chat must act on (finished, needs-verdict, check-failed, failed, cancelled, group-done) and what it
// only needs to know (limited-moved, stuck) goes into a per-origin outbox, batched so a burst of
// finishes costs the chat one turn, not fifteen. The outbox lives in `<dir>/pings.json`: an event is
// written there as pending before the send and marked delivered only once the send is confirmed, so
// a daemon restart replays what was not delivered and never what was.
//
// DELIVERY, in order: the chat's own peer pipe (peer-message.ts; it queues behind a running turn),
// retried every 2 minutes for 2 hours while the chat is not live; then, only for a failed or settled
// group on a desktop chat whose instance runs, the composer (POST /api/sessions/:id/message), and
// never after a pipe write that might already have landed; last, one OS toast and the batch kept as
// `unreadPings` for the caller's next climayte_status. A manager worker (origin kind 'worker') gets
// the text as a non-urgent climayteSend instead.
//
// WHAT A PING CARRIES: ids, titles, groups, statuses, accounts by instance number and short reasons.
// Never a prompt, a report, a follow-up or a verdict note, so worker text never enters the chat.
//
// Kill switch: the file `<dir>/ping-off`. While it exists nothing is recorded or sent.
//
// Every dependency (the worker list and its change feed, the transports, the clock, the folder) is
// passed to startCliMaytePing, so the batching and the delivery chain are tested with a fake clock
// and fake transports (server/tests/climayte-ping.test.ts).

import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { CliMayteStatus } from './climayte-lib'
import { writeJsonStoreAtomic } from './core/json-store'
import { deliverPeerMessage } from './peer-message'

/** A worker waiting longer than this is reported stuck: the five-minute rule (RESUME_WAIT_MS in
 *  climayte-placement.ts) says no task waits longer while an account admits it. */
export const STUCK_AFTER_MS = 5 * 60_000
/** A settled group, or an origin with no live work left, is reported this soon. */
export const SETTLED_FLUSH_MS = 10_000
/** Otherwise the first waking event opens a window that closes after this much quiet... */
export const QUIET_FLUSH_MS = 90_000
/** ...or this long after its oldest waking event, whichever is first. */
export const MAX_BATCH_MS = 5 * 60_000
/** Information-only events go alone after this, when nothing waking comes to carry them. */
export const INFO_ALONE_MS = 30 * 60_000
/** The timer that catches stuck workers and due batches. */
export const HEARTBEAT_MS = 15_000
/** A chat that is not live is tried again this often... */
export const RETRY_EVERY_MS = 2 * 60_000
/** ...for this long, before the composer or the toast. */
export const RETRY_FOR_MS = 2 * 3_600_000
/** How long the peer pipe has to show the message in the chat's transcript. */
export const PEER_CONFIRM_MS = 45_000

const MAX_BULLETS = 15
const TITLE_MAX = 80
const REASON_MAX = 160
const DELIVERED_KEYS_MAX = 5000
const UNREAD_MAX = 20
const FORGET_ORIGIN_MS = 7 * 24 * 3_600_000

/** Who dispatched a worker, so its news goes back there. A chat is reached through its Claude home's
 *  live registry (`home`/sessions); a manager worker through climayteSend. */
export type CliMayteOrigin =
  | { kind: 'chat'; sessionId: string; home: string; transcript: string | null; how: string }
  | { kind: 'worker'; workerId: string }

type ChatOrigin = Extract<CliMayteOrigin, { kind: 'chat' }>

/** The part of an attempt a ping reads. A CliMayteAttempt is one. */
export interface PingAttempt {
  account: { id: string; num: number | null; name?: string }
  startedAt: number
  endedAt: number | null
  outcome: string
  notice?: string | null
  ceiling?: { pct: number; week: boolean } | null
  windDown?: { pct: number | null; reason?: string } | null
}

/** The part of a worker a ping reads. A CliMayteWorker is one (with `origin` once it carries it). */
export interface PingWorker {
  id: string
  group: string
  title: string
  status: CliMayteStatus
  accountId: string | null
  attempts: PingAttempt[]
  check?: string | null
  checkRunner?: unknown
  verdicts?: Array<{ verdict: 'pass' | 'fail'; by?: string }>
  error: string | null
  origin?: CliMayteOrigin
}

export type PingKind =
  | 'finished' // its check passed
  | 'needs-verdict' // done, with no check to judge it
  | 'check-failed' // its check failed; sent back one rung
  | 'failed' // includes a notConverging stop
  | 'cancelled'
  | 'group-done' // every worker of this origin in that group has ended
  | 'limited-moved' // information only: hit a 5-hour or weekly limit, resumed on another account
  | 'stuck' // information only: waiting longer than STUCK_AFTER_MS

const INFO_KINDS: ReadonlySet<PingKind> = new Set(['limited-moved', 'stuck'])
const TERMINAL: ReadonlySet<CliMayteStatus> = new Set(['done', 'failed', 'cancelled'])

export interface PingEvent {
  /** `${workerId}:${kind}:${attemptIndex}` (a group's: `${group}:group-done:${attempts}`). */
  key: string
  kind: PingKind
  workerId: string | null
  group: string
  at: number
  /** The bullet, without its "• ". */
  line: string
}

export interface QueuedPing extends PingEvent {
  seq: number
}

/** What pingEvents compares: one worker as it was at the last look. */
export interface PingSnapshot {
  status: CliMayteStatus
  accountId: string | null
  attempts: number
  checkRunner: boolean
  verdicts: number
  /** When it started waiting, while it waits (for `stuck`). */
  waitingSince: number | null
}

const NEW_WORKER: PingSnapshot = {
  status: 'queued',
  accountId: null,
  attempts: 0,
  checkRunner: false,
  verdicts: 0,
  waitingSince: null,
}

export function snapshotOf(w: PingWorker, prev: PingSnapshot | null, now: number): PingSnapshot {
  return {
    status: w.status,
    accountId: w.accountId,
    attempts: w.attempts.length,
    checkRunner: !!w.checkRunner,
    verdicts: w.verdicts?.length ?? 0,
    waitingSince:
      w.status !== 'waiting'
        ? null
        : prev?.status === 'waiting' && prev.waitingSince != null
          ? prev.waitingSince
          : now,
  }
}

const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** An error's first line, cut, without a closing full stop (the bullet adds its own). */
const reason = (s: string | null | undefined, fallback: string): string => {
  const line = (s ?? '').split('\n')[0].trim()
  return cut(line || fallback, REASON_MAX).replace(/[.!]+$/, '')
}

/** An account by its instance number, never its name (which can be a login). */
const accountLabel = (a: PingAttempt | undefined): string =>
  a?.account.num != null ? `#${a.account.num}` : 'an unnumbered account'

/** How an attempt ending this way stopped at a usage limit, or null when it did not (a context
 *  handoff, a transient retry, an error). */
function limitStop(a: PingAttempt): string | null {
  const window = (week: boolean) => (week ? 'weekly' : '5-hour')
  if (a.ceiling)
    return `reached ${Math.round(a.ceiling.pct)}% of its ${window(a.ceiling.week)} limit`
  if (a.outcome === 'quota') return `hit its ${window(/week/i.test(a.notice ?? ''))} limit`
  if (a.outcome === 'handoff' && a.windDown?.pct != null && a.windDown.reason !== 'context')
    return `reached ${Math.round(a.windDown.pct)}% of its usage limit`
  return null
}

/** What changed for the dispatching chat between `prev` (null: a worker not seen before) and `w`.
 *  Pure: the outbox drops a key it already holds or delivered, so calling this again is safe. */
export function pingEvents(prev: PingSnapshot | null, w: PingWorker, now: number): PingEvent[] {
  const p = prev ?? NEW_WORKER
  const n = w.attempts.length
  const who = `${w.id} "${cut(w.title, TITLE_MAX)}"`
  const out: PingEvent[] = []
  const add = (kind: PingKind, line: string, index = n) =>
    out.push({
      key: `${w.id}:${kind}:${index}`,
      kind,
      workerId: w.id,
      group: w.group,
      at: now,
      line,
    })

  for (let i = Math.max(1, p.attempts); i < n; i++) {
    const before = w.attempts[i - 1]
    const after = w.attempts[i]
    if (before.account.id === after.account.id) continue
    const stop = limitStop(before)
    if (!stop) continue
    const gap = Math.max(
      0,
      Math.round((after.startedAt - (before.endedAt ?? after.startedAt)) / 1000),
    )
    add(
      'limited-moved',
      `${who}: ${accountLabel(before)} ${stop}; resumed on ${accountLabel(after)} after ${gap}s.`,
      i + 1,
    )
  }

  const judged = (w.verdicts ?? []).slice(p.verdicts).filter((v) => v.by === 'check')
  const check = judged.at(-1)?.verdict ?? null
  const last = w.attempts.at(-1)
  const entered = w.status !== p.status
  if (check === 'fail') {
    const back = w.status === 'queued' || w.status === 'running' || w.status === 'waiting'
    add('check-failed', `${who}: check failed, ${back ? 'sent back' : 'not sent back'}.`)
  }
  if (w.status === 'done' && check === 'pass')
    add('finished', `${who}: done on ${accountLabel(last)}, check passed.`)
  else if (w.status === 'done' && entered)
    add('needs-verdict', `${who}: done on ${accountLabel(last)}, needs your verdict.`)
  if (w.status === 'failed' && entered)
    add('failed', `${who}: failed: ${reason(w.error, 'no reason recorded')}.`)
  if (w.status === 'cancelled' && entered) add('cancelled', `${who}: cancelled.`)
  if (
    w.status === 'waiting' &&
    p.status === 'waiting' &&
    p.waitingSince != null &&
    now - p.waitingSince > STUCK_AFTER_MS
  ) {
    const mins = Math.round((now - p.waitingSince) / 60_000)
    add('stuck', `${who}: waiting ${mins} min: ${reason(w.error, 'no account is free')}.`)
  }
  return out
}

/** Local wall-clock time, HH:MM. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The text of one ping. `workers`: the origin's workers now, for the group tally. */
export function pingMessage(
  events: ReadonlyArray<Pick<QueuedPing, 'seq' | 'at' | 'group' | 'line'>>,
  workers: readonly PingWorker[],
): string {
  const seqs = events.map((e) => e.seq)
  const lo = Math.min(...seqs)
  const hi = Math.max(...seqs)
  const n = events.length
  const lines = [
    `[AgentHydra · CliMayte] Not from the user. Ping ${lo === hi ? lo : `${lo}-${hi}`}, ${n} update${n === 1 ? '' : 's'} since ${hhmm(Math.min(...events.map((e) => e.at)))}:`,
    ...events.slice(0, MAX_BULLETS).map((e) => `• ${e.line}`),
  ]
  if (n > MAX_BULLETS) lines.push(`+${n - MAX_BULLETS} more`)
  const groups = [...new Set(events.map((e) => e.group))]
  for (const g of groups) {
    const ws = workers.filter((w) => w.group === g)
    const count = (...s: CliMayteStatus[]) => ws.filter((w) => s.includes(w.status)).length
    const cancelled = count('cancelled')
    lines.push(
      `Group ${g}: ${count('done')} done, ${count('failed')} failed${cancelled ? `, ${cancelled} cancelled` : ''}, ${count('running', 'checking')} running, ${count('queued', 'waiting')} waiting.`,
    )
  }
  const also =
    groups.length > 1
      ? ` (also ${groups
          .slice(1)
          .map((g) => `"${g}"`)
          .join(', ')})`
      : ''
  lines.push(
    `Next: climayte_status {group:"${groups[0] ?? ''}", report:true}${also}, then climayte_verdict.`,
  )
  return lines.join('\n')
}

// ---- the outbox -----------------------------------------------------------------------------

interface OriginBox {
  origin: CliMayteOrigin
  /** The last seq handed out to this origin. */
  seq: number
  pending: QueuedPing[]
  /** Keys sent (or given up on into `unread`), newest last, capped. */
  deliveredKeys: string[]
  lastFlush: number | null
  /** A group settled, or the origin has no live work: flush SETTLED_FLUSH_MS after this. */
  urgentAt: number | null
  /** Set by a failed send: the next try, and whether the composer is ruled out (a pipe write that
   *  may have landed, so typing would risk a duplicate). */
  retry: { firstAt: number; nextAt: number; tries: number; composerUnsafe: boolean } | null
  /** Pings no channel delivered, for the caller's next climayte_status. */
  unread: Array<{ at: number; seqs: string; text: string }>
}

interface PingLedger {
  version: 1
  origins: Record<string, OriginBox>
}

export interface PingClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: PingClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface CliMaytePingDeps {
  /** Holds pings.json, the ping-off switch and pings-journal.jsonl (~/.agenthydra/climayte). */
  dir: string
  /** Every worker now. */
  workers(): PingWorker[]
  /** Calls `cb` on every worker change (onCliMayteChange); returns the unsubscribe. */
  subscribe(cb: (w: PingWorker) => void): () => void
  /** A non-urgent message to a manager worker (climayteSend). */
  climayteSend(workerId: string, text: string): { ok: boolean; message: string }
  clock?: PingClock
  /** deliverPeerMessage by default. */
  deliverPeer?(
    sessionId: string,
    transcript: string | null,
    text: string,
    confirmMs: number,
    claudeHome: string,
  ): Promise<{ ok: boolean; reason: string }>
  /** The composer route. `eligible`: the chat is a desktop chat and its instance runs. Absent: the
   *  chain skips the composer. */
  composer?: {
    eligible(origin: ChatOrigin): Promise<boolean>
    send(sessionId: string, text: string): Promise<{ ok: boolean; reason: string }>
  }
  /** One OS notification (notify-os sendOsNotification by default). */
  toast?(n: { title: string; body: string }): Promise<unknown>
  /** One line per failed delivery; appended to `<dir>/pings-journal.jsonl` by default. */
  journal?(line: Record<string, unknown>): void
}

export interface CliMaytePing {
  /** Diff one worker now (what the change feed calls). */
  observe(w: PingWorker): void
  /** Send every pending batch now, ignoring the windows; resolves when the sends settle. */
  flushNow(): Promise<void>
  /** Resolves once no send is in flight. */
  idle(): Promise<void>
  /** Pings for this chat that no channel delivered; `clear` marks them read. */
  unreadPings(sessionId: string, opts?: { clear?: boolean }): { count: number; texts: string[] }
  /** The chats holding unread pings: climayte_status traces its caller only when there are any. */
  unreadSessions(): string[]
  stop(): void
}

const originKey = (o: CliMayteOrigin): string =>
  o.kind === 'chat' ? `chat:${o.sessionId}` : `worker:${o.workerId}`

const sameOrigin = (a: CliMayteOrigin | undefined, b: CliMayteOrigin): boolean =>
  !!a && originKey(a) === originKey(b)

const seqRange = (batch: QueuedPing[]): string => {
  const s = batch.map((e) => e.seq)
  const lo = Math.min(...s)
  const hi = Math.max(...s)
  return lo === hi ? `${lo}` : `${lo}-${hi}`
}

const originLabel = (o: CliMayteOrigin): string =>
  o.kind === 'chat' ? o.sessionId.slice(0, 8) : o.workerId

/** Start pinging. Seeds a snapshot of every worker (emitting nothing for what happened before),
 *  replays the ledger's undelivered pings, subscribes to changes and arms the timer. */
export function startCliMaytePing(deps: CliMaytePingDeps): CliMaytePing {
  const clock = deps.clock ?? realClock
  const file = join(deps.dir, 'pings.json')
  const offFile = join(deps.dir, 'ping-off')
  const deliverPeer = deps.deliverPeer ?? deliverPeerMessage
  const toast =
    deps.toast ??
    (async (n: { title: string; body: string }) =>
      (await import('./notify-os')).sendOsNotification(n))
  const journal =
    deps.journal ??
    ((line: Record<string, unknown>) => {
      try {
        appendFileSync(join(deps.dir, 'pings-journal.jsonl'), `${JSON.stringify(line)}\n`)
      } catch {
        // the journal must never stop a ping
      }
    })

  const ledger = loadLedger(file, journal, clock.now())
  // An origin with nothing owed and no news for a week is forgotten. Its delivered keys only guard
  // against a re-send in this daemon's life (the first pass emits nothing), so dropping them is safe.
  for (const [k, box] of Object.entries(ledger.origins))
    if (
      !box.pending.length &&
      !box.unread.length &&
      clock.now() - (box.lastFlush ?? 0) > FORGET_ORIGIN_MS
    )
      delete ledger.origins[k]
  const snaps = new Map<string, PingSnapshot>()
  const inflight = new Map<string, Promise<void>>()
  let timer: unknown = null
  let stopped = false

  const pingOff = () => existsSync(offFile)
  const save = () => {
    try {
      writeJsonStoreAtomic(file, ledger)
    } catch (err) {
      journal({
        ts: new Date(clock.now()).toISOString(),
        event: 'ping-ledger-unwritten',
        reason: String(err),
      })
    }
  }
  const fail = (box: OriginBox, batch: QueuedPing[], step: string, why: string) =>
    journal({
      ts: new Date(clock.now()).toISOString(),
      event: 'ping-failed',
      origin: originLabel(box.origin),
      seq: seqRange(batch),
      step,
      reason: why,
    })

  const workersOf = (o: CliMayteOrigin, latest?: PingWorker): PingWorker[] => {
    const all = deps.workers().map((x) => (latest && x.id === latest.id ? latest : x))
    if (latest && !all.some((x) => x.id === latest.id)) all.push(latest)
    return all.filter((x) => sameOrigin(x.origin, o))
  }

  const boxFor = (o: CliMayteOrigin): OriginBox => {
    const k = originKey(o)
    let box = ledger.origins[k]
    if (!box) {
      box = {
        origin: o,
        seq: 0,
        pending: [],
        deliveredKeys: [],
        lastFlush: null,
        urgentAt: null,
        retry: null,
        unread: [],
      }
      ledger.origins[k] = box
    }
    box.origin = o // a resumed chat may come back with another transcript path
    return box
  }

  const enqueue = (box: OriginBox, events: PingEvent[]): boolean => {
    let added = false
    for (const e of events) {
      if (box.deliveredKeys.includes(e.key) || box.pending.some((p) => p.key === e.key)) continue
      box.pending.push({ ...e, seq: ++box.seq })
      added = true
    }
    return added
  }

  const noLive = (o: CliMayteOrigin, latest?: PingWorker) =>
    workersOf(o, latest).every((x) => TERMINAL.has(x.status))

  const observe = (w: PingWorker) => {
    if (stopped) return
    const now = clock.now()
    const prev = snaps.get(w.id) ?? null
    const events = pingEvents(prev, w, now)
    snaps.set(w.id, snapshotOf(w, prev, now))
    const origin = w.origin
    if (!origin || !events.length || pingOff()) return
    const box = boxFor(origin)
    if (TERMINAL.has(w.status)) {
      const group = workersOf(origin, w).filter((x) => x.group === w.group)
      if (group.every((x) => TERMINAL.has(x.status))) {
        const attempts = group.reduce((s, x) => s + x.attempts.length, 0)
        events.push({
          key: `${w.group}:group-done:${attempts}`,
          kind: 'group-done',
          workerId: null,
          group: w.group,
          at: now,
          line: `Group ${w.group} settled: every task (${group.length}) has ended.`,
        })
      }
    }
    if (!enqueue(box, events)) return
    const waking = events.some((e) => !INFO_KINDS.has(e.kind))
    if (events.some((e) => e.kind === 'group-done') || (waking && noLive(origin, w)))
      box.urgentAt ??= now
    save()
    arm()
  }

  /** When this box's batch is due, or null when it has none. */
  const dueAt = (box: OriginBox): number | null => {
    if (!box.pending.length) return null
    if (box.retry) return box.retry.nextAt
    const waking = box.pending.filter((p) => !INFO_KINDS.has(p.kind))
    if (waking.length) {
      if (box.urgentAt != null) return box.urgentAt + SETTLED_FLUSH_MS
      const ats = waking.map((p) => p.at)
      return Math.min(Math.max(...ats) + QUIET_FLUSH_MS, Math.min(...ats) + MAX_BATCH_MS)
    }
    return Math.min(...box.pending.map((p) => p.at)) + INFO_ALONE_MS
  }

  const settle = (box: OriginBox, batch: QueuedPing[]) => {
    const sent = new Set(batch.map((e) => e.key))
    box.pending = box.pending.filter((p) => !sent.has(p.key))
    box.deliveredKeys = [...box.deliveredKeys, ...sent].slice(-DELIVERED_KEYS_MAX)
    box.lastFlush = clock.now()
    box.retry = null
    box.urgentAt = null
    const waking = box.pending.some((p) => !INFO_KINDS.has(p.kind))
    if (box.pending.some((p) => p.kind === 'group-done') || (waking && noLive(box.origin)))
      box.urgentAt = clock.now()
  }

  /** A send failed: try again in RETRY_EVERY_MS, or report true once RETRY_FOR_MS has passed. */
  const retryOrGiveUp = (box: OriginBox, unsafe: boolean): boolean => {
    const now = clock.now()
    box.retry = box.retry
      ? { ...box.retry, tries: box.retry.tries + 1 }
      : { firstAt: now, nextAt: now, tries: 1, composerUnsafe: false }
    if (unsafe) box.retry.composerUnsafe = true
    box.retry.nextAt = now + RETRY_EVERY_MS
    return now - box.retry.firstAt >= RETRY_FOR_MS
  }

  const sendChat = async (box: OriginBox, o: ChatOrigin, batch: QueuedPing[], text: string) => {
    const r = await deliverPeer(o.sessionId, o.transcript, text, PEER_CONFIRM_MS, o.home).catch(
      (err) => ({ ok: false, reason: `error: ${String(err)}` }),
    )
    if (r.ok) return settle(box, batch)
    fail(box, batch, 'peer', r.reason)
    if (!retryOrGiveUp(box, r.reason === 'wrote-but-no-transcript-growth')) return
    const settles = batch.some((e) => e.kind === 'group-done' || e.kind === 'failed')
    if (settles && !box.retry?.composerUnsafe && deps.composer) {
      const ok = await deps.composer.eligible(o).catch(() => false)
      if (ok) {
        const c = await deps.composer
          .send(o.sessionId, text)
          .catch((err) => ({ ok: false, reason: String(err) }))
        if (c.ok) return settle(box, batch)
        fail(box, batch, 'composer', c.reason)
      }
    }
    // Last resort: the human hears of it, and the caller's next climayte_status shows it.
    const groups = [...new Set(batch.map((e) => e.group))].join(', ')
    await toast({
      title: 'CliMayte: a chat missed its ping',
      body: `Chat ${originLabel(o)} was not reachable for 2 hours. Ping ${seqRange(batch)}: ${batch.length} update${batch.length === 1 ? '' : 's'} (${groups}). It shows in that chat's next climayte_status.`,
    }).catch(() => undefined)
    box.unread = [...box.unread, { at: clock.now(), seqs: seqRange(batch), text }].slice(
      -UNREAD_MAX,
    )
    settle(box, batch)
  }

  const sendWorker = (box: OriginBox, workerId: string, batch: QueuedPing[], text: string) => {
    let r: { ok: boolean; message: string }
    try {
      r = deps.climayteSend(workerId, text)
    } catch (err) {
      r = { ok: false, message: String(err) }
    }
    if (r.ok) return settle(box, batch)
    fail(box, batch, 'climayte_send', r.message)
    if (retryOrGiveUp(box, false)) {
      fail(box, batch, 'dropped', 'not delivered for 2 hours')
      settle(box, batch)
    }
  }

  const flush = (box: OriginBox) => {
    const k = originKey(box.origin)
    if (inflight.has(k) || !box.pending.length) return
    const batch = [...box.pending]
    const text = pingMessage(batch, workersOf(box.origin))
    const o = box.origin
    // Deferred one microtask, so the entry is in `inflight` before a synchronous send's
    // `finally` takes it out again.
    const run = Promise.resolve().then(async () => {
      try {
        if (o.kind === 'worker') sendWorker(box, o.workerId, batch, text)
        else await sendChat(box, o, batch, text)
      } finally {
        inflight.delete(k)
        save()
        arm()
      }
    })
    inflight.set(k, run)
  }

  const flushDue = () => {
    if (pingOff()) return
    const now = clock.now()
    for (const box of Object.values(ledger.origins)) {
      const due = dueAt(box)
      if (due != null && due <= now) flush(box)
    }
  }

  const arm = () => {
    if (stopped) return
    if (timer != null) clock.clearTimeout(timer)
    const now = clock.now()
    let next = now + HEARTBEAT_MS
    if (!pingOff())
      for (const [k, box] of Object.entries(ledger.origins)) {
        if (inflight.has(k)) continue
        const due = dueAt(box)
        if (due != null) next = Math.min(next, Math.max(due, now))
      }
    timer = clock.setTimeout(tick, next - now)
  }

  function tick() {
    timer = null
    if (stopped) return
    for (const w of deps.workers()) observe(w) // catches stuck workers and any missed change
    flushDue()
    arm()
  }

  const idle = async () => {
    while (inflight.size) await Promise.all([...inflight.values()])
  }

  // The first pass seeds: what happened before this daemon started is not news.
  const now = clock.now()
  for (const w of deps.workers()) snaps.set(w.id, snapshotOf(w, null, now))
  const unsubscribe = deps.subscribe(observe)
  arm()

  return {
    observe,
    idle,
    async flushNow() {
      if (!pingOff()) for (const box of Object.values(ledger.origins)) flush(box)
      await idle()
    },
    unreadPings(sessionId, opts = {}) {
      const box = ledger.origins[`chat:${sessionId}`]
      const texts = box?.unread.map((u) => u.text) ?? []
      if (box && opts.clear && texts.length) {
        box.unread = []
        save()
      }
      return { count: texts.length, texts }
    },
    unreadSessions() {
      return Object.values(ledger.origins).flatMap((b) =>
        b.origin.kind === 'chat' && b.unread.length ? [b.origin.sessionId] : [],
      )
    },
    stop() {
      stopped = true
      unsubscribe()
      if (timer != null) clock.clearTimeout(timer)
      timer = null
    },
  }
}

/** The ledger, or an empty one when there is none. A file that does not parse is moved aside (kept
 *  for a look) rather than overwritten. */
function loadLedger(
  file: string,
  journal: (line: Record<string, unknown>) => void,
  now: number,
): PingLedger {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { version: 1, origins: {} }
  }
  try {
    const v = JSON.parse(raw) as PingLedger
    if (v && v.version === 1 && v.origins && typeof v.origins === 'object') return v
  } catch {
    // fall through
  }
  const aside = `${file}.corrupt-${now}`
  try {
    renameSync(file, aside)
  } catch {
    // the next save replaces it
  }
  journal({ ts: new Date(now).toISOString(), event: 'ping-ledger-corrupt', path: aside })
  return { version: 1, origins: {} }
}
