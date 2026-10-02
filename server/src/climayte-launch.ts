// Starting one CliMayte attempt on an account: which session it runs in, the transcript carried
// over on a move, what the CLI is told, its settings file and runner, and the bookkeeping once
// it is up. Split out of climayte.ts so each file can be read whole; the state it works on
// (workers, journal) is climayte-core.ts's.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  acctLabel,
  changed,
  claudeCommand,
  configDirOf,
  HOOKS,
  hasTranscript,
  journal,
  LOGS,
  lastHandoffNote,
  ownerClaudeDir,
  PROMPTS,
  peekLog,
  runnerSpecPath,
  sessionRan,
  signalPath,
  slashed,
  tailText,
  transcriptCandidates,
  transcriptFile,
} from './climayte-core'
import { firstLine } from './climayte-journal'
import {
  type CliMayteAccount,
  type CliMayteWorker,
  continuationPrompt,
  copySessionTranscript,
  HANDOFF_PROMPT,
  INTERRUPTED_PROMPT,
  keepReport,
  newestTranscript,
  PAUSED_PROMPT,
  scrubbedEnv,
  TRANSIENT_PROMPT,
  WORKER_BRIEF,
} from './climayte-lib'
import { syncOwnerClaude } from './climayte-owner-sync'
import { launchRunner } from './climayte-runner'
import { MCP_SERVER_KEY } from './mcp-register'

/** What a launch decides before it starts the CLI, and what its bookkeeping needs afterwards. */
interface LaunchPlan {
  /** This attempt's index: how many came before it. */
  n: number
  last: CliMayteWorker['attempts'][number] | undefined
  /** The handoff file a fresh session starts from, when this launch starts one. */
  note: string | null | undefined
  fresh: boolean
  oldSession: CliMayteWorker['sessionId']
  sessionId: string
  /** The account the session leaves, when this launch moves it. */
  fromId: string | null
  copied: boolean | undefined
  resume: boolean
  inSession: boolean
  /** The queued follow-up this launch would deliver. */
  next: string
  delivers: boolean
}

/** Which session this launch runs in. After a planned handoff the task goes on in a NEW session,
 *  started from the handoff file; so does a task whose transcript a move found nowhere, from its
 *  last handoff note (field note 30). */
function sessionPlan(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number] | undefined,
): Pick<LaunchPlan, 'note' | 'fresh' | 'oldSession' | 'sessionId'> {
  const note = w.handoffNote ?? (last?.outcome === 'handoff' ? last.windDown?.path : undefined)
  const fresh = !!note
  const oldSession = w.sessionId
  const sessionId = fresh || !w.sessionId ? crypto.randomUUID() : w.sessionId
  if (!fresh) w.sessionId = sessionId
  return { note, fresh, oldSession, sessionId }
}

/** Moving accounts: carry the transcript over so `--resume` finds it there, from whichever account
 *  holds its newest copy: the last one TRIED may never have run it (field note 30). A session that
 *  holds work already must not start over empty on the new account: with no copy to carry, the
 *  task is failed here (`failed`), and the launch stops. */
function moveTranscript(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  accounts: CliMayteAccount[],
  sessionId: string,
): { copied: boolean; failed: boolean } {
  const holder = newestTranscript(transcriptCandidates(w, accounts), sessionId)
  const copied = holder
    ? holder.id === acct.id || copySessionTranscript(holder.configDir, acct.configDir, sessionId)
    : false
  if (copied || !sessionRan(w, sessionId)) return { copied, failed: false }
  const label = acct.num === null ? acct.name : `#${acct.num} ${acct.name}`
  const kept = lastHandoffNote(w)
  w.status = 'failed'
  w.handoffNote = kept
  w.error = `No account holds this session's transcript (looked on ${transcriptCandidates(w, accounts).length}), so it cannot move to ${label} with its context. ${kept ? `Its last handoff note is ${slashed(kept)}: send it a message (climayte_send) and it continues from that note in a fresh session.` : 'It wrote no handoff note: start it again as a new task.'}`
  journal(w, 'failed', { account: acctLabel(acct), error: firstLine(w.error) })
  changed(w)
  return { copied, failed: true }
}

/** Whether the stopped attempt's message is in the session, and the follow-up this launch
 *  delivers, if it delivers one. */
