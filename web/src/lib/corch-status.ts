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
  ListChecks,
  LoaderCircle,
  type LucideIcon,
} from '@lucide/vue'
import type { BadgeVariants } from '@/components/ui/badge/badge-variants'
import type { CorchAttemptOutcome, CorchStatus, CorchTokens, CorchWorkerView } from '@/lib/api'

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
  // The worker reported done and Corch is running the task's check command (corch.ts startCheck).
  checking: {
    variant: 'info',
    icon: ListChecks,
    spin: false,
    label: 'corch.statusChecking',
    hint: 'corch.statusCheckingHint',
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
  w.status === 'queued' ||
  w.status === 'running' ||
  w.status === 'waiting' ||
  w.status === 'checking'

/** `#68 Darragh (CLI)`, or the bare name when the account has no instance number. */
export const corchAccountLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? a.name : `#${a.num} ${a.name}`

/** Every token a session ran (cache reads included: real traffic, a tenth of the price). */
export const tokenTotal = (t: CorchTokens): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
/** "85.3M": token counts are read at a glance, not to the unit. */
export const formatTokens = (n: number): string => compact.format(n)

/** The first line of a multi-line message, for a one-line row. */
export const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s

/** A model id as people say it: `claude-opus-5-5` → `Opus 5.5`. Anything else is shown as given. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  if (!m) return id
  const [, family = '', major, minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

/** The model and effort a task asked for and the model that ran, for the row's tag and the detail.
 *  null when it asked for neither and nothing has reported yet (the CLI's defaults). */
export function corchRunLabel(
  w: Pick<CorchWorkerView, 'model' | 'effort' | 'reportedModel'>,
): { model: string | null; effort: string | null; ran: string | null; differs: boolean } | null {
  const ran = w.reportedModel ?? null
  if (!w.model && !w.effort && !ran) return null
  return {
    model: w.model ? modelName(w.model) : null,
    effort: w.effort,
    ran: ran ? modelName(ran) : null,
    differs: !!(w.model && ran && w.model !== ran),
  }
}
