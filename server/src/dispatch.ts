import { spawn as nodeSpawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isDispatchReady } from './boot-state'
import { DB_PATH, IS_COMPILED, RUN_LOG_DIR, resolveClaudeExe } from './config'
import { getCliInstance } from './core/cli-instances'
import { coerceQueueItem, db } from './db'
import { buildDetachedSpawn } from './detached-spawn.mjs'
import { headlessRunsAllowed, NO_HEADLESS_REASON } from './headless-policy'
import { classifyLimit, isApiErrorEvent, type LimitKind } from './rate-limit-signal'
import { eventToTailEvents } from './transcript'
import type { ImportState, QueueItem, RunEvent } from './types'

// A dispatched `claude` run must OUTLIVE the daemon: quitting AgentHydra (or an auto-update
// relaunch) tree-kills the daemon (`taskkill /T`), and killing in-flight work with it is exactly
// what we refuse to do. So the daemon does NOT spawn `claude` directly. It spawns a DETACHED
// supervisor (dispatch-runner.ts) that owns `claude` and appends its output to a per-run log file;
// the daemon merely TAILS that log. When the daemon dies, the runner + `claude` keep running to
// completion; the next daemon reattaches by re-reading the log (reattachRuns). Design verified
// end-to-end 2026-07-12 (see dispatch-runner.ts header + server-lib/detached-spawn.mjs).

// --- transient-overload retry ------------------------------------------------
//
// A 529 is NOT a rate limit (see rate-limit-signal.ts): Anthropic's servers are saturated and it
// clears in seconds. The CLI reports it and exits; the daemon used to file that as 'rate_limited'
// and park the run for a 5-hour reset that had nothing to do with it. The right answer is the one
// the desktop app effectively performs by hand — back off and try again.
//
// Backoff spans ~35s over three tries, which is the shape of a real overload; past that it is an
// outage, not a blip, so the run finalizes 'overloaded' and waits for a human. State lives in the
// DB (queue_items.retry_attempts + not_before), never only in memory: this codebase went to WMI
// lengths so a run survives a daemon restart, and an in-memory-only timer would regress that.
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000]
/** How often the always-on sweep looks for a due retry. Tighter than the scheduler's poll because
 *  these backoffs are counted in seconds, not minutes. */
const RETRY_SWEEP_MS = 2_000

function retryAttemptsOf(id: string): number {
  const row = db
    .query<{ n: number | null }, [string]>(
      'select retry_attempts as n from queue_items where id = ?',
    )
    .get(id)
  return row?.n ?? 0
}

// --- pub/sub for live run streaming (SSE) ------------------------------------

export type RunMessage =
  | { type: 'event'; data: RunEvent }
  | {
      type: 'status'
      data: {
        id: string
        status: QueueItem['status']
        exit_code: number | null
        pid: number | null
      }
    }

type Sub = (msg: RunMessage) => void
const subs = new Map<string, Set<Sub>>()