function deliveryPlan(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number] | undefined,
  fresh: boolean,
): Pick<LaunchPlan, 'inSession' | 'next' | 'delivers'> {
  // Stopped after the CLI started (its init event is in the log): the message is already in the
  // session, so ask it to carry on. Stopped before that: the message never arrived, send it again.
  const inSession = !!last && (last.started ?? peekLog(last.log).sawInit)
  // A follow-up is shifted out of `pending` only once the spawn succeeded, so a failed spawn
  // cannot lose it. Without a transcript here the task itself goes first.
  const next = w.pending[0] ?? ''
  const stopped = !!last && ['quota', 'auth', 'transient', 'interrupted'].includes(last.outcome)
  const delivers = !fresh && !!last && w.pending.length > 0 && (w.revived === true || !stopped)
  return { inSession, next, delivers }
}

/** The message the attempt before this one was started with (its prompt file), else the task. */
const prevPromptOf = (w: CliMayteWorker, n: number): string =>
  tailText(join(PROMPTS, `${w.id}-${n - 1}.txt`), 1_000_000) || w.prompt

/** The continuation of a planned handoff: the task, the handoff, where the old transcript is, and
 *  any messages that arrived while the old session was winding down. */
function handoffText(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number],
  note: string,
  oldSession: CliMayteWorker['sessionId'],
  accounts: CliMayteAccount[],
): string {
  let handoff = ''
  try {
    handoff = readFileSync(note, 'utf8')
  } catch {
    handoff = '(The handoff file could not be read; use the earlier transcript.)'
  }
  const old = oldSession ? transcriptFile(configDirOf(last.account.id, accounts), oldSession) : null
  return continuationPrompt(w.prompt, handoff, note, old ? slashed(old) : null, w.pending)
}

/** A revived worker gets the message at once, not a continue prompt for the work it stopped. If
 *  the stopped attempt never started, its own message never arrived either: send it first. */
function followUpText(w: CliMayteWorker, p: LaunchPlan): string {
  if (w.revived === true && !p.inSession) return `${prevPromptOf(w, p.n)}\n\n${p.next}`
  return p.resume ? p.next : `${w.prompt}\n\n${p.next}`
}

/** What a session stopped by a wall, an API error or a kill is told when it goes on, or null
 *  when the attempt before did not end that way. */
function goOnText(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number],
  p: LaunchPlan,
): string | null {
  // Back on the same account once its wall lifted, the session did not move.
  if (last.outcome === 'quota' || last.outcome === 'auth')
    return p.resume && p.inSession
      ? p.fromId
        ? HANDOFF_PROMPT
        : PAUSED_PROMPT
      : prevPromptOf(w, p.n)
  if (last.outcome === 'transient' || last.outcome === 'interrupted')
    return p.resume && p.inSession
      ? last.outcome === 'transient'
        ? TRANSIENT_PROMPT
        : INTERRUPTED_PROMPT
      : prevPromptOf(w, p.n)
  return null
}

/** What the CLI is given on stdin for this launch. */
function launchText(w: CliMayteWorker, p: LaunchPlan, accounts: CliMayteAccount[]): string {
  const { last, note } = p
  if (!last) return w.prompt
  if (note) return handoffText(w, last, note, p.oldSession, accounts)
  if (p.delivers) return followUpText(w, p)
  return goOnText(w, last, p) ?? w.prompt
}

/** The worker's own settings. The wind-down channel: after every tool call the CLI runs this hook,
 *  which prints the worker's signal file when there is one (signalWindDown) and nothing otherwise,
 *  about 65 ms a call. And no AgentHydra MCP server: 84 of a worker's 138 tools were AgentHydra's
 *  own (measured), with which a worker could start more workers, fan out, or move the owner's
 *  desktop chats. A worker does its task; orchestration stays with the chat that asked.
 *  Nor the two other servers the CLI accounts' .claude.json lists that a worker cannot use:
 *  magnific only prints a sign-in notice, which a headless worker can never answer, and
 *  connections-local's instructions are about a memory and to-do list a worker does not keep.
 *  zswarm stays: a worker hands wide, cheap work to it. And no skills synced from claude.ai
 *  (docx, pptx, xlsx, computer-use, chrome-browser, ...: 14 of them, each listed with its
 *  description in every request); `syncClaudeAiSkills: false` given through --settings hides them
 *  for this run only and moves nothing in the account's folder (the CLI's own settings schema,
 *  2.1.286). The owner's skills, synced into the account by syncOwnerClaude, still load.
 *  Returns the settings file, with any signal left from an earlier attempt removed. */
