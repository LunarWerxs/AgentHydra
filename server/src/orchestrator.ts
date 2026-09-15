/**
 * The orchestrator, driven from inside the daemon.
 *
 * WHAT IT IS. `orchestrator/` (a sibling of server/ and web/) is the Python toolbox that decides
 * what SHOULD happen to a chat: the dry loop, the sweep's lanes, moving chats between accounts,
 * archiving, naming, the tray-icon switch. It talks to this daemon over HTTP and owns no state the
 * daemon owns. Until 2026-09-03 it was a separate repository that an agent had to be TOLD about
 * ("you have to use both") - the owner's order that day was to fold it in, so one MCP surface
 * covers the whole fleet. This module is the seam: the daemon runs `python orch.py <script>` on the
 * caller's behalf and hands back what it printed. The rules stay where they are - in the scripts
 * (nothing acts without the tray icon; `--force` is a person's word; every act is verified) - so
 * driving them from here cannot bypass anything a hand-typed `python orch.py` could not.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a rewrite of the toolbox in TypeScript (v2 was exactly that, and
 * was retired for acting on chats that were not finished - orchestrator/README.md tells that story),
 * and not a shell: the script name is validated against the menu grammar and the arguments go to
 * the process as an argv array, never through a shell, so there is nothing to inject.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT } from './config'
import { killProcessTree } from './core/process'
import { readInstanceInfo } from './instance'

/** Where the toolbox lives. `AGENTHYDRA_ORCHESTRATOR_DIR` overrides for a layout where the Python
 *  tree sits somewhere else (a compiled binary with the tree copied beside it, or a developer
 *  pointing at a second checkout); the default is the sibling folder in this repo / this release. */
export function orchestratorDir(env: NodeJS.ProcessEnv = process.env, appRoot = APP_ROOT): string {
  const override = env.AGENTHYDRA_ORCHESTRATOR_DIR?.trim()
  if (override) return override
  const beside = join(appRoot, 'orchestrator')
  if (existsSync(join(beside, 'orch.py'))) return beside
  // A COMPILED BINARY RUN FROM THE REPO'S OWN dist/ (2026-09-06: `bun run dist` then launching
  // dist/AgentHydra.exe as the daemon). APP_ROOT is then dist/ itself, the toolbox is one level
  // up, and every orchestrator-backed tool (move_chats, orchestrator_menu, ...) died with "no
  // orch.py under app\dist\orchestrator" while the tree sat right beside it. Taken only when the
  // toolbox is actually there, so a release zip with no orchestrator still reports `beside`
  // and the honest "not at <dir>" error rather than a guess.
  const repo = join(appRoot, '..', 'orchestrator')
  return existsSync(join(repo, 'orch.py')) ? repo : beside
}

/** The interpreter. `python` is what the toolbox's own docs and both owner machines use on Windows;
 *  Debian-family Linux and macOS ship only `python3`. `AGENTHYDRA_PYTHON` names a specific binary. */
export function pythonBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const override = env.AGENTHYDRA_PYTHON?.trim()
  if (override) return override
  return platform === 'win32' ? 'python' : 'python3'
}

/** A menu name: `chats`, `migrate_chat`, `loop`, `armed`. orch.py resolves it to scripts/<name>.py
 *  or to one of its own driver words; anything else is refused HERE, before a process exists. */
const SCRIPT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4000
export const DEFAULT_TIMEOUT_MS = 10 * 60_000
/** A fleet-wide ACTING pass (the live loop, the sweep) legitimately runs past ten minutes, and
 *  killing it there would orphan actuators mid-act - so it gets the long deadline whichever tool
 *  asked for it, not only the one that happens to know. */
export const LONG_TIMEOUT_MS = 30 * 60_000
export const MAX_TIMEOUT_MS = 60 * 60_000

export function defaultDeadline(script: string, args: string[]): number {
  if (script === 'sweep' || (script === 'loop' && args.includes('--live'))) return LONG_TIMEOUT_MS
  return DEFAULT_TIMEOUT_MS
}

/** The driver's own words. orch.py's exit codes (DRIVER_EXIT_MEANINGS) describe THESE; a delegated
 *  script's exit code is its own (`orch.py <script>` returns `mod.main()` verbatim), so a 3 from
 *  migrate_chat means what migrate_chat's --help says, never "not armed". */
const DRIVER_WORDS = new Set(['loop', 'arm', 'resume', 'pause', 'disarm', 'armed'])

/** One run per script name at a time. The scripts carry their own locks for what must never
 *  overlap (a window, a lane's lockfile); this is the daemon-side backstop so two callers cannot
 *  start the same acting pass twice through this route. Different scripts may overlap.
 *
 *  ⛔ AND THE ENTRY MUST BE ABLE TO GO STALE (owner, 2026-09-07). The `finally` below deletes it
 *  on every normal path, so the only way one survives is a spawn promise that never settles -
 *  and then the lock is IMMORTAL, because nothing else ever removes it. Measured that day: a
 *  migrate_batch died with no python process left anywhere on the machine, and the retry came
 *  back `409 already running (started 85s ago)`. That is the worst shape a lock can take - it
 *  turns a CRASH into a HANG, reports a dead run as healthy, and the caller believes it (this
 *  one did, and told the owner the migration was progressing while nothing moved).
 *
 *  `deadline` settles it with a fact rather than a heuristic: every invocation carries a hard
 *  `timeoutMs` that realSpawn enforces by killing the child, so a lock that outlives its own
 *  timeout cannot have a live run behind it. `kill` is kept so a stale entry can also put down
 *  anything that somehow outlived its deadline before the next run starts. */
interface InFlightRun {
  started: number
  /** started + that run's own timeoutMs + grace. Past this, the entry is provably orphaned. */
  deadline: number
  /** realSpawn's kill switch, used defensively when reaping a stale entry. */
  kill?: () => void
}
const inFlight = new Map<string, InFlightRun>()

/** Grace on top of a run's own timeout before its lock is treated as orphaned. Covers the gap
 *  between realSpawn's kill and its promise settling; deliberately generous, because reaping a
 *  lock that IS live would let two acting passes overlap - the exact thing this map prevents. */
