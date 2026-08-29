import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import rootPkg from '../../package.json'

const HOME = homedir()
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local')

/**
 * Read an app env var by its unprefixed suffix, honouring the pre-rename `CCMANAGERUI_*` spelling.
 *
 * The app shipped as "CC Manager UI" through v0.13.x, so an upgrading install can still carry the
 * old names in a shell profile, a scheduled task, a tray shortcut or a portable launcher we do not
 * control. The new name wins when both are set; the legacy name keeps working indefinitely rather
 * than silently reverting someone's port pin or data-dir override to a default.
 */
export function appEnv(suffix: string): string | undefined {
  return process.env[`AGENTHYDRA_${suffix}`] ?? process.env[`CCMANAGERUI_${suffix}`]
}

/** `*_NO_OPEN=1` — suppress the browser/app window a double-clicked release normally opens.
 *  Read at call time, not module load, because the smoke test sets it per spawn. */
export function noAutoOpen(): boolean {
  return appEnv('NO_OPEN') === '1'
}

/**
 * Resolve the per-user config dir, moving a pre-rename `~/.ccmanagerui` across on first run.
 *
 * Deliberately non-destructive: the move only happens when the new dir does NOT exist yet, and any
 * failure (a pre-rename daemon still holding runtime.json open, a cross-device home, a permission
 * problem) falls back to using the legacy dir where it stands. Losing this directory would lose the
 * run queue, settings, instance labels and the accounts cache, so "keep working from the old path"
 * always beats "start clean at the new one".
 *
 * `home` is a parameter purely so the test can drive it against a scratch dir; production always
 * takes the default.
 */
export function resolveConfigDir(home: string = HOME): string {
  const override = appEnv('HOME')?.trim()
  if (override) return override
  const preferred = join(home, '.agenthydra')
  const legacy = join(home, '.ccmanagerui')
  if (existsSync(preferred)) return preferred
  if (!existsSync(legacy)) return preferred
  try {
    renameSync(legacy, preferred)
    return preferred
  } catch {
    return legacy
  }
}

/**
 * The sqlite file, renamed `ccmanagerui.db` -> `agenthydra.db` in place.
 *
 * Runs after {@link resolveConfigDir}, so for a compiled install the whole directory has usually
 * moved already and only the leaf name is stale. A live daemon holding the file makes renameSync
 * throw on Windows, which is exactly when we want to keep using the legacy name instead of opening
 * a second, empty database beside it. The `-wal`/`-shm` sidecars only exist when sqlite did NOT
 * close cleanly; they are moved best-effort after the main file so the set stays consistent.
 */
export function resolveDbPath(dataDir: string): string {
  const preferred = join(dataDir, 'agenthydra.db')
  const legacy = join(dataDir, 'ccmanagerui.db')
  if (existsSync(preferred) || !existsSync(legacy)) return preferred
  try {
    renameSync(legacy, preferred)
  } catch {
    return legacy
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, preferred + suffix)
    } catch {
      // Sidecar left behind; sqlite rebuilds it from the main file on next open.
    }
  }
  return preferred
}

/** App version — the root package.json's, bundled at build time (the JSON import is embedded into
 *  a compiled binary, so `--version` answers without any file on disk). */
export const VERSION: string = rootPkg.version

/**
 * True when running inside a `bun build --compile` binary. In that mode `import.meta.dir` is a
 * VIRTUAL embedded-filesystem path (`$bunfs` on POSIX, `B:\~BUN` on Windows) — not a real, writable
 * disk location — so "does my own source file exist on real disk?" is the mode probe. Deliberately
 * NOT a match on Bun's placeholder path string: the string is Bun-internal, the disk probe is not.
 */
export const IS_COMPILED = !existsSync(join(import.meta.dir, 'config.ts'))