function writeWorkerSettings(w: CliMayteWorker): string {
  mkdirSync(HOOKS, { recursive: true })
  const hookFile = join(HOOKS, `${w.id}.json`)
  // The owner's edit_claims hook, when installed: before an edit it records the file under this
  // task's id and says when another chat or worker edited it in the last half hour. Workers carry
  // none of the owner's hooks, so without this a worker's edits were invisible to it, and a worker
  // editing a chat's files was the collision it was built for (2026-10-01).
  const claims = ownerClaudeDir ? join(ownerClaudeDir, 'hooks', 'edit_claims.py') : null
  const preToolUse =
    claims && existsSync(claims)
      ? [
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [
              {
                type: 'command',
                command: `python '${slashed(claims)}' 2>/dev/null || true`,
                timeout: 10,
              },
            ],
          },
        ]
      : []
  writeFileSync(
    hookFile,
    JSON.stringify({
      deniedMcpServers: [MCP_SERVER_KEY, 'magnific', 'connections-local'].map((serverName) => ({
        serverName,
      })),
      syncClaudeAiSkills: false,
      hooks: {
        ...(preToolUse.length ? { PreToolUse: preToolUse } : {}),
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `cat '${slashed(signalPath(w.id))}' 2>/dev/null || true`,
              },
            ],
          },
        ],
      },
    }),
  )
  rmSync(signalPath(w.id), { force: true })
  return hookFile
}

function cliArgv(
  w: CliMayteWorker,
  sessionId: string,
  resume: boolean,
  hookFile: string,
): string[] {
  return [
    ...claudeCommand(),
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(w.model ? ['--model', w.model] : []),
    ...(w.effort ? ['--effort', w.effort] : []),
    '--settings',
    hookFile,
    '--append-system-prompt',
    WORKER_BRIEF,
  ]
}

/** Start the CLI under a runner (climayte-runner.ts), launched outside the daemon: a daemon restart
 *  leaves the CLI running and the next daemon reads it on from its files (owner, 2026-09-30).
 *  Files, never pipes, so nothing ties the CLI to this process. The runner's record, or null after
 *  failing the task when it could not start. */
