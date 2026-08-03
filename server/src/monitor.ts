// server/src/monitor.ts — the auto-resume rate-limit watchdog (Feature E / §6B).
//
// The idea: a session killed mid-work by a 5-HOUR rate limit should auto-resume once the window
// clears — sleep through a limit, wake to finished work — but ONLY when the WEEKLY (all-models) cap
// isn't maxed (resuming into a maxed weekly bucket just slams the wall). This reuses everything that
// already exists:
//   · Detection is FREE + structured: dispatch.ts already sniffs the rate-limit signature and
//     finalizes such runs with status 'rate_limited' (the primary, reliable signal — not log
//     scraping). A rate_limited dispatch IS a mid-work stop by definition (it didn't complete).
//     That covers runs WE started. Sessions the user ran themselves (a bare `claude` in a terminal)
//     never get a queue row at all, so they were invisible here — the list said "nothing to resume"
//     with real sessions stuck at the wall. rate-limit-discovery.ts finds those on disk and hands
//     them over as ordinary stops, so both kinds meet the same gate below.
//   · Scheduling is FREE: a resume is just a normal queue_item (--resume <session-id> with a locked
//     prompt) whose `not_before` is set to just after the 5h reset. dispatch.ts already resumes
//     sessions this exact way, authenticated by the same env-token path (§7-Q1/Q5).
//   · The 5h-vs-weekly guardrail is checkUsage: session.resets gives the 5h reset to schedule
//     against; weekAll.pct is the go/no-go.
//
// Safety rails (it auto-prompts while the user sleeps, so they are tight): OFF by default; a global
// switch + optional per-account opt-out; at most N resumes per session (resume_attempts cap) then
// "needs human"; idempotent (never double-queues a resume for a session that already has one).

import { isDispatchReady } from './boot-state'
import { coerceQueueItem, db, getSetting, setSetting } from './db'
import { dispatchItem, isActive, isSessionActive } from './dispatch'
import { sessionMetaMap } from './instance-sessions'
import { discoverPendingStops, type RateLimitedStop } from './rate-limit-discovery'
import type {
  MonitorSettings,
  MonitorStateName,
  MonitorStatusRow,
  QueueItem,
  UsageSnapshot,
} from './types'
import { parseResetTime } from './usage'
import { checkUsageAmbient, checkUsageForAccount } from './usage-service'

/**
 * The one outside-world read this module makes, behind a seam so tests can drive the gate.
 *
 * Not indirection for its own sake: a real read either calls the API with the developer's own login
 * or spawns `claude -p "/usage"` (~9s), so without this the gate's branches can only be exercised by
 * globally mock.module-ing usage-service — which in Bun leaks into every other test file in the run.
 */
export interface MonitorDeps {
  readUsage: (accountId: string | null) => Promise<UsageSnapshot>
  /**
   * Rate-limited sessions found on disk that we never dispatched (rate-limit-discovery.ts). Behind
   * the same seam and for the same reason as readUsage: the real one globs the transcript store and
   * reads files, which a unit test has no business doing to the developer's actual ~/.claude.
   */
  discoverStops: () => Promise<RateLimitedStop[]>
}

const defaultDeps: MonitorDeps = {
  // A run with no dispatch account is not an unauthenticated run: it uses the ambient CLI login,
  // whose quota is just as readable. See checkUsageAmbient.
  readUsage: (accountId) => (accountId ? checkUsageForAccount(accountId) : checkUsageAmbient()),
  discoverStops: () =>
    discoverPendingStops({
      isBusy: (sessionId) => isSessionActive(sessionId),
      hasQueueRow: (sessionId) =>
        !!db
          .query<{ n: number }, [string]>(
            'select count(*) as n from queue_items where session_id = ?',
          )
          .get(sessionId)?.n,
    }),
}

/** The locked resume prompt — a code constant, not a field users casually edit (an advanced
 *  override lives in settings if ever needed). "resume" nudges the model to continue its task. */
export const DEFAULT_RESUME_PROMPT = 'resume'

const MONITOR_POLL_MS = 30_000

// --- settings ----------------------------------------------------------------