// Backstop for the test suite: bun test sets NODE_ENV=test, but only reads the bunfig.toml of its
// CWD, so a run started anywhere without a preload-carrying bunfig (server/tests, a future
// workspace, an IDE runner with the wrong cwd) arrives here with none of the isolation overrides
// set — and every constant below would resolve to the developer's LIVE state: the same sqlite file
// their running daemon has open. That happened on 2026-08-25 (fixture rate_limited rows the live
// monitor kept resuming; a settings round-trip reset a live daemon's switches to their defaults).
// Rather than trust every entry point to remember the preload, refuse to
// touch real state under test at all: point the whole state surface at a throwaway temp dir. Set
// via process.env (not local variables) so child processes tests spawn inherit the same scratch.
// tests/setup.ts remains the primary isolation (it also fixes PATH for child-process fixtures);
// when it ran first, these are already set and this block is inert.
if (
  !IS_COMPILED &&
  process.env.NODE_ENV === 'test' &&
  !appEnv('HOME')?.trim() &&
  appEnv('DB') === undefined &&
  !appEnv('DATA_DIR')?.trim()
) {
  const scratch = mkdtempSync(join(tmpdir(), 'agenthydra-test-'))
  process.env.AGENTHYDRA_HOME = scratch
  process.env.AGENTHYDRA_DB = join(scratch, 'agenthydra-test.db')
  process.env.AGENTHYDRA_DATA_DIR = join(scratch, 'data')
  process.env.AGENTHYDRA_RUN_LOG_DIR = join(scratch, 'run-logs')
  console.error(
    `[agenthydra] NODE_ENV=test with no AGENTHYDRA_HOME/DB/DATA_DIR override — using throwaway state at ${scratch}`,
  )
}

/** Canonical Claude Code CLI transcript store: <home>/.claude/projects/<encoded-cwd>/<session-id>.jsonl */
export const CLAUDE_PROJECTS_ROOT = join(HOME, '.claude', 'projects')

/** Codex stores active rollouts in date folders and archived rollouts in a flat sibling folder. */
export const CODEX_HOME = appEnv('CODEX_HOME')?.trim() || join(HOME, '.codex')
export const CODEX_SESSIONS_ROOT = join(CODEX_HOME, 'sessions')
export const CODEX_ARCHIVED_SESSIONS_ROOT = join(CODEX_HOME, 'archived_sessions')
export const CODEX_SESSION_INDEX_PATH = join(CODEX_HOME, 'session_index.jsonl')

/** OpenCode CLI and Desktop share this SQLite session store. */
export const OPENCODE_DB_PATH =
  appEnv('OPENCODE_DB')?.trim() ||
  join(
    process.env.XDG_DATA_HOME?.trim() || join(HOME, '.local', 'share'),
    'opencode',
    'opencode.db',
  )

/** Per-user config dir; the running-instance pointer (runtime.json) lives here. */
export const CONFIG_DIR = resolveConfigDir()

/** App root: the repo checkout (source mode — parent of server/ and web/) or the directory the
 *  compiled binary sits in (release layout: exe + web/dist side by side). The self-updater and
 *  web-dist resolution key off this. */
export const APP_ROOT = IS_COMPILED ? dirname(process.execPath) : join(import.meta.dir, '..', '..')

export interface DataDirResolution {
  /** The directory state is read from and written to. */
  dir: string
  /** Why this is not the clean canonical resolution, in one line, or null when it is. */
  notice: string | null
}

/**
 * Resolve where our own state lives (sqlite db, per-run logs, caches), folding a source checkout's
 * historical `server/data` into the per-user directory a release has always used.
 *
 * A compiled binary never had a choice here: `import.meta.dir` is a virtual embedded path rather
 * than a writable disk location (db.ts's eager mkdir there would crash the daemon before logging
 * even starts), so releases keep state under CONFIG_DIR. Source checkouts kept theirs beside the
 * code instead, and the two arrangements together are one app reading two DIFFERENT databases:
 * `bun run start` and the installed tray daemon diverged on settings, the run queue and the
 * done-mark ledger. That ledger is the guarantee that one thread gets one continuation, and a
 * guarantee kept in two places is not one. Worse, the split
 * is invisible while you debug it: forensics run against the wrong file answer confidently and
 * wrongly ("that table does not exist", "the mark was never written"). One directory, both modes.
 *
 * The move is non-destructive in the same way {@link resolveConfigDir} is: it happens only when the
 * destination holds no state of its own, and any failure (a live daemon holding the sqlite file
 * open on Windows, a permission problem) keeps using the state where it stands rather than booting
 * onto an empty database.
 *
 * A cross-volume home is the normal Windows development layout, not an edge case - a checkout on
 * `D:` and a profile on `C:` is this machine - and `renameSync` cannot cross a volume: it throws
 * EXDEV. Left at that, the consolidation would silently never happen for exactly the people who hit
 * the split, so the fallback is a recursive COPY and then a delete of the source. Ordered that way
 * round on purpose: an interrupted copy loses nothing, and a copy that lands but cannot delete
 * leaves a leftover which the next boot reports as the ordinary two-directory case rather than
 * acting on.
 *
 * An EMPTY destination is not state, it is a directory something happened to create (a boot that
 * got no further, a backup tool, an unpacked archive), so the move still runs. `rmdirSync` refuses
 * a directory with anything in it, which is what makes that safe: it cannot take contents with it.
 *
 * When both hold real contents, neither is safe to assume. Preferring the destination costs a
 * source developer the work they did today; preferring the source overwrites a real install's
 * history with a scratch dev database; picking by mtime gets both wrong the moment someone runs the
 * other one once. So nothing is moved, nothing is merged, the canonical directory is used, and the
 * other one is REPORTED - in the boot log and in `/api/health` - because a split nobody is told
 * about is exactly the failure this resolver exists to end.
 */
