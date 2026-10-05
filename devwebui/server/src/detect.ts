// ---------------------------------------------------------------------------
// Scaffold detection — given a folder with no .devwebui, look at its
// package.json (+ vite config, + any workspace packages) and propose a
// .devwebui from the dev scripts it finds. Best-effort and recoverable: the
// user previews before anything is written and can edit every process after.
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import path from "node:path";
import { detect as detectPackageManager } from "package-manager-detector";
import { glob } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import type { DetectedProcess, Detection } from "../../shared/dto";

export type { DetectedProcess, Detection } from "../../shared/dto";

// A script KEY that names a dev/serve entrypoint (dev, start, serve:web, …).
const DEV_KEY_RE = /^(dev|start|serve|preview)(:[\w.-]+)?$/i;

// A COMMAND that runs a dev/preview server (not a one-shot build/test).
const SERVER_CMD_RE =
  /\b(vite(?!\s+build)|next\s+(?:dev|start)|react-scripts\s+start|react-app-rewired\s+start|craco\s+start|rescripts\s+start|nuxt(?:\s+dev)?|nuxi\s+dev|astro\s+(?:dev|preview)|remix\s+(?:dev|vite:dev)|webpack(?:\s+serve|-dev-server)|vue-cli-service\s+serve|ng\s+serve|svelte-kit\s+dev|parcel(?!\s+build)|rsbuild\s+dev|rspack\s+serve|solid-start\s+dev|wrangler\s+(?:dev|pages\s+dev))\b/i;

// Hard excludes — even a dev-ish key is not a server if the command is one of these.
const NOT_SERVER_RE =
  /\b(build|--check|--fail-on|eslint|prettier|tsc\b|typecheck|vitest|jest|mocha|playwright|cypress|test\b|lint\b|audit|codegen|generate)\b/i;

// Framework → display name + conventional dev port (last resort if no explicit port).
const FRAMEWORK_DEFAULTS: Array<[RegExp, string, number]> = [
  [/\bastro\b/i, "Astro", 4321],
  [/\bnext\b/i, "Next.js", 3000],
  [/\b(nuxt|nuxi)\b/i, "Nuxt", 3000],
  [/\bremix\b/i, "Remix", 3000],
  [/\b(react-scripts|react-app-rewired|craco|rescripts)\s+start\b/i, "React", 3000],
  [/\bwebpack(?:\s+serve|-dev-server)\b/i, "Webpack", 8080],
  [/\bng\s+serve\b/i, "Angular", 4200],
  [/\bvue-cli-service\b/i, "Vue CLI", 8080],
  [/\bsvelte-kit\b/i, "SvelteKit", 5173],
  [/\bparcel\b/i, "Parcel", 1234],
  [/\brsbuild\b/i, "Rsbuild", 3000],
  [/\bvite\b/i, "Vite", 5173],
];

const PALETTE = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#eab308",
  "#06b6d4",
  "#f97316",
  "#84cc16",
];

const MAX_PROCESSES = 12;
const MAX_WORKSPACE_DIRS = 60;

// Map a detected package-manager agent to the run-command prefix this code
// produces (the rest of detection does `${runner} ${key}`). Anything we don't
// special-case (npm, deno, or no lockfile at all) falls back to "npm run", which
// matches the previous lockfile-only behaviour.
function runnerForAgent(name: string | undefined): string {
  switch (name) {
    case "bun":
      return "bun run";
    case "pnpm":
      return "pnpm";
    case "yarn":
      return "yarn";
    default:
      return "npm run";
  }
}

async function detectRunner(dir: string): Promise<string> {
  // Lockfile-only detection, matching the original (bun.lock(b)/pnpm-lock.yaml/
  // pnpm-workspace.yaml/yarn.lock/package-lock.json); don't traverse upward past
  // the project dir, and don't consult package.json's packageManager field.
  const res = await detectPackageManager({ cwd: dir, strategies: ["lockfile"], stopDir: dir });
  return runnerForAgent(res?.name);
}

function explicitPort(cmd: string): number | undefined {
  const m = cmd.match(/(?:--port[ =]|-p[ =]|\bPORT[ =])(\d{2,5})/i);
  return m ? Number(m[1]) : undefined;
}

function frameworkOf(cmd: string): { name: string; port: number } | undefined {
  for (const [re, name, port] of FRAMEWORK_DEFAULTS) if (re.test(cmd)) return { name, port };
  return undefined;
}

