import { isDispatchReady } from './boot-state'
import { coerceQueueItem, db, getSetting, setSetting } from './db'
import { activeCount, dispatchItem, isSessionActive } from './dispatch'
import type { QueueItem, SchedulerState } from './types'

let timer: ReturnType<typeof setInterval> | null = null
let lastDispatchAt = 0

const SCHEDULER_NUMBER_SETTINGS = {
  spacing_seconds: { fallback: 60, min: 0, max: 86_400 },
  poll_seconds: { fallback: 5, min: 1, max: 3_600 },
  max_concurrent: { fallback: 3, min: 1, max: 100 },
} as const

type SchedulerNumberSetting = keyof typeof SCHEDULER_NUMBER_SETTINGS

/** Normalize both API input and legacy/corrupt persisted values through one set of bounds. */
export function normalizeSchedulerNumber(key: SchedulerNumberSetting, value: unknown): number {
  const { fallback, min, max } = SCHEDULER_NUMBER_SETTINGS[key]
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function num(key: SchedulerNumberSetting): number {
  const n = Number(getSetting(key))
  return normalizeSchedulerNumber(key, n)
}

/** "HH:MM" (24h) or the 09:00 default; anything malformed in the kv store falls back. */
export function tomorrowTime(): string {
  const v = getSetting('tomorrow_time') ?? ''
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v : '09:00'
}

/**
 * ⛔ THE TICK MUST NEVER THROW OUT OF ITSELF. It is handed straight to setInterval, so a
 * synchronous throw here is not caught by anything: it becomes an uncaughtException, and this
 * process installs a handler that answers those with process.exit(1). That is the whole daemon
 * gone - the queue, the monitor, the courier, the HTTP API - because one sqlite read hit a lock.
 * A tick that fails is a tick skipped; the next one is a poll interval away.
 */
function tick() {
  try {
    tickInner()
  } catch (err) {
    console.error('[agenthydra] scheduler tick error:', err)
  }
}

function tickInner() {
  if (getSetting('scheduler_enabled') !== '1') return
  // Don't dispatch until reattachRuns() has settled: a run that survived the previous daemon isn't
  // in `active` yet, so isSessionActive() below would wrongly say "free" and we'd double-dispatch
  // that session. See boot-state.ts. The timer keeps ticking; it just waits out the boot window.
  if (!isDispatchReady()) return
  const maxConcurrent = num('max_concurrent')
  const spacingSeconds = num('spacing_seconds')

  if (activeCount() >= maxConcurrent) return
  if (Date.now() - lastDispatchAt < spacingSeconds * 1000) return

  // not_before gates auto-dispatch only (manual Run ignores it); ISO-8601 UTC strings
  // compare correctly as text. Neither a future-scheduled head item nor one whose
  // session is mid-run may block the rest; skip to the first dispatchable candidate.
  const candidates = db
    .query<QueueItem, [string]>(
      `select * from queue_items
       where status = 'queued' and (not_before is null or not_before <= ?)
       order by position asc, created_at asc limit 20`,
    )
    .all(new Date().toISOString())
  const next = candidates.find((item) => !isSessionActive(item.session_id))
  if (!next) return

  lastDispatchAt = Date.now()
  // fire-and-forget; dispatchItem persists status transitions itself
  void dispatchItem(coerceQueueItem(next))
}

// bun:sqlite returns integers for our boolean columns; coerce to real booleans
export function startScheduler() {
  if (timer) return
  const pollSeconds = num('poll_seconds')
  timer = setInterval(tick, pollSeconds * 1000)
  timer.unref?.()
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function setSchedulerEnabled(enabled: boolean) {
  setSetting('scheduler_enabled', enabled ? '1' : '0')
  if (enabled) {
    lastDispatchAt = 0 // allow an immediate first dispatch
    startScheduler()
  }
}

export interface SchedulerSettingsPatch {
  enabled?: boolean
  spacing_seconds?: number
  poll_seconds?: number
  max_concurrent?: number
  tomorrow_time?: string
}

/** Persist a validated settings patch. Re-arm the timer when its cadence changes so the API's
 * response describes live behavior, not a value that only takes effect after restart. */
export function setSchedulerSettings(patch: SchedulerSettingsPatch): SchedulerState {
  let pollChanged = false
  for (const key of Object.keys(SCHEDULER_NUMBER_SETTINGS) as SchedulerNumberSetting[]) {
    const requested = patch[key]
    if (typeof requested !== 'number' || !Number.isFinite(requested)) continue
    const next = normalizeSchedulerNumber(key, requested)
    if (key === 'poll_seconds' && next !== num('poll_seconds')) pollChanged = true
    setSetting(key, String(next))
  }
  if (
    typeof patch.tomorrow_time === 'string' &&
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(patch.tomorrow_time)
  )
    setSetting('tomorrow_time', patch.tomorrow_time)
  if (typeof patch.enabled === 'boolean') setSchedulerEnabled(patch.enabled)
  if (pollChanged) {
    stopScheduler()
    startScheduler()
  }
  return schedulerState()
}

export function schedulerState(): SchedulerState {
  const counts = db
    .query<{ status: string; c: number }, []>(
      'select status, count(*) as c from queue_items group by status',
    )
    .all()
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]))
  return {
    enabled: getSetting('scheduler_enabled') === '1',
    running_count: activeCount(),
    queued_count: byStatus.queued ?? 0,
    spacing_seconds: num('spacing_seconds'),
    poll_seconds: num('poll_seconds'),
    max_concurrent: num('max_concurrent'),
    tomorrow_time: tomorrowTime(),
  }
}

// Always run the timer loop; the tick itself is a no-op unless enabled.
startScheduler()
