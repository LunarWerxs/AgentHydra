// What CliMayte does when an attempt ends (climayte.ts poll): read the CLI's verdict, apply
// CliMayte's own stops to it, wall the account where it earned one, and set the task's next
// state. Split out of climayte.ts so each file can be read whole; it works on that module's
// state (workers, walls, journal), which it imports. Nothing here runs at import time.

import { rmSync, statSync } from 'node:fs'
import {
  accountsProvider,
  acctLabel,
  changed,
  charge,
  configDirOf,
  credStamp,
  forgetRead,
  handoffWritten,
  journal,
  latestUsage,
  ORG_WALL_MS,
  SIGNED_OUT_MS,
  schedule,
  signalPath,
  startCheck,
  tailText,
  transcriptCandidates,
  transcriptFile,
  trySaveWalls,
  walls,
} from './climayte'
import { firstLine } from './climayte-journal'
import {
  addResults,
  type CliMayteAccount,
  type CliMayteWorker,
  ceilingNotice,
  classifyAttempt,
  isOrgDisabled,
  joinResults,
  newestTranscript,
  ORG_DISABLED_WALL,
  OVERAGE_NOTICE,
  wallUntil,
} from './climayte-lib'
import { readRunnerExit } from './climayte-runner'
import { getCliInstance } from './core/cli-instances'
import { parseResetTime } from './usage'

/** What the session left running, ended with its runner's job (field note 43), goes in the
 *  journal; the runner's own files go. */
function cleanUpRunner(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
  if (!at.runner) return
  const left = readRunnerExit(at.runner.exitFile)?.left
  if (left?.length)
    journal(w, 'cleaned', {
      account: acctLabel(at.account),
      notice: firstLine(
        left.map((p) => `${p.name} ${p.pid}${p.command ? `: ${p.command}` : ''}`).join('; '),
      ),
    })
  rmSync(at.runner.pidFile, { force: true })
  rmSync(at.runner.exitFile, { force: true })
}

/** Stopped at the ceiling: from its handoff when it wrote one, else on like a limit (the wall is up). */
function ceilingVerdict(
  at: CliMayteWorker['attempts'][number],
  ceiling: NonNullable<CliMayteWorker['attempts'][number]['ceiling']>,
  v: ReturnType<typeof classifyAttempt>,
): ReturnType<typeof classifyAttempt> {
  if (at.windDown && handoffWritten(at.windDown))
    return {
      ...v,
      outcome: 'handoff',
      notice: `${ceilingNotice(ceiling)} Its handoff was written; the task continues in a fresh session.`,
    }
  return {
    ...v,
    outcome: 'quota',
    notice: ceilingNotice(ceiling),
    resetsAt: ceiling.resetsAt,
    window: ceiling.week ? 'weekly' : 'session',
    resets: null,
  }
}

/** The CLI's verdict as CliMayte's own stops change it: an overage stop and a ceiling stop are
 *  limits (or a handoff), and a wind-down that wrote its handoff is one too. */
function withStops(
  at: CliMayteWorker['attempts'][number],
  verdict: ReturnType<typeof classifyAttempt>,
): ReturnType<typeof classifyAttempt> {
  let v = verdict
  // Stopped to spare paid extra usage: a limit, whatever the killed process left behind. A turn
  // that still finished cleanly keeps its result; its account is walled either way.
  if (at.overage && v.outcome !== 'done')
    v = {
      ...v,
      outcome: 'quota',
      notice: at.overage.notice ?? OVERAGE_NOTICE,
      resetsAt: at.overage.resetsAt,
      window: 'session',
      resets: null,
    }
  if (at.ceiling && v.outcome !== 'done') v = ceilingVerdict(at, at.ceiling, v)
  // Asked to wind down: a handoff written after the signal means the task goes on in a fresh
  // session elsewhere; none means the session reported the whole task complete instead.
  if (at.windDown && v.outcome === 'done' && handoffWritten(at.windDown))
    v = {
      ...v,
      outcome: 'handoff',
      notice:
        at.windDown.pct === null
          ? 'Handed off on request: wrote a handoff; the task continues in a fresh session.'
          : `Wound down at ${Math.round(at.windDown.pct)}% of its usage limit and wrote a handoff; the task continues in a fresh session on another account.`,
    }
  return v
}

