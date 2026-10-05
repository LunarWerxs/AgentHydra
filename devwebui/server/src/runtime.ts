// ---------------------------------------------------------------------------
// Runtime selection — let a process (or a global default) choose whether its
// command runs under Node or Bun. Bun-driven Vite starts faster and lighter
// than Node-driven Vite, so this is the "use the efficient method" lever.
//
// The rewrite is deliberately CONSERVATIVE: it only touches clear node/bun
// invocations and leaves anything it doesn't recognise exactly as written.
//   bun:   `node x`        -> `bun x`            (run the file under Bun)
//          `bun run x`      -> `bun --bun run x`  (force Bun for the script's bins)
//   node:  `bun --bun run x`-> `bun run x`        (back to Node-shebang bins)
//          `bun x.js`       -> `node x.js`        (run the file under Node)
// `npm run …`, `bunx …`, and everything else are left alone.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write";
import { dataDir } from "./data-dir";
import { OS_SKIP, type SkipOs } from "./scan";
import {
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
  clampAutoUpdateInterval,
  clampUpdateCooldownDays,
} from "./auto-update-interval.ts";
import type { RuntimePref, Settings } from "../../shared/dto";

export type { RuntimePref, Settings } from "../../shared/dto";

export type Runtime = "node" | "bun";

/** The leading invocation of a command line: indentation, program, optional second word. */
type CommandHead = { ws: string; first: string; second: string | undefined; afterFirst: string };

function splitCommandHead(command: string): CommandHead | null {
  const m = command.match(/^(\s*)(\S+)(?:\s+(\S+))?/);
  if (!m) return null;
  const ws = m[1];
  const first = m[2];
  return {
    ws,
    first,
    second: m[3],
    afterFirst: command.slice(ws.length + first.length), // includes leading space
  };
}

/** Point a `node` invocation at Bun — anything we don't recognise is left untouched. */
function commandOnBun(command: string, head: CommandHead): string {
  if (head.first === "node" || head.first === "node.exe") return `${head.ws}bun${head.afterFirst}`;
  if (head.first === "bun" && head.second === "run")
    return command.replace(/^(\s*)bun(\s+)run\b/, "$1bun$2--bun run");
  return command;
}

/** Point a `bun` invocation at Node — only a direct FILE invocation; bare shorthands stay. */
function commandOnNode(command: string, head: CommandHead): string {
  if (head.first !== "bun" && head.first !== "bun.exe") return command;
  if (head.second === "--bun") return command.replace(/^(\s*)bun(\s+)--bun\b/, "$1bun"); // drop --bun
  if (head.second === "run") return command; // `bun run x` already uses Node-shebang bins
  // Only rewrite a direct FILE invocation; leave bare shorthands like `bun dev` alone
  // (Node can't run a bare script name).
  if (head.second && /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(head.second))
    return `${head.ws}node${head.afterFirst}`;
  return command;
}

export function withRuntime(command: string, runtime?: Runtime): string {
  if (!runtime) return command;
  const head = splitCommandHead(command);
  if (!head) return command;
  return runtime === "bun" ? commandOnBun(command, head) : commandOnNode(command, head);
}

// ---------------------------------------------------------------------------
// Global settings (~/.devwebui/settings.json). The `Settings` shape lives in
// the shared DTOs (re-exported above); the read/write functions stay here.
// ---------------------------------------------------------------------------
const settingsFile = (): string => path.join(dataDir(), "settings.json");
const RUNTIME_PREFS: RuntimePref[] = ["auto", "node", "bun"];

const cleanList = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map(String)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : fallback;
const cleanExclude = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
    : [];

// The current OS's skip is on by default; the others off. Stored values win.
const skipToggleDefaults = () => ({
  skipWindows: process.platform === "win32",
  skipMac: process.platform === "darwin",
  skipLinux: process.platform === "linux",
});
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
// A trimmed string setting. A blank value is kept (it means "use the GUI page's own
// hostname"); only a missing/non-string value falls back to the default.
const cleanStr = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v.trim() : fallback;
// Default blank → links use whatever host the GUI was opened on (localhost on the
// same machine, the LAN IP from another device). Set an explicit host to override.
const DEFAULT_LINK_HOST = "";