const STALE_LOCK_GRACE_MS = 60_000

/** The live entry for `script`, reaping it first if it is provably orphaned. Every reader goes
 *  through here, so no caller can mistake a dead lock for a live one. */
function liveRun(script: string): InFlightRun | null {
  const run = inFlight.get(script)
  if (!run) return null
  if (Date.now() < run.deadline) return run
  try {
    run.kill?.()
  } catch {}
  inFlight.delete(script)
  return null
}

/** fan_out.py's own read-only subcommands (its docstring: `status` and `list` never spawn, send
 *  or delete anything) - the ONLY fan_out invocations this route must never queue behind a write. */
const FAN_OUT_READ_SUBCOMMANDS = new Set(['status', 'list'])

/**
 * The in-flight/route-lock KEY for one invocation - `script` for every script, UNLESS it is one
 * of fan_out's read-only subcommands, which take no lock at all.
 *
 * ⛔ A READ WAS REFUSED BY THE WRITE'S LOCK (found live 2026-09-15). The route locks by SCRIPT
 * NAME, and `fan_out status`/`fan_out list` run the very same script name as a spawn that can
 * take minutes (~30-90s per chat, sequential) - so `fan_out_status`, read-only by its own MCP
 * description, answered `409 fan_out is already running through this route` three times while a
 * spawn it had nothing to do with was still working. `null` means "no lock at all": two reads may
 * run concurrently with each other and with a write, exactly as reading a file while it is being
 * written is fine as long as the write is atomic (fan_out.py's `_upsert` already is - see
 * `_save`'s write-then-`os.replace`). Every OTHER fan_out subcommand (a bare spawn, `send`,
 * `delete`) keeps the single shared "fan_out" key they always had, so two spawns - or a spawn and
 * a delete - still cannot overlap.
 */
export function routeLockKey(script: string, args: string[]): string | null {
  if (script === 'fan_out' && FAN_OUT_READ_SUBCOMMANDS.has(args[0] ?? '')) return null
  return script
}

/** The chats an invocation names: every `--chat <query>`, normalized, plus whether it sweeps a
 *  whole account. Parsing is literal on purpose - resolving a fragment to a chat is the Python
 *  side's job, and a daemon that guessed would be a second, disagreeing resolver. */
export function chatScopeOf(args: string[]): { chats: Set<string>; sweeps: boolean } {
  const chats = new Set<string>()
  let sweeps = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all-unarchived') sweeps = true
    else if (args[i] === '--chat' && i + 1 < args.length)
      chats.add(
        String(args[i + 1] ?? '')
          .trim()
          .toLowerCase(),
      )
  }
  chats.delete('')
  return { chats, sweeps }
}

/**
 * May the incoming call take the route from the run that holds it?
 *
 * ⛔ ONLY WHEN A PERSON SAID SO, AND ONLY WHEN NOTHING IS STRANDED. Found live 2026-09-12,
 * draining #8: a patient `move_chats` sat in stop-idle for its 300s while the owner said "kill
 * it and move it", and the correct call - the same move with `terminate_live` - was refused 409
 * because the route is keyed by SCRIPT NAME. The only way through was to find the engine's pid
 * and `taskkill` it by hand, which is outside every rail these tools exist to provide, and the
 * refused call's resume text was lost with it.
 *
 * Two conditions, both necessary. `--terminate-live` is the person's word: it is the same act
 * with the waiting overridden, and queueing it behind the very wait it overrides is backwards.
 * And the incoming call's chats must COVER the holder's, so no chat is left half-moved by the
 * kill: whatever the preempted run had started, the incoming run is about to do itself, and
 * migrate_chat re-resolves and re-gates every chat from scratch. A holder that names chats this
 * call does not is never preempted - that is what orchestrator_cancel is for, deliberately, by
 * a person who can see what they are abandoning (and migrate_reconcile.py to find it after).
 */
export function mayPreempt(incoming: string[], holder: string[]): boolean {
  if (!incoming.includes('--terminate-live')) return false
  const want = chatScopeOf(incoming)
  const held = chatScopeOf(holder)
  if (held.sweeps) return want.sweeps // only a sweep covers a sweep
  if (held.chats.size === 0) return false // an unreadable scope is never preempted
  for (const chat of held.chats) if (!want.chats.has(chat)) return false
  return true
}

/** The resume text a migrate_batch invocation carries, and the chats it names. */
function resumeOf(args: string[]): { resume: string; chats: string[] } {
  const i = args.indexOf('--resume')
  const resume = i >= 0 && i + 1 < args.length ? String(args[i + 1] ?? '').trim() : ''
  return { resume, chats: [...chatScopeOf(args).chats] }
}

/**
 * A REFUSED MOVE MUST NOT EAT ITS RESUME: stage it against every chat the call named.
 *
 * ⛔ WHY IT LIVES HERE AND NOT IN THE MCP TOOL (review finding, 2026-09-14). The first cut
 * staged from `move_chats` after catching the 409 - but `move_chats` detaches by default (any
 * batch carrying a resume declares more than two minutes), so the route answered 202 with an
 * operation id and the refusal happened later, inside that operation, where no MCP code ever saw
 * it. The fix covered the rare blocking call and missed the path nearly every real call takes.
 * This is the one place both paths go through.
 *
 * WHY AT ALL (found live 2026-09-12): a `move_chats` carrying a resume was refused busy; the
 * refusal was right, but the words died with the call, and the landed chat had to be told by
 * hand that four background jobs had been orphaned. Staged through `stage_reply` - the script
 * that owns the delivery ledger - with `--dedupe`, so a re-fired call re-uses the row instead of
 * leaving two wakes. Staged, never sent: the courier types it later, with its own rails.
 */
