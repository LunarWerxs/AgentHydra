// server/src/core/dsh-instances.ts — DeepSeek Harness homes as managed instances.
//
// WHAT AN INSTANCE IS HERE. The harness keeps everything under ONE root — `$DSH_HOME`, else
// `~/.dsh` — and that root holds its credentials, its settings, its plugin profiles and every
// session. So "a second DeepSeek account" means a second home, exactly the way a second Codex
// account means a second `CODEX_HOME` (core/codex-instances.ts) and a second Claude CLI login means
// a second `CLAUDE_CONFIG_DIR` (core/cli-instances.ts). This module models that: a home, whether a
// server is serving it, and the lifecycle verbs around it.
//
// THE DEFAULT HOME IS A ROW, NOT A SPECIAL CASE. Whatever `$DSH_HOME`/`~/.dsh` resolves to is
// listed alongside the ones created here, because it is the one people actually have — hiding it
// until someone "registers" it would make the table lie about the machine.
//
// ⛔ THE SERVER'S URL CARRIES A ONE-TIME TOKEN, AND IT NEVER LEAVES THIS PROCESS. `dsh web` prints
// `http://127.0.0.1:<port>/?token=…` once, at boot, and anyone holding that string has the session.
// So: the daemon reads it out of the harness's own log file, opens the window ITSELF, and returns
// `{ ok: true }`. It is never put in an API response, never handed to the SPA, never logged by us.
// That is also why "open" is a server action rather than a link the browser could follow.
//
// ⛔ NO LOGIN VERB, AND NO READING OF `.credentials.yaml`. Signing in is the user's own step, and
// the credential file is theirs; nothing here opens it. An instance's identity, when we show one, is
// the home it lives in — never a key read out of it.
//
// Never throws for expected failures (bad name, collision, no install, port in use) — every
// mutating function returns a status-carrying CMActionResult, same contract as core/lifecycle.ts.

import { spawn } from 'node:child_process'
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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, DSH_HOME } from '../config'
import { findFreePort } from '../find-free-port.mjs'
import { openPortableWindow } from '../portable-window.mjs'
import { instanceNumberFor } from './instance-numbers'
import {
  describeStoreRefusal,
  type JsonStoreMutation,
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
} from './json-store'
import { isPathInside } from './paths'
import type { CMActionResult } from './shared'

/** Where homes created here live: `<CONFIG_DIR>/dsh-instances/<id>`. */
const DSH_INSTANCES_ROOT = join(CONFIG_DIR, 'dsh-instances')
/** The registry of homes we created. The default home is NOT in it — it is found, not recorded. */
const STORE_PATH = join(CONFIG_DIR, 'dsh-instances.json')
/** Where a launched server's own stdout goes, one file per instance id. */
const LOG_DIR = join(CONFIG_DIR, 'dsh-logs')

const NAME_MAX = 60
/** First port tried for a new server. `dsh web` defaults to 3080; ours walk up from just above it
 *  so a harness the user started by hand keeps the port it already has. */
const PORT_BASE = 3090

// --- persistence ---------------------------------------------------------------------------------

interface StoredInstance {
  id: string
  name: string
  home: string
  createdAt: number
  /** The port the last launch from here used, so "open" can find a server it did not start. */
  lastPort?: number
}

interface Store {
  instances: StoredInstance[]
}

const STORE_WHAT = 'DeepSeek Harness instance registry'

const STORE_SPEC: JsonStoreSpec<Store> = {
  path: STORE_PATH,
  decode: (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null
    const instances = (parsed as { instances?: unknown }).instances
    if (!Array.isArray(instances)) return null
    return { instances: instances as StoredInstance[] }
  },
  empty: () => ({ instances: [] }),
}

/** The last unreadable-store condition already logged, so a broken file is reported once per
 *  distinct failure rather than on every poll. Cleared when the store reads cleanly. */
let reportedStoreFailure: string | null = null

function readStore(): Store {
  const read = readJsonStore(STORE_SPEC)
  if (read.status === 'ok') {
    reportedStoreFailure = null
    return read.value
  }
  if (read.status === 'missing') return STORE_SPEC.empty()
  const key = `${read.status}:${read.reason}`
  if (reportedStoreFailure !== key) {
    reportedStoreFailure = key
    console.error(
      `[dsh-instances] ${STORE_PATH} is ${read.status} (${read.reason}). Listing no created instances and refusing every change until it is repaired; the file has NOT been modified.`,
    )
  }
  return STORE_SPEC.empty()
}

