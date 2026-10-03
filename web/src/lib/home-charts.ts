// web/src/lib/home-charts.ts — data shaping for the Instances landing page's charts band.
// Pure and clock-free: every call takes `asOf` (ms), so a chart never shifts between refreshes.

const HOUR_MS = 3_600_000

/** Index 0 = oldest hour, `hours - 1` = the hour containing `asOf`; null when outside the window. */
export function hourIndex(at: number, asOf: number, hours: number): number | null {
  if (!Number.isFinite(at)) return null
  const lastStart = Math.floor(asOf / HOUR_MS) * HOUR_MS
  const i = hours - 1 - (lastStart - Math.floor(at / HOUR_MS) * HOUR_MS) / HOUR_MS
  return i >= 0 && i < hours && at <= asOf ? i : null
}

/** Start (ms) of each of the last `hours` clock hours, oldest first. */
export function hourStarts(asOf: number, hours: number): number[] {
  const lastStart = Math.floor(asOf / HOUR_MS) * HOUR_MS
  return Array.from({ length: hours }, (_, i) => lastStart - (hours - 1 - i) * HOUR_MS)
}

/** Events per hour over the last `hours` hours. */
export function countPerHour(times: number[], asOf: number, hours = 24): number[] {
  const out = new Array<number>(hours).fill(0)
  for (const t of times) {
    const i = hourIndex(t, asOf, hours)
    if (i !== null) out[i] = (out[i] ?? 0) + 1
  }
  return out
}

export type WorkerOutcome = 'done' | 'failed' | 'running'

/** A worker's status as the three chart colours: cancelled counts with failed, anything not yet
 *  finished (queued, waiting, checking) with running. */
export function workerOutcome(status: string): WorkerOutcome {
  if (status === 'done') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'running'
}

/** Workers started (createdAt) per hour, split by outcome. */
export function workersPerHour(
  workers: Array<{ createdAt: number; status: string }>,
  asOf: number,
  hours = 24,
): Array<Record<WorkerOutcome, number>> {
  const out = Array.from({ length: hours }, () => ({ done: 0, failed: 0, running: 0 }))
  for (const w of workers) {
    const i = hourIndex(w.createdAt, asOf, hours)
    const bucket = i === null ? undefined : out[i]
    if (bucket) bucket[workerOutcome(w.status)]++
  }
  return out
}

export interface HeadroomRow {
  key: string
  label: string
  /** % used, 0-100; null when that window was never read. */
  session: number | null
  week: number | null
  to: 'cli' | 'instances'
}

const worst = (r: HeadroomRow) => Math.max(r.session ?? -1, r.week ?? -1)

/** Signed-in accounts with at least one reading, most used first (the one about to hit a limit on top). */
export function sortHeadroom(rows: HeadroomRow[]): HeadroomRow[] {
  return rows.filter((r) => worst(r) >= 0).sort((a, b) => worst(b) - worst(a))
}

/** Severity bucket for a % used. */
export function severityOf(pct: number): 'ok' | 'warn' | 'high' {
  return pct >= 90 ? 'high' : pct >= 70 ? 'warn' : 'ok'
}

/** A window whose reset has passed is back to 0% used (its stored % describes the ended window). */
export function usedPct(
  limit: { pct: number; resetsAt?: string | null } | null | undefined,
  now: number,
): number | null {
  if (!limit) return null
  const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  if (Number.isFinite(reset) && reset <= now) return 0
  return Math.min(100, Math.max(0, limit.pct))
}