async function stageRefusedResume(
  args: string[],
  deps: SpawnDeps & { dir?: string; python?: string },
): Promise<Array<Record<string, unknown>>> {
  const { resume, chats } = resumeOf(args)
  if (!resume) return []
  const out: Array<Record<string, unknown>> = []
  for (const chat of chats) {
    const run = await runOrchestrator(
      {
        script: 'stage_reply',
        args: [chat, '--text', resume, '--by', 'move_chats (refused)', '--dedupe', '--json'],
        timeoutMs: 60_000,
      },
      deps,
    )
    let payload: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse('stdout' in run ? run.stdout : '')
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
    } catch {
      payload = null
    }
    out.push(
      payload?.id
        ? { chat, staged: true, id: payload.id, reused: payload.reused === true }
        : {
            chat,
            staged: false,
            why:
              'error' in run
                ? run.error
                : run.stderr.trim() || run.exitMeaning || `exit ${String(run.exitCode)}`,
          },
    )
  }
  return out
}

/** How long to wait for a preempted run's lock to clear before giving up and refusing as usual.
 *  realSpawn's kill settles its promise in milliseconds; this is the bound, not the expectation. */
let PREEMPT_WAIT_MS = 5_000

/** Test seam: shorten the preempt wait, so the "did not clear in time" branch is testable without
 *  a five-second sleep. Returns the previous value. */
export function setPreemptWaitMsForTests(ms: number): number {
  const was = PREEMPT_WAIT_MS
  PREEMPT_WAIT_MS = ms
  return was
}

/** Poll until `script` holds no live run, or the bound elapses. Returns whether it cleared. */
async function waitForLockToClear(
  script: string,
  budgetMs: number = PREEMPT_WAIT_MS,
): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (!liveRun(script)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !liveRun(script)
}

/** Is any toolbox script running through this daemon right now? The compiled updater asks
 *  before it replaces orchestrator/ (audit AH-08). Reaps stale entries first - an immortal lock
 *  must not block an update forever either. */
export function orchestratorBusy(): boolean {
  for (const script of [...inFlight.keys()]) liveRun(script)
  return inFlight.size > 0
}

// ── durable operations (audit AH-09) ────────────────────────────────────────────────────────
//
// A script may run for 10, 30 or 60 minutes, and the HTTP route used to hold its result hostage
// to one connection whose idle timeout is 255 s. Reproduced end to end: ECONNRESET at 256 s, a
// retry answered "busy", and the original command finished at 270 s with nobody to tell. A client
// therefore read "network failure" for an act that was still running, and a blind retry could
// either hit busy or, later, repeat an act that had already completed.
//
// The registry below makes a run an OPERATION with an id and a lifetime beyond the connection:
//   * a caller may pass an idempotency key - a second request with the same key, while the
//     first is running or within OPERATION_TTL_MS of finishing, returns THE SAME operation and
//     starts nothing (so a retry after a dropped connection gets the original outcome);
//   * a caller may ask for the id up front (`async`) and poll it;
//   * a running operation can be cancelled, which kills the child's whole tree; the outcome then
//     says cancelled rather than failed.
// Results are kept in memory, bounded (OPERATION_KEEP) and expiring (OPERATION_TTL_MS): this is
// reconciliation for a dropped connection and a restart-free daemon, not an audit log - the
// toolbox's own ledgers are the durable record of what an act did.
//
// ⛔ 'RESTART-FREE' IS THE LOAD-BEARING WORD, AND IT USED TO BE INVISIBLE TO CALLERS (2026-09-12).
// A migration batch was launched detached, the daemon restarted while it ran, the batch's child
// process survived the restart and finished its work ORPHANED - and every poll of its id then
// answered a bare 'no such operation', with the recent list empty. The MCP descriptions promised
// an unconditional hour and 'nothing is gone', so the honest conclusion from the answer was that
// the run had never existed. An hour was spent reconstructing the per-chat verdicts from four
// other tools. Nothing here is made durable in response - that WOULD be the audit log this
// deliberately is not - but a miss now says WHY it missed, so a caller can tell 'never existed'
// from 'did not survive a restart' and knows to read the toolbox's ledger instead.

export type OrchestratorOutcome =
  | OrchestratorRun
  | {
      ok: false
      error: string
      busy?: boolean
      operationId?: string
      /** A refused migrate_batch's resume text, staged per named chat (see stageRefusedResume). */
      resumeStaged?: Array<Record<string, unknown>>
    }

export interface OrchestratorOperation {
  id: string
  script: string
  args: string[]
  idempotencyKey: string | null
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** Null while running. */
  result: OrchestratorOutcome | null
  /** True once the child process actually started. A refusal before that (bad request, busy)
   *  is a result too, but not one an idempotency key should pin: the caller may retry. */
  ran: boolean
}

interface OperationEntry {
  op: OrchestratorOperation
  promise: Promise<OrchestratorOperation>
  kill: (() => void) | null
  cancelRequested: boolean
}

const OPERATION_TTL_MS = 60 * 60_000
const OPERATION_KEEP = 200
const operations = new Map<string, OperationEntry>()

/** When THIS daemon process started. A miss is interpreted against it: an id minted by an
 *  earlier process cannot be in this one's map, and that is a different fact from a bad id. */
const REGISTRY_STARTED_AT = Date.now()

/** Why an id is not here - so a 404 can be acted on instead of puzzled over. */
export type OperationMiss = {
  ok: false
  error: string
  reason: 'unknown-id' | 'daemon-restarted'
  /** When the daemon that is answering started. */
  daemonStartedAt: number
  /** How many records this process is holding, so 'empty' is distinguishable from 'pruned'. */
  held: number
}

export function operationMissReason(now = Date.now()): OperationMiss {
  // A registry this young cannot have pruned anything: OPERATION_TTL_MS is an hour, so an id
  // that is absent from a process younger than that was either never minted here or was minted
  // before a restart. Either way the caller's next move is the same, and saying so is the fix.
  const youngerThanTtl = now - REGISTRY_STARTED_AT < OPERATION_TTL_MS
  const restarted = youngerThanTtl
  return {
    ok: false,
    reason: restarted ? 'daemon-restarted' : 'unknown-id',
    daemonStartedAt: REGISTRY_STARTED_AT,
    held: operations.size,
    error: restarted
      ? 'no such operation here - THIS DAEMON STARTED AT ' +
        new Date(REGISTRY_STARTED_AT).toISOString() +
        ', less than an hour ago, and operation records live only in the daemon process that ' +
        'ran them. If your run began before that time, it was a DIFFERENT process: the record ' +
        'did not survive the restart, and the run itself may well have finished (a detached ' +
        "child outlives the daemon). Do NOT re-fire the act - read the toolbox's own ledger " +
        'for what it did, and verify the effect directly.'
      : 'no such operation - this daemon has been up over an hour, so the id was either never ' +
        'minted here or its record has passed the one-hour retention.',
  }
}

