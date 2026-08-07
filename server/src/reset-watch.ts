// server/src/reset-watch.ts — notice the moment a quota window rolls over, and say so out loud.
//
// THE INSIGHT THAT MAKES THIS CHEAP: a reset is not something we have to discover by polling for a
// change. The usage endpoint hands us the reset instant IN ADVANCE (`resets_at`, a real ISO-8601
// timestamp — see usage-api.ts). So "has it reset?" is not an inference from a percentage that
// dropped; it is a wall-clock comparison against a timestamp we already recorded. That distinction
// matters: percentages are integers and can sit still for an hour (see usage-history.ts), so a
// delta-based detector would be both late and ambiguous. A timestamp is neither.
//
// Two paths, and the second is why this feels instant rather than "within 15 minutes":
//   1. PASSIVE. Every real reading routes through noteUsageSnapshot() (called from the two finish()
//      closures in usage-service.ts). It compares the newly-read window against the one we last saw
//      and raises an event if the recorded reset instant has passed. This alone catches everything,
//      eventually — bounded by the background sweep's interval.
//   2. ARMED. Because we know the next reset instant, we set a timer FOR it (plus a small buffer to
//      let the server-side window actually roll) and re-check just that instance then. Detection
//      lands within seconds of the real reset instead of within a sweep interval.
//
// State is persisted (DATA_DIR/reset-watch.json) rather than kept in memory, because the single
// most valuable notification this thing can send is one that fires at 3am — precisely when an
// auto-update restart or a machine sleep is most likely to have cycled the process. An in-memory
// watcher would lose exactly the events it exists to catch.
//
// PERSISTENT ("annoying") MODE is why events are objects with a lifecycle rather than fire-and-
// forget calls: an event stays open until acknowledged, and a repeat timer re-delivers it on a
// cadence. Bounded on both ends (a max repeat count, and a hard expiry) so a forgotten toggle can
// never turn into a notification that outlives its own usefulness.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { sendOsNotification } from './notify-os'
import { getNotificationSettings, MAX_REPEATS_CEILING, smtpPassword } from './notify-settings'
import { sendMail } from './notify-smtp'
import type {
  NotifyDeliveryResult,
  ResetEvent,
  ResetKind,
  UsageLimit,
  UsageSnapshot,
} from './types'
import { resetTimeIso } from './usage'

const STATE_PATH = join(DATA_DIR, 'reset-watch.json')

/** The two windows worth announcing. The per-model weekly sub-limit is deliberately not one: it
 *  shares the weekly reset instant, so it would double every notification for no new information. */
const KINDS: ResetKind[] = ['session', 'weekAll']

/**
 * How stale a missed reset may be and still be worth announcing.
 *
 * The case this bounds: the daemon was off for a week. On boot, every recorded reset instant is in
 * the past, and without a grace window we would open a burst of events for rollovers the user
 * lived through days ago. Past this, we silently re-baseline instead.
 */
const MAX_LAG_MS = 24 * 60 * 60 * 1000

/** Slack after the recorded instant before the armed re-check fires — the server-side window needs
 *  a moment to actually roll, and probing at exactly T sometimes still reads the old numbers. */
const ARM_BUFFER_MS = 45_000

/** How often the repeat loop wakes to look for events that are due another delivery. */
const REPEAT_TICK_MS = 30_000

/** An unacknowledged event is dropped after this, repeats exhausted or not. */
const EVENT_EXPIRY_MS = 48 * 60 * 60 * 1000

// --- persisted state ----------------------------------------------------------

/** What we last saw for one window of one instance. */
export interface WindowState {
  /** The reset instant we recorded, ISO, or null when the window hadn't started. */
  resetsAt: string | null
  /** The percentage at that reading — becomes the "you were at 97%" in the message. */
  pct: number | null
  /** The reset instant we have already raised an event for, so one rollover fires exactly once. */
  notifiedFor: string | null
}

interface WatchFile {
  /** Keyed by usage-cache key (`desktop:<dir>` / `cli:<id>`), then by window kind. */
  windows: Record<string, Partial<Record<ResetKind, WindowState>>>
  events: ResetEvent[]
}

const emptyFile = (): WatchFile => ({ windows: {}, events: [] })

function readState(): WatchFile {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyFile()
    return {
      windows: parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {},
      events: Array.isArray(parsed.events) ? parsed.events : [],
    }
  } catch {
    return emptyFile()
  }
}

function writeState(state: WatchFile): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    // Best-effort, but say so: losing this file means losing a pending notification, which is not
    // the kind of failure that should be invisible.
    console.error('[reset-watch] could not persist state:', err)
  }
}

// --- the pure decision --------------------------------------------------------

