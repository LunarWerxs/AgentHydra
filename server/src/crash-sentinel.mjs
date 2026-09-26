/**
 * Crash sentinel and safe mode for a LunarWerx daemon: notice that the PREVIOUS run never shut
 * down cleanly, and let a launch come up quiet (no auto-started watchers, child processes or
 * background jobs) so a crash inside startup work stops repeating on every relaunch.
 *
 * WHY: a daemon auto-starts its watchers and children the moment it boots, and the tray host
 * revives it the moment it dies. A crash inside that startup work therefore replays on every
 * revive until the crash-loop guard gives up, and there was no way to start the app WITHOUT that
 * work to reach its settings or its logs. Two halves:
 *
 * 1. THE SENTINEL. Every launch writes `<dir>/run_<launchId>`; a graceful shutdown deletes it. A
 *    run file whose owner process is gone at the next launch is proof the owner did not shut down
 *    gracefully (a crash, a hard kill, power loss). close() deletes only this process's OWN file,
 *    never every run_* file: a self-update relaunch overlaps predecessor and successor for a
 *    moment, and a predecessor sweeping the directory on its way out would erase its successor's
 *    live marker. A file whose owner pid is still alive is skipped for the same reason, unless the
    file was written before the machine last booted: then that pid now belongs to an unrelated
    process (a recycled pid, most likely after the power loss or BSOD this exists for).
 *
 * 2. SAFE MODE. `--safe-mode` on the command line (a CLI user, or buildRelaunchArgv's `safeMode`
 *    option) or LUNARWERX_SAFE_MODE=1 in the environment (the tray host: its start command is an
 *    opaque per-app string, so it sets an env var rather than splice a flag into it) asks the
 *    daemon to skip its auto-start work. Which work counts as auto-start is the app's call; this
 *    module only answers the question.
 *
 * Anything that force-kills the daemon ON PURPOSE (the tray's Quit and Restart, an app's `stop`)
 * should call clearRunSentinels(dir) afterwards, or the next launch reads that deliberate kill as
 * a crash. The tray hosts do this when their config names the directory (CrashSentinelDir).
 *
 * Runtime-agnostic (Bun + Node), synchronous (runs once at startup over a few tiny files), and it
 * never throws: a sentinel that cannot be written must not stop the daemon from starting.
 * Synced from the shared kit, do not edit in an app.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

export const SAFE_MODE_FLAG = "--safe-mode";
export const SAFE_MODE_ENV = "LUNARWERX_SAFE_MODE";
const RUN_PREFIX = "run_";
/** Slack for comparing boot times: wall-clock corrections shift the computed boot moment a little. */
const BOOT_TOLERANCE_MS = 5 * 60 * 1000;

/** When this machine booted, in epoch ms (what the run file records as `bootedAt`). */
function defaultBootTime() {
  return Date.now() - Math.round(uptime() * 1000);
}

/** Signal 0 probes without delivering anything. EPERM means it exists but is not ours: alive. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function tryUnlink(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one run file. A corrupt or empty file (the crash landed mid-write) still counts as a run
 * that never closed, so it degrades to "owner unknown" instead of being ignored.
 */
function readRun(path, launchId) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const pid = Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  return {
    launchId,
    pid,
    startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : null,
    safeMode: parsed?.safeMode === true,
    bootedAt: Number.isFinite(parsed?.bootedAt) ? parsed.bootedAt : null,
  };
}

/**
 * Did the operator ask for safe mode? The flag, or the env var set to anything but an explicit
 * off value ("", "0", "false", "no", "off"), so the tray can pin it OFF for "Restart Normally"
 * even when the variable is inherited from its own environment.
 * @param {readonly string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isSafeModeRequested(argv = process.argv, env = process.env) {
  if (argv.includes(SAFE_MODE_FLAG)) return true;
  const value = String(env[SAFE_MODE_ENV] ?? "").trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(value);
}

/**
 * Open this launch's sentinel: report any earlier run that never closed, then mark this one.
 * Leftover files are deleted once reported, so one crash is reported by exactly one launch.
 * @param {object} options
 * @param {string} options.dir        The app's sentinel directory (e.g. `<CONFIG_DIR>/.sentinel`).
 * @param {boolean} [options.safeMode=false]  Recorded in the run file, for the next launch's report.
 * @param {boolean} [options.closeOnCleanExit=true]  Close automatically on a process exit with
 *   code 0. A crash handler's exit(1), an uncaught exception or a hard kill leaves the file behind.
 * @param {string} [options.launchId]  Defaults to a random UUID.
 * @param {number} [options.pid]       Defaults to process.pid.
 * @param {() => Date} [options.now]
 * @param {(pid: number) => boolean} [options.isAlive]
 * @param {() => number} [options.bootTime]  Epoch ms this machine booted.
 */
export function openCrashSentinel(options) {
  const {
    dir,
    safeMode = false,
    closeOnCleanExit = true,
    launchId = randomUUID(),
    pid = process.pid,
    now = () => new Date(),
    isAlive = defaultIsAlive,
    bootTime = defaultBootTime,
  } = options;
  const ownName = `${RUN_PREFIX}${launchId}`;
  const file = join(dir, ownName);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}

  let bootedAt = null;
  try {
    bootedAt = bootTime();
  } catch {}
  const uncleanRuns = [];
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX) || name === ownName) continue;
    const path = join(dir, name);
    const run = readRun(path, name.slice(RUN_PREFIX.length));
    // A live owner is an overlapping sibling (a predecessor still draining after an update
    // relaunch), not a crash. Our own pid on another launch's file is a recycled pid: dead. So is
    // a live pid on a file from an earlier boot: no process survives a reboot.
    const earlierBoot =
      run.bootedAt !== null && bootedAt !== null && Math.abs(run.bootedAt - bootedAt) > BOOT_TOLERANCE_MS;
    if (run.pid !== null && run.pid !== pid && !earlierBoot && isAlive(run.pid)) continue;
    const { bootedAt: _boot, ...reported } = run;
    uncleanRuns.push(reported);
    tryUnlink(path);
  }

  let written = false;
  try {
    const record = { pid, startedAt: now().toISOString(), safeMode, bootedAt };
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    written = true;
  } catch {}

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    tryUnlink(file);
  };
  if (closeOnCleanExit) {
    process.once("exit", (code) => {
      if (code === 0) close();
    });
  }

  return {
    launchId,
    file,
    written,
    safeMode,
    uncleanRuns,
    previousRunCrashed: uncleanRuns.length > 0,
    close,
  };
}

/**
 * Delete every run file in `dir`. For a caller that just stopped the daemon ON PURPOSE by force,
 * so the next launch does not report that stop as a crash. Returns how many were removed.
 * @param {string} dir
 * @returns {number}
 */
export function clearRunSentinels(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (name.startsWith(RUN_PREFIX) && tryUnlink(join(dir, name))) removed++;
  }
  return removed;
}
