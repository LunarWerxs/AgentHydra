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
// No dispatchItem import any more, and that absence is load-bearing: since the no-headless law
// the auto-resume monitor has no way to start an invisible run at all, rather than merely
// choosing not to. The compiler is the guard.
import { isActive, isSessionActive } from './dispatch'
import { sessionMetaMap } from './instance-sessions'
import { getOrchestratorSettings } from './orchestrator'
import { discoverPendingStops, type RateLimitedStop } from './rate-limit-discovery'
import { isSessionSuperseded } from './session-launch'
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
  /**
   * The migrate-on-limit target: a RUNNING desktop instance with headroom, excluding the ref the
   * stop already ran under, or null when no viable account exists. Behind the seam because the
   * real one joins the instance list with the usage cache (orchestrator's routing table).
   * Optional so pre-existing deps objects stay valid; absent means "no target" (scheduled path).
   */
  pickMigrationTarget?: (excludeRef: string | null) => Promise<{ ref: string; name: string } | null>
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
  pickMigrationTarget: async (excludeRef) => {
    // ONE picker, shared with the feed's recommendation and the reviewer's rubric. This used
    // to carry its own inline copy of the eligibility filter, which is one policy living in
    // two places and free to drift; `pickPlacement` is now the only definition of "an account
    // that may take work", and buildInstanceRows is handed the placement ledger so a
    // migration lands somewhere other than wherever the last one went.
    const { buildInstanceRows, getOrchestratorSettings, pickPlacement } = await import(
      './orchestrator'
    )
    const { listInstances } = await import('./core/instances')
    const { allCachedUsage } = await import('./usage-cache')
    const { recentPlacements, recordPlacement } = await import('./placements')
    const s = getOrchestratorSettings()
    const now = Date.now()
    const rows = buildInstanceRows(
      (await listInstances()).map((i) => ({
        dir: i.dir,
        name: i.label ?? i.name,
        isRunning: i.isRunning,
      })),
      allCachedUsage(),
      s,
      now,
      recentPlacements(s.balanceWindowMins, now),
    )
    const hit = pickPlacement(rows, { excludeRef })
    if (hit) recordPlacement(hit.ref, 'migrate', null, now)
    return hit ? { ref: hit.ref, name: hit.name } : null
  },
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

/** Enqueue a resume of the rate-limited item's session, scheduled for `notBefore`. When
 *  `instanceRefOverride` is set (migrate-on-limit), the resume runs on THAT account instead of
 *  the original pin — the whole point being that the original just hit its 5-hour wall. */
/**
 * The thread's own name, with any resume/migration prefix this monitor (or the migrate route)
 * previously stapled on peeled back off.
 *
 * Queue titles NEST: a resume of a resume of a run reads "Migrated resume: Auto-resume: Ship the
 * parser". That is merely ugly on the queue row, but the same string becomes the chat's title in
 * the owner's desktop sidebar once a migrated run is imported, and there it has to be the thread's
 * name rather than a record of the plumbing that moved it. Stripping is idempotent and never
 * returns empty — a title that is nothing BUT prefixes keeps its original text.
 */
export function baseTitle(title: string): string {
  let t = (title ?? '').trim()
  for (;;) {
    const next = t.replace(/^(?:Auto-resume|Migrated resume|Migrate|Revive):\s*/, '').trim()
    if (next === t) break
    t = next
  }
  return t || (title ?? '').trim()
}