/** Every turn's closing text, not just the last: a repo's Stop hook can force a turn after the
 *  report (field note 13), and a limit can cut the session after one. `result` is them joined. */
function keepResults(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
): void {
  if (v.turnTexts.length) {
    w.results = addResults(w.results, v.turnTexts)
    w.result = joinResults(w.results)
    for (const text of v.turnTexts)
      journal(w, 'turn-end', {
        account: acctLabel(at.account),
        attempt: w.attempts.length,
        said: firstLine(text),
      })
  } else if (v.outcome === 'done' || v.outcome === 'handoff') w.result = v.result
}

/** Wall an account that hit its limit until the limit resets. */
function wallAtLimit(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  // The CLI's own resetsAt when it streamed one, else the notice's text (wallUntil). A weekly
  // wall with neither falls back to the account's own weekly reset rather than an hour.
  let weekly: number | null = null
  if (v.resetsAt === null && (v.window === 'weekly' || /weekly/i.test(v.notice ?? ''))) {
    const reading = latestUsage(at.account.id, getCliInstance(at.account.id)?.lastUsageCheck)
    const week = Date.parse(reading?.weekAll?.resetsAt ?? '')
    if (Number.isFinite(week)) weekly = week
  }
  walls[at.account.id] = {
    until: wallUntil(now, v, parseResetTime, weekly),
    reason: v.notice ?? 'usage limit',
  }
  // The wall holds in memory either way; a throw here must not leave the worker 'running'.
  trySaveWalls()
}

/** Wall an account whose login no longer works, until its recheck (recheckSignedOut). */
function wallSignedOut(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  const dir = getCliInstance(at.account.id)?.configDir
  const org = isOrgDisabled(v.notice)
  walls[at.account.id] = {
    until: now + (org ? ORG_WALL_MS : SIGNED_OUT_MS),
    reason: org ? ORG_DISABLED_WALL : 'signed out',
    cred: dir ? credStamp(dir) : null,
  }
  trySaveWalls()
}

function retryTransient(
  w: CliMayteWorker,
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  if (w.retries < 3) {
    w.notBefore = now + [5_000, 10_000, 20_000][w.retries]!
    w.retries++
    w.status = 'queued'
  } else {
    w.status = 'failed'
    w.error = `Anthropic stayed overloaded through 3 retries: ${v.notice ?? ''}`.trim()
  }
}

/** Killed from outside with the transcript intact: resume the same session on the same
 *  account. Three in one turn means something keeps killing it, and that needs a person. No
 *  delay: with one, a resume took 3.1 s every time (6 real cases), all of it waiting. */
function resumeInterrupted(w: CliMayteWorker, stderr: string): void {
  if (w.retries < 3) {
    w.notBefore = null
    w.retries++
    w.status = 'queued'
  } else {
    w.status = 'failed'
    w.error = `The CLI was stopped before it finished three times in a row in this turn.${stderr ? ` Its last error output: ${stderr.slice(-1_500)}` : ''}`
  }
}

/** The worker's next state from how its attempt ended, with the account's wall where it earned one. */
function settleWorker(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
  stderr: string,
): void {
  switch (v.outcome) {
    case 'done':
      w.retries = 0
      w.error = null
      w.status = w.pending.length ? 'queued' : 'done'
      break
    case 'handoff':
      // launch() starts the next session from the handoff; the wound-down account is tried last.
      w.retries = 0
      w.error = null
      w.status = 'queued'
      break
    case 'quota':
      wallAtLimit(at, v, now)
      w.retries = 0
      w.status = 'queued'
      break
    case 'auth':
      wallSignedOut(at, v, now)
      w.status = 'queued'
      break
    case 'transient':
      retryTransient(w, v, now)
      break
    case 'interrupted':
      resumeInterrupted(w, stderr)
      break
    default:
      w.status = 'failed'
      w.error = v.result || stderr.slice(-1_500) || 'The CLI exited without a result.'
  }
}