export function resolveDataDir(
  configDir: string,
  legacyDir: string | null,
  /** Seam for the test, and only for the test: production always passes renameSync. A cross-volume
   *  move is the branch that matters most here and no test can conjure a second volume, so the
   *  THROW is injected while the copy and the delete underneath it stay real. */
  rename: (from: string, to: string) => void = renameSync,
): DataDirResolution {
  const preferred = join(configDir, 'data')
  if (!legacyDir || legacyDir === preferred || !existsSync(legacyDir))
    return { dir: preferred, notice: null }
  const preferredExists = existsSync(preferred)
  if (preferredExists && readdirSync(preferred).length > 0)
    return {
      dir: preferred,
      notice: `state also exists at ${legacyDir}; using ${preferred} and leaving the other untouched`,
    }
  try {
    if (preferredExists) rmdirSync(preferred)
    mkdirSync(dirname(preferred), { recursive: true })
    try {
      rename(legacyDir, preferred)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
      cpSync(legacyDir, preferred, { recursive: true })
      // Only now: the copy is complete, so nothing is at risk. A delete that fails leaves a
      // leftover the next boot reports, which is the honest outcome, not a lost database.
      rmSync(legacyDir, { recursive: true, force: true })
    }
    return { dir: preferred, notice: null }
  } catch {
    return {
      dir: legacyDir,
      notice: `could not move ${legacyDir} to ${preferred}; still using it in place`,
    }
  }
}

const DATA_DIR_OVERRIDE = appEnv('DATA_DIR')?.trim()
const DATA_DIR_RESOLUTION: DataDirResolution = DATA_DIR_OVERRIDE
  ? { dir: DATA_DIR_OVERRIDE, notice: null }
  : resolveDataDir(CONFIG_DIR, IS_COMPILED ? null : join(import.meta.dir, '..', 'data'))

/** Where our own state lives (sqlite db + per-run logs + caches): the per-user CONFIG_DIR, in both
 *  source and compiled mode. Overridable for the same reason RUN_LOG_DIR is, so a test touching
 *  usage-cache.json or usage-history.json never writes into live state (see tests/setup.ts). */
export const DATA_DIR = DATA_DIR_RESOLUTION.dir
/** One line naming a state directory that exists but is NOT the one in use, or null when there is
 *  no ambiguity. Surfaced at boot and by `/api/health` so nobody debugs against the wrong file. */
export const DATA_DIR_NOTICE = DATA_DIR_RESOLUTION.notice
export const DB_PATH = appEnv('DB') ?? resolveDbPath(DATA_DIR)
/** Per-run logs (+ the detached runner's spec/status sidecars). Overridable so tests (and a
 *  portable install) can isolate them from the default data dir. */
export const RUN_LOG_DIR = appEnv('RUN_LOG_DIR')?.trim() || join(DATA_DIR, 'run-logs')

/**
 * Staging area for "copy the session file to the clipboard".
 *
 * The clipboard holds a PATH, not bytes, so the file it points at has to keep existing for as long
 * as the user might paste — which rules out an OS temp file we delete on the way out. It also has
 * to carry the session's TITLE as its filename (the real transcript on disk is named by uuid, and
 * pasting `4f3c…9a.jsonl` into a folder is exactly the thing the title-named download fixed), which
 * rules out clipboarding the original in place. So: stage a titled copy here and keep it.
 * The directory holds at most one file — each copy wipes it first, which is honest, because the
 * clipboard itself only ever holds one thing.
 */
export const CLIPBOARD_DIR = join(DATA_DIR, 'clipboard')

/**
 * `--port <n>` on the command line, or null when absent/malformed.
 *
 * It beats the environment (below) for one reason: the auto-update relaunch is handed to WMI
 * Win32_Process.Create on win32, which does NOT inherit our environment block, so the port the
 * predecessor is actually serving on can only reach the successor as an argument. Handing over the
 * PREFERRED port instead would make the successor wait out its full 8s on a socket nobody is
 * releasing and then bind a port the user's open tab is not on.
 */