const readOsSkip = (o: unknown, base: Record<SkipOs, string[]>): Record<SkipOs, string[]> => {
  const src = (o ?? {}) as Partial<Record<SkipOs, unknown>>;
  return {
    windows: cleanList(src.windows, base.windows),
    mac: cleanList(src.mac, base.mac),
    linux: cleanList(src.linux, base.linux),
  };
};

export function readSettings(): Settings {
  const d = skipToggleDefaults();
  try {
    const s = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return {
      runtime: RUNTIME_PREFS.includes(s.runtime) ? s.runtime : "auto",
      freePortOnStart: bool(s.freePortOnStart, true),
      autoStartOnLaunch: bool(s.autoStartOnLaunch, false),
      monitorResources: bool(s.monitorResources, true),
      linkHost: cleanStr(s.linkHost, DEFAULT_LINK_HOST),
      autoScan: bool(s.autoScan, false),
      firstScanDone: bool(s.firstScanDone, false),
      scanExclude: cleanExclude(s.scanExclude),
      skipWindows: bool(s.skipWindows, d.skipWindows),
      skipMac: bool(s.skipMac, d.skipMac),
      skipLinux: bool(s.skipLinux, d.skipLinux),
      osSkip: readOsSkip(s.osSkip, OS_SKIP),
      pulseInstallId:
        typeof s.pulseInstallId === "string"
          ? s.pulseInstallId
          : typeof s.analyticsInstallId === "string"
            ? s.analyticsInstallId
            : undefined,
      pulseInstallReported: bool(s.pulseInstallReported, false),
      autoUpdate: bool(s.autoUpdate, false),
      autoUpdateIntervalSecs: Number.isFinite(s.autoUpdateIntervalSecs)
        ? clampAutoUpdateInterval(s.autoUpdateIntervalSecs)
        : AUTO_UPDATE_INTERVAL_DEFAULT_S,
      updateNotify: bool(s.updateNotify, true),
      updateCooldownDays: Number.isFinite(s.updateCooldownDays)
        ? clampUpdateCooldownDays(s.updateCooldownDays)
        : 0,
      portableMode: bool(s.portableMode, false),
      hideTrayIcon: bool(s.hideTrayIcon, false),
    };
  } catch {
    return {
      runtime: "auto",
      freePortOnStart: true,
      autoStartOnLaunch: false,
      monitorResources: true,
      linkHost: DEFAULT_LINK_HOST,
      autoScan: false,
      firstScanDone: false,
      scanExclude: [],
      ...d,
      osSkip: readOsSkip(null, OS_SKIP),
      autoUpdate: false,
      autoUpdateIntervalSecs: AUTO_UPDATE_INTERVAL_DEFAULT_S,
      updateNotify: true,
      updateCooldownDays: 0,
      portableMode: false,
      hideTrayIcon: false,
    };
  }
}