function num(key: string, fallback: number, min: number, max: number): number {
  const n = Number(getSetting(key))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function getMonitorSettings(): MonitorSettings {
  return {
    enabled: getSetting('monitor_enabled') === '1',
    maxAttempts: num('monitor_max_attempts', 3, 1, 100),
    resumeBufferMin: num('monitor_resume_buffer_min', 3, 0, 24 * 60),
    resumePrompt: getSetting('monitor_resume_prompt') || DEFAULT_RESUME_PROMPT,
  }
}

export function setMonitorSettings(patch: Partial<MonitorSettings>): MonitorSettings {
  if (typeof patch.enabled === 'boolean') setSetting('monitor_enabled', patch.enabled ? '1' : '0')
  if (typeof patch.maxAttempts === 'number' && Number.isFinite(patch.maxAttempts))
    setSetting(
      'monitor_max_attempts',
      String(Math.min(100, Math.max(1, Math.floor(patch.maxAttempts)))),
    )
  if (typeof patch.resumeBufferMin === 'number' && Number.isFinite(patch.resumeBufferMin))
    setSetting(
      'monitor_resume_buffer_min',
      String(Math.min(24 * 60, Math.max(0, Math.floor(patch.resumeBufferMin)))),
    )
  if (typeof patch.resumePrompt === 'string' && patch.resumePrompt.trim())
    setSetting('monitor_resume_prompt', patch.resumePrompt.trim().slice(0, 1000))
  return getMonitorSettings()
}

/** Per-account: a row with enabled=0 opts that account OUT while the global switch is on. */
export function monitorEnabledForAccount(accountId: string): boolean {
  const row = db
    .query<{ enabled: number }, [string]>(
      'select enabled from monitor_accounts where account_id = ?',
    )
    .get(accountId)
  return row ? row.enabled === 1 : true
}

export function setMonitorForAccount(accountId: string, enabled: boolean): void {
  db.query(
    'insert into monitor_accounts (account_id, enabled) values (?, ?) on conflict(account_id) do update set enabled = ?',
  ).run(accountId, enabled ? 1 : 0, enabled ? 1 : 0)
}

/** Forget an account's override — for when the account itself is deleted. The table has no foreign
 *  key, so the row would otherwise outlive it and quietly re-apply an old opt-out to any future
 *  account that happened to reuse the id. */
export function clearMonitorForAccount(accountId: string): void {
  db.query('delete from monitor_accounts where account_id = ?').run(accountId)
}

export function listMonitorAccounts(): Record<string, boolean> {
  const rows = db
    .query<{ account_id: string; enabled: number }, []>(
      'select account_id, enabled from monitor_accounts',
    )
    .all()
  return Object.fromEntries(rows.map((r) => [r.account_id, r.enabled === 1]))
}

// --- state -------------------------------------------------------------------

interface MonitorStateRow {
  item_id: string
  session_id: string
  account_id: string | null
  resume_attempts: number
  state: MonitorStateName
  resume_item_id: string | null
  message: string | null
  next_check_at: string | null
  updated_at: string
  /** Set for discovered stops, which have no queue_items row to join a title out of. */
  title: string | null
  discovered: number
}

function getState(itemId: string): MonitorStateRow | null {
  return (
    db
      .query<MonitorStateRow, [string]>('select * from monitor_state where item_id = ?')
      .get(itemId) ?? null
  )
}

function upsertState(
  item: RateLimitedStop,
  fields: {
    state: MonitorStateName
    message: string | null
    resumeItemId: string | null
    attempts: number
    nextCheckAt?: string | null
  },
): void {
  db.query(
    `insert into monitor_state
       (item_id, session_id, account_id, resume_attempts, state, resume_item_id, message, next_check_at, updated_at, title, discovered)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(item_id) do update set
       resume_attempts = excluded.resume_attempts,
       state = excluded.state,
       resume_item_id = excluded.resume_item_id,
       message = excluded.message,
       next_check_at = excluded.next_check_at,
       updated_at = excluded.updated_at,
       title = excluded.title,
       discovered = excluded.discovered`,
  ).run(
    item.id,
    item.session_id,
    item.account_id ?? null,
    fields.attempts,
    fields.state,
    fields.resumeItemId,
    fields.message,
    fields.nextCheckAt ?? null,
    new Date().toISOString(),
    // Stored for EVERY row, not just discovered ones. A dispatched stop used to join its title back
    // out of queue_items, so clearing finished runs from the queue left the row labelled with a bare
    // session id. The title is a snapshot of a moment anyway; keeping our own copy makes the row
    // stand on its own.
    item.title,
    item.discovered ? 1 : 0,
  )
}

/** The most resume attempts already spent on this session (the cap is per session, not per stop). */
function sessionAttempts(sessionId: string): number {
  const row = db
    .query<{ m: number | null }, [string]>(
      'select max(resume_attempts) as m from monitor_state where session_id = ?',
    )
    .get(sessionId)
  return row?.m ?? 0
}

/** Idempotency: a live (queued/running) resume already exists for this session. */
function hasPendingResume(sessionId: string): boolean {
  const rows = db
    .query<{ resume_item_id: string | null }, [string]>(
      "select resume_item_id from monitor_state where session_id = ? and state = 'scheduled'",
    )
    .all(sessionId)
  for (const r of rows) {
    if (!r.resume_item_id) continue
    const q = db
      .query<{ status: string }, [string]>('select status from queue_items where id = ?')
      .get(r.resume_item_id)
    if (q && (q.status === 'queued' || q.status === 'running')) return true
  }
  return false
}

/**
 * Settle every 'scheduled' row whose resume has already had its outcome.
 *
 * Nothing else does this. A row was written the moment a resume was enqueued and then never looked
 * at again: `processRateLimited` skips any stop it has already seen, `dispatchDueResumes` only
 * dispatches, and `finalize`/`cancelItem` in dispatch.ts touch `queue_items` alone. So a resume that
 * ran to completion in March still reported "Scheduled · resumes ~09:14" forever, and deleting the
 * queue item left a row pointing at nothing at all. That is why the list filled up with runs the
 * user knew were long finished or cancelled.
 *
 * Called from monitorStatus() rather than only from the tick, deliberately: the tick returns early
 * while the monitor is switched OFF, which is exactly when a user is most likely to be looking at
 * this list wondering why it is full of history.
 */
function reconcileScheduled(): void {
  const rows = db
    .query<{ item_id: string; resume_item_id: string | null }, []>(
      "select item_id, resume_item_id from monitor_state where state = 'scheduled'",
    )
    .all()
  for (const r of rows) {
    // A 'scheduled' row with no resume id never got one; there is nothing to wait for.
    const q = r.resume_item_id
      ? db
          .query<{ status: string }, [string]>('select status from queue_items where id = ?')
          .get(r.resume_item_id)
      : null
    // Still pending: leave it alone, this is the one genuinely live case.
    if (q && (q.status === 'queued' || q.status === 'running')) continue

    // A resume that hit the wall again is not this row's problem: the new stop gets its own
    // monitor_state row and its own attempt count. Settle this one either way.
    const settled: { state: MonitorStateName; message: string } = !q
      ? { state: 'done', message: 'the scheduled resume is no longer in the queue' }
      : q.status === 'completed'
        ? { state: 'done', message: 'resumed and finished' }
        : q.status === 'canceled'
          ? { state: 'done', message: 'the scheduled resume was canceled' }
          : q.status === 'failed'
            ? { state: 'needs_human', message: 'the scheduled resume failed' }
            : { state: 'done', message: `the scheduled resume ended (${q.status})` }
    db.query(
      'update monitor_state set state = ?, message = ?, updated_at = ? where item_id = ?',
    ).run(settled.state, settled.message, new Date().toISOString(), r.item_id)
  }
}

/**
 * The stops that still need something to happen, newest first.
 *
 * Deliberately NOT the whole table. This list is a to-do, not a ledger: a finished resume, a
 * cancelled one, or one whose session the user has since archived are all history, and leaving them
 * in made a handful of live items impossible to pick out. The rows stay in the table (they carry the
 * per-session attempt count the cap depends on) — they are just not shown.
 */
export function monitorStatus(): MonitorStatusRow[] {
  reconcileScheduled()
  const meta = sessionMetaMap()
  const rows = db
    .query<MonitorStateRow, []>(
      "select * from monitor_state where state != 'done' order by updated_at desc",
    )
    .all()
    // Archiving is the user saying they are finished with a session. Auto-resume already refuses to
    // touch one (rate-limit-discovery.ts); showing it here as "Scheduled" would promise the resume
    // that deliberately will not happen.
    .filter((r) => !meta.get(r.session_id)?.archived)
  return rows.map((r) => {
    // Rows written before titles were stored on every row still join theirs out of queue_items.
    const t = r.title
      ? null
      : db
          .query<{ title: string }, [string]>('select title from queue_items where id = ?')
          .get(r.item_id)
    return {
      itemId: r.item_id,
      sessionId: r.session_id,
      accountId: r.account_id,
      title: r.title ?? t?.title ?? null,
      state: r.state,
      message: r.message,
      resumeAttempts: r.resume_attempts,
      resumeItemId: r.resume_item_id,
      updatedAt: r.updated_at,
      discovered: r.discovered === 1,
    }
  })
}

// --- resume enqueue ----------------------------------------------------------

/** Enqueue a resume of the rate-limited item's session, scheduled for `notBefore`. Returns its id. */
function enqueueResume(item: QueueItem, notBefore: string): string {
  const id = crypto.randomUUID()
  const prompt = getMonitorSettings().resumePrompt
  const posRow = db
    .query<{ m: number | null }, []>('select max(position) as m from queue_items')
    .get()
  const position = (posRow?.m ?? 0) + 1
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued', ?, ?, ?)`,
  ).run(
    id,
    item.session_id,
    `Auto-resume: ${item.title}`.slice(0, 200),
    item.cwd,
    prompt,
    item.model ?? null,
    item.effort ?? null,
    item.permission_mode ?? null,
    item.account_id ?? null,
    // Carry the ORIGINAL item's pinning forward — otherwise an instance-pinned run that gets
    // auto-resumed loses its pin and resumes as Ambient (wrong credentials, defeats the pin).
    item.instance_ref ?? null,
    position,
    notBefore,
    Date.now(),
  )
  return id
}