/** MUTATORS: read-modify-write under the interprocess lock; see core/json-store.ts. */
function mutate<R>(fn: (store: Store) => { result: R; changed: boolean }): JsonStoreMutation<R> {
  return mutateJsonStore(STORE_SPEC, fn)
}

/** The status-carrying refusal every mutator returns when the registry cannot be safely changed. */
function refusal(
  action: string,
  dir: string | null,
  data: Record<string, unknown>,
  failure: { status: 'corrupt' | 'unreadable' | 'locked' | 'write-failed'; reason: string },
): CMActionResult {
  return {
    ok: false,
    action,
    dir,
    message: describeStoreRefusal(STORE_WHAT, STORE_PATH, failure),
    data: { ...data, registry: failure.status, reason: failure.reason },
  }
}

const fail = (
  action: string,
  message: string,
  dir: string | null = null,
  data: Record<string, unknown> = {},
): CMActionResult => ({ ok: false, action, dir, message, data })

// --- what a home looks like from outside ---------------------------------------------------------

/** One DeepSeek Harness home, as the API and the UI see it. */
export interface DshInstance {
  /** Permanent short handle (`#7`), from the one sequence desktop/CLI/Codex instances share. */
  num: number
  id: string
  name: string
  /** The `DSH_HOME` this instance IS. */
  home: string
  /** True for the home the harness would use with no env override — the one already on the machine. */
  isDefault: boolean
  /** Conversations under it. Cheap: one directory walk two levels deep, no logs decompressed. */
  sessions: number
  /** The port a server for this home is answering on, or null when nothing is serving it. */
  port: number | null
  running: boolean
  createdAt: number
}

/** Sessions under a home, counted without reading a single log: `sessions/<project>/<session>/`. */
function countSessions(home: string): number {
  const root = join(home, 'sessions')
  let total = 0
  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return 0
  }
  for (const project of projects) {
    try {
      total += readdirSync(join(root, project), { withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      ).length
    } catch {
      // a project directory that vanished mid-walk contributes nothing
    }
  }
  return total
}

/**
 * The port a home's own launcher recorded, when it has one.
 *
 * `launcher.json` is written by the desktop wrapper around `dsh web` (the owner's, and now ours),
 * and it is the only durable link between a home and the port serving it. Reading it is what lets
 * AgentHydra see a server somebody else started rather than claiming the home is idle.
 */
function launcherPort(home: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'launcher.json'), 'utf8')) as {
      port?: unknown
    }
    return typeof parsed.port === 'number' && Number.isFinite(parsed.port) ? parsed.port : null
  } catch {
    return null
  }
}

/**
 * Is something listening on this port?
 *
 * Deliberately a CONNECT probe and not an HTTP request: `dsh web` answers `/` with a redirect to
 * its token URL and would reject an unauthenticated fetch, so "did it reply the way I expected" is
 * a worse question than "is the port open". Synchronous-looking but bounded: the caller awaits one
 * short connection attempt per home, and a home with no port never probes at all.
 */