export function subscribeRun(id: string, cb: Sub): () => void {
  let set = subs.get(id)
  if (!set) {
    set = new Set()
    subs.set(id, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
    if (set && set.size === 0) subs.delete(id)
  }
}

function publish(id: string, msg: RunMessage) {
  const set = subs.get(id)
  if (!set) return
  for (const cb of set) {
    try {
      cb(msg)
    } catch {
      // a dead subscriber shouldn't break dispatch
    }
  }
}

// --- run-event persistence ---------------------------------------------------

const insertEvent = db.query(
  'insert into run_events (queue_item_id, seq, ts, role, kind, text, tool_name) values (?, ?, ?, ?, ?, ?, ?)',
)

/**
 * Per-run in-memory state.
 *
 * `limitKind` replaces the old single `rateLimited` boolean: a quota wall and a transient overload
 * are different failures and finalize() now sends them different places (rate-limit-signal.ts).
 * `sawOutput` gates the retry — see shouldRetryTransient.
 */
interface RunRuntime {
  seq: number
  limitKind: LimitKind | null
  /** True once the run produced a real conversational turn (not just CLI meta/errors). */
  sawOutput: boolean
}
const freshRuntime = (): RunRuntime => ({ seq: 0, limitKind: null, sawOutput: false })
const runtime = new Map<string, RunRuntime>()

function recordEvent(
  id: string,
  role: RunEvent['role'],
  kind: RunEvent['kind'],
  text: string,
  toolName: string | null,
) {
  const rt = runtime.get(id) ?? freshRuntime()
  rt.seq += 1
  runtime.set(id, rt)
  const ts = new Date().toISOString()
  let info: { lastInsertRowid: number | bigint }
  try {
    info = insertEvent.run(id, rt.seq, ts, role, kind, text, toolName)
  } catch {
    // run_events is FK'd to queue_items, so recording against a row that is already gone (the item
    // was deleted mid-run) throws. Transcribing output must never be able to kill the tail loop that
    // is trying to finalize the run — same reason publish() swallows a bad subscriber.
    return
  }
  const ev: RunEvent = {
    id: Number(info.lastInsertRowid),
    queue_item_id: id,
    seq: rt.seq,
    ts,
    role,
    kind,
    text,
    tool_name: toolName,
  }
  publish(id, { type: 'event', data: ev })
}

export function getRunEvents(id: string): RunEvent[] {
  return db
    .query<RunEvent, [string]>('select * from run_events where queue_item_id = ? order by seq asc')
    .all(id)
}

// --- argv --------------------------------------------------------------------

export function buildArgv(item: QueueItem): string[] {
  const useFake = !!process.env.AGENTHYDRA_FAKE
  // Compiled binaries can't spawn sibling .ts files (import.meta.dir is virtual inside the exe);
  // the exe re-spawns itself with the __fake_claude subcommand instead (server/src/main.ts).
  const argv: string[] = useFake
    ? IS_COMPILED
      ? [process.execPath, '__fake_claude']
      : [process.execPath, join(import.meta.dir, 'fake-claude.ts')]
    : [resolveClaudeExe()]

  if (!useFake) {
    if (item.new_chat) {
      argv.push('--session-id', item.session_id)
    } else {
      argv.push('--resume', item.session_id)
      if (item.fork) argv.push('--fork-session')
    }
    if (item.model) argv.push('--model', item.model)
    if (item.effort) argv.push('--effort', item.effort)
    if (item.permission_mode) argv.push('--permission-mode', item.permission_mode)
    argv.push('--verbose', '--output-format', 'stream-json', '--print')
  }
  argv.push(item.prompt)
  return argv
}

// --- line handling -----------------------------------------------------------

// A normal `claude` stream-json line. Runner marker lines ({"__dispatch":…}) are peeled off by the
// tail loop before this runs, so this only ever sees genuine Claude output — identical parsing to
// the pre-detach inline reader.
function handleLine(id: string, line: string) {
  if (!line) return
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  const rt = runtime.get(id)
  const t = ev.type
  if (t === 'assistant' || t === 'user') {
    // Only the CLI's own synthetic error notice counts (see isApiErrorEvent) — never model prose,
    // tool inputs, or tool results, which is what a run about rate limits is full of.
    const trusted = isApiErrorEvent(ev)
    for (const te of eventToTailEvents(ev)) {
      if (rt && trusted) rt.limitKind = classifyLimit(te.text) ?? rt.limitKind
      // A real turn from the model. This is what makes a retry unsafe (see shouldRetryTransient):
      // the CLI's own error notice is synthetic and carries no work, so it never counts.
      if (rt && !trusted) rt.sawOutput = true
      // A run's stored event log has no 'thinking' kind and is not getting one: it is what the queue
      // replays, and reasoning is neither replayable nor worth the rows. eventToTailEvents drops
      // those blocks unless asked, and this call never asks, so the guard is only here to keep that
      // fact checked by the compiler rather than assumed.
      if (te.kind !== 'thinking') recordEvent(id, te.role, te.kind, te.text, te.tool_name)
    }
  } else if (t === 'rate_limit_event') {
    // The CLI's FIRST-CLASS wall signal, and the only one that needs no regex:
    //   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
    //     "rateLimitType":"seven_day","resetsAt":1785225600, …}}
    // `status` is one of allowed | allowed_warning | rejected — only 'rejected' is a wall, the other
    // two ride along on perfectly healthy runs. Structured, so it holds even when the wording of the
    // human notice changes; both window types (five_hour, seven_day) are the same quota answer.
    const info = ev.rate_limit_info
    if (rt && info?.status === 'rejected') {
      rt.limitKind = 'quota'
      const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null
      const window = info.rateLimitType === 'seven_day' ? 'weekly' : 'session'
      recordEvent(
        id,
        'system',
        'meta',
        `${window} limit reached on this run's account${resetsAt ? ` — resets ${resetsAt.toLocaleString()}` : ''}.`,
        null,
      )
    }
  } else if (t === 'result') {
    const text = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev)
    // A `result` mirrors the model's final summary, so its text is only evidence when the CLI also
    // flagged the turn as errored — otherwise a run that ANSWERS a question about rate limits
    // (this repo's own bread and butter) reports itself rate-limited.
    if (rt && ev.is_error) rt.limitKind = classifyLimit(text) ?? rt.limitKind
    recordEvent(id, 'system', 'meta', text, null)
  } else if (t === 'system' && ev.subtype === 'init') {
    recordEvent(id, 'system', 'meta', `session started (${ev.model ?? 'model'})`, null)
  }
}

// --- per-run files (owned by the detached runner; the daemon reads them) ------

const DISPATCH_RUNNER = join(import.meta.dir, 'dispatch-runner.ts')

/** The argv that spawns the detached runner in either mode: a source checkout spawns
 *  `bun dispatch-runner.ts <spec>`; a compiled exe re-spawns ITSELF with the __dispatch_runner
 *  subcommand (server/src/main.ts) — the sibling .ts file doesn't exist on disk there. */
const runnerArgv = (specPath: string): string[] =>
  IS_COMPILED
    ? [process.execPath, '__dispatch_runner', specPath]
    : [process.execPath, DISPATCH_RUNNER, specPath]
const logPathFor = (id: string) => join(RUN_LOG_DIR, `${id}.stream.jsonl`)
const statusPathFor = (id: string) => join(RUN_LOG_DIR, `${id}.status.json`)
const specPathFor = (id: string) => join(RUN_LOG_DIR, `${id}.spec.json`)

interface RunStatus {
  runnerPid?: number
  childPid?: number | null
  startedAt?: string
  state?: 'running' | 'exited'
  code?: number
}

function readStatus(id: string): RunStatus | null {
  try {
    return JSON.parse(readFileSync(statusPathFor(id), 'utf8')) as RunStatus
  } catch {
    return null
  }
}

/** A runner marker line, or null for an ordinary `claude` stream-json line. */
function parseMarker(
  line: string,
): { kind: 'exit'; code: number } | { kind: 'stderr'; text: string } | null {
  if (!line.includes('__dispatch')) return null
  try {
    const o = JSON.parse(line)
    if (o && o.__dispatch === 'exit')
      return { kind: 'exit', code: typeof o.code === 'number' ? o.code : -1 }
    if (o && o.__dispatch === 'stderr') return { kind: 'stderr', text: String(o.text ?? '') }
  } catch {
    // a real claude line that merely contains the substring "__dispatch" — fall through to normal handling
  }
  return null
}