function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

function fmtLocalTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// --- the poll loop -----------------------------------------------------------

let ticking = false

async function tick(deps: MonitorDeps): Promise<void> {
  if (getSetting('monitor_enabled') !== '1') return
  if (ticking) return // a slow checkUsage must not let ticks pile up
  ticking = true
  try {
    // Settle finished resumes before anything else reads state, so a session whose resume already
    // completed is eligible for a fresh stop rather than looking permanently "scheduled".
    reconcileScheduled()
    await dispatchDueResumes()
    await processRateLimited(deps)
  } catch (err) {
    console.error('[agenthydra] monitor tick error:', err)
  } finally {
    ticking = false
  }
}

/** Fire OUR scheduled resumes the moment they're due — independent of the global scheduler switch,
 *  since auto-resume is its own opt-in and shouldn't require the main scheduler to be on. */
async function dispatchDueResumes(): Promise<void> {
  // Same boot-window guard as the scheduler (boot-state.ts): a run that survived the previous
  // daemon isn't in `active` until reattachRuns() settles, so isSessionActive() below could miss
  // it and this would auto-resume a SECOND `claude` against a session already running.
  if (!isDispatchReady()) return
  const now = new Date().toISOString()
  const rows = db
    .query<{ resume_item_id: string | null }, []>(
      "select resume_item_id from monitor_state where state = 'scheduled' and resume_item_id is not null",
    )
    .all()
  for (const r of rows) {
    if (!r.resume_item_id) continue
    const raw = db.query('select * from queue_items where id = ?').get(r.resume_item_id)
    if (!raw) continue
    const q = coerceQueueItem(raw)
    const due = !q.not_before || q.not_before <= now
    if (q.status === 'queued' && due && !isActive(q.id) && !isSessionActive(q.session_id)) {
      void dispatchItem(q)
    }
  }
}