function argvPort(argv: readonly string[] = process.argv): number | null {
  const at = argv.indexOf('--port')
  const raw = at === -1 ? undefined : argv[at + 1]
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

export const PORT = argvPort() ?? Number(process.env.PORT ?? 7787)

/** Preferred port for the disposable instance-only daemon. It intentionally differs from the
 * full manager's port so opening the full app later never has to evict or upgrade quick mode.
 * Like the full daemon, quick mode hops upward if the preferred port is occupied. */
export const INSTANCE_MODE_PORT = Number(appEnv('INSTANCE_PORT') ?? PORT + 1)

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The REST API is intentionally unauthenticated for local tools, so binding it to a LAN interface
 * would turn every process-launch/file-management route into a remote-control surface. Fail closed
 * on a stray deployment-style HOST=0.0.0.0 instead of silently exposing it.
 */
export function validateBindHost(value: string | undefined): string {
  const host = value?.trim() || '127.0.0.1'
  if (LOOPBACK_BIND_HOSTS.has(host.toLowerCase())) return host
  throw new Error(
    `HOST must be loopback-only (127.0.0.1, localhost, or ::1); received ${JSON.stringify(host)}`,
  )
}

export const HOST = validateBindHost(process.env.HOST)

/** Service identity — used in /api/health and the runtime.json pointer (single-instance). */
export const SERVICE_NAME = 'agenthydra'

/** Built Vue SPA: web/dist under APP_ROOT in BOTH modes (repo checkout, or beside the binary in
 *  the release zip). Kept as a candidate list so a future layout can add entries, not re-plumb. */
export const WEB_DIST_CANDIDATES = [join(APP_ROOT, 'web', 'dist')]

/**
 * First-run outer size of the portable app window (what Chromium's `--window-size` takes).
 * Only applies to a window the dedicated profile has NEVER seen — the kit's
 * openPortableWindow probes the profile's saved placement first, so a size the user picked
 * themselves (or a maximize) wins on every later launch. Without it a never-seen window
 * opens at Chromium's default of ~the whole work area (~1905x2092 on a 4K display).
 *
 * Measured against the real UI, not guessed. Width: the fixed-viewport shell caps at
 * SHELL_BASE_MAX = 1000px (web/src/composables/useShellWidth.ts) and the page never
 * scrolls, but the binding constraint is the sessions sidebar, which rail-collapses below a
 * `(min-width: 1024px)` viewport (web/src/components/SessionsView.vue) — 1024 + ~16px frame
 * = 1040 outer is the floor below which a first-run window opens onto the collapsed rail;
 * 1060 clears it with slack for frame variance. Height is a density pick: a 758px viewport
 * fits the ~48px header, the sidebar's search toolbar and ~10 session rows, with matching
 * reading room in the transcript pane — 800 outer (outer = viewport + ~34 title + ~8 frame;
 * Chromium draws its title bar inside the client area). The tray's cold start carries the
 * same numbers (misc/AgentHydra-Tray.ps1 PortableWindowSize) — keep them in step.
 */
export const PORTABLE_WINDOW_SIZE = { width: 1060, height: 800 }

/** Compact first-run size for `/instances`. The pathname gives Chromium independent remembered
 * geometry from the full manager window, so resizing either surface never disturbs the other. */
export const INSTANCE_MODE_WINDOW_SIZE = { width: 700, height: 760 }

/**
 * Resolve the `claude` executable, mirroring the Python `claude_command()`:
 * prefer the npm-global install, else fall back to PATH resolution ("claude").
 */
export function resolveClaudeExe(): string {
  const candidates = [
    join(APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(APPDATA, 'npm', 'claude.cmd'),
    join(APPDATA, 'npm', 'claude'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'claude'
}

/**
 * Resolve the Codex CLI. The Microsoft Store/Desktop install keeps version-addressed helper
 * binaries below LocalAppData, while npm/homebrew installs normally put `codex` on PATH.
 */
export function resolveCodexExe(): string {
  const configured = appEnv('CODEX_PATH')?.trim()
  if (configured) return configured

  const desktopBin = join(LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  if (existsSync(desktopBin)) {
    const glob = new Bun.Glob('*/codex.exe')
    const matches = [...glob.scanSync({ cwd: desktopBin, onlyFiles: true })]
    if (matches.length > 0) return join(desktopBin, matches.sort().at(-1)!)
  }

  const npmCandidates = [join(APPDATA, 'npm', 'codex.cmd'), join(APPDATA, 'npm', 'codex')]
  for (const candidate of npmCandidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'codex'
}