/**
 * Launch the detached runner (`bun dispatch-runner.ts <spec>`) so it OUTLIVES the daemon.
 *
 * The hard part is Windows. The Bun daemon puts every process it spawns — via Bun.spawn OR
 * node:child_process (which Bun implements on the same primitive) — into a job object, and even the
 * `cmd /c start` hand-off's grandchild stays in it (verified 2026-07-12: such runners died on a
 * daemon `process.exit()`, a `taskkill /T`, AND a graceful shutdown — only a bare `taskkill /F` of
 * the daemon spared them). The ONLY reliable escape is to have the OS create the process for us,
 * OUTSIDE the daemon's job: Win32_Process.Create (WMI). The created runner is a child of WmiPrvSE,
 * jobless, and runs as the current user with the user profile env (HOME/APPDATA/PATH — what `claude`
 * needs), which is why the runner reads everything else (child argv, cwd, DB path, account) from the
 * spec rather than the daemon's env. POSIX has no such problem: a plain `detached:true` (setsid) is a
 * genuine session detach.
 *
 * `AGENTHYDRA_RUNNER_LAUNCH` (documented in .env.example) overrides the per-OS default:
 *   'wmi'   win32 default — survives Quit (needs PowerShell + WMI).
 *   'start' escape hatch for a box where WMI/PowerShell is blocked: launch via `cmd /c start`
 *           instead. Dispatch still works, but a run will NOT survive Quit (it stays in the job).
 *           'startb' is the same via `start /b`.
 *   'posix' macOS/Linux default — plain detached setsid.
 */
function launchDetachedRunner(specPath: string): void {
  const method =
    process.env.AGENTHYDRA_RUNNER_LAUNCH || (process.platform === 'win32' ? 'wmi' : 'posix')

  if (process.platform !== 'win32' || method === 'posix') {
    const { argv } = buildDetachedSpawn(process.platform, runnerArgv(specPath))
    nodeSpawn(argv[0]!, argv.slice(1), {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    }).unref()
    return
  }

  if (method === 'wmi') {
    // Each argv element double-quoted for CreateProcess; single-quotes escaped for the PS string.
    const cmdline = runnerArgv(specPath)
      .map((s) => `"${s}"`)
      .join(' ')
    // ProcessStartupInformation is NOT optional polish: Win32_Process.Create applies DEFAULT
    // STARTUPINFO, and `bun` is a console-subsystem exe, so the runner gets a REAL, VISIBLE console
    // window on the user's desktop for the whole run — the daemon's own `windowsHide: true` (below)
    // only hides the short-lived powershell.exe, never the WMI-created grandchild. Worse than ugly:
    // closing that stray window sends CTRL_CLOSE_EVENT to everything on its console, killing the
    // runner AND `claude` mid-turn with no exit marker (the run then finalizes as a bare "failed,
    // exit -1"). SW_HIDE (0) keeps the console allocated — the runner still redirects the child's
    // stdout/stderr to the log, so nothing needs a window — but never shows it.
    // Verified 2026-07-15 by probing GetConsoleWindow/IsWindowVisible from INSIDE a WMI-created
    // process: without this, VISIBLE; with it, hidden. (CreateFlags=CREATE_NO_WINDOW is not an
    // option here — Win32_ProcessStartup rejects that flag with ReturnValue 21, "invalid parameter".)
    const ps =
      `$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}'; ProcessStartupInformation = $s } | Out-Null`
    nodeSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return
  }

  // `start` / `start /b` escape hatch (AGENTHYDRA_RUNNER_LAUNCH): launches without WMI for a box
  // where it's blocked. The run works but will NOT survive Quit (a console child stays in the
  // daemon's job object) — that trade-off is documented on the setting in .env.example.
  const b = method === 'startb' ? ['/b'] : []
  nodeSpawn('cmd', ['/c', 'start', '', ...b, ...runnerArgv(specPath)], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  }).unref()
}

// --- dispatch ----------------------------------------------------------------

interface ActiveEntry {
  sessionId: string
  canceled: boolean
  childPid: number | null
  killed: boolean
  /**
   * Is the runner behind this entry verifiably OURS and alive — i.e. is its status file a live
   * record we may take a child pid from?
   *
   * True for a run we just spawned. For a reattach it is isRunnerAlive()'s answer, and when that is
   * false the status file is a leftover from a dead process: the pid inside it is just a number,
   * and on Windows that number gets recycled. Trusting it then is how a run gets stranded
   * 'running' forever (the recycled pid answers "alive", so the child-died grace never fires and no
   * marker is ever coming) — or worse, how a cancel killTree()s a stranger's process.
   */
  runnerLive: boolean
}

const active = new Map<string, ActiveEntry>()

export function activeCount(): number {
  return active.size
}

export function isActive(id: string): boolean {
  return active.has(id)
}

/** True if any running item targets this session — two concurrent `--resume <id>`
 *  children would interleave writes to the same transcript. */
export function isSessionActive(sessionId: string): boolean {
  for (const entry of active.values()) if (entry.sessionId === sessionId) return true
  return false
}

// --- the transient-retry sweep -----------------------------------------------

let retryTimer: ReturnType<typeof setInterval> | null = null

/**
 * Re-dispatch runs whose transient-overload backoff has elapsed.
 *
 * ALWAYS ON, and deliberately gated on NEITHER `scheduler_enabled` NOR `monitor_enabled`. Both
 * default off, and both are the wrong consent: they govern "run my queue for me" and "auto-prompt
 * my sessions while I sleep" — hours-scale autonomy. This is a run the user started, seconds ago,
 * by hand, which died on someone else's server hiccup. Finishing it is what they already asked for,
 * so hiding it behind an opt-in most people never enable would leave the bug fixed on paper only.
 *
 * `isDispatchReady()` IS honoured: the boot window is exactly when a reattaching run isn't in
 * `active` yet, and dispatching then could put two `claude --resume` on one transcript.
 */
export async function dispatchDueRetries(): Promise<void> {
  if (!isDispatchReady()) return
  const rows = db
    .query<QueueItem, [string]>(
      `select * from queue_items
       where status = 'queued' and retry_attempts > 0 and not_before is not null and not_before <= ?
       order by position asc`,
    )
    .all(new Date().toISOString())
  for (const raw of rows) {
    const item = coerceQueueItem(raw)
    if (isActive(item.id) || isSessionActive(item.session_id)) continue
    void dispatchItem(item)
  }
}

export function startRetrySweep(): void {
  if (retryTimer) return
  retryTimer = setInterval(() => void dispatchDueRetries().catch(() => {}), RETRY_SWEEP_MS)
}

