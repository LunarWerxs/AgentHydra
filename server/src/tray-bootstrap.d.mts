// Types for tray-bootstrap.mjs — the shared "this build HAS a tray, and it is running" primitive.
// Hand-written so the TypeScript apps get a typed import without depending on the kit's toolchain.

/** The tray host's exe for one app, `<App>-Tray.exe`, paired with that app's `<App>-Tray.json`. */
export function trayHostExeFor(configFile: string): string;

/** Every file a tray host needs to run, for an app that names its config and icon like this. */
export function trayToolkitFiles(names: { configFile: string; iconFile: string }): string[];

/** Half a toolkit is not a toolkit: a host with no config cannot start, a config with no host is a
 *  file. `embedded` maps filename -> a path the runtime can read (Bun's embedded-file paths). */
export function isCompleteTrayToolkit(
  embedded: Readonly<Record<string, string>> | null | undefined,
  files: string[],
): boolean;

/** The tray config as it must land beside a materialized host: `appRoot` made absolute to the
 *  RUNNING exe's directory and `compiledExe` set to that exe's real filename. Unparseable JSON is
 *  returned unchanged rather than thrown. */
export function patchTrayConfig(
  raw: string,
  opts: { appRoot: string; compiledExe: string },
): string;

export type TrayToolkitReason =
  | 'sidecar'
  | 'materialized'
  | 'already-materialized'
  | 'not-windows'
  | 'not-compiled'
  | 'nothing-embedded'
  | 'write-failed';

export interface TrayToolkitResult {
  /** The directory holding a runnable tray host, or null when there is none. */
  dir: string | null;
  reason: TrayToolkitReason;
  /** Files written this run (empty when nothing had to be). */
  wrote: string[];
  /** Present only when a write failed: the error, for the log and the toast. */
  error?: string;
}

export interface TrayToolkitDeps {
  appRoot: string;
  compiled: boolean;
  /** Where this app keeps its state; the toolkit lands in `<stateDir>/tray/<version>`. */
  stateDir: string;
  version: string;
  exePath: string;
  configFile: string;
  iconFile: string;
  /** filename -> embedded file path, set by the app's generated release entrypoint. */
  embedded?: Readonly<Record<string, string>> | null;
  platform?: string;
  exists?: (path: string) => boolean;
  sizeOf?: (path: string) => number | null;
  readBytes?: (path: string) => Promise<Uint8Array>;
  readText?: (path: string) => Promise<string>;
  writeBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  writeText?: (path: string, text: string) => Promise<void>;
  mkdir?: (path: string) => void;
  joinPath?: (...parts: string[]) => string;
  dirOf?: (path: string) => string;
  baseOf?: (path: string) => string;
}

/** Ensure a runnable tray host exists, and say where it is. Never throws. */
export function materializeTrayToolkit(deps: TrayToolkitDeps): Promise<TrayToolkitResult>;

/** The probe's stdout -> true / false / null (null = could not tell). */
export function parseTrayHostCount(stdout: string): boolean | null;

/** Is a tray host FOR THIS APP alive right now? true / false / null = could not tell. The host's
 *  exe is named for its app, so `configFile` decides which exe is counted. */
export function trayHostProcessState(opts: {
  spawnProbe?: (argv: string[]) => Promise<string>;
  configFile: string;
}): Promise<boolean | null>;

/** The probe's command line, exported so the filter can be asserted without spawning anything. */
export function trayHostProbeArgv(configFile: string): string[];

/** Stop this install's pre-rename host, delete its old exe and retarget its shortcuts at the new one.
 *  Resolves the PowerShell exit code, or null off Windows. */
export function retireLegacyTrayHost(opts: {
  appRoot: string;
  configFile: string;
  platform?: string;
  runPowerShell?: (script: string, env: Record<string, string>) => Promise<number>;
}): Promise<number | null>;

export type TrayHostSkipReason =
  | 'not-windows'
  | 'headless'
  | 'not-compiled'
  | 'no-tray-toolkit'
  | 'hidden-by-setting'
  | 'already-running';

/** A build agent rather than a person's desktop (CI / GITHUB_ACTIONS / TF_BUILD / …). */
export function isHeadlessEnv(env?: Record<string, string | undefined>): boolean;

export type TrayHostDecision = { start: true } | { start: false; reason: TrayHostSkipReason };

/** Should THIS daemon start the tray host? Pure, so it can be asserted on directly. */
export function trayHostDecision(input: {
  platform: string;
  compiled: boolean;
  toolkitPresent: boolean;
  hideTray: boolean;
  alreadyRunning: boolean;
  /** A build agent: no desktop to put an icon on, and a detached host would outlive the job. */
  headless?: boolean;
}): TrayHostDecision;

export interface StartTrayHostDeps {
  appRoot: string;
  compiled: boolean;
  configFile: string;
  hideTray: () => boolean;
  /** Overrides the CI sniff (isHeadlessEnv). */
  headless?: boolean;
  env?: Record<string, string | undefined>;
  /** Where a materialized copy landed; without one, `<appRoot>/misc` is used. */
  toolkitDir?: string | null;
  platform?: string;
  exists?: (path: string) => boolean;
  /** Tri-state: an UNKNOWN starts the host, because a named mutex makes a double start harmless. */
  isRunning?: () => Promise<boolean | null>;
  spawnHost?: (exe: string, cwd: string, configFile: string) => void;
}

/** Start the tray host if nothing else has. */
export function startTrayHostIfMissing(
  deps: StartTrayHostDeps,
): Promise<TrayHostDecision & { exe: string }>;