async function processRateLimited(deps: MonitorDeps): Promise<void> {
  const settings = getMonitorSettings()
  const now = new Date().toISOString()
  const dispatched: RateLimitedStop[] = db
    .query<QueueItem, []>("select * from queue_items where status = 'rate_limited'")
    .all()
    .map((raw) => ({ ...coerceQueueItem(raw), discovered: false }))
  // Stops we watched happen, plus stops we went and found. From here down they are the same thing:
  // every rail below (opt-out, attempt cap, usage gate, idempotency) applies to both without a
  // branch. A discovery failure must never take the dispatched path down with it.
  let found: RateLimitedStop[] = []
  try {
    found = await deps.discoverStops()
  } catch (err) {
    console.error('[agenthydra] rate-limit discovery failed:', err)
  }

  // Discovery already refuses archived sessions; a stop WE dispatched needs the same guard, or
  // archiving a session would silently fail to stop the resume it was queued for.
  const meta = sessionMetaMap()

  for (const item of [...dispatched, ...found]) {
    if (meta.get(item.session_id)?.archived) continue
    const existing = getState(item.id)

    // Already resolved for this exact stop — skip, except a blocked_weekly re-arms once its
    // re-check time passes (to reconsider after the weekly window resets).
    if (existing) {
      if (existing.state !== 'blocked_weekly') continue
      if (existing.next_check_at && existing.next_check_at > now) continue
    }

    // Per-account opt-out.
    if (item.account_id && !monitorEnabledForAccount(item.account_id)) continue

    const priorAttempts = existing?.resume_attempts ?? sessionAttempts(item.session_id)

    // Idempotent: a live resume already pending for this session.
    if (hasPendingResume(item.session_id)) continue

    // Attempt cap (per session).
    if (priorAttempts >= settings.maxAttempts) {
      upsertState(item, {
        state: 'needs_human',
        message: `hit the ${settings.maxAttempts}-resume cap for this session`,
        resumeItemId: null,
        attempts: priorAttempts,
      })
      continue
    }

    // The usage gate — the crux. Read the run's quota fresh, from whichever credential it actually
    // ran under: a named dispatch account, or (the DEFAULT) the ambient CLI login. Hard-refusing the
    // ambient case made the monitor inert for anyone who never pasted a token in, which is everyone
    // by default: it parked every real stop at "needs you — no dispatch account" and resumed nothing.
    const snap = await deps.readUsage(item.account_id)
    const wk = snap.weekAll
    if (!wk) {
      // Unknown usage is NOT "plenty left" — refuse to resume blindly.
      upsertState(item, {
        state: 'needs_human',
        message: 'could not read usage — not resuming without a reading',
        resumeItemId: null,
        attempts: priorAttempts,
      })
      continue
    }
    if (wk.pct >= 100) {
      const resetIso = parseResetTime(wk.resets)
      upsertState(item, {
        state: 'blocked_weekly',
        message: `blocked: weekly maxed (resets ${wk.resets})`,
        resumeItemId: null,
        attempts: priorAttempts,
        nextCheckAt: resetIso ?? isoIn(60),
      })
      continue
    }

    // Weekly has room → schedule the resume just after the 5-hour session reset (+ buffer). If the
    // 5h reset can't be parsed, fall back to now + 5h (the worst-case window length).
    const sessIso = snap.session ? parseResetTime(snap.session.resets) : null
    const base = sessIso ? new Date(sessIso) : new Date(Date.now() + 5 * 3600 * 1000)
    const notBefore = new Date(base.getTime() + settings.resumeBufferMin * 60_000).toISOString()
    const resumeId = enqueueResume(item, notBefore)
    upsertState(item, {
      state: 'scheduled',
      message: `resumes ~${fmtLocalTime(notBefore)}`,
      resumeItemId: resumeId,
      attempts: priorAttempts + 1,
      nextCheckAt: null,
    })
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startMonitor(): void {
  if (timer) return
  timer = setInterval(() => void tick(defaultDeps), MONITOR_POLL_MS)
}

export function stopMonitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Run one tick now (used by the "check now" route + tests). */
export async function runMonitorOnce(deps: MonitorDeps = defaultDeps): Promise<void> {
  await tick(deps)
}