export function stopRetrySweep(): void {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

/** Liveness probe (signal 0 never actually signals — Node/Bun convention on every OS). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill `claude` (childPid) and its descendants. The runner is `claude`'s PARENT, not a descendant,
 *  so it survives this and still writes the terminal marker — which is how a cancel becomes final. */
async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await Bun.spawn(['taskkill', '/pid', String(pid), '/t', '/f'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      }).exited
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * True if the detached runner for `id` is still alive — identified by its UNIQUE spec-file name in a
 * live process's command line, NOT by a stored PID. This is what makes reattach PID-reuse-safe: after
 * a long daemon downtime the stored childPid may have been recycled by an unrelated process, so
 * `isAlive(childPid)` would lie; matching the runner's own `<id>.spec.json` argument cannot. Also
 * catches a runner that was still launching when the previous daemon died (its cmdline already carries
 * the spec), so a live run is never wrongly finalized as failed. Never throws.
 */
async function isRunnerAlive(id: string): Promise<boolean> {
  // Item ids are uuids/simple slugs (no WQL/regex metacharacters), so the needle needs no escaping.
  const needle = `${id}.spec.json`
  try {
    if (process.platform === 'win32') {
      const proc = Bun.spawn(
        [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // `AND ProcessId <> $PID` is load-bearing, not defensive tidiness: the needle is embedded
          // in THIS powershell's own CommandLine (it IS the LIKE pattern), so without the exclusion
          // the query always matches itself and the count is never zero. That made isRunnerAlive
          // return true for every reattach on Windows — silently defeating reattachRuns's stale-pid
          // guard AND its "runner gone, nothing to replay → fail" path. (The POSIX branch below
          // can't self-match: `ps -eo args=` prints `ps`'s own args, which don't contain the needle.)
          `@(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${needle}%' AND ProcessId <> $PID").Count`,
        ],
        { stdout: 'pipe', stderr: 'ignore', windowsHide: true },
      )
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return Number(out.trim()) > 0
    }
    const proc = Bun.spawn(['ps', '-eo', 'args='], { stdout: 'pipe', stderr: 'ignore' })
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return out.split('\n').some((line) => line.includes(needle))
  } catch {
    return false
  }
}

function cleanupRunFiles(id: string): void {
  try {
    rmSync(specPathFor(id), { force: true })
  } catch {
    /* best-effort */
  }
  try {
    rmSync(statusPathFor(id), { force: true })
  } catch {
    /* best-effort */
  }
  // The log file ({id}.stream.jsonl) is kept — it's the raw record, same as before.
}

/**
 * May we transparently re-run this? Only when BOTH hold:
 *
 *  · the stop was an unmistakable server-side overload, not the user's quota (rate-limit-signal.ts);
 *  · the run produced NO real turn before dying.
 *
 * The second condition is the one that matters. A retry re-sends the ORIGINAL prompt through
 * `claude --resume`, which appends it to the transcript again — harmless when the overload landed
 * before the model ever answered (the observed case: the run's only events were "session started"
 * and the 529), but a duplicated instruction if real work had already happened. Re-running work the
 * user already paid for, unasked, is worse than making them press Run. So: retry the blip, hand
 * back the ambiguous case.
 */
function shouldRetryTransient(rt: RunRuntime | undefined, attempts: number): boolean {
  if (rt?.limitKind !== 'transient' || rt.sawOutput) return false
  return attempts < MAX_TRANSIENT_RETRIES
}

/** Park the run as 'queued' with a due time, so the sweep re-dispatches it after the backoff. The
 *  state is entirely in the DB: a daemon that dies mid-backoff comes back to a queued row the sweep
 *  (or the Run button) still honours, rather than a timer that died with it. */
function scheduleTransientRetry(id: string, attempts: number): void {
  const waitMs =
    RETRY_BACKOFF_MS[attempts] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 20_000
  const next = attempts + 1
  // Recorded BEFORE the re-dispatch wipes run_events, so the reason is on screen during the wait.
  recordEvent(
    id,
    'system',
    'meta',
    `Overloaded (server-side, not your usage limit) — retrying in ${Math.round(waitMs / 1000)}s (attempt ${next} of ${MAX_TRANSIENT_RETRIES}).`,
    null,
  )
  db.query(
    "update queue_items set status = 'queued', pid = null, started_at = null, finished_at = null, exit_code = null, not_before = ?, retry_attempts = ? where id = ?",
  ).run(new Date(Date.now() + waitMs).toISOString(), next, id)
  publish(id, { type: 'status', data: { id, status: 'queued', exit_code: null, pid: null } })
  runtime.delete(id)
  active.delete(id)
  cleanupRunFiles(id)
}

/** Persist the terminal status + notify subscribers, exactly once per run. A cancel wins over the
 *  process's own exit code so a killed run reads as 'canceled', not 'failed'. */
function finalize(id: string, exitCode: number, opts: { canceled?: boolean } = {}): void {
  if (!active.has(id)) return // already finalized (defensive)
  const rt = runtime.get(id)

  // A transient overload is not a terminal state until we've actually tried again.
  if (!opts.canceled && exitCode !== 0) {
    const attempts = retryAttemptsOf(id)
    if (shouldRetryTransient(rt, attempts)) {
      scheduleTransientRetry(id, attempts)
      return
    }
  }

  const status: QueueItem['status'] = opts.canceled
    ? 'canceled'
    : rt?.limitKind === 'quota'
      ? 'rate_limited'
      : // Distinct from 'failed': nothing is wrong with the run or the prompt, Anthropic's servers
        // were saturated. Deliberately NOT 'rate_limited' — monitor.ts would park it against a
        // 5-hour reset that has nothing to do with a 529.
        rt?.limitKind === 'transient'
        ? 'overloaded'
        : exitCode === 0
          ? 'completed'
          : 'failed'
  db.query(
    'update queue_items set status = ?, finished_at = ?, exit_code = ?, pid = null where id = ?',
  ).run(status, new Date().toISOString(), exitCode, id)
  publish(id, { type: 'status', data: { id, status, exit_code: exitCode, pid: null } })
  runtime.delete(id)
  active.delete(id)
  cleanupRunFiles(id)

  // A completed run carrying import_to lands in that desktop instance's app as a visible chat
  // (a migration or handoff delivery). Armed AFTER the row is terminal: a delivery problem
  // (instance since closed, etc.) must never unsettle a finished run. Arming rather than simply
  // firing is what makes it survivable — see deliverPendingImports below.
  if (status === 'completed') {
    const row = db
      .query<{ import_to: string | null }, [string]>(
        'select import_to from queue_items where id = ?',
      )
      .get(id)
    if (row?.import_to?.startsWith('desktop:')) {
      // Re-armed on EVERY completion, including a re-run of an already-delivered item: the run
      // appended new turns, so the chat is worth (re)delivering, and the import URL targets an
      // existing chat by session id rather than creating a second one.
      db.query(
        "update queue_items set import_state = 'pending', import_error = null where id = ?",
      ).run(id)
      void attemptDesktopImport(id).catch((err) =>
        console.error('[agenthydra] post-run desktop import error:', err),
      )
    }
  }
}

// --- desktop delivery of finished runs ---------------------------------------

/**
 * How long a completed run keeps trying to reach its target instance's app before giving up.
 *
 * Generous on purpose. The usual refusal is "that desktop app is not running", and the reason it is
 * not running is usually that the owner is asleep — which is the exact scenario migrate-on-limit and
 * the overnight handoffs exist for. A day covers a normal night; past that the delivery is stale
 * news and a chat surfacing from two days ago is noise, not help.
 */
const IMPORT_DEADLINE_MS = 24 * 3600 * 1000
/** Slower than RETRY_SWEEP_MS: a refused import costs a process-liveness check, and the thing it
 *  waits for (a human opening an app) does not change on a two-second timescale. */
const IMPORT_SWEEP_MS = 60_000

/** Seam for tests, so the delivery logic can be driven without spawning a desktop app. */
export type DesktopImporter = (opts: {
  sessionId: string
  instanceDir: string
  title?: string | null
}) => Promise<{
  ok: boolean
  reason?: string
  titled?: boolean
}>

function setImportState(id: string, state: ImportState, error: string | null): void {
  db.query('update queue_items set import_state = ?, import_error = ? where id = ?').run(
    state,
    error,
    id,
  )
}

/**
 * One attempt to land a completed run in its target desktop instance's app.
 *
 * WHY THIS IS RETRIED AND NOT JUST LOGGED. The import deliberately refuses a target that is not
 * running, because firing it at a closed instance BOOTS that instance (the owner's "never open
 * accounts on your own" rule, broken by a side door). That refusal is correct, but the old code
 * treated it as terminal: one console.error and the finished work never appeared anywhere. Since a
 * migrated run can outlive the moment its target was picked by hours, "the app was shut just then"
 * was enough to lose the delivery entirely, silently, with the queue row still reading 'completed'.
 * Staying 'pending' turns that into a wait instead of a loss.
 *
 * A successful spawn that could not TITLE the chat is still 'done' — the conversation is in the app,
 * which is the delivery; re-firing the URL would not name it any better. The caveat is recorded.
 */
export async function attemptDesktopImport(id: string, importer?: DesktopImporter): Promise<void> {
  const row = db
    .query<
      {
        session_id: string
        import_to: string | null
        import_title: string | null
        import_state: ImportState | null
        finished_at: string | null
      },
      [string]
    >(
      'select session_id, import_to, import_title, import_state, finished_at from queue_items where id = ?',
    )
    .get(id)
  if (row?.import_state !== 'pending') return
  if (!row.import_to?.startsWith('desktop:')) {
    setImportState(id, 'gave_up', 'no desktop instance to deliver to')
    return
  }
  let result: { ok: boolean; reason?: string; titled?: boolean }
  try {
    // Dynamic import keeps session-launch (which pulls in core/instances) out of dispatch's module
    // graph at load time.
    const run = importer ?? (await import('./session-launch')).importSessionToDesktop
    result = await run({
      sessionId: row.session_id,
      instanceDir: row.import_to.slice('desktop:'.length),
      title: row.import_title,
    })
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : 'import-threw' }
  }
  if (result.ok) {
    setImportState(
      id,
      'done',
      result.titled === false ? 'delivered, but the chat title could not be written' : null,
    )
    return
  }
  const finished = row.finished_at ? Date.parse(row.finished_at) : Number.NaN
  const expired = Number.isFinite(finished) && Date.now() - finished > IMPORT_DEADLINE_MS
  setImportState(id, expired ? 'gave_up' : 'pending', result.reason ?? 'the import was refused')
}

