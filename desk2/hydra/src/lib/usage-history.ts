// The arithmetic behind the Instances usage-history charts, with no drawing in it. Owner, 2026-10-07:
// the Instances stats are historical charts only. What matters here is that a missing usage sample
// is a gap, never a 0, and that a day is the reader's local calendar day, as the server writes it.
import type { SpendBucket } from '@agenthydra/server/types'
import { linePath } from '@/lib/chart'

export interface PlotBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * One SVG path per run of present values. A null ends the run, so the line stops at a gap and starts
 * again after it: "no sample" and "0% used" are different facts, and a gap must not read as a dip.
 */
export function segmentPaths(values: ReadonlyArray<number | null>, box: PlotBox, max: number): string[] {
  const last = Math.max(1, values.length - 1)
  const runs: Array<Array<{ x: number; y: number }>> = []
  let run: Array<{ x: number; y: number }> = []
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run)
      run = []
      return
    }
    const clamped = Math.min(Math.max(v, 0), max)
    run.push({ x: box.left + (i / last) * box.width, y: box.top + box.height - (clamped / max) * box.height })
  })
  if (run.length) runs.push(run)
  return runs.map((r) => linePath(r))
}

/** The server's day key: the reader's local calendar date as YYYY-MM-DD (server analytics dayKey). */
export function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** The last `count` local days ending today, oldest first. */
export function lastDays(today: Date, count: number): string[] {
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    out.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)))
  }
  return out
}

/**
 * Weighted tokens per day, one number per source in the order given. A day a source wrote nothing
 * is 0 here: it used no tokens, which is a real zero, unlike a usage sample that was never taken.
 */
export function dailyTokens(
  bySource: ReadonlyArray<{ byDay: SpendBucket[] }>,
  days: string[],
): Array<{ key: string; values: number[] }> {
  return days.map((key) => ({
    key,
    values: bySource.map(({ byDay }) => byDay.find((b) => b.key === key)?.weighted ?? 0),
  }))
}

export function dayLabel(key: string): string {
  return new Date(`${key}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}