async function portIsServing(port: number): Promise<boolean> {
  const { connect } = await import('node:net')
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function hydrate(rec: StoredInstance | null, home: string, isDefault: boolean): DshInstance {
  const id = rec?.id ?? 'default'
  return {
    num: instanceNumberFor('dsh', id),
    id,
    name: rec?.name ?? 'DeepSeek Harness',
    home,
    isDefault,
    sessions: countSessions(home),
    port: rec?.lastPort ?? launcherPort(home),
    running: false, // filled in by listDshInstances, which is the only async reader
    createdAt: rec?.createdAt ?? 0,
  }
}

/**
 * Every DeepSeek Harness home on this machine: the default one first, then the ones created here.
 *
 * The default row appears only when that home EXISTS — an empty list is the honest answer on a
 * machine without the harness, and inventing a row for `~/.dsh` would put a tool in the table that
 * nobody has installed.
 */
export async function listDshInstances(): Promise<DshInstance[]> {
  const rows: DshInstance[] = []
  if (existsSync(DSH_HOME)) rows.push(hydrate(null, DSH_HOME, true))
  for (const rec of readStore().instances) {
    // A registered home whose directory was deleted from under us still lists: it is a record the
    // user made, and silently dropping it would leave a "where did my instance go" with no answer.
    rows.push(hydrate(rec, rec.home, false))
  }
  await Promise.all(
    rows.map(async (row) => {
      if (row.port === null) return
      row.running = await portIsServing(row.port)
    }),
  )
  return rows
}

/**
 * Every home a session reader should look under.
 *
 * This is the DSH twin of codexInstanceStores(), and it exists for the same reason config.ts gives
 * for not exporting Codex session roots: the set of homes is not "the default one" — it is the
 * default one PLUS every instance created here, and a reader that joins paths onto the default
 * would make every session in every other home invisible to listing, search and analytics.
 *
 * Synchronous on purpose: the transcript index is built inside a sweep that already yields, and a
 * home's existence is one `existsSync`.
 */
export function dshInstanceStores(): string[] {
  const homes = existsSync(DSH_HOME) ? [DSH_HOME] : []
  for (const rec of readStore().instances) {
    if (rec.home && rec.home !== DSH_HOME && existsSync(rec.home)) homes.push(rec.home)
  }
  return homes
}

// --- lifecycle -----------------------------------------------------------------------------------

function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'name is required'
  if (trimmed.length > NAME_MAX) return `name is longer than ${NAME_MAX} characters`
  return null
}

/**
 * A new home, empty, for a second DeepSeek account or a separate configuration.
 *
 * The directory is created but NOT initialized: `dsh` writes its own settings, credentials and
 * session store on first run, and a half-made home written by us would be a second source of truth
 * for a layout the harness owns. So this makes the folder and gets out of the way.
 */
export function createDshInstance(name: string): CMActionResult {
  const problem = nameError(name)
  if (problem) return fail('dsh-create', problem, null, { name })
  const trimmed = name.trim()
  const id = crypto.randomUUID()
  const home = join(DSH_INSTANCES_ROOT, id)
  const taken = readStore().instances.some((i) => i.name.toLowerCase() === trimmed.toLowerCase())
  if (taken)
    return fail('dsh-create', `An instance called '${trimmed}' already exists.`, null, { name })
  try {
    mkdirSync(home, { recursive: true })
  } catch (err) {
    return fail(
      'dsh-create',
      `Failed to create home '${home}': ${err instanceof Error ? err.message : String(err)}`,
      home,
      { name },
    )
  }
  const num = instanceNumberFor('dsh', id)
  const outcome = mutate((store) => {
    store.instances.push({ id, name: trimmed, home, createdAt: Date.now() })
    return { result: null, changed: true }
  })
  if (!outcome.ok) {
    // The record never landed, so the directory minted for it is already an orphan: take it back
    // rather than leave an unexplained folder beside a registry the owner now has to repair.
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // best effort
    }
    return refusal('dsh-create', home, { name }, outcome)
  }
  return {
    ok: true,
    action: 'dsh-create',
    dir: home,
    message: `DeepSeek Harness instance #${num} '${trimmed}' created. Launch it to sign in.`,
    data: { id, home, num },
  }
}

export function renameDshInstance(id: string, name: string): CMActionResult {
  const problem = nameError(name)
  if (problem) return fail('dsh-rename', problem, null, { id })
  const trimmed = name.trim()
  const outcome = mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec) return { result: { ok: false, why: `Unknown instance '${id}'.` }, changed: false }
    if (store.instances.some((i) => i.id !== id && i.name.toLowerCase() === trimmed.toLowerCase()))
      return {
        result: { ok: false, why: `An instance called '${trimmed}' already exists.` },
        changed: false,
      }
    rec.name = trimmed
    return { result: { ok: true, why: '' }, changed: true }
  })
  if (!outcome.ok) return refusal('dsh-rename', null, { id }, outcome)
  if (!outcome.result.ok) return fail('dsh-rename', outcome.result.why, null, { id })
  return {
    ok: true,
    action: 'dsh-rename',
    dir: null,
    message: `Renamed to '${trimmed}'.`,
    data: { id, name: trimmed },
  }
}

export interface DeleteDshInstanceOptions {
  /** Also delete the home directory and everything in it — sessions included. Off by default. */
  deleteFiles?: boolean
  /** The instance's own name, typed back, when `deleteFiles` is set. */
  confirmName?: string
}