async function viteConfigPort(dir: string): Promise<number | undefined> {
  for (const f of [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
    "vite.config.cjs",
    "vite.config.cts",
  ]) {
    const fp = path.join(dir, f);
    let txt: string;
    try {
      txt = await readFile(fp, "utf8");
    } catch {
      continue; // missing or unreadable config — fall through to defaults
    }
    const m =
      txt.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/) ??
      txt.match(/\bport\s*:\s*(\d{2,5})/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "dev";
}

function titleCase(s: string): string {
  return s
    .replace(/[-_:]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyName(key: string): string {
  const stripped = key.replace(/^(dev|start|serve|preview):?/i, "").trim();
  return titleCase(stripped || key);
}

function prettyProjectName(raw: string): string {
  const base = raw.replace(/^@[^/]+\//, ""); // drop npm scope
  return titleCase(base) || "Project";
}

type Pkg = { name?: string; scripts?: Record<string, string>; workspaces?: unknown };

async function readPkg(dir: string): Promise<Pkg | null> {
  const fp = path.join(dir, "package.json");
  try {
    return JSON.parse(await readFile(fp, "utf8"));
  } catch {
    return null; // missing, unreadable, or invalid JSON
  }
}

/** Everything one script's id/name/port decision needs, threaded from the caller. */
type ScriptCtx = {
  runner: string;
  cfgPort: number | undefined;
  seen: Set<string>;
  runtimePin: "node" | "bun" | undefined;
  cwdRel?: string;
  label?: string;
};

/** Namespace a script key into a process id and claim it. For workspace packages the
 *  label prefixes the id; duplicates bump a suffix (strictly increasing → always terminates). */
function uniqueProcessId(key: string, label: string | undefined, seen: Set<string>): string {
  const idBase = label ? (key === "dev" ? label : `${label}-${key}`) : key;
  let id = sanitizeId(idBase);
  for (let n = 2; seen.has(id); n++) id = sanitizeId(`${idBase}-${n}`);
  seen.add(id);
  return id;
}

/** Display name: the workspace label + key for a workspace package, else just the pretty key. */
function scriptProcessName(key: string, label: string | undefined): string {
  if (!label) return prettyName(key);
  return titleCase(label) + (key === "dev" ? "" : ` ${prettyName(key)}`);
}

/** Port for one script: an explicit flag wins, then Vite's config file, then the framework default. */
function scriptPort(
  key: string,
  cmd: string,
  cfgPort: number | undefined,
  fw: { name: string; port: number } | undefined,
): number | undefined {
  const viteish = fw?.name === "Vite" || /\bvite\b/i.test(cmd) || key === "dev" || key === "start";
  return explicitPort(cmd) ?? (viteish ? cfgPort : undefined) ?? fw?.port;
}

/** One `scripts` entry → one proposed process, or null when it isn't a dev server. */
function processFromScript(
  key: string,
  rawCmd: unknown,
  ctx: ScriptCtx,
): { process: DetectedProcess; framework?: string } | null {
  const cmd = String(rawCmd);
  if (!DEV_KEY_RE.test(key) && !SERVER_CMD_RE.test(cmd)) return null;
  if (NOT_SERVER_RE.test(cmd)) return null;

  const fw = frameworkOf(cmd);
  return {
    process: {
      id: uniqueProcessId(key, ctx.label, ctx.seen),
      name: scriptProcessName(key, ctx.label),
      command: `${ctx.runner} ${key}`,
      ...(ctx.cwdRel ? { cwd: ctx.cwdRel } : {}),
      port: scriptPort(key, cmd, ctx.cfgPort, fw),
      ...(ctx.runtimePin ? { runtime: ctx.runtimePin } : {}),
    },
    framework: fw?.name,
  };
}

/** Pull dev-server processes out of one package's scripts. `cwdRel`/`label` namespace workspace packages. */
async function processesFromPackage(
  pkg: Pkg,
  pkgDir: string,
  runner: string,
  seen: Set<string>,
  runtimePin: "node" | "bun" | undefined,
  cwdRel?: string,
  label?: string,
): Promise<{ processes: DetectedProcess[]; framework?: string }> {
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const ctx: ScriptCtx = {
    runner,
    cfgPort: await viteConfigPort(pkgDir),
    seen,
    runtimePin,
    cwdRel,
    label,
  };
  const out: DetectedProcess[] = [];
  let framework: string | undefined;

  for (const [key, rawCmd] of Object.entries(scripts)) {
    const found = processFromScript(key, rawCmd, ctx);
    if (!found) continue;
    if (found.framework && !framework) framework = found.framework; // first framework seen wins
    out.push(found.process);
  }
  return { processes: out, framework };
}

// ---- workspace expansion -------------------------------------------------
function packageWorkspaceGlobs(pkg: Pkg): string[] {
  const w = pkg.workspaces;
  if (Array.isArray(w)) return w.map(String);
  if (w && typeof w === "object" && Array.isArray((w as { packages?: unknown }).packages))
    return (w as { packages: unknown[] }).packages.map(String);
  return [];
}

async function pnpmWorkspaceGlobs(root: string): Promise<string[]> {
  let txt: string;
  try {
    txt = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return []; // no pnpm workspace file
  }
  try {
    const doc = parseYaml(txt) as { packages?: unknown } | null;
    const pkgs = doc?.packages;
    return Array.isArray(pkgs) ? pkgs.map(String) : [];
  } catch {
    return []; // malformed YAML — ignore
  }
}

/**
 * Expand workspace globs (e.g. "packages/*", "apps/**") into absolute directories
 * that contain a package.json. We glob for the `package.json` inside each pattern
 * and take its dirname — that gives only real packages, skips node_modules and
 * dot-directories, and stays bounded by MAX_WORKSPACE_DIRS.
 */
async function expandWorkspaceGlobs(root: string, patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  // Turn each directory glob into a "<glob>/package.json" file glob.
  const filePatterns = patterns.map(
    (p) => `${p.replace(/\\/g, "/").replace(/\/+$/, "")}/package.json`,
  );
  let matches: string[];
  try {
    matches = await glob(filePatterns, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: false, // skip dot-directories
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**"], // skip node_modules
    });
  } catch {
    return []; // unreadable tree — fall back to no workspace packages
  }
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const d = path.dirname(m);
    if (seen.has(d)) continue;
    seen.add(d);
    dirs.push(d);
    if (dirs.length >= MAX_WORKSPACE_DIRS) break; // runaway guard / cap
  }
  return dirs;
}

/** Inspect `dir` (package.json, vite config, workspaces) and propose a .devwebui, or null. */
export async function detectProject(dir: string): Promise<Detection | null> {
  const rootPkg = await readPkg(dir);
  if (!rootPkg) return null;

  const runner = await detectRunner(dir);
  const runtimePin = runner === "bun run" ? "bun" : undefined; // Bun project → run Vite under Bun
  const seen = new Set<string>();
  let framework: string | undefined;
  const procs: DetectedProcess[] = [];

  // 1) the root package's own dev scripts (cwd = the .devwebui's folder).
  const rootRes = await processesFromPackage(rootPkg, dir, runner, seen, runtimePin);
  framework ??= rootRes.framework;
  procs.push(...rootRes.processes);

  // 2) workspace packages (npm/yarn/bun "workspaces" + pnpm-workspace.yaml).
  const globs = [...packageWorkspaceGlobs(rootPkg), ...(await pnpmWorkspaceGlobs(dir))];
  const wsDirs = (await expandWorkspaceGlobs(dir, globs)).filter((d) => d !== dir);
  for (const wsDir of wsDirs) {
    const wp = await readPkg(wsDir);
    if (!wp) continue;
    const rel = path.relative(dir, wsDir).replace(/\\/g, "/");
    const label = wp.name ? wp.name.replace(/^@[^/]+\//, "") : path.basename(wsDir);
    const res = await processesFromPackage(wp, wsDir, runner, seen, runtimePin, rel, label);
    framework ??= res.framework;
    procs.push(...res.processes);
  }

  if (!procs.length) return null;

  // Order: dev → start → serve → the rest; root before workspaces (no cwd first).
  const rank = (p: DetectedProcess) =>
    (p.cwd ? 10 : 0) + (p.id === "dev" ? 0 : p.id === "start" ? 1 : p.id === "serve" ? 2 : 3);
  procs.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

  const truncated = procs.length > MAX_PROCESSES ? procs.length - MAX_PROCESSES : 0;
  const kept = procs.slice(0, MAX_PROCESSES);
  kept.forEach((p, i) => {
    p.color = PALETTE[i % PALETTE.length];
  });

  return {
    name: prettyProjectName(String(rootPkg.name || path.basename(dir))),
    framework,
    processes: kept,
    ...(truncated ? { truncated } : {}),
  };
}