export function finish(w: CliMayteWorker, events: unknown[]): void {
  const at = w.attempts[w.attempts.length - 1]
  if (at?.outcome !== 'running') return
  cleanUpRunner(w, at)
  const stderr = tailText(at.errLog, 4_000)
  const v = withStops(at, classifyAttempt(events, stderr, at.started === true))
  rmSync(signalPath(w.id), { force: true })
  forgetRead(at.log)
  const now = Date.now()
  if (v.outcome === 'auth' || v.outcome === 'quota') keepHome(w, at)
  at.outcome = v.outcome
  at.notice = v.notice
  at.endedAt = now
  const spent = charge(w, at)
  w.turns += v.turns
  keepResults(w, at, v)
  if (w.status === 'cancelled') {
    changed(w)
    return
  }
  settleWorker(w, at, v, now, stderr)
  // climayteSend told the caller a queued message would be delivered; say that it was not.
  if (w.status === 'failed' && w.pending.length)
    w.error =
      `${w.error ?? ''} ${w.pending.length} queued message(s) were not delivered; send one again to retry.`.trim()
  journalFinish(w, at, v, spent)
  if (w.status === 'done' && w.check) startCheck(w)
  changed(w)
  schedule(50)
}

/** An attempt refused at sign-in, or stopped at a limit, before it wrote anything to the session
 *  never becomes the session's home (field note 30): the home goes back to the account holding the
 *  newest transcript, which the next launch resumes on or moves from. */
function keepHome(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
  const sessionId = at.sessionId ?? w.sessionId
  if (!sessionId || w.accountId !== at.account.id) return
  let accounts: CliMayteAccount[] = []
  try {
    accounts = accountsProvider()
  } catch {
    // the attempts' own accounts still resolve through the instance store
  }
  const here = configDirOf(at.account.id, accounts)
  const file = transcriptFile(here, sessionId)
  try {
    if (file && statSync(file).mtimeMs >= at.startedAt) return // it wrote: this is the home
  } catch {
    // gone since: it wrote nothing that is still there
  }
  const others = transcriptCandidates(w, accounts).filter((c) => c.id !== at.account.id)
  const holder = newestTranscript(others, sessionId)
  if (holder) w.accountId = holder.id
}

/** The journal line for an attempt that just ended (finish), from its verdict and the worker's
 *  new state. */
function journalFinish(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: {
    outcome: CliMayteWorker['attempts'][number]['outcome']
    notice: string | null
    turns: number
  },
  spent: number,
): void {
  const account = acctLabel(at.account)
  const notice = v.notice ? firstLine(v.notice) : undefined
  const until = (): string | undefined => {
    const u = walls[at.account.id]?.until
    return u ? new Date(u).toISOString() : undefined
  }
  if (w.status === 'failed') {
    journal(w, 'failed', { account, error: firstLine(w.error) })
    return
  }
  switch (v.outcome) {
    case 'done':
      journal(w, w.status === 'done' ? 'done' : 'turn-done', {
        account,
        costUsd: Math.round(spent * 10_000) / 10_000,
        turns: v.turns,
        totalCostUsd: Math.round(w.costUsd * 10_000) / 10_000,
      })
      break
    case 'handoff':
      // A ceiling stop that still got its handoff written is a ceiling stop all the same: without
      // this line the night's one ceiling stop (w-d7fbb102, #102) was in the totals but not here.
      if (at.ceiling)
        journal(w, 'limit', { account, until: until(), ceiling: true, pct: at.ceiling.pct })
      journal(w, 'handoff-written', { account, path: at.windDown?.path })
      break
    case 'quota':
      journal(w, 'limit', {
        account,
        notice,
        until: until(),
        ...(at.ceiling ? { ceiling: true, pct: at.ceiling.pct } : {}),
      })
      break
    case 'auth':
      journal(w, 'signed-out', { account, notice, until: until() })
      break
    case 'transient':
      journal(w, 'retry', {
        account,
        notice,
        retry: w.retries,
        waitS: w.notBefore ? Math.round((w.notBefore - Date.now()) / 1000) : 0,
      })
      break
    case 'interrupted':
      journal(w, 'interrupted', { account, retry: w.retries })
      break
  }
}