/**
 * Retry every delivery still waiting for its target app to come back.
 *
 * ALWAYS ON, gated on neither `scheduler_enabled` nor `monitor_enabled`, for the same reason the
 * transient-retry sweep above is not: those switches govern hours-scale autonomy, while this only
 * finishes delivering a migration or handoff the user already asked for. It also runs during the
 * boot window that `isDispatchReady()` guards, deliberately — that guard exists to stop a second
 * `claude --resume` landing on one transcript, and an import writes no transcript. The guard that
 * matters here lives inside the import itself, which refuses a session that is live.
 */
export async function deliverPendingImports(importer?: DesktopImporter): Promise<void> {
  const rows = db
    .query<{ id: string }, []>(
      "select id from queue_items where import_state = 'pending' order by position asc",
    )
    .all()
  for (const r of rows) await attemptDesktopImport(r.id, importer)
}

let importTimer: ReturnType<typeof setInterval> | null = null

export function startImportSweep(): void {
  if (importTimer) return
  importTimer = setInterval(() => void deliverPendingImports().catch(() => {}), IMPORT_SWEEP_MS)
}

export function stopImportSweep(): void {
  if (importTimer) {
    clearInterval(importTimer)
    importTimer = null
  }
}

/**
 * Tail the run's log until the terminal marker (then finalize), the child dies without one (fail),
 * or the run is canceled. Handles BOTH a fresh run (childPid learned from the status file once the
 * runner writes it) and a reattach (childPid already known). Reading from a byte offset with a
 * persistent UTF-8 decoder means a run that produces megabytes of output isn't re-read each poll and
 * multibyte chars never split across reads.
 */