function pruneOperations(now = Date.now()): void {
  const finished = [...operations.values()].filter((e) => e.op.finishedAt !== null)
  for (const e of finished) {
    if (now - (e.op.finishedAt ?? now) > OPERATION_TTL_MS) operations.delete(e.op.id)
  }
  const stillFinished = [...operations.values()]
    .filter((e) => e.op.finishedAt !== null)
    .sort((a, b) => (a.op.finishedAt ?? 0) - (b.op.finishedAt ?? 0))
  while (stillFinished.length > OPERATION_KEEP) {
    const oldest = stillFinished.shift()
    if (oldest) operations.delete(oldest.op.id)
  }
}

function snapshot(op: OrchestratorOperation): OrchestratorOperation {
  return { ...op, args: [...op.args] }
}

/**
 * Start a run as an operation - or, with an idempotency key that names one already RUNNING or
 * that SUCCEEDED, return that one and start nothing.
 *
 * A failed or cancelled run does NOT pin the key. `ran` alone used to be the test - true the
 * moment a child process actually started - so a deterministic failure (title mismatch, a
 * refused precondition, anything that fails the same way every time) got resurrected forever:
 * the same key kept answering the old FAILED operation, and the only escape was perturbing an
 * argument (see docs/todo/TODO.md, "Overnight orchestration run", item 3). A key still protects
 * what it exists to protect - a dropped connection retried while the original is still running,
 * or already succeeded, must not start a second act - but a failed or cancelled run leaves the
 * key free for the very next call with that key to try again for real.
 */
export function startOrchestratorOperation(
  input: { script?: unknown; args?: unknown; timeoutMs?: unknown },
  opts: {
    idempotencyKey?: string | null
    deps?: SpawnDeps & { dir?: string; python?: string }
  } = {},
): { op: OrchestratorOperation; promise: Promise<OrchestratorOperation>; reused: boolean } {
  pruneOperations()
  const key = opts.idempotencyKey?.trim() || null
  if (key) {
    for (const e of operations.values()) {
      if (e.op.idempotencyKey === key && (e.op.status === 'running' || e.op.status === 'done'))
        return { op: snapshot(e.op), promise: e.promise, reused: true }
    }
  }
  const check = validateInvocation(input)
  const op: OrchestratorOperation = {
    id: crypto.randomUUID(),
    script: check.ok ? check.invocation.script : String(input.script ?? ''),
    args: check.ok ? check.invocation.args : [],
    idempotencyKey: key,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    result: null,
    ran: false,
  }
  const entry: OperationEntry = {
    op,
    promise: Promise.resolve(op),
    kill: null,
    cancelRequested: false,
  }
  const deps = opts.deps ?? {}
  entry.promise = runOrchestrator(input, {
    ...deps,
    onProcess: (kill) => {
      op.ran = true
      entry.kill = kill
      deps.onProcess?.(kill)
      // A cancel that arrived before the child existed lands the moment it does.
      if (entry.cancelRequested) kill()
    },
  }).then((result) => {
    // An injected spawn never reports a process; if the run went far enough to have a script
    // record, it ran as far as this registry is concerned.
    if ('script' in result) op.ran = true
    op.result = result
    op.finishedAt = Date.now()
    op.status = entry.cancelRequested ? 'cancelled' : result.ok ? 'done' : 'failed'
    return snapshot(op)
  })
  operations.set(op.id, entry)
  return { op: snapshot(op), promise: entry.promise, reused: false }
}

export function getOrchestratorOperation(id: string): OrchestratorOperation | null {
  const e = operations.get(id)
  return e ? snapshot(e.op) : null
}

