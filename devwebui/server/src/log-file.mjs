/**
 * Persistent daemon log — tees console output to <configDir>/logs/daemon.log.
 *
 * SHARED LunarWerx server-lib (source of truth: lunarwerx-ui/src/server-lib/log-file.mjs; synced
 * into each app's server root by sync.mjs, alongside instance-pointer/find-free-port/etc.). The
 * config dir is passed IN by the caller — each app computes its own (REPOYETI_HOME / DEVWEBUI_HOME
 * / REDESIGN_HOME / AGENTHYDRA_HOME, else ~/.<app>) — so this file stays app-agnostic and depends
 * on nothing but node builtins. That matters: it must run as the very FIRST thing at startup,
 * before any config chain that could itself throw.
 *
 * Why this exists: the daemon is normally launched by the tray via `cmd.exe /c bun … ` with
 * CreateNoWindow, so its stdout/stderr go to a hidden console and are LOST. When the process dies
 * (a crash handler calls console.error then exit(1), or the runtime crashes on its own) there was
 * no record of WHY. This captures every console line to a file that survives the process,
 * regardless of how the daemon was launched (tray, terminal, or an auto-update successor).
 *
 * Writes are SYNCHRONOUS (fs.writeSync on an appended fd), deliberately: a buffered stream would
 * lose the final console.error when a crash handler calls process.exit(1) a tick later. The daemon
 * logs little (a boot banner + occasional errors), so sync writes cost nothing here. Everything is
 * best-effort — a logging failure must never take the daemon down (that would be the ironic
 * opposite of the point), so every fs call is guarded and a hard failure just disables file logging
 * and leaves the real console untouched.
 */
import { join } from "node:path";
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { inspect } from "node:util";

/** Roll the log over at this size, at start and while running; old generations are gzipped. */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
let MAX_BYTES = DEFAULT_MAX_BYTES;
/** Old generations kept: daemon.log.1.gz (newest) .. daemon.log.<KEEP>.gz. */
const KEEP = 3;

/**
 * Roll `path` into `<path>.1.gz`, shifting `.1.gz` to `.2.gz` and so on, dropping beyond `keep`. A
 * plain `<path>.1` from the older single-generation rotation is cleared too. Best effort; never throws.
 * @param {string} path
 * @param {number} [keep]
 */
export function rotateLog(path, keep = KEEP) {
  try {
    rmSync(`${path}.1`, { force: true });
    rmSync(`${path}.${keep}.gz`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}.gz`)) renameSync(`${path}.${i}.gz`, `${path}.${i + 1}.gz`);
    }
    writeFileSync(`${path}.1.gz`, gzipSync(readFileSync(path)));
    rmSync(path, { force: true });
  } catch {
    /* raced or unwritable: the caller opens whatever is there */
  }
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];
const LEVEL = { log: "INFO ", info: "INFO ", warn: "WARN ", error: "ERROR", debug: "DEBUG" };

let fd = null;
let patched = false;
const original = {};
let currentPath = null;
let written = 0;

/** Format one console line the way console.* would render it (Errors keep their stack). */
function formatArgs(args) {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" ");
}

function writeLine(level, text) {
  if (fd === null) return;
  try {
    const stamp = new Date().toISOString();
    const line = `[${stamp}] ${level} ${text}\n`;
    if (written > MAX_BYTES && currentPath) {
      // Roll while running, so a daemon that stays up for weeks cannot grow one file without bound.
      closeSync(fd);
      rotateLog(currentPath);
      fd = openSync(currentPath, "a");
      written = 0;
    }
    written += writeSync(fd, line);
  } catch {
    // Disk full / handle lost — stop trying so we don't spin on every log call. The real console
    // is untouched, so output still goes to stdout; only the file copy is dropped.
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* already gone */
    }
    fd = null;
  }
}

/**
 * Open (or reopen) <dir>/logs/daemon.log and tee every console.* call to it. Idempotent — calling
 * twice is a no-op after the first success. Returns the log-file path, or null if file logging
 * could not be set up (in which case the console behaves exactly as before).
 *
 * @param {string} dir  The app's config dir; the log lands in <dir>/logs/daemon.log.
 */
export function initFileLogging(dir, opts) {
  if (opts && opts.maxBytes > 0) MAX_BYTES = opts.maxBytes;
  if (patched && fd !== null) return currentPath;

  const logDir = join(dir, "logs");
  const path = join(logDir, "daemon.log");
  try {
    mkdirSync(logDir, { recursive: true });
    // Rotate before opening so a run's own crash still lands in the fresh file, and the rotated
    // copies hold the previous run(s).
    try {
      if (statSync(path).size > MAX_BYTES) rotateLog(path);
    } catch {
      /* no existing log yet, or stat raced — just open fresh */
    }
    fd = openSync(path, "a");
    currentPath = path;
    try {
      written = statSync(path).size;
    } catch {
      written = 0;
    }
  } catch {
    fd = null;
    currentPath = null;
    return null; // logging dir unwritable — leave the console as-is
  }

  if (!patched) {
    for (const m of CONSOLE_METHODS) {
      const orig = console[m].bind(console);
      original[m] = orig;
      console[m] = (...args) => {
        orig(...args); // real stdout/stderr, unchanged
        writeLine(LEVEL[m], formatArgs(args));
      };
    }
    patched = true;
  }

  // Boot marker so runs are visually separated across restarts sharing one file.
  writeLine("INFO ", `── daemon process ${process.pid} starting (${process.argv.slice(1).join(" ")}) ──`);
  return currentPath;
}

/** The current log-file path, or null if file logging isn't active. */
export function logFilePath() {
  return currentPath;
}

/** Undo the console patch, close the file and put back the default roll size (a test's lowered
 *  `maxBytes` must not outlive it). For tests; the daemon never calls this. */
export function restoreFileLogging() {
  MAX_BYTES = DEFAULT_MAX_BYTES;
  for (const m of CONSOLE_METHODS) {
    const orig = original[m];
    if (orig) console[m] = orig;
  }
  patched = false;
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = null;
  }
  currentPath = null;
}