async function tailRun(id: string, entry: ActiveEntry): Promise<void> {
  const logPath = logPathFor(id)
  const decoder = new TextDecoder()
  let offset = 0
  let buf = ''
  let sawStatus = entry.childPid !== null // reattach already read the status file
  let deadFor = 0
  const POLL_MS = 250
  const START_GRACE_MS = 20_000 // status file must appear within this, else the runner never launched
  // After `claude` (childPid) goes non-alive, wait this long for the runner's trailing flush + exit
  // marker to land before giving up. Generous because the runner drains stdout/stderr AFTER the child
  // exits, then writes the marker; a large final chunk + slow disk (AV scan) can stretch that out.
  const DEAD_GRACE_MS = 4000
  const startedWaiting = Date.now()

  for (;;) {
    // 1. Learn the child pid from the runner's status file (fresh runs only, once).
    if (entry.childPid === null) {
      const st = readStatus(id)
      if (st) {
        // The file EXISTING is what proves the runner launched (step 5), regardless of whether we
        // may trust the pid inside it — so record that either way.
        sawStatus = true
        // ...but only adopt the pid while the runner is live. reattachRuns deliberately refuses a
        // dead runner's pid; re-reading the same stale file here would hand it straight back.
        if (entry.runnerLive && typeof st.childPid === 'number') {
          entry.childPid = st.childPid
          db.query('update queue_items set pid = ? where id = ?').run(st.childPid, id)
          publish(id, {
            type: 'status',
            data: { id, status: 'running', exit_code: null, pid: st.childPid },
          })
        }
      }
    }

    // 2. Read + process any new log bytes.
    let size = 0
    try {
      size = statSync(logPath).size
    } catch {
      size = 0 // not created yet
    }
    // Defensive: the log is append-only in this design, but if it ever shrank (truncated/replaced)
    // our byte offset would run past EOF and we'd read nothing forever — resync to the new size.
    if (size < offset) offset = size
    if (size > offset) {
      let fd: number | null = null
      try {
        fd = openSync(logPath, 'r')
        const len = size - offset
        const b = Buffer.allocUnsafe(len)
        const read = readSync(fd, b, 0, len, offset)
        offset += read
        buf += decoder.decode(b.subarray(0, read), { stream: true })
      } catch {
        // transient read error; try again next poll
      } finally {
        if (fd !== null) closeSync(fd)
      }
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) {
          const marker = parseMarker(line)
          if (marker?.kind === 'exit') {
            finalize(id, marker.code, { canceled: entry.canceled })
            return
          }
          if (marker?.kind === 'stderr') {
            const rt = runtime.get(id)
            if (rt) rt.limitKind = classifyLimit(marker.text) ?? rt.limitKind
            recordEvent(id, 'system', 'meta', `stderr: ${marker.text.slice(0, 2000)}`, null)
          } else {
            handleLine(id, line)
          }
        }
        idx = buf.indexOf('\n')
      }
    }

    // 3. Cancel: kill the child once we know its pid; the runner then writes the exit marker.
    if (entry.canceled && entry.childPid && !entry.killed) {
      entry.killed = true
      await killTree(entry.childPid)
    }

    // 4. Nothing left that could still finish this run → fail after a short grace, so a marker
    //    already in flight still wins. Two ways to arrive here:
    //      · we were watching a child and it died without writing a terminal marker (runner crashed);
    //      · we reattached onto a runner that was ALREADY gone, so there is no child to watch at
    //        all — the log we replayed in step 2 is everything that will ever exist, and if it held
    //        a marker we returned there. This branch is what reattachRuns means by "fails after its
    //        grace"; it used to work only because step 1 re-adopted the dead runner's stale pid and
    //        step 4 then found it dead, which is the same read that strands the run outright when
    //        the pid has been recycled by something still alive.
    //    A fresh run is neither: runnerLive is true and its child pid simply hasn't appeared yet
    //    (step 5's START_GRACE covers a runner that never launches).
    const nothingLeftToWatch =
      entry.childPid !== null ? !isAlive(entry.childPid) : !entry.runnerLive
    if (nothingLeftToWatch) {
      deadFor += POLL_MS
      if (deadFor > DEAD_GRACE_MS) {
        // Say WHY. exit -1 is our own synthetic code for "we lost the process", not something
        // `claude` reported, and without this line the run reads as a bare red "failed, exit -1"
        // with no hint that the work up to this point actually happened and landed on disk.
        if (!entry.canceled)
          recordEvent(
            id,
            'system',
            'meta',
            'run interrupted: the claude process exited without finishing this turn (killed, or AgentHydra restarted under it). Work it had already completed is on disk — open the session to see how far it got.',
            null,
          )
        finalize(id, -1, { canceled: entry.canceled })
        return
      }
    } else {
      deadFor = 0
    }

    // 5. Runner never launched (no status file, no output) → fail.
    if (!sawStatus && Date.now() - startedWaiting > START_GRACE_MS) {
      recordEvent(
        id,
        'system',
        'meta',
        'run did not start (dispatch runner failed to launch)',
        null,
      )
      finalize(id, -1, { canceled: entry.canceled })
      return
    }

    await Bun.sleep(POLL_MS)
  }
}

/** Fail a queue item BEFORE it's ever registered in `active` (finalize() no-ops until active.set,
 *  so the terminal state has to be written directly here — same fields finalize() sets). Used for
 *  every pre-launch instance-pinning failure: a pinned run must NEVER silently fall back to Ambient
 *  credentials, so an instance_ref that doesn't resolve to a real, live instance fails loudly here
 *  instead of reaching the runner with desktopDir/cliConfigDir both null. */
function failPreLaunch(item: QueueItem, message: string): void {
  recordEvent(item.id, 'system', 'meta', message, null)
  db.query(
    'update queue_items set status = ?, finished_at = ?, exit_code = ?, pid = null where id = ?',
  ).run('failed', new Date().toISOString(), -1, item.id)
  publish(item.id, {
    type: 'status',
    data: { id: item.id, status: 'failed', exit_code: -1, pid: null },
  })
  runtime.delete(item.id)
}