/**
 * Should a reading of `limit` raise a reset event, given what we last saw?
 *
 * Pure and exported so the whole decision — including the two ways it must NOT fire (already
 * announced, and too stale to matter) — is unit-testable without a disk, a clock, or a network.
 *
 * Returns the previous state's reset instant when an event is due, else null.
 */
export function resetDue(
  prev: WindowState | undefined,
  now: Date,
  maxLagMs = MAX_LAG_MS,
): string | null {
  if (!prev?.resetsAt) return null
  // Already announced this exact rollover. The next reading carries a LATER resetsAt, at which
  // point this comparison stops matching and the next window becomes eligible on its own merits.
  if (prev.notifiedFor === prev.resetsAt) return null
  const at = new Date(prev.resetsAt).getTime()
  if (!Number.isFinite(at)) return null
  const lag = now.getTime() - at
  // Not yet, or so long ago that announcing it would be archaeology rather than news.
  if (lag < 0 || lag > maxLagMs) return null
  return prev.resetsAt
}

/** The state a freshly-read limit should be recorded as. `notifiedFor` is carried forward so a
 *  reading that repeats an already-announced instant cannot re-open it. */
export function nextWindowState(
  limit: UsageLimit | null | undefined,
  prev: WindowState | undefined,
  justNotifiedFor: string | null,
  now = new Date(),
): WindowState {
  const resetsAt = resetTimeIso(limit ?? null, now)
  return {
    resetsAt,
    pct: limit?.pct ?? null,
    notifiedFor: justNotifiedFor ?? prev?.notifiedFor ?? null,
  }
}

// --- delivery -----------------------------------------------------------------

const KIND_LABEL: Record<ResetKind, string> = {
  session: '5-hour session',
  weekAll: 'weekly (all models)',
}

/** The user-facing copy for one event. Pure, so the wording is testable and lives in one place. */
export function eventMessage(ev: ResetEvent): { title: string; body: string } {
  const window = KIND_LABEL[ev.kind]
  const was = ev.previousPct === null ? '' : ` You were at ${ev.previousPct}%.`
  const nowAt = ev.currentPct === null ? '' : ` Now at ${ev.currentPct}%.`
  return {
    title: `${ev.label}: ${window} limit reset`,
    body: `Your ${window} quota window has rolled over.${was}${nowAt}`,
  }
}

/**
 * Push one event out over every enabled channel. Never throws: a channel that fails reports itself
 * and the others still go. `sticky` rides on persistent mode — a toast that fades after five
 * seconds while you're away from the desk is the exact failure persistent mode exists to fix.
 */
export async function deliver(ev: ResetEvent): Promise<NotifyDeliveryResult> {
  const settings = getNotificationSettings()
  const { title, body } = eventMessage(ev)
  const result: NotifyDeliveryResult = {
    desktop: { attempted: false, ok: false },
    email: { attempted: false, ok: false },
  }

  if (settings.notifyDesktop) {
    result.desktop.attempted = true
    const r = await sendOsNotification({ title, body, sticky: settings.notifyPersistent })
    result.desktop.ok = r.ok
    if (!r.ok) result.desktop.error = r.error
  }

  if (settings.notifyEmail && settings.notifySmtpHost && settings.notifyEmailTo) {
    result.email.attempted = true
    const r = await sendMail(
      {
        host: settings.notifySmtpHost,
        port: settings.notifySmtpPort,
        secure: settings.notifySmtpSecure,
        user: settings.notifySmtpUser,
        pass: smtpPassword(),
      },
      {
        from: settings.notifyEmailFrom || settings.notifySmtpUser || settings.notifyEmailTo,
        to: settings.notifyEmailTo,
        subject: title,
        text: `${body}\n\nWindow reset at ${ev.resetAt}\nDetected at ${ev.detectedAt}\n\n— AgentHydra`,
      },
    )
    result.email.ok = r.ok
    if (!r.ok) result.email.error = r.error
  }

  return result
}

// --- detection ----------------------------------------------------------------

/** Re-check a single instance by its usage key. Injected at start() so this module never imports
 *  usage-service (which imports back into the usage stack) — a real cycle, not a stylistic one. */
export interface ResetWatchDeps {
  recheck: (key: string) => Promise<void>
}

let deps: ResetWatchDeps | null = null
let armTimer: ReturnType<typeof setTimeout> | null = null
let repeatTimer: ReturnType<typeof setInterval> | null = null
/** Set while the armed timer's own re-check is running, so it cannot re-arm itself into a loop. */
let recheckInFlight = false

