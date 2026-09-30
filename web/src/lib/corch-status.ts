// How a Corch task's status and each account attempt look on screen: badge variant, icon, label and
// hover text in one table, so the list row and the detail pane can never disagree. Every status has
// an icon because colour alone failed the 2026-09-30 review ('queued' and 'cancelled' were two
// near-identical grey pills).
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from '@lucide/vue'
import type { BadgeVariants } from '@/components/ui/badge/badge-variants'
import type { CorchAttemptOutcome, CorchStatus, CorchWorkerView } from '@/lib/api'

export interface CorchStatusMeta {
  variant: BadgeVariants['variant']
  icon: LucideIcon
  /** Spin the icon (running only). */
  spin: boolean
  label: string
  hint: string
}

export const CORCH_STATUS: Record<CorchStatus, CorchStatusMeta> = {
  queued: {
    variant: 'muted',
    icon: Clock,
    spin: false,
    label: 'corch.statusQueued',
    hint: 'corch.statusQueuedHint',
  },
  running: {
    variant: 'info',
    icon: LoaderCircle,
    spin: true,
    label: 'corch.statusRunning',
    hint: 'corch.statusRunningHint',
  },
  waiting: {
    variant: 'warning',
    icon: Hourglass,
    spin: false,
    label: 'corch.statusWaiting',
    hint: 'corch.statusWaitingHint',
  },
  done: {
    variant: 'success',
    icon: CircleCheck,
    spin: false,
    label: 'corch.statusDone',
    hint: 'corch.statusDoneHint',
  },
  failed: {
    variant: 'destructive',
    icon: CircleX,
    spin: false,
    label: 'corch.statusFailed',
    hint: 'corch.statusFailedHint',
  },
  cancelled: {
    variant: 'outline',
    icon: Ban,
    spin: false,
    label: 'corch.statusCancelled',
    hint: 'corch.statusCancelledHint',
  },
}

export const CORCH_OUTCOME: Record<
  CorchAttemptOutcome,
  { variant: BadgeVariants['variant']; label: string }
> = {
  running: { variant: 'info', label: 'corch.outcomeRunning' },
  done: { variant: 'success', label: 'corch.outcomeDone' },
  quota: { variant: 'warning', label: 'corch.outcomeQuota' },
  transient: { variant: 'muted', label: 'corch.outcomeTransient' },
  auth: { variant: 'warning', label: 'corch.outcomeAuth' },
  // Killed from outside (a daemon restart) and resumed by itself: never the word for a manual Stop.
  interrupted: { variant: 'muted', label: 'corch.outcomeInterrupted' },
  // Wound down near its limit and handed off to a fresh session; its notice says so.
  handoff: { variant: 'info', label: 'corch.outcomeHandoff' },
  error: { variant: 'destructive', label: 'corch.outcomeError' },
  cancelled: { variant: 'outline', label: 'corch.outcomeCancelled' },
}

/** Why a task that has already run is queued again, as an i18n key and its values; null for one
 *  that simply has not started. Without it a task moving accounts after a limit looked exactly like
 *  one that had never run (2026-09-30 UI review). */
export function corchQueuedNote(
  w: Pick<CorchWorkerView, 'status' | 'attempts' | 'notBefore' | 'retries'>,
  now: number,
): { key: string; values?: Record<string, number> } | null {
  if (w.status !== 'queued') return null
  const last = w.attempts[w.attempts.length - 1]
  if (!last) return null
  if (w.notBefore !== null && w.notBefore > now)
    return {
      key: 'corch.queuedRetry',
      values: { s: Math.ceil((w.notBefore - now) / 1000), n: Math.max(1, w.retries) },
    }
  if (last.outcome === 'quota') return { key: 'corch.queuedLimit' }
  if (last.outcome === 'auth') return { key: 'corch.queuedSignedOut' }
  if (last.outcome === 'handoff') return { key: 'corch.queuedHandoff' }
  if (last.outcome === 'interrupted') return { key: 'corch.queuedRestart' }
  return null
}

export const isCorchActive = (w: Pick<CorchWorkerView, 'status'>): boolean =>
  w.status === 'queued' || w.status === 'running' || w.status === 'waiting'

/** `#68 Darragh (CLI)`, or the bare name when the account has no instance number. */
export const corchAccountLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? a.name : `#${a.num} ${a.name}`

/** The first line of a multi-line message, for a one-line row. */
export const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s