/** Spawn one queue item. Resolves when the run finalizes (or immediately if its session is busy).
 *  Registers the run in `active` SYNCHRONOUSLY before the first await, so callers (run-due,
 *  scheduler) that check isActive/isSessionActive right after see it as running. */
export async function dispatchItem(item: QueueItem): Promise<void> {
  // authoritative session lock (callers pre-check for a friendly error; this closes the race):
  // two concurrent --resume of the same session would interleave transcript writes.
  if (isSessionActive(item.session_id)) return

  // SURFACE PURITY, at the one chokepoint every headless run passes through (owner law
  // 2026-08-26: "desktop stays desktop, CLI stays CLI, headless stays headless, and you never
  // cross open"). The reported failure was desktop chats being continued as "a headless thing I
  // couldn't see": a queue --resume appends to the thread's transcript from outside, so the work
  // happens in a process the owner cannot watch and the desktop app cannot show live.
  //
  // The guard lives HERE, not in the HTTP route, deliberately: six call sites reach this function
  // (route, run-due, retry sweep, scheduler, monitor) and a route-level check would leave five
  // ways in. `allow_headless` is the owner's explicit override and the ONLY way past it.
  //
  // It deliberately does NOT exempt new_chat, though a genuinely new chat always passes it (a
  // freshly minted uuid has no desktop entry, so the lookup returns null). An adversarial audit
  // found the exemption was a real hole rather than a free optimisation: the create route lets a
  // caller supply the session id even when new_chat is true, and buildArgv then passes it as
  // `--session-id <id>`, so `{new_chat: true, session_id: <an existing desktop chat>}` wrote
  // headless turns straight into that chat's transcript with the check skipped at both layers.
  // Reachable from the MCP tool too, i.e. by the orchestrator itself. Asking the question about
  // every run - "does this id already live in a desktop app?" - costs one directory walk and
  // cannot be reasoned around.
  // SUPERSEDED 2026-08-27 by a wider law. The block above describes the guard as it was: it asked
  // only whether THIS thread already lived in a desktop app, and let every other run through. The
  // owner's ruling closed that gap outright ("We should never have any headless chats. No
  // headless."), because the property that was wrong is INVISIBLE rather than cross-surface: an
  // orphaned CLI thread or a scheduled run is just as unwatchable as a hijacked desktop chat.
  //
  // `allow_headless` no longer buys a way past. An override that defeats "never" is not an
  // override, it is the old behaviour behind a flag. The column stays so existing queue rows still
  // read back, it simply cannot authorise a run any more. See headless-policy.ts for the one
  // remaining switch and why its default is off.
  if (!headlessRunsAllowed()) {
    failPreLaunch(item, NO_HEADLESS_REASON)
    return
  }

  // fresh run: clear prior events + any stale files from an earlier run of this item.
  db.query('delete from run_events where queue_item_id = ?').run(item.id)
  runtime.set(item.id, freshRuntime())
  try {
    rmSync(logPathFor(item.id), { force: true })
  } catch {
    /* best-effort */
  }
  try {
    rmSync(statusPathFor(item.id), { force: true })
  } catch {
    /* best-effort */
  }

  // Instance-derived run identity (instance_ref = 'desktop:<dir>' | 'cli:<id>'): the spec carries
  // only PATHS — the runner extracts the instance's OAuth token value-blind at spawn time
  // (core/accounts.ts), so no credential ever touches the spec file, same discipline as accountId.
  // The cli id → configDir lookup happens HERE because the store read is daemon state; the dir is
  // not a secret.
  let desktopDir: string | null = null
  let cliConfigDir: string | null = null
  if (item.instance_ref?.startsWith('desktop:')) {
    desktopDir = item.instance_ref.slice('desktop:'.length) || null
    // Existence check (parallel to the 'cli:' branch's getCliInstance lookup below): a deleted
    // desktop instance's dir must fail HERE, pre-launch, not reach the runner. An isolated desktop
    // instance dir is a real folder on disk (Electron's --user-data-dir), so existsSync is sound.
    if (desktopDir && !existsSync(desktopDir)) {
      failPreLaunch(
        item,
        `run-as desktop instance not found (${desktopDir}) — it may have been deleted`,
      )
      return
    }
  } else if (item.instance_ref?.startsWith('cli:')) {
    cliConfigDir = getCliInstance(item.instance_ref.slice('cli:'.length))?.configDir ?? null
    if (!cliConfigDir) {
      failPreLaunch(
        item,
        `run-as CLI instance not found (${item.instance_ref}) — it may have been deleted`,
      )
      return
    }
  }
  // A non-null instance_ref that resolved to NEITHER a desktopDir NOR a cliConfigDir is malformed
  // (an empty suffix like 'desktop:'/'cli:', an unrecognized prefix like 'garbage:foo', or a bare
  // 'desktop' with no colon) — it must fail loudly here, not fall through and silently dispatch as
  // Ambient. This is the other half of the pinning guarantee: a pinned run never runs unpinned.
  if (item.instance_ref && !desktopDir && !cliConfigDir) {
    failPreLaunch(
      item,
      `run-as instance reference is malformed (${item.instance_ref}) — expected 'desktop:<dir>' or 'cli:<id>'`,
    )
    return
  }

  const spec = {
    itemId: item.id,
    childArgv: buildArgv(item),
    cwd: item.cwd,
    accountId: item.account_id ?? null,
    desktopDir,
    cliConfigDir,
    dbPath: DB_PATH,
    envExtra: {
      ...(process.env.AGENTHYDRA_FAKE ? { FAKE_SESSION_ID: item.session_id } : {}),
      // FAKE_SLEEP_MS is a test-only knob; forward it so a fake run launched via WMI (which does
      // NOT inherit the daemon's env) can still be slowed down for the survive/reattach tests.
      ...(process.env.FAKE_SLEEP_MS ? { FAKE_SLEEP_MS: process.env.FAKE_SLEEP_MS } : {}),
      // Same deal: makes the stand-in fail the way the real CLI does, so the 529 retry path can be
      // driven end to end rather than unit-tested around.
      ...(process.env.FAKE_ERROR_MODE ? { FAKE_ERROR_MODE: process.env.FAKE_ERROR_MODE } : {}),
    },
    logPath: logPathFor(item.id),
    statusPath: statusPathFor(item.id),
  }
  writeFileSync(specPathFor(item.id), JSON.stringify(spec))

  const entry: ActiveEntry = {
    sessionId: item.session_id,
    canceled: false,
    childPid: null,
    killed: false,
    // We are spawning the runner ourselves right now, so the status file it is about to write is
    // ours by construction — there is no stale-pid question for a fresh run.
    runnerLive: true,
  }
  active.set(item.id, entry) // SYNC: before the first await

  db.query(
    'update queue_items set status = ?, pid = null, started_at = ?, finished_at = null, exit_code = null where id = ?',
  ).run('running', new Date().toISOString(), item.id)
  publish(item.id, {
    type: 'status',
    data: { id: item.id, status: 'running', exit_code: null, pid: null },
  })

  // Launch the DETACHED runner so it survives the daemon exiting / being tree-killed.
  try {
    launchDetachedRunner(specPathFor(item.id))
  } catch (err) {
    recordEvent(item.id, 'system', 'meta', `failed to launch runner: ${String(err)}`, null)
    finalize(item.id, -1)
    return
  }

  await tailRun(item.id, entry)
}

