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
  Network,
} from '@lucide/vue'
import type { BadgeVariants } from '@/components/ui/badge/badge-variants'
import { pii, piiName } from '@/composables/usePrivacy'
import type {
  CliMayteAttemptOutcome,
  CliMayteStatus,
  CliMayteTokens,
  CliMayteVerdict,
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

/** A manager held between turns while its wave runs (`waiting` with `hold: 'wave'`): at work, not
 *  stuck and not waiting for quota, so it reads as info, not the warning `waiting` has. */
export const CLIMAYTE_WAVE_HOLD: CliMayteStatusMeta = {
  variant: 'info',
  icon: Network,
  spin: false,
  label: 'climayte.statusManaging',
  hint: 'climayte.statusManagingHint',
}

/** The chip for a status, or the manager's own when it is held on a wave. */
export const climayteStatusMeta = (
  status: CliMayteStatus,
  hold?: 'wave' | null,
): CliMayteStatusMeta =>
  status === 'waiting' && hold === 'wave' ? CLIMAYTE_WAVE_HOLD : CLIMAYTE_STATUS[status]

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

/** `#68 Darragh (CLI)`, or the bare name when the account has no instance number. Privacy mode
 *  masks it: a numbered instance's name may be the account's address, and a bare name IS the
 *  account's. */
export const climayteAccountLabel = (a: { num: number | null; name: string }): string =>
  a.num === null ? piiName(a.name) : `#${a.num} ${pii(a.name)}`

/** Every token a session ran (cache reads included: real traffic, a tenth of the price). */
export const tokenTotal = (t: CliMayteTokens): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite

/** "85.3M": token counts are read at a glance, not to the unit (the kit's formatter). */
export { formatTokens } from './kit'

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

/** One line of a failed task's story, as an i18n key and its values. */
export interface CliMayteStoryLine {
  key: string
  values?: Record<string, string | number>
  /** Values that are i18n keys themselves (an outcome, a status, "default"), translated first. */
  keys?: Record<string, string>
  /** How its attempts ended, most frequent first; they become the line's `list` value. */
  counts?: { n: number; label: string }[]
}

/** What failed, how it got there, what happened next, and where it stands now. */
export interface CliMayteFailedStory {
  what: CliMayteStoryLine
  how: CliMayteStoryLine[]
  next: CliMayteStoryLine[]
  end: CliMayteStoryLine
}

type CliMayteStoryTask = Pick<
  CliMayteWorkerView,
  | 'id'
  | 'title'
  | 'cwd'
  | 'status'
  | 'error'
  | 'attempts'
  | 'verdicts'
  | 'judged'
  | 'pending'
  | 'model'
  | 'effort'
  | 'reportedModel'
  | 'auto'
  | 'createdAt'
>

/** The first sentence of a message's first line: the server writes a task's error for people, and
 *  its opening sentence says what failed. */
function firstSentence(s: string): string {
  const line = firstLine(s).trim()
  return /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
}

/** `{model}` and `{effort}` for a story line; "default" where the task named none. */
function storyRun(
  model: string | null,
  effort: string | null,
): { values: Record<string, string>; keys: Record<string, string> } {
  const values: Record<string, string> = {}
  const keys: Record<string, string> = {}
  if (model) values.model = modelName(model)
  else keys.model = 'climayte.runDefault'
  if (effort) values.effort = effort
  else keys.effort = 'climayte.runDefault'
  return { values, keys }
}

const STORY_VERDICT = {
  pass: {
    owner: 'climayte.failedAcceptedOwner',
    orchestrator: 'climayte.failedAcceptedOrchestrator',
    unknown: 'climayte.failedAccepted',
  },
  fail: {
    owner: 'climayte.failedRejectedOwner',
    orchestrator: 'climayte.failedRejectedOrchestrator',
    unknown: 'climayte.failedRejected',
  },
}

/** The lines saying how a failed task got there: its attempts, and what it ran on. */
function failedHow(w: CliMayteStoryTask): CliMayteStoryLine[] {
  const tally = new Map<CliMayteAttemptOutcome, number>()
  for (const a of w.attempts) {
    const outcome: CliMayteAttemptOutcome = a.ceiling ? 'ceiling' : a.outcome
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1)
  }
  const counts = [...tally]
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, n]) => ({ n, label: CLIMAYTE_OUTCOME[outcome].label }))
  const [only] = counts
  const how: CliMayteStoryLine[] = [
    !only
      ? { key: 'climayte.failedNeverRan' }
      : w.attempts.length === 1
        ? { key: 'climayte.failedAttemptOne', keys: { outcome: only.label } }
        : { key: 'climayte.failedAttempts', values: { n: w.attempts.length }, counts },
  ]
  const run = climayteRunLabel(w)
  if (run?.differs && run.model) {
    const ran = storyRun(w.reportedModel ?? null, w.effort)
    how.push({
      key: 'climayte.failedRanOther',
      values: { ...ran.values, asked: run.model },
      keys: ran.keys,
    })
  } else if (w.auto)
    how.push({ key: 'climayte.failedRanAuto', ...storyRun(w.reportedModel ?? w.model, w.effort) })
  return how
}

/** The key for a failed task's end result: accepted, still failed, or what the redo became. */
function failedEnd(accepted: boolean, redo: CliMayteStoryTask | undefined): string {
  return accepted
    ? 'climayte.failedEndAccepted'
    : !redo
      ? 'climayte.failedEndStill'
      : redo.status === 'done'
        ? 'climayte.failedEndRedoDone'
        : redo.status === 'failed'
          ? 'climayte.failedEndRedoFailed'
          : redo.status === 'cancelled'
            ? 'climayte.failedEndRedoStopped'
            : 'climayte.failedEndRedoActive'
}

