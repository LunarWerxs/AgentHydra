// The Failures section's data shaping (tested in web/test/shell/failures.test.ts).
import type { FailureCause } from '@shared/protocol'

export const CAUSE_LABEL: Record<FailureCause, string> = {
  auth_expired: 'Sign-in expired',
  org_disabled: 'Organization disabled',
  usage_limit: 'Usage limit',
  interrupted: 'Interrupted',
  refused_send: 'Message refused',
  worker_failed: 'Worker failed',
  hook_timeout: 'Hook timed out',
  hook_failed: 'Hook failed',
  move_failed: 'Account move failed',
  network: 'Network',
  unknown: 'Unknown'
}

export const causeLabel = (c: string): string => CAUSE_LABEL[c as FailureCause] ?? c

/** Start of the local day `daysBack` days before today's, epoch ms. */
export function dayStart(now: number, daysBack: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysBack)
  return d.getTime()
}

/** Counts as [key, n] rows, most first; ties by key. */
export function ranked(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** "3m 12s", "45s", "-" for none. */
export function duration(ms: number | null): string {
  if (ms === null) return '-'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