/** Cancel a running item: kill `claude` (the runner then writes the terminal marker, so the tail
 *  finalizes it as 'canceled'), and reflect it immediately in the DB/UI. */
export function cancelItem(id: string): boolean {
  const entry = active.get(id)
  if (!entry) {
    // No live tail (e.g. a stale 'running' row we couldn't reattach): best-effort mark canceled.
    const row = db
      .query<{ status: string }, [string]>('select status from queue_items where id = ?')
      .get(id)
    if (row && row.status === 'running') {
      db.query('update queue_items set status = ?, finished_at = ?, pid = null where id = ?').run(
        'canceled',
        new Date().toISOString(),
        id,
      )
      publish(id, { type: 'status', data: { id, status: 'canceled', exit_code: null, pid: null } })
      return true
    }
    return false
  }
  entry.canceled = true
  if (entry.childPid && !entry.killed) {
    entry.killed = true
    void killTree(entry.childPid)
  }
  // Immediate feedback; the tail loop writes the authoritative final row when the marker lands.
  db.query('update queue_items set status = ? where id = ?').run('canceled', id)
  publish(id, {
    type: 'status',
    data: { id, status: 'canceled', exit_code: null, pid: entry.childPid },
  })
  return true
}

/**
 * Recover dispatch runs that were in flight when the previous daemon exited (Quit / auto-update /
 * crash). For each `running` queue_item: rebuild its run_events from the on-disk log (the log is the
 * source of truth), then resume tailing. tailRun then either sees the terminal marker (the run
 * finished while we were down → finalize) or keeps tailing a still-live run to completion. A run
 * whose process is gone with no marker is finalized as failed. Call once at boot, after db.ts is
 * ready. Idempotent: it only touches rows still marked 'running'.
 */
export async function reattachRuns(): Promise<void> {
  const rows = db.query<QueueItem, []>("select * from queue_items where status = 'running'").all()
  for (const row of rows) {
    const id = row.id
    // Rebuild events from whatever the runner has written so far (delete-then-replay = idempotent).
    db.query('delete from run_events where queue_item_id = ?').run(id)
    runtime.set(id, freshRuntime())

    const st = readStatus(id)
    const hasLog = existsSync(logPathFor(id))
    // Identity check (not raw PID liveness): is OUR runner still alive? This is PID-reuse-safe and
    // also true for a runner that was still launching when the previous daemon died.
    const runnerAlive = await isRunnerAlive(id)
    // Trust the stored childPid ONLY while the runner is verifiably alive — else a recycled PID could
    // be mistaken for our child (stuck run, or a cancel force-killing an innocent process).
    const childPid = runnerAlive && typeof st?.childPid === 'number' ? st.childPid : null

    const entry: ActiveEntry = {
      sessionId: row.session_id,
      canceled: false,
      childPid,
      killed: false,
      runnerLive: runnerAlive,
    }
    active.set(id, entry)

    if (!runnerAlive && !hasLog) {
      // The runner is gone and left nothing to replay: unrecoverable, mark failed.
      recordEvent(
        id,
        'system',
        'meta',
        'run lost: AgentHydra restarted and this run left no output to recover from.',
        null,
      )
      finalize(id, -1)
      continue
    }
    // SURFACE PURITY, re-checked on adoption. The pre-launch guard is a point-in-time answer, and
    // this is the one moment a stale answer can be corrected: a run legal when it started may have
    // had its session imported into a desktop app while the daemon was down, and adopting it would
    // resume tailing a headless writer inside a chat the owner now sees (an adversarial audit,
    // 2026-08-26, found nothing re-gated a run after launch). Stopping it leaves a mid-turn
    // transcript, which the stranded detector already surfaces for a proper in-app revive - a far
    // better end state than a hidden process writing into a visible chat.
    if (!row.allow_headless) {
      const { desktopHomeFor } = await import('./session-launch')
      const home = await desktopHomeFor(row.session_id).catch(() => null)
      if (home) {
        recordEvent(
          id,
          'system',
          'meta',
          'surface-violation on reattach: this thread now lives in the desktop app, so the ' +
            'headless run continuing it was stopped. Continue it in its app.',
          null,
        )
        entry.canceled = true
        if (childPid) void killTree(childPid)
        finalize(id, -1)
        continue
      }
    }
    // runnerAlive → resume tailing a live run; else the log exists → tailRun replays it and either
    // finalizes from its terminal marker (finished while we were down) or, seeing the runner gone with
    // no marker, fails after its grace. childPid is null unless the runner is verified alive.
    if (childPid) db.query('update queue_items set pid = ? where id = ?').run(childPid, id)
    void tailRun(id, entry)
  }
}
