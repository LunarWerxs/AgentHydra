// Crash sentinel + safe mode.
//
// WHY: the tray host revives a daemon that dies, and a booting daemon auto-starts the user's dev
// servers (autoStartOnLaunch, the auto-update resume list). When one of those starts is what
// takes the daemon down, every revive repeats it, and there was no quiet way back in. So every
// launch drops `<dataDir>/.sentinel/run_<launch-id>` and a CLEAN shutdown removes it again: a run
// file still on disk at the next boot means the previous daemon never got to shut down. That boot
// then comes up in SAFE MODE - projects load, nothing auto-starts - and the GUI offers
// "Leave safe mode" plus a link to the de-duplicated crash entry this records.
//
// A run file whose pid is still alive is a sibling, not a crash: the auto-update successor boots
// while its predecessor is still handing over the port, so it must not read that file as a
// crash (and must not delete it: the predecessor removes its own on the way out).
//
// A run file older than the current OS boot is not a crash either: a reboot or logoff ends the
// daemon without a shutdown() (Windows sends no SIGTERM), and treating that as a crash would put
// every login in safe mode and skip the auto-start the owner booted for. Such a leftover is dropped
// uncounted, before the pid check, because pids are reused across reboots.
// Best-effort throughout: a sentinel that cannot be written must never stop the daemon booting.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./data-dir";
import type { SafeModeStatus } from "../../shared/dto";

/** One launch's marker, as written to its run file. */
export interface SentinelRun {
  id: string;
  pid: number;
  startedAt: number;
  /** The uncaught throw that ended the run, when the crash handler got to record it. */
  reason?: string;
}

const RUN_PREFIX = "run_";

export function sentinelDir(): string {
  return path.join(dataDir(), ".sentinel");
}

/** True when `pid` names a live process (EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let ownFile: string | null = null;
let ownRun: SentinelRun | null = null;

/** When the OS last booted (ms epoch), for telling a reboot's leftovers from a crash's. */
export function osBootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

/**
 * Arm this launch's sentinel and report the newest run that ended without a clean shutdown (or
 * null). Leftovers from dead runs are consumed so one crash triggers safe mode once, not forever.
 */
export function armCrashSentinel(opts?: {
  dir?: string;
  isAlive?: (pid: number) => boolean;
  bootTime?: number;
}): SentinelRun | null {
  const dir = opts?.dir ?? sentinelDir();
  const isAlive = opts?.isAlive ?? pidAlive;
  let crashed: SentinelRun | null = null;
  try {
    const bootTime = opts?.bootTime ?? osBootTime();
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(RUN_PREFIX)) continue;
      const file = path.join(dir, name);
      let run: SentinelRun;
      try {
        run = JSON.parse(readFileSync(file, "utf8")) as SentinelRun;
      } catch {
        // A torn write is still evidence the run never finished; date it by the file itself so
        // the boot check below still applies.
        const startedAt = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
        run = { id: name.slice(RUN_PREFIX.length), pid: 0, startedAt };
      }
      if (run.startedAt < bootTime) {
        rmSync(file, { force: true }); // ended by a reboot or logoff, not a crash
        continue;
      }
      if (run.pid !== process.pid && isAlive(run.pid)) continue; // a live sibling, not a crash
      if (!crashed || run.startedAt > crashed.startedAt) crashed = run;
      rmSync(file, { force: true });
    }
    ownRun = { id: randomUUID(), pid: process.pid, startedAt: Date.now() };
    ownFile = path.join(dir, `${RUN_PREFIX}${ownRun.id}`);
    writeFileSync(ownFile, JSON.stringify(ownRun), { mode: 0o600 });
  } catch (e) {
    console.error(`[devwebui] crash sentinel unavailable: ${(e as Error).message}`);
  }
  return crashed;
}

/** Stamp why this run is dying onto its run file (sync: called from the last-resort handlers). */
export function noteCrashReason(reason: unknown): void {
  if (!ownFile || !ownRun) return;
  const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  const stamped: SentinelRun = { ...ownRun, reason: text.slice(0, 2000) };
  try {
    writeFileSync(ownFile, JSON.stringify(stamped), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Clean shutdown: remove this run's file so the next boot starts normally. */
export function disarmCrashSentinel(): void {
  if (!ownFile) return;
  try {
    rmSync(ownFile, { force: true });
  } catch {
    /* best-effort */
  }
  ownFile = null;
}

// Safe-mode state lives here, not on the Manager, because it is decided before the Manager
// loads any project and read by routes that never touch a process.
let safeMode: SafeModeStatus = {
  active: false,
  trigger: null,
  crashedRunStartedAt: null,
  reason: null,
  crashProcessId: null,
  crashFingerprint: null,
};

export function getSafeMode(): SafeModeStatus {
  return { ...safeMode };
}

export function setSafeMode(next: SafeModeStatus): void {
  safeMode = { ...next };
}

/** Leave safe mode (the banner's button); returns false when it was not active. */
export function exitSafeMode(): boolean {
  if (!safeMode.active) return false;
  safeMode = { ...safeMode, active: false };
  return true;
}