function startRunner(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  argv: string[],
  files: { promptFile: string; log: string; errLog: string },
): NonNullable<CliMayteWorker['attempts'][number]['runner']> | null {
  const { promptFile, log, errLog } = files
  closeSync(openSync(log, 'a'))
  closeSync(openSync(errLog, 'a'))
  const runner = {
    pid: null,
    pidFile: `${log}.pid.json`,
    exitFile: `${log}.exit.json`,
    launchedAt: Date.now(),
  }
  rmSync(runner.pidFile, { force: true })
  rmSync(runner.exitFile, { force: true })
  try {
    launchRunner(
      {
        argv,
        cwd: w.cwd,
        // No claude.ai connectors (Gmail, Calendar, Drive, Notion, ...; several answer needs-auth).
        // Measured on #83 with the real CLI: with them it took 2.0-3.0 s to its init event and
        // loaded 158-202 tools (a different number run to run); without, 1.2-1.3 s and a steady 137
        // tools. Local MCP servers still load. Here, not in scrubbedEnv: quick add uses that too.
        // 5-minute prompt cache, not the subscription default of 1 hour: the CLI says 1-hour
        // writes bill at a higher rate (2x input against 1.25x), and cache writes were about a third
        // of what filled the 5-hour meter in run 1. Only 9 of its 2,105 requests came more than 5
        // minutes after the one before, so the re-writes cost 1.8M tokens against 10.4M written:
        // about 27% less write cost (owner's go-ahead, 2026-09-30).
        // No auto-memory: a worker does one task and what it should carry over goes in its
        // report or handoff note, yet the memory instructions rode in every request. The CLI
        // reads this variable ahead of the autoMemoryEnabled setting (2.1.286).
        env: {
          ...scrubbedEnv(acct.configDir, w.id),
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
          CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        stdin: promptFile,
        stdout: log,
        stderr: errLog,
        pidFile: runner.pidFile,
        exitFile: runner.exitFile,
      },
      runnerSpecPath(log),
    )
  } catch (err) {
    w.status = 'failed'
    w.error = `Could not start the CLI: ${err instanceof Error ? err.message : String(err)}`
    journal(w, 'failed', { account: acctLabel(acct), error: firstLine(w.error) })
    changed(w)
    return null
  }
  return runner
}

/** The journal: a move first (the account it left), then the start and why this account. */
function journalLaunch(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  p: LaunchPlan,
  activeOnAccount: number,
): void {
  if (p.fromId) {
    const left = [...w.attempts].reverse().find((a) => a.account.id === p.fromId)?.account
    journal(w, 'moved', {
      from: left ? acctLabel(left) : p.fromId,
      account: acctLabel(acct),
      copied: p.fresh ? undefined : p.copied,
    })
  }
  journal(w, p.fresh ? 'handoff-resumed' : p.delivers ? 'follow-up-delivered' : 'launched', {
    account: acctLabel(acct),
    attempt: p.n + 1,
    sessionPct: acct.sessionPct,
    weekPct: acct.weekPct,
    active: activeOnAccount,
    model: w.model,
    effort: w.effort,
  })
}

/** A new message, or a handoff's fresh session, starts a new report; the previous turns are kept
 *  in `reports` (keepReport), because a follow-up queued while a turn ran is delivered the moment
 *  it ends, before anyone reads it. Before a handoff they are labelled so: the continuation answers
 *  the same message, and its report is the one `result` should show. */
function startReport(w: CliMayteWorker, p: LaunchPlan): void {
  if (p.last && !p.delivers && !p.fresh) return
  const label = p.fresh ? `${w.message ?? firstLine(w.prompt, 200)} (before a handoff)` : w.message
  w.reports = keepReport({ ...w, message: label }, Date.now())
  if (!p.fresh) w.message = firstLine(p.delivers ? p.next : w.prompt, 200)
  w.result = null
  w.results = []
}

/** The bookkeeping once the CLI has started: the journal, the delivered follow-up, a fresh
 *  session's record, the new report, and the worker's running state. */
function noteLaunch(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  p: LaunchPlan,
  activeOnAccount: number,
): void {
  if (p.fromId) w.moves++
  journalLaunch(w, acct, p, activeOnAccount)
  if (p.delivers) w.pending.shift()
  if (p.fresh) {
    if (p.oldSession) w.sessions = [...(w.sessions ?? []), p.oldSession]
    w.sessionId = p.sessionId
    w.pending = [] // they went into the continuation prompt
    delete w.handoffNote
  }
  startReport(w, p)
  delete w.revived
  w.accountId = acct.id
  w.status = 'running'
  w.error = null
  w.notBefore = null
  changed(w)
}

/** `activeOnAccount`: workers already running on `acct` (every group) when it was picked; the
 *  journal records it with the account's usage, the two things pickAccount scores on. */
export function launch(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  accounts: CliMayteAccount[],
  activeOnAccount = 0,
): void {
  const n = w.attempts.length
  const last = w.attempts[n - 1]
  const session = sessionPlan(w, last)
  const { fresh, sessionId } = session
  const fromId = w.accountId !== acct.id ? w.accountId : null
  let copied: boolean | undefined
  if (fromId && !fresh) {
    const moved = moveTranscript(w, acct, accounts, sessionId)
    if (moved.failed) return
    copied = moved.copied
  }
  // The owner's global CLAUDE.md and skills, so a worker keeps the owner's rules (field note 5).
  if (ownerClaudeDir) syncOwnerClaude(ownerClaudeDir, acct.configDir)
  const resume = !fresh && hasTranscript(acct.configDir, sessionId)
  const plan: LaunchPlan = {
    n,
    last,
    ...session,
    fromId,
    copied,
    resume,
    ...deliveryPlan(w, last, fresh),
  }
  const text = launchText(w, plan, accounts)

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(PROMPTS, { recursive: true })
  const promptFile = join(PROMPTS, `${w.id}-${n}.txt`)
  writeFileSync(promptFile, text)
  const log = join(LOGS, `${w.id}-${n}.jsonl`)
  const errLog = join(LOGS, `${w.id}-${n}.err.log`)
  const hookFile = writeWorkerSettings(w)
  const argv = cliArgv(w, sessionId, resume, hookFile)
  const runner = startRunner(w, acct, argv, { promptFile, log, errLog })
  if (!runner) return
  w.attempts.push({
    account: { id: acct.id, num: acct.num, name: acct.name, configDir: acct.configDir },
    pid: null,
    log,
    errLog,
    startedAt: Date.now(),
    endedAt: null,
    outcome: 'running',
    notice: null,
    resumed: resume,
    sessionId,
    cacheTtl: '5m',
    startPct: acct.sessionPct,
    daemonPid: process.pid,
    runner,
    requested: { model: w.model, effort: w.effort },
  })
  noteLaunch(w, acct, plan, activeOnAccount)
}
