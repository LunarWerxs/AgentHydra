// Starting one CliMayte attempt on an account: which session it runs in, the transcript carried
// over on a move, what the CLI is told, its settings file and runner, and the bookkeeping once
// it is up. Split out of climayte.ts so each file can be read whole; the state it works on
// (workers, journal) is climayte-core.ts's.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import {
  acctLabel,
  changed,
  claudeCommand,
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
  workers,
} from './climayte-core'
import { copySessionToCwd } from './climayte-cwd'
import { etaBandCalibrations, etaCalibration, etaNote, MAX_PAST_ETAS } from './climayte-eta'
import { allEtaSamples } from './climayte-eta-ledger'
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
import { ownerMcpServers, syncOwnerClaude } from './climayte-owner-sync'
import { launchRunner } from './climayte-runner'
import { HAIKU } from './climayte-scorecard'
import { workerHooks } from './climayte-signal'
import { readWave, waveStateText } from './climayte-wave'
import { PORT } from './config'
import { OLD_HAIKU } from './core/haiku-pin'
import {
  deskBrowserMcpUrl,
  isAgenthydraBrowserEntry,
  MCP_PATH,
  MCP_SERVER_KEY,
} from './mcp-register'
import { getOrchestratorDaemonUrl } from './orchestrator'

/** The most processes one worker's tree may have alive at once, the runner included (Windows leaves
 *  console hosts, conhost.exe, out of the count it enforces).
 *  Not a limit on how many workers run: it ends a runaway inside its own job (2026-10-03: a worker's
 *  self-calling shell function started about 3,000 processes and froze the desktop). The busiest
 *  worker measured 2026-10-04 had 48 alive, so this leaves it eight times that. Each runner
 *  records its worker's peak in its exit file (RunnerExit.peakProcesses), to tune it by. */
export const WORKER_MAX_PROCESSES = 400

/** Piece 6: when a manager's conversation exceeds this (the newest request's input, cache reads and
 *  cache writes), the next wake starts a fresh session from waveStateText instead of a handoff note. */
export const MANAGER_CONTEXT_TOKENS = 60_000

/** What a manager's fresh session is told first (the wave's state follows it): its job and the one
 *  rule that matters, that it can never write a pass. */
export const MANAGER_BRIEF = `You are the manager of a wave of tasks (the CLIManager). The wave's state is below and its tools are the climayte-manager MCP server: wave_state, wave_dispatch, wave_send, wave_cancel, wave_escalate, wave_note, wave_report. Dispatch the keys whose "after" keys have passed, answer escalations, and call wave_report when every key is passed, failed or escalated. You never write a pass: the daemon judges each task by command (its check, that its commits exist on the branch, that its diff stays inside the brief's paths), and the orchestrator accepts the wave. End every brief you write with a line \`Commits: <sha>...\` or \`Commits: none\`. You never deploy, publish or release. Keep your own replies short; each wake costs the owner usage.`

/** A manager's session ends and a fresh one starts from the wave's state (waveStateText) rather than
 *  a resume or a handoff note when it grew past MANAGER_CONTEXT_TOKENS, or after a handoff, a
 *  limit, a move or a crash: the state is on disk, so nothing is lost and the new session is small. */
function managerWake(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number] | undefined,
  moving: boolean,
): boolean {
  if (w.kind !== 'manage' || !w.wave || !last) return false
  return moving || last.outcome !== 'done' || (last.context ?? 0) > MANAGER_CONTEXT_TOKENS
}

/** The prompt of a manager's fresh session: its brief, the wave as the store holds it, and what was
 *  queued for it (the batch report that woke it). */
function managerText(
  w: CliMayteWorker,
  accounts: CliMayteAccount[],
  acct: CliMayteAccount,
): string {
  let state = '(The wave record could not be read; call wave_state.)'
  for (const dir of [acct.configDir, ...accounts.map((a) => a.configDir)]) {
    const wave = w.wave ? readWave(dir, w.wave) : null
    if (!wave) continue
    state = waveStateText(wave, workers)
    break
  }
  return [MANAGER_BRIEF, state, ...w.pending].join('\n\n')
}