export function listOrchestratorOperations(): OrchestratorOperation[] {
  pruneOperations()
  return [...operations.values()]
    .map((e) => snapshot(e.op))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Ask a running operation to stop. Its whole process tree is killed; the outcome then reads
 *  `cancelled`. A finished operation is left as it is. */
export function cancelOrchestratorOperation(
  id: string,
): { ok: true; status: OrchestratorOperation['status'] } | { ok: false; error: string } {
  const e = operations.get(id)
  if (!e) return { ok: false, error: 'no such operation' }
  if (e.op.status !== 'running') return { ok: true, status: e.op.status }
  e.cancelRequested = true
  e.kill?.()
  return { ok: true, status: 'running' }
}

/**
 * Tests only: forget every operation AND release every route lock.
 *
 * ⛔ THE LOCK HALF IS LOAD-BEARING, AND IT WAS MISSING (GitHub CI, Linux, 2026-09-14). `bun test`
 * runs every file in ONE process, so `inFlight` outlives the file that filled it. A file that
 * stubs a spawn which never settles - which is exactly how orchestrator-stale-lock.test.ts pins
 * "a young lock still blocks" - leaves an IMMORTAL `migrate_batch` lock behind, and every later
 * file's migrate_batch run is then refused busy by a run that does not exist. The preempt suite
 * went red on Linux and green on Windows off nothing but readdir order deciding which file ran
 * first: its holder could not start, so there was no operation to preempt. Clearing the
 * operations without the locks left exactly half the module state behind.
 *
 * Clears rather than kills: a stub's kill switch is the test's own business, and a real run's
 * lock is never reached by this seam because production never calls it.
 */
export function resetOrchestratorOperationsForTests(): void {
  operations.clear()
  inFlight.clear()
}
/** Output kept per stream. The dry loop over a full fleet is a few thousand lines; a runaway is
 *  truncated from the FRONT so the verdict lines at the end survive. */
export const MAX_OUTPUT_CHARS = 200_000

export interface OrchestratorInvocation {
  script: string
  args: string[]
  timeoutMs: number
}

export type InvocationCheck =
  | { ok: true; invocation: OrchestratorInvocation }
  | { ok: false; error: string }

/** Pure. Shapes the caller's request into an argv the driver accepts, or says exactly why not. */
export function validateInvocation(input: {
  script?: unknown
  args?: unknown
  timeoutMs?: unknown
}): InvocationCheck {
  const script = typeof input.script === 'string' ? input.script.trim() : ''
  if (!script)
    return {
      ok: false,
      error: 'script is required (a menu name such as `chats`, `loop` or `armed`)',
    }
  if (!SCRIPT_NAME.test(script))
    return {
      ok: false,
      error: `script ${JSON.stringify(script)} is not a menu name (lowercase letters, digits, underscores)`,
    }
  const rawArgs = input.args == null ? [] : input.args
  if (!Array.isArray(rawArgs)) return { ok: false, error: 'args must be an array of strings' }
  if (rawArgs.length > MAX_ARGS)
    return { ok: false, error: `too many args (${rawArgs.length} > ${MAX_ARGS})` }
  const args: string[] = []
  for (const a of rawArgs) {
    if (typeof a !== 'string') return { ok: false, error: 'every arg must be a string' }
    if (a.length > MAX_ARG_LENGTH)
      return { ok: false, error: `an arg is longer than ${MAX_ARG_LENGTH} characters` }
    if (a.includes('\0')) return { ok: false, error: 'an arg contains a NUL byte' }
    args.push(a)
  }
  let timeoutMs = defaultDeadline(script, args)
  if (input.timeoutMs != null) {
    const n = Number(input.timeoutMs)
    if (!Number.isFinite(n) || n <= 0)
      return { ok: false, error: 'timeoutMs must be a positive number' }
    timeoutMs = Math.min(Math.floor(n), MAX_TIMEOUT_MS)
  }
  return { ok: true, invocation: { script, args, timeoutMs } }
}

/**
 * May a request carrying this Origin run an orchestrator script? Pure.
 *
 * The daemon's shared loopback guard (loopback-guard.mjs) rejects CROSS-site browser requests, but
 * a page served from ANOTHER loopback port is "same-site" to the Fetch spec (a site ignores the
 * port), and the guard strips ports before comparing - so a dev server, a preview, or any local
 * daemon's page could POST here. The orchestrator's own gateway closed exactly this hole on
 * 2026-09-03 (its commit 8c636b9: "Origins must now match exactly"); this route, which can run any
 * script with a person's `--force`, gets the same rule: no Origin (curl, the tray, an MCP client -
 * same-machine tools the owner ran) or the daemon's OWN origin, byte for byte. Nothing else.
 */
export function runOriginAllowed(
  originHeader: string | null | undefined,
  requestUrl: string,
): boolean {
  const origin = (originHeader ?? '').trim()
  if (!origin || origin === 'null') return !origin
  try {
    return new URL(origin).origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}

/** What orch.py's exit codes mean, verbatim from its docstring, so a caller reads a verdict and not
 *  a number. A script's OWN codes (migrate_chat's 4 = live writer, 6 = held, ...) are in that
 *  script's `--help`; the driver passes them through unchanged. */
export const DRIVER_EXIT_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok',
  1: 'daemon failure',
  2: 'the loop found something that failed',
  3: 'unknown script, deterministic refusal, or not armed (nothing acts without the tray icon)',
})

/** Pure. 0 is ok for everyone; the other meanings apply only to the driver's own words. */
export function exitMeaning(script: string, code: number | null): string | null {
  if (code == null) return null
  if (code === 0) return DRIVER_EXIT_MEANINGS[0] ?? 'ok'
  return DRIVER_WORDS.has(script) ? (DRIVER_EXIT_MEANINGS[code] ?? null) : null
}

export interface OrchestratorRun {
  ok: boolean
  script: string
  args: string[]
  command: string[]
  cwd: string
  exitCode: number | null
  exitMeaning: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  /** The operation this run took the route from, when a person's `--terminate-live` preempted a
   *  patient move of the same chats (see mayPreempt). Absent on an ordinary run, so a caller
   *  that does not know about preemption reads exactly what it always did. */
  preempted?: string
}

/** One row of `lib/actionlib.CATALOG`, as `orch.py --catalog` prints it. Deliberately loose: the
 *  Python catalog is the source of truth and gains fields as scripts gain rails, and a daemon that
 *  rejected a key it had not been taught would turn a catalog addition into an outage here. */
export interface OrchestratorAction {
  /** `observe` (reads only) or `mutate` (changes something, behind the rails). */
  kind: string
  summary: string
  invocation?: string
  platforms?: string
  guards?: string[]
  result?: string
  availability?: string
  [extra: string]: unknown
}

export interface OrchestratorStatus {
  dir: string
  present: boolean
  python: string
  pythonVersion: string | null
  /** The driver's own menu (`python orch.py` with no arguments), when the tree is present and
   *  python answers - the one place every script and what it does is listed. */
  menu: string | null
  /** The same list as DATA (`orch.py --catalog`, i.e. lib/actionlib.CATALOG), so a caller reads
   *  the actions instead of parsing `menu`'s prose (audit AH-25). null means NOT READ, never "it
   *  has no actions" - `actionsError` says which, so the two can never look alike. */
  actions: Record<string, OrchestratorAction> | null
  actionsError: string | null
  error: string | null
}

/** Bounded and newline-normalised: python on Windows emits CRLF into a pipe, and an agent reading
 *  the verdict lines should not have to strip carriage returns first. `alreadyDropped` is what the
 *  spawn adapter discarded WHILE READING (see drainBounded); it is folded into the one truncation
 *  header so the caller sees the whole loss, not just this final trim. */
function tail(raw: string, alreadyDropped = 0): string {
  const text = raw.replace(/\r\n?/g, '\n')
  const extra = Math.max(0, text.length - MAX_OUTPUT_CHARS)
  const dropped = alreadyDropped + extra
  const kept = extra ? text.slice(-MAX_OUTPUT_CHARS) : text
  return dropped > 0 ? `…[truncated ${dropped} chars]\n${kept}` : kept
}

/** One spawn, captured, with a deadline. Exposed for tests through `deps`; the real thing is
 *  Bun.spawn with windowsHide (python is a console program - see scripts/checks/spawn-console-window.mjs). */