/**
 * Is this 5-hour reset pointless to announce, because the WEEKLY cap still blocks the account?
 *
 * The percentages are not independent: the weekly all-models limit is the binding ceiling, and a
 * session window coming back on an account that is out of weekly quota changes nothing you can act
 * on. usage.ts already says as much for the advice text ("a fresh 5-hour session % is a red herring
 * when weekly is near 100"); this applies the same rule to the toast, so an account the Instances
 * tab has filtered out of view stops paging about it (owner request, 2026-08-07).
 *
 * Deliberately reads the CURRENT weekly figure from the same snapshot, not the pre-reset one: the
 * question is "is this account usable NOW", and the session window is the only thing that just
 * rolled over. Only ever gates 'session' — a weekly reset is the event that genuinely unblocks an
 * account. Unknown weekly (never read, or a partial snapshot) never suppresses: silence has to be
 * something we affirmatively concluded, not a side effect of missing data.
 */
export function sessionResetIsMoot(
  kind: ResetKind,
  snap: UsageSnapshot,
  maxWeeklyPct: number,
): boolean {
  if (kind !== 'session') return false
  const weekly = snap.weekAll?.pct
  if (typeof weekly !== 'number' || !Number.isFinite(weekly)) return false
  return weekly >= maxWeeklyPct
}

/**
 * Record a fresh reading and raise events for any window that rolled over since the last one.
 *
 * Called from usage-service's finish() for both desktop and CLI checks, so every real reading in
 * the process passes through here exactly once. Returns the events raised (usually none).
 */
export async function noteUsageSnapshot(
  key: string,
  label: string,
  snap: UsageSnapshot,
  now = new Date(),
): Promise<ResetEvent[]> {
  const settings = getNotificationSettings()
  const state = readState()
  const perKey = state.windows[key] ?? {}
  const raised: ResetEvent[] = []

  for (const kind of KINDS) {
    const enabled = kind === 'session' ? settings.notifySessionReset : settings.notifyWeeklyReset
    const prev = perKey[kind]
    const limit = snap[kind] ?? null
    // The decision is made even when the kind is disabled, so that turning it on later doesn't
    // replay a backlog: we still consume the rollover, we just don't announce it.
    const dueAt = resetDue(prev, now)
    let notifiedFor: string | null = null

    if (dueAt) {
      notifiedFor = dueAt
      const prevPct = prev?.pct ?? null
      const loud =
        settings.notifyEnabled &&
        enabled &&
        (prevPct === null || prevPct >= settings.notifyMinPct) &&
        !sessionResetIsMoot(kind, snap, settings.notifySessionMaxWeeklyPct)
      if (loud) {
        raised.push({
          id: crypto.randomUUID(),
          key,
          label,
          kind,
          resetAt: dueAt,
          detectedAt: now.toISOString(),
          previousPct: prevPct,
          currentPct: limit?.pct ?? null,
          acknowledged: false,
          repeats: 0,
          lastNotifiedAt: now.toISOString(),
        })
      }
    }
    perKey[kind] = nextWindowState(limit, prev, notifiedFor, now)
  }

  state.windows[key] = perKey
  if (raised.length) state.events = [...raised, ...state.events].slice(0, 100)
  writeState(state)

  for (const ev of raised) {
    // Sequential, not parallel: two toasts fired in the same millisecond stack unreadably, and
    // this is at most two events.
    await deliver(ev).catch((err) => console.error('[reset-watch] delivery failed:', err))
  }
  arm()
  return raised
}

// --- the armed re-check -------------------------------------------------------

/** The soonest future reset instant across every tracked window, with the key that owns it. */
export function nextArm(
  windows: WatchFile['windows'],
  now = new Date(),
): { key: string; at: number } | null {
  let best: { key: string; at: number } | null = null
  for (const [key, kinds] of Object.entries(windows)) {
    for (const kind of KINDS) {
      const at = kinds[kind]?.resetsAt
      if (!at) continue
      const t = new Date(at).getTime()
      if (!Number.isFinite(t) || t <= now.getTime()) continue
      if (!best || t < best.at) best = { key, at: t }
    }
  }
  return best
}

/** (Re)arm the precise timer for the next known reset. Cheap and idempotent — called after every
 *  reading, and after every fire. */
function arm(): void {
  if (armTimer) {
    clearTimeout(armTimer)
    armTimer = null
  }
  if (!deps) return
  const next = nextArm(readState().windows)
  if (!next) return
  // Node/Bun clamp a setTimeout delay to a 32-bit ms range; a weekly reset can be further out than
  // that is comfortable, so cap the sleep and re-arm on waking. Also keeps a machine that slept
  // through the instant from missing it entirely.
  const delay = Math.min(next.at + ARM_BUFFER_MS - Date.now(), 30 * 60_000)
  armTimer = setTimeout(
    () => {
      armTimer = null
      void fireArmed(next.key)
    },
    Math.max(1_000, delay),
  )
  armTimer.unref?.()
}