function enqueueResume(item: QueueItem, notBefore: string, instanceRefOverride?: string): string {
  const id = crypto.randomUUID()
  const prompt = getMonitorSettings().resumePrompt
  const posRow = db
    .query<{ m: number | null }, []>('select max(position) as m from queue_items')
    .get()
  const position = (posRow?.m ?? 0) + 1
  const name = baseTitle(item.title)
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at, import_to, import_title)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    item.session_id,
    `${instanceRefOverride ? 'Migrated resume' : 'Auto-resume'}: ${name}`.slice(0, 200),
    item.cwd,
    prompt,
    item.model ?? null,
    item.effort ?? null,
    item.permission_mode ?? null,
    // A migrated resume must not carry the original account_id either — the instance ref wins in
    // the runner, but leaving a stale account id on the row misreports who paid.
    instanceRefOverride ? null : (item.account_id ?? null),
    // Carry the ORIGINAL item's pinning forward — otherwise an instance-pinned run that gets
    // auto-resumed loses its pin and resumes as Ambient (wrong credentials, defeats the pin).
    instanceRefOverride ?? item.instance_ref ?? null,
    position,
    notBefore,
    Date.now(),
    // A MIGRATED resume runs on a BORROWED account, so without this it finishes headless and lands
    // nowhere the owner looks — the one gap left in the migrate story. finalize() in dispatch.ts
    // imports a completed run carrying import_to into that instance's desktop app, exactly as the
    // "Migrate to another account" menu item does, so the borrowed run ends up visible on the
    // account that can actually keep driving it (the original one is still behind its 5-hour wall).
    //
    // A same-account auto-resume deliberately imports NOTHING: that chat already sits in the app it
    // belongs to, and importing would add a duplicate entry pointing at the same transcript.
    //
    // Unlike the menu route this does NOT archive the old desktop entries first. That route is
    // user-initiated and settles in seconds; this one fires unattended and a migrated run can be
    // long, so the target instance may have been closed by the time it finishes (the import refuses
    // to boot a closed instance, by design). Archive-then-fail would leave the thread visible in no
    // app at all — strictly worse than the duplicate entry not archiving can leave behind, and
    // transcripts are shared across instances so the original entry keeps showing the real thread.
    instanceRefOverride ?? null,
    instanceRefOverride ? name.slice(0, 200) : null,
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
/**
 * Where a due resume is delivered. There are exactly two answers and neither is invisible, which
 * is the whole point: the type has no headless member to return, so the no-headless law is
 * enforced here by construction rather than by a branch someone could add back.
 *
 * `native` means the reviewer wakes the thread inside its own desktop app. `terminal` opens a
 * visible window. Everything that is not reachable natively takes the terminal, INCLUDING the
 * `queue` preference, which used to mean headless dispatch and now means the closest thing to
 * what it asked for that a person can actually watch.
 *
 * Pure and exported so the policy can be checked without launching anything, the same reason
 * commandInstallOutcome in orchestrator.ts is.
 */
export type ResumeSurface = 'native' | 'terminal'