/** What a spawn adapter can hand back while the child runs. `onProcess` receives a kill switch
 *  the moment the child exists, so a caller (the durable-operation registry) can cancel it. */
export interface SpawnHooks {
  onProcess?: (kill: () => void) => void
}

export interface SpawnDeps {
  /** Forwarded to the spawn adapter; see SpawnHooks. */
  onProcess?: SpawnHooks['onProcess']
  spawn?: (
    command: string[],
    cwd: string,
    timeoutMs: number,
    hooks?: SpawnHooks,
  ) => Promise<{
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    /** Characters the adapter discarded from the FRONT of each stream while reading, when the
     *  child said more than MAX_OUTPUT_CHARS. A fake spawn may leave these out. */
    stdoutDropped?: number
    stderrDropped?: number
  }>
}

/**
 * Read a child's stream to its end while keeping at most `cap` characters of it - the LAST
 * `cap`, so the verdict lines survive - and counting what was let go (audit AH-14).
 *
 * Before this the adapter did `new Response(stream).text()` and applied the cap afterwards, so a
 * verbose or runaway script (a dry loop over a big fleet prints thousands of lines; a stuck one
 * can print forever until its deadline) had the daemon hold the ENTIRE output in memory first
 * and only then keep 200k of it. The cap now applies as the bytes arrive. Both streams are
 * drained concurrently by the caller so the child can never block on a full pipe.
 */
export async function drainBounded(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap = MAX_OUTPUT_CHARS,
  abandon?: AbortSignal,
): Promise<{ text: string; dropped: number }> {
  if (!stream) return { text: '', dropped: 0 }
  const decoder = new TextDecoder('utf-8')
  const reader = stream.getReader()
  // `abandon` fires when the child was killed and its pipe STILL has not closed: a grandchild the
  // tree walk could not see is holding it. What arrived so far is returned; waiting longer would
  // hold the route open for as long as that stranger lives (the CI container proved it: no
  // process table, a 120 s grandchild, a route that never answered).
  const giveUp = () => {
    reader.cancel().catch(() => {})
  }
  if (abandon?.aborted) giveUp()
  else abandon?.addEventListener('abort', giveUp, { once: true })
  let text = ''
  let dropped = 0
  const trim = () => {
    if (text.length > cap) {
      dropped += text.length - cap
      text = text.slice(-cap)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      trim()
    }
    text += decoder.decode()
    trim()
  } catch {
    // A read error (the child was killed mid-write, the pipe closed under us): what arrived is
    // still the honest answer, and the exit code says the rest.
  } finally {
    abandon?.removeEventListener('abort', giveUp)
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
  return { text, dropped }
}

// The Unix process-tree walk and the tree kill live in ./core/process, beside the process table
// they read: dispatch.ts needs the same two, and keeping a second copy here is how its Unix
// branch stayed a bare single-process kill while this one was fixed (audit AH-15, and the
// adversarial re-check of that closure on 2026-09-06 that found the surviving duplicate).

/** Kill the WHOLE tree, not just python. An acting script blocks on its actuator (a powershell
 *  driving a window, `subprocess.run` in migrate_chat / chips / courier); killing only the
 *  interpreter would leave that actuator running unsupervised while the caller reads "timed
 *  out". The toolbox itself uses `taskkill /T /F` for the same reason (lib/enginelib.py). The walk
 *  and the kill live in core/process.ts (killProcessTree), shared with dispatch.ts, because two
 *  copies of this is how dispatch's Unix branch stayed a single-process kill after this one was
 *  fixed. */
function killTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    if (proc.pid) killProcessTree(proc.pid)
    // Settle Bun's own handle too: the tree kill above went through the OS, and on Windows it
    // already took this pid with it, so this is a no-op there and the real kill on a host where
    // the pid could not be enumerated.
    proc.kill('SIGKILL')
  } catch {
    // already gone
  }
}

/** The URL THIS daemon answers on, recorded by index.ts the moment it has bound its port. */
let daemonUrl: string | null = null

export function setOrchestratorDaemonUrl(url: string): void {
  daemonUrl = url
}

/**
 * The environment a toolbox child runs with.
 *
 * Two things are pinned here rather than inherited:
 *
 *   * PYTHONUTF8 / PYTHONIOENCODING: Python writing to a PIPE on Windows encodes with the locale
 *     code page (cp1252) unless told otherwise, and the toolbox prints '×', '🟢' and account names
 *     - decoded as UTF-8 here that would be mojibake on a machine without UTF-8 mode.
 *   * AGENTHYDRA_URL: THE DAEMON THAT SPAWNED THE CHILD (audit AH-04). hydralib's default is
 *     127.0.0.1:7787 and it only ever read AGENTHYDRA_URL, while this daemon auto-hops to another
 *     port when 7787 is taken and never told its child. Reproduced: AGENTHYDRA_PORT=17787 with no
 *     URL set, and the toolbox still addressed 7787 - a menu that looks healthy while every fleet
 *     read fails, or, with an older daemon on 7787, the wrong daemon answering. The bound URL
 *     overrides any AGENTHYDRA_URL the daemon itself inherited: a child of this daemon talks to
 *     this daemon, whatever the shell that started the daemon was pointed at.
 */
export function orchestratorChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  url: string | null = daemonUrl,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(base as Record<string, string>),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  const own = url ?? readInstanceInfo()?.url ?? null
  if (own) env.AGENTHYDRA_URL = own
  return env
}

/** After a kill, how long an unclosed pipe is waited on before the drain is abandoned. */
const DRAIN_GRACE_MS = 5_000