async function fireArmed(key: string): Promise<void> {
  if (recheckInFlight || !deps) {
    arm()
    return
  }
  recheckInFlight = true
  try {
    // The re-check flows back into noteUsageSnapshot, which is what actually raises the event.
    await deps.recheck(key)
  } catch (err) {
    console.error(`[reset-watch] armed re-check for '${key}' failed:`, err)
  } finally {
    recheckInFlight = false
    arm()
  }
}

// --- persistent ("annoying") mode ---------------------------------------------

/** Which open events are due another delivery right now. Pure, so the cadence + the two stop
 *  conditions (max repeats, expiry) are testable without waiting on real minutes. */
export function dueForRepeat(
  events: ResetEvent[],
  settings: {
    notifyEnabled: boolean
    notifyPersistent: boolean
    notifyPersistentIntervalMin: number
    notifyPersistentMaxRepeats: number
  },
  now = new Date(),
): ResetEvent[] {
  if (!settings.notifyEnabled || !settings.notifyPersistent) return []
  const cap =
    settings.notifyPersistentMaxRepeats > 0
      ? settings.notifyPersistentMaxRepeats
      : MAX_REPEATS_CEILING
  const intervalMs = settings.notifyPersistentIntervalMin * 60_000
  return events.filter((ev) => {
    if (ev.acknowledged) return false
    if (ev.repeats >= cap) return false
    const last = new Date(ev.lastNotifiedAt).getTime()
    if (!Number.isFinite(last)) return false
    return now.getTime() - last >= intervalMs
  })
}

/** Drop events that have outlived their usefulness, acknowledged or not. */
export function pruneEvents(events: ResetEvent[], now = new Date()): ResetEvent[] {
  return events.filter((ev) => {
    const at = new Date(ev.detectedAt).getTime()
    if (!Number.isFinite(at)) return false
    if (now.getTime() - at > EVENT_EXPIRY_MS) return false
    return true
  })
}

async function repeatTick(): Promise<void> {
  const state = readState()
  const pruned = pruneEvents(state.events)
  const due = dueForRepeat(pruned, getNotificationSettings())
  if (due.length === 0) {
    if (pruned.length !== state.events.length) writeState({ ...state, events: pruned })
    return
  }
  const nowIso = new Date().toISOString()
  const byId = new Map(due.map((e) => [e.id, e]))
  const nextEvents = pruned.map((ev) =>
    byId.has(ev.id) ? { ...ev, repeats: ev.repeats + 1, lastNotifiedAt: nowIso } : ev,
  )
  writeState({ ...state, events: nextEvents })
  for (const ev of due) {
    await deliver(ev).catch((err) => console.error('[reset-watch] repeat delivery failed:', err))
  }
}

// --- the public read/act surface (what the API routes call) --------------------

/** Open (unacknowledged, unexpired) events, newest first. */
export function listResetEvents(): ResetEvent[] {
  const state = readState()
  const pruned = pruneEvents(state.events)
  if (pruned.length !== state.events.length) writeState({ ...state, events: pruned })
  return pruned
}

/** Acknowledge one event (or all, when `id` is omitted). Acknowledging stops persistent repeats. */
export function acknowledgeResetEvents(id?: string): ResetEvent[] {
  const state = readState()
  const events = pruneEvents(state.events).map((ev) =>
    !id || ev.id === id ? { ...ev, acknowledged: true } : ev,
  )
  writeState({ ...state, events })
  return events
}

/** Fire a one-off notification through the configured channels, so a user can prove the plumbing
 *  works without waiting five hours for a real reset. Returns the per-channel outcome. */
export async function sendTestNotification(): Promise<NotifyDeliveryResult> {
  const now = new Date().toISOString()
  return deliver({
    id: 'test',
    key: 'test',
    label: 'AgentHydra',
    kind: 'session',
    resetAt: now,
    detectedAt: now,
    previousPct: 100,
    currentPct: 0,
    acknowledged: false,
    repeats: 0,
    lastNotifiedAt: now,
  })
}

// --- lifecycle ----------------------------------------------------------------

/** Start the watcher: arm the next known reset and begin the persistent-repeat loop. */
export function startResetWatch(d: ResetWatchDeps): void {
  deps = d
  arm()
  if (repeatTimer) clearInterval(repeatTimer)
  repeatTimer = setInterval(() => {
    void repeatTick().catch((err) => console.error('[reset-watch] repeat tick failed:', err))
  }, REPEAT_TICK_MS)
  repeatTimer.unref?.()
}

/** Stop all timers (used by tests and by a clean shutdown). */
export function stopResetWatch(): void {
  if (armTimer) clearTimeout(armTimer)
  if (repeatTimer) clearInterval(repeatTimer)
  armTimer = null
  repeatTimer = null
  deps = null
}