/**
 * Forget an instance, and optionally delete its home.
 *
 * ⛔ THE DEFAULT HOME IS NOT DELETABLE FROM HERE, at all. It is the machine's own harness install,
 * it is not something this app created, and `deleteFiles` against it would destroy a session store
 * AgentHydra is only ever a reader of. The refusal is unconditional — no confirm string unlocks it.
 *
 * Deleting files requires the name typed back AND the path to be inside our own instances root, so
 * a hand-edited registry pointing `home` at something else cannot be turned into a delete of it.
 */
export function deleteDshInstance(id: string, opts: DeleteDshInstanceOptions = {}): CMActionResult {
  if (id === 'default')
    return fail(
      'dsh-delete',
      "The default DeepSeek Harness home is the machine's own install, not something AgentHydra created. Remove it yourself if you mean to.",
      DSH_HOME,
      { id },
    )
  const rec = readStore().instances.find((i) => i.id === id)
  if (!rec) return fail('dsh-delete', `Unknown instance '${id}'.`, null, { id })
  if (opts.deleteFiles) {
    if (opts.confirmName !== rec.name)
      return fail('dsh-delete', 'Type the instance name to confirm deleting its files.', rec.home, {
        id,
      })
    // The registry is a plain JSON file a person can edit. A `home` pointing somewhere else must
    // therefore never become a recursive delete of somewhere else.
    if (!isPathInside(DSH_INSTANCES_ROOT, rec.home))
      return fail(
        'dsh-delete',
        `'${rec.home}' is outside the directory AgentHydra manages, so its files were left alone. Remove the instance without --delete-files, or delete the folder yourself.`,
        rec.home,
        { id },
      )
    try {
      rmSync(rec.home, { recursive: true, force: true })
    } catch (err) {
      return fail(
        'dsh-delete',
        `Failed to delete '${rec.home}': ${err instanceof Error ? err.message : String(err)}`,
        rec.home,
        { id },
      )
    }
  }
  const outcome = mutate((store) => {
    const idx = store.instances.findIndex((i) => i.id === id)
    if (idx === -1) return { result: false, changed: false }
    store.instances.splice(idx, 1)
    return { result: true, changed: true }
  })
  if (!outcome.ok) return refusal('dsh-delete', rec.home, { id }, outcome)
  return {
    ok: true,
    action: 'dsh-delete',
    dir: rec.home,
    message: opts.deleteFiles
      ? `Deleted '${rec.name}' and its home.`
      : `Removed '${rec.name}' from the list. Its home is still on disk at ${rec.home}.`,
    data: { id, deletedFiles: opts.deleteFiles === true },
  }
}

// --- launching -----------------------------------------------------------------------------------

/**
 * The harness's entry script, or null when it is not installed.
 *
 * `node <entry>`, never the `dsh` shim: npm installs `dsh.cmd` on Windows and Node ≥ 20.12 refuses
 * to spawn a `.cmd` without a shell, so the obvious spelling fails with EINVAL. The same trap the
 * harness's own plugin config documents for `codegraph`.
 */
export function resolveDshEntry(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.APPDATA
      ? join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : null,
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter((p): p is string => p !== null)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** Where one instance's launch log lives. One file per id, truncated on each launch: the only thing
 *  read back out of it is the boot URL, and keeping an old boot's URL would offer a dead window. */
function logPathFor(id: string): string {
  return join(LOG_DIR, `${id}.log`)
}

/**
 * The workspace a home's own desktop wrapper records, when it has one.
 *
 * `dsh` treats its working directory AS the agent's workspace, so this is not cosmetic: launching
 * in the wrong directory hands the agent a different project. The wrapper writes the choice to
 * `launcher.json`, and honouring it means a launch from AgentHydra lands where a launch from the
 * user's own shortcut would.
 */
function launcherWorkspace(home: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'launcher.json'), 'utf8')) as {
      workspace?: unknown
    }
    const workspace = typeof parsed.workspace === 'string' ? parsed.workspace.trim() : ''
    return workspace && existsSync(workspace) ? workspace : null
  } catch {
    return null
  }
}

/**
 * The pid listening on a local port, or null when it cannot be established.
 *
 * Platform-specific and deliberately read-only: `Get-NetTCPConnection` on Windows, `lsof` on POSIX.
 * Null on anything unexpected - an unparseable answer must read as "I do not know", never as a pid
 * that would then be killed. Nothing here ever kills by NAME: several `node` processes on this
 * machine are not the harness.
 */
