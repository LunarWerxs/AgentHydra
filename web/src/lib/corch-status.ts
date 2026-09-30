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
  error: { variant: 'destructive', label: 'corch.outcomeError' },
  cancelled: { variant: 'outline', label: 'corch.outcomeCancelled' },
}

export const isCorchActive = (w: Pick<CorchWorkerView, 'status'>): boolean =>
  w.status === 'queued' || w.status === 'running' || w.status === 'waiting'

/** `#68 Darragh (CLI)`, or the bare name when the account has no instance number. */
export const corchAccountLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? a.name : `#${a.num} ${a.name}`

/** The first line of a multi-line message, for a one-line row. */
export const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s