/** What a launch decides before it starts the CLI, and what its bookkeeping needs afterwards. */
interface LaunchPlan {
  /** This attempt's index: how many came before it. */
  n: number
  last: CliMayteWorker['attempts'][number] | undefined
  /** The handoff file a fresh session starts from, when this launch starts one. */
  note: string | null | undefined
  /** A manager's fresh session started from the wave's state (managerWake). */
  wake: boolean
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
  moving: boolean,
): Pick<LaunchPlan, 'note' | 'wake' | 'fresh' | 'oldSession' | 'sessionId'> {
  const wake = managerWake(w, last, moving)
  const note = wake
    ? undefined
    : (w.handoffNote ?? (last?.outcome === 'handoff' ? last.windDown?.path : undefined))
  const fresh = wake || !!note
  const oldSession = w.sessionId
  const sessionId = fresh || !w.sessionId ? crypto.randomUUID() : w.sessionId
  if (!fresh) w.sessionId = sessionId
  return { note, wake, fresh, oldSession, sessionId }
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

/** A message asked for another folder (climayteSend `cwd`): carry the session into that folder's
 *  project dir on this account (the original stays) so `--resume` finds it there, and run there.
 *  A fresh session has nothing to carry. A session that ran but cannot be copied stays where it is:
 *  resuming in a folder without its transcript would start over empty. */
export function applyPendingCwd(
  w: CliMayteWorker,
  acct: CliMayteAccount,
  sessionId: string,
  fresh: boolean,
): void {
  const to = w.pendingCwd
  delete w.pendingCwd
  if (!to || to === w.cwd) return
  let copied: boolean | undefined
  try {
    if (!fresh) copied = copySessionToCwd(acct.configDir, sessionId, to)
  } catch (err) {
    journal(w, 'cwd-changed', {
      cwd: to,
      from: w.cwd,
      error: firstLine(err instanceof Error ? err.message : String(err)),
    })
    return
  }
  if (copied === false && sessionRan(w, sessionId)) {
    journal(w, 'cwd-changed', { cwd: to, from: w.cwd, error: 'no transcript to carry; stayed' })
    return
  }
  journal(w, 'cwd-changed', { cwd: to, from: w.cwd, ...(copied === undefined ? {} : { copied }) })
  w.cwd = to
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

/** The transcripts of the task's sessions so far, newest first: the one that wrote the handoff,
 *  then the ones before it in the chain (18 of 36 continuations on record were second or later in
 *  one). Each from the first account that holds it, the newest attempt's account first. */
function chainTranscripts(
  w: CliMayteWorker,
  oldSession: CliMayteWorker['sessionId'],
  accounts: CliMayteAccount[],
): string[] {
  const dirs = transcriptCandidates(w, accounts).map((c) => c.configDir)
  const found: string[] = []
  for (const id of [...(w.sessions ?? []), oldSession].reverse()) {
    if (!id) continue
    for (const dir of dirs) {
      const file = transcriptFile(dir, id)
      if (!file) continue
      found.push(slashed(file))
      break
    }
  }
  return found
}

/** The continuation of a planned handoff: the task, the handoff, where the old transcripts are,
 *  and any messages that arrived while the old session was winding down. */
function handoffText(
  w: CliMayteWorker,
  last: CliMayteWorker['attempts'][number],
  note: string,
  oldSession: CliMayteWorker['sessionId'],
  accounts: CliMayteAccount[],
  acct: CliMayteAccount,
): string {
  let handoff = ''
  try {
    handoff = readFileSync(note, 'utf8')
  } catch {
    handoff = '(The handoff file could not be read; use the earlier transcript.)'
  }
  const asked = last.windDown
  return continuationPrompt(
    w.prompt,
    handoff,
    note,
    chainTranscripts(w, oldSession, accounts),
    w.pending,
    {
      sameAccount: acct.id === last.account.id,
      why: asked?.reason ?? (asked?.pct === null ? 'request' : 'usage'),
      chat: w.chat === true,
    },
  )
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
function launchText(
  w: CliMayteWorker,
  p: LaunchPlan,
  accounts: CliMayteAccount[],
  acct: CliMayteAccount,
): string {
  const { last, note } = p
  if (!last) return w.prompt
  if (p.wake) return managerText(w, accounts, acct)
  if (note) return handoffText(w, last, note, p.oldSession, accounts, acct)
  if (p.delivers) return followUpText(w, p)
  return goOnText(w, last, p) ?? w.prompt
}

/** The MCP servers a worker never gets. AgentHydra's own: 84 of a worker's 138 tools were
 *  AgentHydra's (measured), with which a worker could start more workers, fan out, or move the
 *  owner's desktop chats; a worker does its task, orchestration stays with the chat that asked.
 *  And magnific, which only prints a sign-in notice a headless worker can never answer.
 *  connections-local is NOT here (2026-10-02): workers are given tasks that use connections_execute
 *  (the memory tools, the fourman board), and a worker without it reported "the Connections MCP
 *  tools were not exposed in this session" and drove the local MCP by hand through a script.
 *  hswarm stays too: a worker hands wide, cheap work to it. */
const WORKER_DENIED_MCP: readonly string[] = [MCP_SERVER_KEY, 'magnific']

/** AgentHydra's own endpoint on any host, port and scheme, as a `deniedMcpServers` URL pattern:
 *  the CLI (2.1.286, its settings schema and matcher) takes `*` as any scheme and, in the host, any
 *  host and port; in the path `*` is any run of characters, so `/api/mcp/` and a query match too.
 *  A name deny cannot reach the account's own `.claude.json` listing a second PC's daemon under
 *  another name (2026-10-02). */
const WORKER_DENIED_MCP_URL = `*://*${MCP_PATH}*`

/** A worker's files here: its settings (writeWorkerSettings), its MCP servers (writeWorkerMcp) and,
 *  for a chat, its appended prompt (writeChatPrompt). */
const workerFiles = (id: string): [settings: string, mcp: string, chatPrompt: string] => [
  join(HOOKS, `${id}.json`),
  join(HOOKS, `${id}.mcp.json`),
  join(HOOKS, `${id}.chat.md`),
]

/** Remove a worker's settings and MCP files: once its CLI has ended (the next launch writes them
 *  again), or when the worker is removed. They were never removed before 2026-10-02, and 440
 *  settings and 18 MCP files had piled up on the owner's machine. */
export function removeWorkerFiles(id: string): void {
  for (const file of workerFiles(id)) rmSync(file, { force: true })
}

/** The ids of the workers that have a settings or MCP file here. */
export function workerFileIds(): string[] {
  let names: string[] = []
  try {
    names = readdirSync(HOOKS)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const name of names) {
    const id = /^(w-[0-9a-f]+)(?:(?:\.mcp)?\.json|\.chat\.md)$/.exec(name)?.[1]
    if (id) ids.add(id)
  }
  return [...ids]
}

/** The servers this daemon gives a worker itself (writeWorkerMcp). */
const OWN_WORKER_MCP = ['climayte-worker', 'climayte-manager'] as const

/** Take this daemon's own servers off the account's `mcp-needs-auth-cache.json`, the CLI's record of
 *  servers that answered 401 or 403 (it skips each for 15 minutes without connecting). A refusal
 *  there before 2026-10-04 (a 403 while the attempt's pid was still unread, climayte-ask-mcp.ts)
 *  left every worker on that account without climayte_ask for that window; measured that day on
 *  account #35 and on another account two seconds after its workers started. These servers never
 *  ask anyone to sign in, so an entry for one is always stale. Other servers' entries are kept. */
export function forgetOwnNeedsAuth(configDir: string): void {
  const file = join(configDir, 'mcp-needs-auth-cache.json')
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return
    if (!OWN_WORKER_MCP.some((name) => name in cache)) return
    for (const name of OWN_WORKER_MCP) delete cache[name]
    writeFileSync(file, JSON.stringify(cache))
  } catch {
    // No cache, or one the CLI is writing: nothing of ours to take off.
  }
}

/** The owner's MCP servers for `--mcp-config` (ownerMcpServers: entries with no credential),
 *  so a worker has what a desktop session on this machine has whatever its account's `.claude.json`
 *  says; the account's own servers still load beside them, and a name in both is one server.
 *  AgentHydra's own server is left out by name and by its endpoint, so a second PC's daemon under
 *  another name is left out too. The file, or null when there is nothing to give (no owner dir, as
 *  under tests).
 *  For `manage` kind workers, also includes the manager endpoint for wave control. */
export function writeWorkerMcp(w: CliMayteWorker): string | null {
  // A sealed worker has the one config its task named and nothing of the owner's or this daemon's.
  if (w.sealed) return w.sealed.mcpConfig
  const file = workerFiles(w.id)[1]
  // A chat has the owner's servers with none left out: his own `claude` has AgentHydra's too.
  const deny = w.chat ? { names: [], paths: [] } : { names: WORKER_DENIED_MCP, paths: [MCP_PATH] }
  // A Desk chat's connector servers join them, the owner's own of the same name winning (as in
  // desk2's chat-runtime).
  const servers: Record<string, unknown> = {
    ...w.desk?.mcpServers,
    ...(ownerClaudeDir ? ownerMcpServers(ownerClaudeDir, deny) : {}),
  }

  // The port this daemon actually bound (index.ts tells the orchestrator module at boot); PORT
  // is only the preferred one and the daemon hops off it when it is busy.
  const base = getOrchestratorDaemonUrl() ?? `http://127.0.0.1:${PORT}`
  // Every worker may ask its origin a question (climayte_ask, climayte-ask-mcp.ts); the endpoint
  // refuses a caller that is not this worker's CLI. Only under a real owner dir, so a test with no
  // owner dir still writes no config.
  if (ownerClaudeDir)
    servers['climayte-worker'] = { type: 'http', url: `${base}/api/corch/ask/${w.id}` }

  // A worker that is not a chat gets Desk's browser tools for its folder. The owner's generic Desk
  // entry (mcp-register puts it in ~/.claude.json) is replaced by this one; any other `browser`
  // server of the owner's wins, as desk2's connector servers do.
  if (
    ownerClaudeDir &&
    !w.chat &&
    (!('browser' in servers) || isAgenthydraBrowserEntry(servers.browser))
  ) {
    servers.browser = {
      type: 'http',
      url: `${deskBrowserMcpUrl()}?worker=${encodeURIComponent(w.id)}&cwd=${encodeURIComponent(w.cwd)}`,
    }
  }

  // For managers, add the manager endpoint (piece 4). The URL uses the manager's own worker ID.
  // The daemon listens on 127.0.0.1; the id is not a secret (piece 4, docs/CLIMAYTE.md).
  if (w.kind === 'manage') {
    // The manager's MCP config lists the manager endpoint with only a URL (no header, no token).
    servers['climayte-manager'] = {
      type: 'http',
      url: `${base}/api/corch/mcp/${w.id}`,
    }
  }

  if (Object.keys(servers).length === 0) {
    rmSync(file, { force: true })
    return null
  }
  mkdirSync(HOOKS, { recursive: true })
  writeFileSync(file, JSON.stringify({ mcpServers: servers }))
  return file
}

/** The worker's own settings. The wind-down channel: after every tool call the CLI calls this hook,
 *  which answers with the worker's signal file when there is one (signalWindDown) and nothing
 *  otherwise. Written here as a `cat` command; the worker's runner turns it into an http hook it
 *  answers itself, so a tool call starts no process for it (climayte-signal.ts). The edit_claims
 *  hook is in exec form for the same reason. The denied MCP servers (WORKER_DENIED_MCP) and
 *  AgentHydra's endpoint under any name (WORKER_DENIED_MCP_URL), whichever scope lists them.
 *  And no skills synced from claude.ai (docx, pptx, xlsx, computer-use, chrome-browser, ...: 14 of
 *  them, each listed with its description in every request); `syncClaudeAiSkills: false` given
 *  through --settings hides them
 *  for this run only and moves nothing in the account's folder (the CLI's own settings schema,
 *  2.1.286). The owner's skills, synced into the account by syncOwnerClaude, still load.
 *  The owner's Bash guards (destructive_guard, push_force_guard) run on Bash and PowerShell calls for
 *  every worker and chat that is not sealed, the same as edit_claims: the owner's chats have them.
 *  Returns the settings file, with any signal left from an earlier attempt removed. */
function writeWorkerSettings(w: CliMayteWorker, acct: CliMayteAccount): string {
  mkdirSync(HOOKS, { recursive: true })
  const hookFile = workerFiles(w.id)[0]
  // The owner's edit_claims hook, when installed: before an edit it records the file under this
  // task's id and says when another chat or worker edited it in the last half hour. Workers carry
  // none of the owner's hooks, so without this a worker's edits were invisible to it, and a worker
  // editing a chat's files was the collision it was built for (2026-10-01).
  const claims =
    ownerClaudeDir && !w.sealed ? join(ownerClaudeDir, 'hooks', 'edit_claims.py') : null
  // The owner's Bash guards, for the same reason: a worker with permissions skipped had no guard
  // against a `git clean -f` or a force push in a shared checkout (2026-10-07).
  const hooksDir = ownerClaudeDir && !w.sealed ? join(ownerClaudeDir, 'hooks') : null
  const guards = hooksDir
    ? ['destructive_guard.py', 'push_force_guard.py']
        .map((f) => join(hooksDir, f))
        .filter((f) => existsSync(f))
        .map(slashed)
    : []
  writeFileSync(
    hookFile,
    JSON.stringify({
      ...(w.chat ? chatSettings(acct) : w.sealed ? QUIET_SETTINGS : WORKER_ONLY_SETTINGS),
      // The signal hook is written in its shell form here; the worker's runner answers it over http
      // instead, before the CLI starts (climayte-signal.ts, RunnerSpec.signal).
      hooks: workerHooks({
        signalFile: slashed(signalPath(w.id)),
        claims: claims && existsSync(claims) ? slashed(claims) : null,
        guards,
        // The daemon answers it: it asks why a missed estimate missed (climayte-eta.ts).
        stopUrl:
          w.chat || w.sealed
            ? null
            : `${getOrchestratorDaemonUrl() ?? `http://127.0.0.1:${PORT}`}/api/corch/stop/${w.id}`,
      }),
    }),
  )
  rmSync(signalPath(w.id), { force: true })
  return hookFile
}

/** No claude.ai skills and no humanizer plugin, for an ordinary worker and a sealed one alike
 *  (writeWorkerSettings). A chat has the owner's own (chatSettings). */
const QUIET_SETTINGS = {
  syncClaudeAiSkills: false,
  // One account's claude.ai-synced humanizer plugin still listed `humanizer:humanizer` in every
  // request after the line above (3 of 14 starts, 2026-10-02); no worker ever invoked it.
  enabledPlugins: { 'humanizer@synced': false },
}

/** What only an ordinary worker's settings carry: QUIET_SETTINGS and no denied MCP server. Not a
 *  sealed worker's: it has exactly its config's servers (--strict-mcp-config), AgentHydra's own when
 *  the task names it, and its allowedTools are the gate. Denying them left four sealed test chats of
 *  the Free tools with no tool at all (2026-10-06). */
const WORKER_ONLY_SETTINGS = {
  deniedMcpServers: [
    ...WORKER_DENIED_MCP.map((serverName) => ({ serverName })),
    { serverUrl: WORKER_DENIED_MCP_URL },
  ],
  ...QUIET_SETTINGS,
}

/** A chat's settings: the account folder's CLAUDE.md left out. syncOwnerClaude fills that file with
 *  the lean worker profile for every worker on the account, so it is never swapped per launch; a
 *  chat skips it (`claudeMdExcludes` applies to the User memory type, CLI 2.1.286, measured
 *  2026-10-04) and gets the owner's own CLAUDE.md instead (chatPromptText). */
function chatSettings(acct: CliMayteAccount): { claudeMdExcludes: string[] } {
  return { claudeMdExcludes: [slashed(join(acct.configDir, 'CLAUDE.md'))] }
}

/** What a chat is told on top of the CLI's own prompt: it is the main agent of the owner's Desk
 *  chat (he reads every reply; it orchestrates subjects and hands off to an heir that is again the
 *  main agent), no terminal is attached, its process (every background command with it) ends with
 *  the turn, and the window it is read in (AgentHydra's, desk2/) plays a markdown image of a local
 *  picture or video in place (desk2 media cache: CHAT_MEDIA, left out when the Desk's own append
 *  carries the same sentence). */
const CHAT_MEDIA =
  'To show the person a picture, GIF or video, put it in your reply as a markdown image of its absolute path, ![what it shows](C:/absolute/path.mp4): png, jpg, gif, webp, mp4, mov or webm (videos up to 200 MB) appear and play right in the chat, so never only name the path of a screenshot, GIF or recording you made or found.'
const CHAT_NOTE_BASE =
  "You are the main agent of the owner's Desk chat: he reads every reply you write. No terminal is attached, so nothing that waits for an interactive prompt or a permission dialog can be answered. Orchestrate: send the work to CliMayte workers, HSwarm or sub-agents, check what they report, and report to him; when you run out of context or account you hand off to an heir that continues as this chat's main agent." +
  ' Your process ends when your turn ends, and every background command with it; nothing wakes this chat when one finishes, so never end a turn saying a poll or job will wake you: wait inside the turn with a time-limited loop on its output.'
export const CHAT_NOTE = `${CHAT_NOTE_BASE} ${CHAT_MEDIA}`

/** Whether the CLI's own CLAUDE.md walk, which reads `.claude/CLAUDE.md` in every folder above the
 *  working folder, already reaches the owner's (`~/.claude/CLAUDE.md`) from `cwd`. */
function walkReachesOwnerMd(cwd: string, ownerDir: string): boolean {
  if (basename(ownerDir) !== '.claude') return false
  const rel = relative(dirname(ownerDir), cwd)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** A chat's appended prompt: CHAT_NOTE, then the Desk's append when the task carried one (it has
 *  the media sentence, so CHAT_NOTE's own is left out), then the owner's global CLAUDE.md unless
 *  the CLI's own walk reads it already from the chat's folder (so it is never in a request twice). */
export function chatPromptText(w: CliMayteWorker): string {
  const note = w.desk ? `${CHAT_NOTE_BASE}\n\n${w.desk.append}` : CHAT_NOTE
  if (!ownerClaudeDir || walkReachesOwnerMd(w.cwd, ownerClaudeDir)) return note
  const md = join(ownerClaudeDir, 'CLAUDE.md')
  let owner = ''
  try {
    owner = readFileSync(md, 'utf8').trim()
  } catch {
    return note
  }
  return owner
    ? `${note}\n\nContents of ${slashed(md)} (the owner's global instructions):\n\n${owner}`
    : note
}

/** Write a chat's appended prompt (`--append-system-prompt-file`): a file, so the owner's CLAUDE.md
 *  never meets the Windows command line's length limit. */
function writeChatPrompt(w: CliMayteWorker): string {
  const file = workerFiles(w.id)[2]
  mkdirSync(HOOKS, { recursive: true })
  writeFileSync(file, chatPromptText(w))
  return file
}

/** The owner's home, whose `.claude` holds his skills, commands and agents: a chat is given it with
 *  `--add-dir`, which loads them beside the account's lean set (measured 2026-10-04: 38 of the
 *  owner's skills more, and no hook or settings from that folder). Null when the owner dir is not
 *  a `.claude` folder (tests). */
function ownerHome(): string | null {
  return ownerClaudeDir && basename(ownerClaudeDir) === '.claude' ? dirname(ownerClaudeDir) : null
}

/** What tells the CLI who it is: an ordinary worker's WORKER_BRIEF, a chat's prompt file and the
 *  owner's skills, or a sealed worker's own system prompt in place of the CLI's, with no settings
 *  source (no CLAUDE.md, hook or user setting; `--settings` is still read), no built-in tool, and
 *  no MCP server but its config's (docs/CLIMAYTE.md, "Sealed tasks"). */
function briefArgs(w: CliMayteWorker): string[] {
  if (w.sealed)
    return [
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--tools',
      '',
      // Variadic, like --mcp-config: the option after it ends its list.
      '--allowedTools',
      ...w.sealed.allowedTools,
      '--system-prompt-file',
      w.sealed.systemPromptFile,
    ]
  if (!w.chat) {
    // How the newest estimates compared with the real time (climayte-eta.ts): nothing until there
    // are enough samples, then the ratio to multiply a first guess by.
    const samples = allEtaSamples(workers.values())
    const note = etaNote(
      etaCalibration(samples, w.kind ?? null),
      samples,
      etaBandCalibrations(samples),
    )
    return ['--append-system-prompt', note ? `${WORKER_BRIEF} ${note}` : WORKER_BRIEF]
  }
  const home = ownerHome()
  // --add-dir is variadic: the option after it ends its list.
  return [...(home ? ['--add-dir', home] : []), '--append-system-prompt-file', writeChatPrompt(w)]
}

export function cliArgv(
  w: CliMayteWorker,
  sessionId: string,
  resume: boolean,
  hookFile: string,
  mcpFile: string | null,
): string[] {
  return [
    ...claudeCommand(),
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // A sealed worker is allowed its named tools and no other (briefArgs).
    ...(w.sealed ? ['--permission-mode', 'default'] : ['--dangerously-skip-permissions']),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(w.model ? ['--model', w.model] : []),
    ...(w.effort ? ['--effort', w.effort] : []),
    // Variadic in the CLI: an option must follow it, never a bare argument.
    ...(mcpFile ? ['--mcp-config', mcpFile] : []),
    '--settings',
    hookFile,
    ...briefArgs(w),
  ]
}

/** The prompt cache an attempt runs with: 1 hour for a manager and a chat, else 5 minutes. */
const cacheTtl = (w: CliMayteWorker): '1h' | '5m' => (w.kind === 'manage' || w.chat ? '1h' : '5m')

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
        // Piece 6: managers use 1-hour cache (less re-read cost on frequent wakes).
        // TERM=dumb: a worker has no terminal. Unset, Git Bash makes it xterm-256color, and then
        // every login shell runs aliases.sh's seven `$(type -p X.exe)` subshells for winpty
        // aliases; a worker runs its Bash commands as login shells whenever its 10 s shell
        // snapshot timed out (94% of them on 2026-10-04). Measured: 1.8 s -> 1.1 s a login shell.
        // A chat keeps the claude.ai connectors (his own `claude` has them: a chat asked to answer
        // a company sends the mail) and the 1-hour cache, since a person's next message is often
        // more than 5 minutes away.
        env: {
          ...scrubbedEnv(acct.configDir, w.id),
          ...(w.chat ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
          CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl(w),
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          TERM: 'dumb',
        },
        stdin: promptFile,
        stdout: log,
        stderr: errLog,
        pidFile: runner.pidFile,
        exitFile: runner.exitFile,
        // The wind-down hook is answered by this runner over http, not by a `cat` per tool call.
        signal: { file: signalPath(w.id), settings: workerFiles(w.id)[0] },
        maxProcesses: WORKER_MAX_PROCESSES,
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
  if (!p.fresh) {
    w.message = firstLine(p.delivers ? p.next : w.prompt, 200)
    // A new message gets its own estimate; the last one's is kept once it settled (finish).
    if (w.eta?.tookS !== undefined)
      w.pastEtas = [...(w.pastEtas ?? []), w.eta].slice(-MAX_PAST_ETAS)
    delete w.eta
  }
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
  delete w.heldForResetSince
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
  // A worker stored on Haiku 4.5 before 2026-10-07 starts on Haiku 5.5 (owner: "never use Haiku
  // 4.5"): a follow-up, resume, restart or handoff would otherwise pass `--model claude-haiku-4-5`.
  if (w.model && OLD_HAIKU.test(w.model)) w.model = HAIKU
  const n = w.attempts.length
  const last = w.attempts[n - 1]
  const fromId = w.accountId !== acct.id ? w.accountId : null
  const session = sessionPlan(w, last, !!fromId)
  const { fresh, sessionId } = session
  let copied: boolean | undefined
  if (fromId && !fresh) {
    const moved = moveTranscript(w, acct, accounts, sessionId)
    if (moved.failed) return
    copied = moved.copied
  }
  if (w.pendingCwd) applyPendingCwd(w, acct, sessionId, fresh)
  // The owner's global CLAUDE.md and skills, so a worker keeps the owner's rules (field note 5).
  if (ownerClaudeDir && !w.sealed) syncOwnerClaude(ownerClaudeDir, acct.configDir)
  // A sealed worker's folder is a temp one made at dispatch; a cleanup since then is made good.
  if (w.sealed) mkdirSync(w.cwd, { recursive: true })
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
  const text = launchText(w, plan, accounts, acct)

  mkdirSync(LOGS, { recursive: true })
  mkdirSync(PROMPTS, { recursive: true })
  const promptFile = join(PROMPTS, `${w.id}-${n}.txt`)
  writeFileSync(promptFile, text)
  const log = join(LOGS, `${w.id}-${n}.jsonl`)
  const errLog = join(LOGS, `${w.id}-${n}.err.log`)
  const hookFile = writeWorkerSettings(w, acct)
  forgetOwnNeedsAuth(acct.configDir)
  const argv = cliArgv(w, sessionId, resume, hookFile, writeWorkerMcp(w))
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
    cacheTtl: cacheTtl(w),
    startPct: acct.sessionPct,
    daemonPid: process.pid,
    runner,
    requested: { model: w.model, effort: w.effort },
  })
  noteLaunch(w, acct, plan, activeOnAccount)
}
