// How a CliMayte task's status and each account attempt look on screen: badge variant, icon, label and
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
import type {
  CliMayteAttemptOutcome,
  CliMayteStatus,
  CliMayteTokens,
  CliMayteWorkerView,
} from '@/lib/api'

export interface CliMayteStatusMeta {
  variant: BadgeVariants['variant']
  icon: LucideIcon
  /** Spin the icon (running only). */
  spin: boolean
  label: string
  hint: string
}

export const CLIMAYTE_STATUS: Record<CliMayteStatus, CliMayteStatusMeta> = {
  queued: {
    variant: 'muted',
    icon: Clock,
    spin: false,
    label: 'climayte.statusQueued',
    hint: 'climayte.statusQueuedHint',
  },
  running: {
    variant: 'info',
    icon: LoaderCircle,
    spin: true,
    label: 'climayte.statusRunning',
    hint: 'climayte.statusRunningHint',
  },
  waiting: {
    variant: 'warning',
    icon: Hourglass,
    spin: false,
    label: 'climayte.statusWaiting',
    hint: 'climayte.statusWaitingHint',
  },
  // The worker reported done and CliMayte is running the task's check command (climayte.ts startCheck).
  checking: {
    variant: 'info',
    icon: ListChecks,
    spin: false,
    label: 'climayte.statusChecking',
    hint: 'climayte.statusCheckingHint',
  },
  done: {
    variant: 'success',
    icon: CircleCheck,
    spin: false,
    label: 'climayte.statusDone',
    hint: 'climayte.statusDoneHint',
  },
  failed: {
    variant: 'destructive',
    icon: CircleX,
    spin: false,
    label: 'climayte.statusFailed',
    hint: 'climayte.statusFailedHint',
  },
  cancelled: {
    variant: 'outline',
    icon: Ban,
    spin: false,
    label: 'climayte.statusCancelled',
    hint: 'climayte.statusCancelledHint',
  },
}

export const CLIMAYTE_OUTCOME: Record<
  CliMayteAttemptOutcome,
  { variant: BadgeVariants['variant']; label: string }
> = {
  running: { variant: 'info', label: 'climayte.outcomeRunning' },
  done: { variant: 'success', label: 'climayte.outcomeDone' },
  quota: { variant: 'warning', label: 'climayte.outcomeQuota' },
  ceiling: { variant: 'info', label: 'climayte.outcomeCeiling' },
  transient: { variant: 'muted', label: 'climayte.outcomeTransient' },
  auth: { variant: 'warning', label: 'climayte.outcomeAuth' },
  // Killed from outside (a daemon restart) and resumed by itself: never the word for a manual Stop.
  interrupted: { variant: 'muted', label: 'climayte.outcomeInterrupted' },
  // Wound down near its limit and handed off to a fresh session; its notice says so.
  handoff: { variant: 'info', label: 'climayte.outcomeHandoff' },
  error: { variant: 'destructive', label: 'climayte.outcomeError' },
  cancelled: { variant: 'outline', label: 'climayte.outcomeCancelled' },
}

/** Why a task that has already run is queued again, as an i18n key and its values; null for one
 *  that simply has not started. Without it a task moving accounts after a limit looked exactly like
 *  one that had never run (2026-09-30 UI review). */
export function climayteQueuedNote(
  w: Pick<CliMayteWorkerView, 'status' | 'attempts' | 'notBefore' | 'retries'>,
  now: number,
): { key: string; values?: Record<string, number> } | null {
  if (w.status !== 'queued') return null
  const last = w.attempts[w.attempts.length - 1]
  if (!last) return null
  if (w.notBefore !== null && w.notBefore > now)
    return {
      key: 'climayte.queuedRetry',
      values: { s: Math.ceil((w.notBefore - now) / 1000), n: Math.max(1, w.retries) },
    }
  if (last.outcome === 'quota') return { key: 'climayte.queuedLimit' }
  if (last.outcome === 'auth') return { key: 'climayte.queuedSignedOut' }
  if (last.outcome === 'handoff') return { key: 'climayte.queuedHandoff' }
  if (last.outcome === 'interrupted') return { key: 'climayte.queuedRestart' }
  return null
}

export const isCliMayteActive = (w: Pick<CliMayteWorkerView, 'status'>): boolean =>
  w.status === 'queued' ||
  w.status === 'running' ||
  w.status === 'waiting' ||
  w.status === 'checking'

/** `#68 Darragh (CLI)`, or the bare name when the account has no instance number. */
export const climayteAccountLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? a.name : `#${a.num} ${a.name}`

/** Every token a session ran (cache reads included: real traffic, a tenth of the price). */
export const tokenTotal = (t: CliMayteTokens): number =>
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
export function climayteRunLabel(
  w: Pick<CliMayteWorkerView, 'model' | 'effort' | 'reportedModel'>,
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
