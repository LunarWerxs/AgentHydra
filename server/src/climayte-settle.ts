// server/src/climayte-settle.ts — a finished attempt's outcome turned into its worker's next state
// (settleWorker): the account's wall, a transient retry, a resume, a broken install, the results
// kept, and the attempt's journal line and charge. finish in climayte.ts calls it. Split from
// climayte.ts on 2026-10-08; nothing here imports it.

import { statSync } from 'node:fs'
import { claudeInstallState, INSTALL_BROKEN_HEAD } from './claude-install-guard'
import {
  accountsProvider,
  acctLabel,
  chargeAttempt,
  claudeCommand,
  configDirOf,
  journal,
  latestUsage,
  ORG_WALL_MS,
  spentOf,
  transcriptCandidates,
  transcriptFile,
  walls,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import {
  addResults,
  type CliMayteAccount,
  type CliMayteWorker,
  type classifyAttempt,
  IDENTITY_WALL,
  isIdentityCheck,
  isInstantEmptyDeath,
  isOrgDisabled,
  joinResults,
  newestTranscript,
  notConverging,
  ORG_DISABLED_WALL,
  wallUntil,
} from './climayte-lib'
import { ceilingFields, credStamp, trySaveWalls } from './climayte-stops'
import { holdManagerForWave } from './climayte-wave-ops'
import { resolveClaudeExe } from './config'
import { getCliInstance } from './core/cli-instances'
import { parseResetTime } from './usage'

/** A CLI that died at once with nothing on stdout or stderr and no runner pid is either killed from
 *  outside or unable to run at all. A fresh look at the install tells them apart: when it does not
 *  run (or the last-known-good copy had to stand in), the death is the install's, not the task's:
 *  'install-broken' spends no retry and moves nothing (2026-10-06: a placeholder claude.exe read as
 *  "interrupted" three times and failed the chat). */
export function installBroken(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  events: unknown[],
  stderr: string,
  hadRunnerPid: boolean,
): ReturnType<typeof classifyAttempt> {
  if (v.outcome !== 'interrupted' && v.outcome !== 'error') return v
  const livedMs = (at.endedAt ?? Date.now()) - at.startedAt
  if (!isInstantEmptyDeath({ livedMs, events, stderr, hadRunnerPid })) return v
  if (claudeCommand()[0] !== resolveClaudeExe()) return v
  const st = claudeInstallState(true)
  if (st.ok && !st.usingLastKnownGood) return v
  return { ...v, outcome: 'install-broken', notice: st.reason }
}

/** Every turn's closing text, not just the last: a repo's Stop hook can force a turn after the
 *  report (field note 13), and a limit can cut the session after one. `result` is them joined. */
export function keepResults(
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

/** Wall an account whose login no longer works until its credential file changes (recheckSignedOut). */
function wallSignedOut(
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
): void {
  const dir = getCliInstance(at.account.id)?.configDir
  const org = isOrgDisabled(v.notice)
  walls[at.account.id] = {
    until: org ? now + ORG_WALL_MS : now,
    reason: org ? ORG_DISABLED_WALL : isIdentityCheck(v.notice) ? IDENTITY_WALL : 'signed out',
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

/** The worker's state from its attempt's outcome alone, with the account's wall where it earned one
 *  (settleWorker). */
function settleByOutcome(
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
      // `retries` is not reset here or at a limit: they happen mid-turn, and resetting made "3 per
      // turn" into "3 between limits", which never ends (stress review, 2026-10-02).
      w.error = null
      w.status = 'queued'
      break
    case 'quota':
      wallAtLimit(at, v, now)
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
    case 'install-broken':
      // Held where it is: no retry spent, no wall, no move. The next tick's guard says why and
      // releases it the moment the install runs.
      w.status = 'waiting'
      w.error = `${INSTALL_BROKEN_HEAD}: ${v.notice ?? 'the CLI cannot start'}.`
      w.waitUntil = null
      break
    default:
      w.status = 'failed'
      w.error = v.result || stderr.slice(-1_500) || 'The CLI exited without a result.'
  }
}

/** The worker's next state from how its attempt ended, with the account's wall where it earned one. */
export function settleWorker(
  w: CliMayteWorker,
  at: CliMayteWorker['attempts'][number],
  v: ReturnType<typeof classifyAttempt>,
  now: number,
  stderr: string,
): void {
  settleByOutcome(w, at, v, now, stderr)
  // A requeued task that keeps moving, handing off or spending stops here and asks (notConverging).
  if (w.status === 'queued' && (v.outcome === 'handoff' || v.outcome === 'quota')) {
    const stop = notConverging(w)
    if (stop) {
      w.status = 'failed'
      w.error = stop
    }
  }

  // Piece 2: The hold. When a manager's turn ends done while its wave has live tasks and no report,
  // hold it in waiting with hold: 'wave'.
  if (v.outcome === 'done' && w.kind === 'manage' && w.wave && w.status !== 'failed')
    holdManagerForWave(w, w.wave, now)
}

/** An attempt refused at sign-in, or stopped at a limit, before it wrote anything to the session
 *  never becomes the session's home (field note 30): the home goes back to the account holding the
 *  newest transcript, which the next launch resumes on or moves from. */
export function keepHome(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): void {
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
export function journalFinish(
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
        // The estimate this turn settled (finish), never an earlier turn's.
        ...(w.eta?.tookS !== undefined && w.eta.doneAt === at.endedAt
          ? { etaMin: w.eta.minutes, tookMin: Math.round(w.eta.tookS / 6) / 10 }
          : {}),
      })
      break
    case 'handoff':
      // A ceiling stop that still got its handoff written is a ceiling stop all the same: without
      // this line the night's one ceiling stop (w-d7fbb102, #102) was in the totals but not here.
      if (at.ceiling) journal(w, 'limit', { account, until: until(), ...ceilingFields(at.ceiling) })
      journal(w, 'handoff-written', { account, path: at.windDown?.path })
      break
    case 'quota':
      journal(w, 'limit', {
        account,
        notice,
        until: until(),
        ...(at.ceiling ? ceilingFields(at.ceiling) : {}),
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
    case 'install-broken':
      journal(w, 'install-broken', { account, notice })
      break
  }
}

/** Charge an ended attempt to its task: its own cost and tokens. Returns the cost. */
export function charge(w: CliMayteWorker, at: CliMayteWorker['attempts'][number]): number {
  const spent = spentOf(w, at)
  chargeAttempt(w, at, spent)
  return spent.costUsd
}