export function resumeSurfaceFor(
  handoffSurface: string,
  instanceRef: string | null | undefined,
): ResumeSurface {
  // A native delivery needs BOTH: the owner wanting desktop, and a thread that actually lives in a
  // desktop app we can address. A `desktop` preference over a CLI-instance thread is the case that
  // used to fall through to headless rather than admit it could not be done natively.
  return handoffSurface === 'desktop' && instanceRef?.startsWith('desktop:') ? 'native' : 'terminal'
}

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
    // One lineage, one continuation: a session done-marked (handed off/migrated) AFTER this
    // resume was scheduled must not be revived — its successor owns the task, and firing the
    // resume would set two sessions overwriting the same work. Cancel the row; the reconciler
    // settles the monitor state from it on the next pass.
    if (q.status === 'queued' && isSessionSuperseded(q.session_id)) {
      db.query('update queue_items set status = ?, finished_at = ? where id = ?').run(
        'canceled',
        new Date().toISOString(),
        q.id,
      )
      continue
    }
    const due = !q.not_before || q.not_before <= now
    if (q.status === 'queued' && due && !isActive(q.id) && !isSessionActive(q.session_id)) {
      // Placement follows the owner's surface preference (standing rule 2026-08-25: match the
      // preference; 'desktop' means no terminals and nothing headless). 'desktop' hands the due
      // resume to the ACTION GATE (owner law 2026-08-26): a revive proposal the reviewer decides
      // and then delivers through the desktop app's own message channel — the thread wakes
      // VISIBLY in its app, never headless, never as a deaf re-import.
      //
      // NO HEADLESS (owner law 2026-08-27). Two branches used to fall through to dispatchItem
      // here and both are gone. The first was `surface === 'queue'`, the classic headless
      // dispatch "for owners who chose it"; it is no longer a thing anyone can choose, so it now
      // means the same as 'terminal', which is the nearest thing to what it asked for that a
      // person can actually watch. The second was subtler and was the one doing real damage: a
      // 'desktop' preference whose thread has no `desktop:` instance ref (a CLI instance, or no
      // ref at all) cannot be delivered natively, and it quietly fell back to headless rather
      // than admitting that. Since the ban those resumes were scheduled, dispatched and refused
      // on every attempt, which is a resume that can never happen.
      //
      // So the rule is now total and has no fallthrough: deliver natively when the thread lives
      // in a desktop app we can reach, and otherwise open a VISIBLE terminal. Both are proven
      // paths that were already here; nothing new had to be invented to close the hole. The
      // decision itself is resumeSurfaceFor(), pure and tested, because a routing policy that can
      // only be exercised by actually launching something is a policy nothing checks.
      if (resumeSurfaceFor(getOrchestratorSettings().handoffSurface, q.instance_ref) === 'native') {
        try {
          const { proposeAction } = await import('./proposals')
          proposeAction({
            kind: 'revive',
            sessionId: q.session_id,
            instanceRef: q.instance_ref,
            title: baseTitle(q.title),
            summary: `${baseTitle(q.title)} stopped at a usage limit and its window has reset — deliver the resume turn`,
            evidence: {
              flavor: 'limit-reset',
              resumePrompt: q.prompt,
              cwd: q.cwd,
              scheduledFor: q.not_before ?? null,
            },
            evidenceAt: new Date().toISOString(),
          })
          // Same honesty as the terminal branch below: this row's job (actioning the scheduled
          // resume) is done, but nothing has RUN yet - a proposal is waiting for the reviewer to
          // decide it. An exit code of 0 would claim a clean finish for work that has not started.
          db.query(
            'update queue_items set status = ?, finished_at = ?, exit_code = ? where id = ?',
          ).run('completed', new Date().toISOString(), null, q.id)
          db.query(
            'update monitor_state set message = ?, updated_at = ? where resume_item_id = ?',
          ).run(
            'window reset — handed to the reviewer as a revive proposal',
            new Date().toISOString(),
            q.id,
          )
        } catch (err) {
          console.error('[agenthydra] revive-proposal handoff failed:', err)
        }
      } else {
        void (async () => {
          try {
            const { launchTerminalSession } = await import('./session-launch')
            const res = await launchTerminalSession({
              cwd: q.cwd,
              prompt: q.prompt,
              instanceRef: q.instance_ref,
              model: q.model,
              effort: q.effort,
              resumeSessionId: q.session_id,
              // NOBODY IS WATCHING THIS WINDOW. It opens on a timer while the owner is away,
              // so a per-command approval prompt is a silent deadlock rather than a
              // safeguard - measured 2026-08-27: a session started without this loaded its
              // instructions, issued one shell command and froze for good. Same posture
              // AgentHydra already stamps on every chat it seeds.
              permissionMode: 'bypassPermissions',
            })
            // WHAT `completed` MEANS HERE, AND WHAT IT MUST NOT BE READ AS. This row is the
            // SCHEDULED RESUME, and its job genuinely is finished once the resume has been
            // actioned. The WORK has not finished: launchTerminalSession returns the instant the
            // window is spawned (it pipes nothing and waits for nothing), so ok means "a terminal
            // is open", never "the turn ran".
            //
            // So there is deliberately NO exit code. Writing 0 claimed a clean finish for work
            // that had not begun, which is the failure this codebase already names in types.ts:
            // conflating "the work finished" with "you can see it" is exactly how something goes
            // missing while nothing looks wrong. A launch we could not make IS our own outcome,
            // so that one keeps a real non-zero code.
            db.query(
              'update queue_items set status = ?, finished_at = ?, exit_code = ? where id = ?',
            ).run(
              res.ok ? 'completed' : 'failed',
              new Date().toISOString(),
              res.ok ? null : 1,
              q.id,
            )
            // Say which of the two happened, the way the native branch above does. Without this
            // the row looked identical whether a window opened or the launch failed outright.
            db.query(
              'update monitor_state set message = ?, updated_at = ? where resume_item_id = ?',
            ).run(
              res.ok
                ? 'window reset - resumed in a visible terminal; the run itself is not tracked here'
                : `window reset - could not open a terminal: ${res.reason ?? 'unknown'}`,
              new Date().toISOString(),
              q.id,
            )
          } catch (err) {
            console.error('[agenthydra] visible auto-resume failed:', err)
          }
        })()
      }
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

    // Weekly has room. A 5-hour stop with the migrate toggle on doesn't wait for the reset at
    // all: it resumes NOW on another running account with headroom (owner directive 2026-08-25 —
    // "if the chat seems like it should still be running, migrate it and keep working"). The
    // original account rejoins the routing pool naturally once its window resets. Falls back to
    // the scheduled resume when no viable target exists.
    if (getOrchestratorSettings().migrateOnLimit) {
      let target: { ref: string; name: string } | null = null
      try {
        target = (await deps.pickMigrationTarget?.(item.instance_ref ?? null)) ?? null
      } catch (err) {
        console.error('[agenthydra] migration target pick failed:', err)
      }
      if (target) {
        const resumeId = enqueueResume(item, new Date().toISOString(), target.ref)
        upsertState(item, {
          state: 'scheduled',
          message: `migrated to ${target.name} until the 5h resets`,
          resumeItemId: resumeId,
          attempts: priorAttempts + 1,
          nextCheckAt: null,
        })
        continue
      }
    }

    // Schedule the resume just after the 5-hour session reset (+ buffer). If the
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