async function realSpawn(command: string[], cwd: string, timeoutMs: number, hooks?: SpawnHooks) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
    env: orchestratorChildEnv(),
  })
  const abandon = new AbortController()
  let grace: ReturnType<typeof setTimeout> | null = null
  const killAndBound = () => {
    killTree(proc)
    // The kill takes the tree we can see. If a pipe is still open DRAIN_GRACE_MS later, something
    // we could not see holds it; stop reading rather than hang the route on it.
    grace ??= setTimeout(() => abandon.abort(), DRAIN_GRACE_MS)
  }
  hooks?.onProcess?.(killAndBound)
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    killAndBound()
  }, timeoutMs)
  try {
    // Both streams drained together, bounded as they arrive (drainBounded): a child that fills one
    // pipe while the other is unread would otherwise deadlock, and one that never stops talking
    // would otherwise be held whole in memory until its deadline.
    const [out, err, code] = await Promise.all([
      drainBounded(proc.stdout, MAX_OUTPUT_CHARS, abandon.signal),
      drainBounded(proc.stderr, MAX_OUTPUT_CHARS, abandon.signal),
      proc.exited,
    ])
    return {
      code,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      stdoutDropped: out.dropped,
      stderrDropped: err.dropped,
    }
  } finally {
    // Whatever happened above (a drain that threw, a rejected exit), the deadline timer must not
    // fire on a run that is already over, and a child still alive must not outlive its adapter.
    clearTimeout(killer)
    if (grace) clearTimeout(grace)
    if (proc.exitCode === null && !proc.killed) killTree(proc)
  }
}

/** Outcome of checking whether a script is already running through this route: either the caller
 *  is free to proceed (optionally because it just preempted the holder), or must stop and return
 *  the given refusal. */
type LiveRunConflict =
  | { blocked: false; preempted?: string }
  | { blocked: true; outcome: OrchestratorOutcome }

/**
 * `script` already has `running` in flight; decide whether this call may preempt it or must be
 * refused. Split out of runOrchestrator so its nested preempt/refuse branches don't compound with
 * the spawn/try/catch below them. Callers check `liveRun` themselves and only call this — and only
 * `await` its result — when it is non-null, so a caller with nothing in flight reaches its spawn in
 * the same synchronous tick it always did.
 *
 * Name the run that holds the lock AND the one call that releases it. A bare "wait for it" is
 * what sent 2026-09-12 to taskkill and 2026-09-13 to a hand-killed migrate_batch: the remedy
 * existed both times (cancelOrchestratorOperation) and the refusal never said so.
 */
async function resolveLiveRunConflict(
  script: string,
  args: string[],
  deps: SpawnDeps & { dir?: string; python?: string },
  running: InFlightRun,
): Promise<LiveRunConflict> {
  const holder = [...operations.values()].find(
    (e) => e.op.status === 'running' && e.op.script === script,
  )
  // Every refusal below carries the call's resume, staged, when it had one.
  const refuse = async (error: string): Promise<OrchestratorOutcome> => {
    const resumeStaged =
      script === 'migrate_batch' && resumeOf(args).resume
        ? await stageRefusedResume(args, deps)
        : undefined
    return {
      ok: false,
      busy: true,
      ...(holder ? { operationId: holder.op.id } : {}),
      ...(resumeStaged ? { resumeStaged } : {}),
      error,
    }
  }

  // ...and when the incoming call is the SAME act with a person's word added, take the route
  // instead of naming a remedy the person then has to run by hand. See mayPreempt.
  if (holder && mayPreempt(args, holder.op.args)) {
    const stop = cancelOrchestratorOperation(holder.op.id)
    if (stop.ok && (await waitForLockToClear(script)))
      return { blocked: false, preempted: holder.op.id }
    // ⛔ THE HOLDER IS ALREADY DYING, SO DO NOT SAY "WAIT FOR IT" (review finding, 2026-09-14).
    // A tree whose grandchild holds a pipe open can outlast the wait, and falling through to
    // the ordinary refusal told the caller to wait for a healthy run, or to cancel one this
    // very call had just cancelled - while nothing was moving the chats at all.
    if (stop.ok)
      return {
        blocked: true,
        outcome: await refuse(
          `${script} (operation ${holder.op.id}) was preempted by this call and is still being torn down after ${Math.round(PREEMPT_WAIT_MS / 1000)}s - it needs no orchestrator_cancel. Fire this same call again in a few seconds; nothing is moving these chats until you do.`,
        ),
      }
  }

  const age = Math.round((Date.now() - running.started) / 1000)
  const remedy = holder
    ? `wait for it, or stop it with orchestrator_cancel { id: "${holder.op.id}" } and fire this call again`
    : 'wait for it rather than starting a second one'
  return {
    blocked: true,
    outcome: await refuse(
      `${script} is already running through this route (started ${age}s ago) - ${remedy}`,
    ),
  }
}

/** Run one script by its menu name. The driver's cwd is the toolbox root, exactly as a person
 *  typing `python orch.py <script>` there, so state/, the tray heartbeat and the ledgers resolve
 *  to the same files a hand-run would use. */