/** Merge a partial patch into the saved settings and persist the result. */
export function writeSettings(patch: Partial<Settings>): Settings {
  const cur = readSettings();
  const next: Settings = {
    runtime:
      patch.runtime !== undefined && RUNTIME_PREFS.includes(patch.runtime)
        ? patch.runtime
        : cur.runtime,
    freePortOnStart: bool(patch.freePortOnStart, cur.freePortOnStart),
    autoStartOnLaunch: bool(patch.autoStartOnLaunch, cur.autoStartOnLaunch),
    monitorResources: bool(patch.monitorResources, cur.monitorResources),
    linkHost: patch.linkHost !== undefined ? cleanStr(patch.linkHost, cur.linkHost) : cur.linkHost,
    autoScan: patch.autoScan !== undefined ? !!patch.autoScan : cur.autoScan,
    firstScanDone: patch.firstScanDone !== undefined ? !!patch.firstScanDone : cur.firstScanDone,
    scanExclude:
      patch.scanExclude !== undefined ? cleanExclude(patch.scanExclude) : cur.scanExclude,
    skipWindows: bool(patch.skipWindows, cur.skipWindows),
    skipMac: bool(patch.skipMac, cur.skipMac),
    skipLinux: bool(patch.skipLinux, cur.skipLinux),
    osSkip: patch.osSkip !== undefined ? readOsSkip(patch.osSkip, cur.osSkip) : cur.osSkip,
    pulseInstallId:
      typeof patch.pulseInstallId === "string" ? patch.pulseInstallId : cur.pulseInstallId,
    pulseInstallReported: bool(patch.pulseInstallReported, cur.pulseInstallReported ?? false),
    autoUpdate: bool(patch.autoUpdate, cur.autoUpdate),
    autoUpdateIntervalSecs:
      patch.autoUpdateIntervalSecs !== undefined
        ? clampAutoUpdateInterval(patch.autoUpdateIntervalSecs)
        : cur.autoUpdateIntervalSecs,
    updateNotify: bool(patch.updateNotify, cur.updateNotify),
    updateCooldownDays:
      patch.updateCooldownDays !== undefined
        ? clampUpdateCooldownDays(patch.updateCooldownDays)
        : cur.updateCooldownDays,
    portableMode: bool(patch.portableMode, cur.portableMode),
    hideTrayIcon: bool(patch.hideTrayIcon, cur.hideTrayIcon),
  };
  mkdirSync(dataDir(), { recursive: true });
  writeJsonAtomic(settingsFile(), next, { mode: 0o600, trailingNewline: false });
  return next;
}

/** Ensure the on-disk file contains every key (incl. osSkip) so users can discover + hand-edit them. */
export function materializeSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (raw && typeof raw === "object" && raw.osSkip) return; // already complete
  } catch {
    /* missing or invalid — (re)write below */
  }
  writeSettings({});
}

// Lockfiles that identify a project's package manager → the runtime its scripts expect. Bun's own
// lockfiles mean "run under Bun"; the Node package managers (npm/yarn/pnpm) mean "run under Node".
// Mirrors detect.ts's lockfile-only strategy (no packageManager field, no upward walk) so a
// freshly-scaffolded project and an auto-detected existing one agree on the runtime.
const BUN_LOCKFILES = ["bun.lock", "bun.lockb"];
const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];

/**
 * Detect which runtime a project's scripts expect from the lockfile in `dir`, or undefined if
 * there's no clear signal (no lockfile). This is what makes the `auto` setting genuinely
 * automatic: a Bun project whose command still literally says `node …/vite.js` gets run under
 * Bun without any per-process pin, and a Node project's `bun x.js` gets run under Node — each
 * matched to how the project actually installs. A cheap synchronous check, run once at load.
 */
export function detectProjectRuntime(dir: string): Runtime | undefined {
  for (const f of BUN_LOCKFILES) if (existsSync(path.join(dir, f))) return "bun";
  for (const f of NODE_LOCKFILES) if (existsSync(path.join(dir, f))) return "node";
  return undefined;
}

/**
 * Resolve the effective runtime for a process. Precedence, highest first:
 *   1. the process's explicit `runtime` pin (a deliberate per-process override always wins);
 *   2. an explicit global setting of `node`/`bun` (the user forcing one everywhere);
 *   3. under `auto`, the project's detected runtime (from its lockfile) — this is the "just do
 *      the right thing per project" behaviour; undefined here means "leave the command as written".
 */
export function effectiveRuntime(
  processRuntime: Runtime | undefined,
  global: RuntimePref,
  projectRuntime?: Runtime,
): Runtime | undefined {
  if (processRuntime) return processRuntime;
  if (global !== "auto") return global;
  return projectRuntime;
}
