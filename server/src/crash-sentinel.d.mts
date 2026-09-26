/**
 * Types for crash-sentinel.mjs - a per-launch run file that reveals an unclean previous exit, and
 * the safe-mode switch a relaunch uses to start without auto-start work. See the .mjs for why.
 * Synced from the shared kit, do not edit in an app.
 */

export const SAFE_MODE_FLAG: "--safe-mode";
export const SAFE_MODE_ENV: "LUNARWERX_SAFE_MODE";

/** One earlier launch whose run file was still there: it never shut down gracefully. */
export interface UncleanRun {
  launchId: string;
  /** Null when the file was unreadable (the crash landed mid-write). */
  pid: number | null;
  /** ISO timestamp the run started, or null when unreadable. */
  startedAt: string | null;
  /** Whether that run was itself in safe mode (a crash even then points past auto-start work). */
  safeMode: boolean;
}

export interface CrashSentinelOptions {
  /** The app's sentinel directory (e.g. `<CONFIG_DIR>/.sentinel`); created when missing. */
  dir: string;
  /** Recorded in this launch's run file. Defaults to false. */
  safeMode?: boolean;
  /** Close on a process exit with code 0. Defaults to true. */
  closeOnCleanExit?: boolean;
  /** Defaults to a random UUID. */
  launchId?: string;
  /** Defaults to process.pid. */
  pid?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  /** Epoch ms this machine booted; a live pid on a run file from an earlier boot is a recycled pid. */
  bootTime?: () => number;
}

export interface CrashSentinel {
  launchId: string;
  /** This launch's run file. */
  file: string;
  /** False when the run file could not be written (the daemon still starts). */
  written: boolean;
  safeMode: boolean;
  uncleanRuns: UncleanRun[];
  /** True when at least one earlier launch never shut down gracefully. */
  previousRunCrashed: boolean;
  /** Mark this launch as shut down gracefully. Idempotent. */
  close(): void;
}

export function isSafeModeRequested(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
): boolean;

export function openCrashSentinel(options: CrashSentinelOptions): CrashSentinel;

export function clearRunSentinels(dir: string): number;