export async function runOrchestrator(
  input: { script?: unknown; args?: unknown; timeoutMs?: unknown },
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorOutcome> {
  const check = validateInvocation(input)
  if (!check.ok) return { ok: false, error: check.error }
  const { script, args, timeoutMs } = check.invocation
  const dir = deps.dir ?? orchestratorDir()
  const driver = join(dir, 'orch.py')
  if (!existsSync(driver))
    return {
      ok: false,
      error: `the orchestrator is not at ${dir} (no orch.py). It ships in this repo as orchestrator/; set AGENTHYDRA_ORCHESTRATOR_DIR if it lives elsewhere.`,
    }
  const command = [deps.python ?? pythonBinary(), 'orch.py', script, ...args]
  const spawn = deps.spawn ?? realSpawn

  // ⛔ ONLY AWAIT WHEN THERE IS SOMETHING TO RESOLVE. A caller that finds no live run must reach
  // the spawn below in the SAME synchronous tick as before — tests rely on that to observe a
  // spawn's side effect (e.g. an increment) immediately after firing two calls back to back with
  // no await between them. Introducing an `await` here unconditionally would push that spawn a
  // microtask later even when `liveRun` says there is nothing to wait for.
  const lockKey = routeLockKey(script, args)
  let preempted: string | undefined
  const running = lockKey !== null ? liveRun(lockKey) : null
  if (running) {
    const conflict = await resolveLiveRunConflict(lockKey as string, args, deps, running)
    if (conflict.blocked) return conflict.outcome
    preempted = conflict.preempted
  }

  const started = Date.now()
  const entry: InFlightRun | null =
    lockKey !== null ? { started, deadline: started + timeoutMs + STALE_LOCK_GRACE_MS } : null
  if (lockKey !== null && entry) inFlight.set(lockKey, entry)
  try {
    const r = await spawn(command, dir, timeoutMs, {
      // Keep this run's kill switch on its own lock entry, so a later caller that finds the
      // entry orphaned can put down a child that outlived its deadline before starting afresh.
      // `entry` is null for an unlocked invocation (routeLockKey said so - see fan_out's
      // status/list) - there is no lock entry to attach the kill switch to, and none is needed.
      onProcess: (kill) => {
        if (entry) entry.kill = kill
        deps.onProcess?.(kill)
      },
    })
    return {
      ok: r.code === 0 && !r.timedOut,
      script,
      args,
      command,
      cwd: dir,
      ...(preempted ? { preempted } : {}),
      exitCode: r.code,
      exitMeaning: exitMeaning(script, r.code),
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdout: tail(r.stdout, r.stdoutDropped ?? 0),
      stderr: tail(r.stderr, r.stderrDropped ?? 0),
    }
  } catch (e) {
    return {
      ok: false,
      error: `could not start ${command[0]}: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    // ⛔ ONLY IF THE MAP STILL HOLDS *THIS* RUN. Once a lock can be reaped as stale, a later run
    // may already own the key by the time an abandoned promise finally settles, and an
    // unconditional delete would release ITS lock - handing a second caller a concurrent acting
    // pass, which is the one thing this map exists to prevent. Identity check, not a name check.
    if (lockKey !== null && entry && inFlight.get(lockKey) === entry) inFlight.delete(lockKey)
  }
}

/** `python --version` (or the equivalent probe spawn), reduced to a version string plus, on
 *  failure, the message that belongs in OrchestratorStatus.error. Split out of
 *  orchestratorStatus so its try/catch and its menu-probe sibling below don't nest. */
async function probePythonVersion(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  cwd: string,
): Promise<{ version: string | null; error: string | null }> {
  try {
    const v = await spawn([python, '--version'], cwd, 15_000)
    if (v.code !== 0)
      return {
        version: null,
        error: `${python} --version exited ${v.code}: ${`${v.stderr}${v.stdout}`.trim()}`,
      }
    return { version: `${v.stdout}${v.stderr}`.trim() || null, error: null }
  } catch (e) {
    return {
      version: null,
      error: `${python} is not runnable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/** `python orch.py` with no arguments, i.e. the driver's own menu, reduced the same way. */
async function probeMenu(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  dir: string,
): Promise<{ menu: string | null; error: string | null }> {
  try {
    const m = await spawn([python, 'orch.py'], dir, 60_000)
    if (m.code !== 0)
      return { menu: null, error: `orch.py menu exited ${m.code}: ${m.stderr.trim()}` }
    return { menu: m.stdout.trim(), error: null }
  } catch (e) {
    return { menu: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** `python orch.py --catalog`, i.e. lib/actionlib.CATALOG as JSON (audit AH-25). Until this
 *  existed the only machine-readable view of the action list was the printed menu's prose, so
 *  every consumer - mcp.ts's orchestrator_menu among them - was a text parser over a layout
 *  nobody had promised to keep.
 *
 *  Its failure is deliberately NOT folded into OrchestratorStatus.error. The prose menu is the
 *  older surface and still the one a person reads; a driver too old to know `--catalog`, or a
 *  catalog that will not parse, is a missing convenience rather than an unhealthy toolbox, and
 *  reporting it as `error` would make a perfectly working install read as broken.
 *
 *  It is also NOT a dispatch allowlist, and must never become one. orch.py resolves a script name
 *  against the FILES under scripts/ on purpose (see `_scripts_on_disk` there), so a brand-new
 *  script is runnable the moment it lands, before anyone has written its catalog row -
 *  tests/test_actionlib.py is what catches a missing row, not a refusal to run. Gating runs on
 *  this list would turn that documented grace period into an outage. */
async function probeCatalog(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  dir: string,
): Promise<{ actions: Record<string, OrchestratorAction> | null; error: string | null }> {
  try {
    const c = await spawn([python, 'orch.py', '--catalog'], dir, 60_000)
    if (c.code !== 0)
      return {
        actions: null,
        error: `orch.py --catalog exited ${c.code}: ${`${c.stderr}${c.stdout}`.trim()}`,
      }
    let parsed: unknown
    try {
      parsed = JSON.parse(c.stdout)
    } catch (e) {
      return {
        actions: null,
        error: `orch.py --catalog did not print JSON: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    // An array or a bare string parses fine and would then read as a catalog with no rows, which
    // is the one answer this field must never give by accident.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { actions: null, error: 'orch.py --catalog printed JSON that is not an object' }
    return { actions: parsed as Record<string, OrchestratorAction>, error: null }
  } catch (e) {
    return { actions: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Is the toolbox there and does python answer - and if so, the menu and the action catalog.
 *  Read-only. */
export async function orchestratorStatus(
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorStatus> {
  const dir = deps.dir ?? orchestratorDir()
  const python = deps.python ?? pythonBinary()
  const present = existsSync(join(dir, 'orch.py'))
  const spawn = deps.spawn ?? realSpawn
  let error: string | null = present ? null : `no orch.py under ${dir}`
  const { version: pythonVersion, error: versionError } = await probePythonVersion(
    spawn,
    python,
    present ? dir : APP_ROOT,
  )
  error = error ?? versionError
  let menu: string | null = null
  let actions: Record<string, OrchestratorAction> | null = null
  // Never left as a bare null: a status read that could not look must say so, or "not read" and
  // "read, and there is nothing" become the same answer.
  let actionsError: string | null = error ?? 'the toolbox was not read'
  if (present && pythonVersion) {
    // Two spawns of the same driver with nothing between them, so a status read costs one round
    // trip rather than two sequential 60s ceilings.
    const [m, c] = await Promise.all([
      probeMenu(spawn, python, dir),
      probeCatalog(spawn, python, dir),
    ])
    menu = m.menu
    error = error ?? m.error
    actions = c.actions
    actionsError = c.error
  }
  return { dir, present, python, pythonVersion, menu, actions, actionsError, error }
}