async function pidOnPort(port: number): Promise<number | null> {
  const argv =
    process.platform === 'win32'
      ? [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`,
        ]
      : ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', windowsHide: true })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const first = text.trim().split(/\r?\n/)[0]?.trim()
    const pid = first ? Number(first) : Number.NaN
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** The URL a `dsh web` boot printed, out of its own log. Returns null until the line appears. */
function urlFromLog(logPath: string, port: number): string | null {
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  const match = new RegExp(
    String.raw`http://(?:127\.0\.0\.1|localhost):${port}/\?token=[A-Za-z0-9_-]+`,
  ).exec(text)
  return match?.[0] ?? null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start a server for one home, and open its window.
 *
 * HIDDEN, ALWAYS. `dsh web` is a console program: a visible console is not merely ugly, it is fatal
 * - an operator who closes that window kills the harness with no traceback. stdout goes to a log
 * file instead, which is also where the boot URL is recovered from.
 *
 * Already serving? Then this opens a window against the running server rather than starting a
 * second one, which is what a person means by pressing the button twice.
 */
export async function launchDshInstance(id: string): Promise<CMActionResult> {
  const rows = await listDshInstances()
  const row = rows.find((r) => r.id === id)
  if (!row) return fail('dsh-launch', `Unknown instance '${id}'.`, null, { id })

  if (row.running && row.port !== null) return openDshWindow(row, row.port)

  const entry = resolveDshEntry()
  if (!entry)
    return fail(
      'dsh-launch',
      'DeepSeek Harness is not installed on this machine. Install it with: npm install -g @deepseek-ai/dsh',
      row.home,
      { id },
    )
  if (!existsSync(row.home)) {
    try {
      mkdirSync(row.home, { recursive: true })
    } catch (err) {
      return fail(
        'dsh-launch',
        `Failed to create home '${row.home}': ${err instanceof Error ? err.message : String(err)}`,
        row.home,
        { id },
      )
    }
  }

  const port = await findFreePort(row.port ?? PORT_BASE)
  const logPath = logPathFor(id)
  let out: number
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(logPath, '')
    out = openSync(logPath, 'a')
  } catch (err) {
    return fail(
      'dsh-launch',
      `Failed to open the log at '${logPath}': ${err instanceof Error ? err.message : String(err)}`,
      row.home,
      { id },
    )
  }

  let pid: number | undefined
  try {
    // `node <entry>`, never the `dsh` shim: npm installs `dsh.cmd` on Windows and Node >= 20.12
    // refuses to spawn a .cmd without a shell (EINVAL) - the same trap the harness's own plugin
    // config documents for `codegraph`.
    const child = spawn(process.execPath, [entry, 'web', '--no-open', '--port', String(port)], {
      // The workspace the agent gets IS its cwd, and the harness's own wrapper records one per
      // home; falling back to the home itself keeps a fresh instance inside its own directory
      // rather than inheriting whatever directory the daemon happened to be started in.
      cwd: launcherWorkspace(row.home) ?? row.home,
      // The home is the ONE thing that makes this instance itself. Everything else is inherited.
      env: { ...process.env, DSH_HOME: row.home },
      stdio: ['ignore', out, out],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    child.unref()
    pid = child.pid
  } catch (err) {
    return fail(
      'dsh-launch',
      `Failed to start the harness: ${err instanceof Error ? err.message : String(err)}`,
      row.home,
      { id },
    )
  } finally {
    try {
      closeSync(out)
    } catch {
      // the child holds its own duplicate of the descriptor; ours is done either way
    }
  }

  // The harness prints its URL once, when the server is ready. Poll its LOG rather than the socket:
  // the port opens before the token is printed, so a port probe would race and open a window at a
  // URL that does not exist yet. 40 x 500 ms = 20 s, the order the harness's own wrapper waits.
  let url: string | null = null
  for (let i = 0; i < 40 && url === null; i++) {
    await sleep(500)
    url = urlFromLog(logPath, port)
  }
  rememberPort(id, port)
  if (!url)
    return fail(
      'dsh-launch',
      `The harness did not report its address within 20s. Its own log is at '${logPath}'.`,
      row.home,
      { id, port, pid },
    )

  const opened = await openPortableWindow(url, {
    // Its own Chromium profile, so the window remembers where the user put it - and the same
    // directory the harness's desktop wrapper already uses, so an existing window's placement
    // carries over instead of starting from nothing.
    profileDir: join(row.home, 'browser-profile'),
    initialSize: { width: 1440, height: 900 },
  })
  if (!opened.ok)
    return {
      ok: false,
      action: 'dsh-launch',
      dir: row.home,
      message:
        opened.reason === 'no-browser'
          ? `Serving on port ${port}, but no Chromium-family browser was found to open a window in.`
          : `Serving on port ${port}, but the window could not be opened.`,
      data: { id, port, pid, served: true },
    }
  return {
    ok: true,
    action: 'dsh-launch',
    dir: row.home,
    message: `DeepSeek Harness #${row.num} '${row.name}' is serving on port ${port}.`,
    data: { id, port, pid, browser: opened.browser },
  }
}

/**
 * Open a window against a server that is ALREADY running.
 *
 * Its URL is recovered from the home's own `.web-url` (what the harness's desktop wrapper writes)
 * or from our launch log, and never reconstructed: the token IS the authentication and it is
 * printed exactly once, so a server whose token nobody kept cannot be joined. Say that plainly
 * rather than opening a window onto a rejection.
 */
async function openDshWindow(row: DshInstance, port: number): Promise<CMActionResult> {
  let url: string | null = null
  try {
    const saved = readFileSync(join(row.home, '.web-url'), 'utf8').trim()
    if (saved.includes(`:${port}/`)) url = saved
  } catch {
    // no wrapper-written url; fall through to our own log
  }
  url ??= urlFromLog(logPathFor(row.id), port)
  if (!url)
    return fail(
      'dsh-open',
      `A server is already answering on port ${port}, but its one-time address was not kept by whatever started it. Stop that server and launch again.`,
      row.home,
      { id: row.id, port },
    )
  const opened = await openPortableWindow(url, {
    profileDir: join(row.home, 'browser-profile'),
    initialSize: { width: 1440, height: 900 },
  })
  return opened.ok
    ? {
        ok: true,
        action: 'dsh-open',
        dir: row.home,
        message: `Opened the window for port ${port}.`,
        data: { id: row.id, port, browser: opened.browser },
      }
    : fail(
        'dsh-open',
        opened.reason === 'no-browser'
          ? 'No Chromium-family browser was found to open a window in.'
          : 'The window could not be opened.',
        row.home,
        { id: row.id, port },
      )
}

/**
 * Stop the server for one home.
 *
 * The pid comes from the PORT, not from one we remembered: the daemon restarts, the user's own
 * wrapper starts servers we never saw, and a remembered pid is wrong in both of those cases while
 * the listener is right in all of them. A stop touches nothing else - the home, its sessions and
 * its credentials are untouched.
 */
export async function quitDshInstance(id: string): Promise<CMActionResult> {
  const rows = await listDshInstances()
  const row = rows.find((r) => r.id === id)
  if (!row) return fail('dsh-quit', `Unknown instance '${id}'.`, null, { id })
  if (!row.running || row.port === null)
    return fail('dsh-quit', 'Nothing is serving this home.', row.home, { id })
  const pid = await pidOnPort(row.port)
  if (pid === null)
    return fail(
      'dsh-quit',
      `Port ${row.port} is in use, but the process that owns it could not be identified.`,
      row.home,
      { id, port: row.port },
    )
  try {
    process.kill(pid)
  } catch (err) {
    return fail(
      'dsh-quit',
      `Failed to stop pid ${pid}: ${err instanceof Error ? err.message : String(err)}`,
      row.home,
      { id, port: row.port, pid },
    )
  }
  return {
    ok: true,
    action: 'dsh-quit',
    dir: row.home,
    message: `Stopped the server on port ${row.port}.`,
    data: { id, port: row.port, pid },
  }
}

/** Record the port a launch used, so a later "open" can find a server this process did not start. */
function rememberPort(id: string, port: number): void {
  if (id === 'default') return // not ours to record: the wrapper's own launcher.json already says
  mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec || rec.lastPort === port) return { result: false, changed: false }
    rec.lastPort = port
    return { result: true, changed: true }
  })
}