/** A failed task's story, from the task and the loaded task list; null for any other status. The
 *  list's hover and the detail pane both print it (owner, 2026-10-02: "a little clearer to the human
 *  what failed, and also what the next result was. Try again, use a smarter model, what happened,
 *  what was the end result"). */
export function climayteFailedStory(
  w: CliMayteStoryTask,
  tasks: readonly CliMayteStoryTask[],
): CliMayteFailedStory | null {
  if (w.status !== 'failed') return null

  const how = failedHow(w)
  const next: CliMayteStoryLine[] = []
  // The check's own verdicts are part of how it failed; only a person's or the orchestrator's
  // newest one is something that happened to the failure. And only when nothing ran since
  // (`judged`): a thumbs-down sends the task back, and a rerun that then fails came AFTER that
  // verdict, so the verdict is not what happened next.
  const last = w.verdicts?.[w.verdicts.length - 1]
  let accepted = false
  if (last && last.by !== 'check' && w.judged) {
    accepted = last.verdict === 'pass'
    next.push({ key: STORY_VERDICT[last.verdict][last.by ?? 'unknown'] })
    if (last.note) next.push({ key: 'climayte.failedNote', values: { note: firstLine(last.note) } })
  }
  // Started again: the newest later task with the same title in the same folder.
  const redo = tasks
    .filter(
      (o) => o.id !== w.id && o.title === w.title && o.cwd === w.cwd && o.createdAt > w.createdAt,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (redo) {
    const status = { status: CLIMAYTE_STATUS[redo.status].label }
    const was = w.reportedModel ?? w.model
    const now = redo.reportedModel ?? redo.model
    if ((was && now && modelName(was) !== modelName(now)) || w.effort !== redo.effort) {
      const ran = storyRun(now ?? null, redo.effort)
      next.push({
        key: 'climayte.failedRedoneOn',
        values: ran.values,
        keys: { ...ran.keys, ...status },
      })
    } else next.push({ key: 'climayte.failedRedone', keys: status })
  }
  if (w.pending.length)
    next.push({ key: 'climayte.failedFollowUp', values: { n: w.pending.length } })
  if (!next.length) next.push({ key: 'climayte.failedNothingNext' })

  const end = failedEnd(accepted, redo)

  return {
    what: w.error
      ? { key: 'climayte.failedWhat', values: { error: firstSentence(w.error) } }
      : { key: 'climayte.failedNoReason' },
    how,
    next,
    end: { key: end },
  }
}

/** The story as its four lines of text (what failed, how, what came next, the end result), so the
 *  hover and the detail pane print the same words. `t` is vue-i18n's. */
export function climayteStoryLines(
  story: CliMayteFailedStory,
  t: (key: string, values: Record<string, unknown>) => string,
): string[] {
  const text = (line: CliMayteStoryLine): string => {
    const values: Record<string, unknown> = { ...line.values }
    for (const [name, key] of Object.entries(line.keys ?? {})) values[name] = t(key, {})
    if (line.counts) values.list = line.counts.map((c) => `${c.n} ${t(c.label, {})}`).join(', ')
    return t(line.key, values)
  }
  return [[story.what], story.how, story.next, [story.end]].map((part) => part.map(text).join(' '))
}

/** The row's verdict mark: a tick, a cross, or "on another round". A failed verdict on a task that
 *  is still working is a retry, not a failure: on 2026-10-02 ten running rows each showed a red
 *  cross after their own check said no, and the list read as "lots of chats failed" (owner). The
 *  hover says who judged it; `note` is the first line of what they said. */
export function climayteVerdictMark(
  w: Pick<CliMayteWorkerView, 'status' | 'verdicts'>,
): { kind: 'pass' | 'fail' | 'retry'; key: string; values: { n: number }; note: string } | null {
  const verdicts = w.verdicts ?? []
  const v = verdicts[verdicts.length - 1]
  if (!v) return null
  const note = v.note ? firstLine(v.note) : ''
  const by = v.by ?? 'unknown'
  if (v.verdict === 'pass') return { kind: 'pass', key: VERDICT_PASS[by], values: { n: 0 }, note }
  const n = verdicts.filter((x) => x.verdict === 'fail' && (x.by ?? 'unknown') === by).length
  return isCliMayteActive(w)
    ? { kind: 'retry', key: VERDICT_RETRY[by], values: { n }, note }
    : { kind: 'fail', key: VERDICT_FAIL[by], values: { n }, note }
}
type VerdictBy = NonNullable<CliMayteVerdict['by']> | 'unknown'
const VERDICT_PASS: Record<VerdictBy, string> = {
  check: 'climayte.verdictPassCheck',
  orchestrator: 'climayte.verdictPassOrchestrator',
  owner: 'climayte.verdictPassOwner',
  unknown: 'climayte.verdictPassed',
}
const VERDICT_FAIL: Record<VerdictBy, string> = {
  check: 'climayte.verdictFailCheck',
  orchestrator: 'climayte.verdictFailOrchestrator',
  owner: 'climayte.verdictFailOwner',
  unknown: 'climayte.verdictFailed',
}
const VERDICT_RETRY: Record<VerdictBy, string> = {
  check: 'climayte.verdictRetryCheck',
  orchestrator: 'climayte.verdictRetrySentBack',
  owner: 'climayte.verdictRetrySentBack',
  unknown: 'climayte.verdictRetrySentBack',
}
