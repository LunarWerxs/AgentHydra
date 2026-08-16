/**
 * Types for relaunch-argv.mjs — the argv that relaunches this build of a daemon, pinned to the
 * port it is actually serving on. See the .mjs for the three failure modes it exists to prevent.
 * Synced from the shared kit, do not edit in an app.
 */

export interface RelaunchArgvOptions {
  /** `process.execPath` — the real executable in both source and compiled mode. */
  execPath: string;
  /** True inside a `bun build --compile` binary, where argv[0..1] are placeholders. */
  isCompiled: boolean;
  /** The port actually being SERVED, never the preferred one. */
  boundPort: number;
  /** Daemon verb to state explicitly ("start"/"serve"); omit for an entry that takes no verb. */
  command?: string;
  /** Defaults to "--port". */
  portFlag?: string;
  /** Defaults to "--relaunch". */
  relaunchFlag?: string;
  /** Flags whose NEXT token is a value (e.g. "--root"), so a value is never re-read as a flag. */
  valueFlags?: readonly string[];
}

export function buildRelaunchArgv(
  argv: readonly string[],
  options: RelaunchArgvOptions,
): string[];
