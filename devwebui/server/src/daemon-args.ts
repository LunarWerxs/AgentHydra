/**
 * The daemon's OWN command-line flags, and the guard that keeps them out of the CLI dispatcher.
 *
 * server/src/index.ts hands ANY argv beyond the program name to the CLI, which answers and exits
 * without ever starting a server. That was safe while every launcher was bare — the tray, dev.ts
 * and the auto-update relaunch all respawned with no verb — and it is exactly why the relaunch
 * could only ever pass information through the environment.
 *
 * The environment is not good enough for the relaunch anymore. It is handed to WMI
 * Win32_Process.Create on win32 (see buildDetachedSpawn), which takes a command LINE and does NOT
 * inherit the caller's environment block, so an env-only handover reaches the transient
 * powershell.exe and never the successor daemon. Going through WMI is what gets the successor OUT
 * of the predecessor's process tree, so a tray Quit (`taskkill /T /F`) landing in the ~800ms
 * handoff can no longer kill both. So the successor's port and relaunch signal have to be
 * arguments, and arguments have to stop meaning "this is a CLI invocation".
 *
 * parseDaemonArgs is deliberately all-or-nothing: it returns null the moment it sees a token it
 * does not own, so anything that is not exclusively daemon flags still reaches the CLI untouched.
 * Every CLI verb is a bare word (`start`, `list`, `mcp`, …) or `--version`/`--help`, none of which
 * this recognises, so no existing invocation changes meaning.
 */

/** Flags whose next token is their value. */
const VALUE_FLAGS = new Set(["--port", "--resume"]);
/** Flags that stand alone. */
const BARE_FLAGS = new Set(["--relaunch", "--safe-mode"]);

export interface DaemonArgs {
  /** The port to prefer, from `--port <n>`; null when not given. */
  port: number | null;
  /** True when this process is the auto-update successor. */
  relaunch: boolean;
  /** Process ids the predecessor had RUNNING, to bring back up after the update. */
  resume: string[];
  /** `--safe-mode`: boot without any launch-time auto-start (see crash-sentinel.ts). Only set
   *  when the flag was given, so the common bare/relaunch shapes stay exactly as they were. */
  safeMode?: true;
}

/**
 * Parse an argv tail as daemon flags. Returns null when ANY token is not a daemon flag (or a
 * value flag is missing/malformed), meaning the argv belongs to the CLI, not the daemon.
 */
export function parseDaemonArgs(argv: readonly string[]): DaemonArgs | null {
  const out: DaemonArgs = { port: null, relaunch: false, resume: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (BARE_FLAGS.has(token)) {
      if (token === "--safe-mode") out.safeMode = true;
      else out.relaunch = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) return null;
    const value = argv[i + 1];
    if (value === undefined) return null;
    i++;
    if (token === "--port") {
      const n = Number(value);
      // A malformed port is a hard null rather than a silent fallback: it means we were called in
      // a way nobody intended, and booting a daemon on the wrong port is worse than not booting.
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) return null;
      out.port = n;
    } else {
      out.resume = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/**
 * Remove every `<flag> <value>` pair from an argv. Used before rebuilding the relaunch argv so a
 * per-generation list (the resume ids, which are recomputed each time) cannot accumulate: the
 * successor's argv is the next generation's input, so anything merely appended grows forever.
 */
export function stripFlagPair(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
      i++;
      continue;
    }
    out.push(argv[i] as string);
  }
  return out;
}
