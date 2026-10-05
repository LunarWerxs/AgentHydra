#!/usr/bin/env bun
/**
 * devwebui CLI — one installable command so humans, scripts, and AI agents can run and drive
 * DevWebUI without typing `bun run <script>` or speaking raw HTTP/MCP.
 *
 * It's a THIN wrapper over the daemon's existing REST API (the same surface the GUI and the MCP
 * server already use — see shared/routes.ts) plus a launcher for the daemon itself. Nothing here
 * reimplements the manager; lifecycle/status/list/process verbs just drive the running daemon over
 * loopback HTTP, exactly like server/src/mcp.ts does. Modeled on the same thin-CLI-over-daemon
 * pattern used by sibling LunarWerx daemons.
 *
 *   devwebui start [--port N] [--foreground]   boot the daemon (detached by default; prints the URL)
 *   devwebui stop                              graceful shutdown of the running daemon
 *   devwebui status [--json]                   is it running + where + a project/process summary
 *   devwebui list | ps [--json]                list managed processes (id · name · status · port)
 *   devwebui start-process   <id|name>         start / stop / restart / enable / disable one process
 *   devwebui stop-process    <id|name>
 *   devwebui restart-process <id|name>
 *   devwebui enable-process  <id|name>
 *   devwebui disable-process <id|name>
 *   devwebui start-all | stop-all              start / stop every managed process
 *   devwebui alerts list|add|remove|events|clear   threshold alert rules + fired-event history
 *   devwebui pairing codes|clients|revoke     local API auth: pairing codes + paired clients
 *   devwebui open-process <file> <id>          desktop-shortcut launcher: boot+load+start+focus
 *   devwebui open-project <file>               desktop-shortcut launcher for a whole codebase
 *   devwebui mcp                               run the stdio MCP server for AI agents
 *
 * Connection resolution matches mcp.ts: DEVWEBUI_URL > DEVWEBUI_PORT > ~/.devwebui/runtime.json
 * pointer > default port. Bin entry is wired in package.json ("bin": { "devwebui": ... }).
 *
 * Reachable two ways: as the `devwebui` bin from a checkout, and — since index.ts delegates
 * any verb-bearing argv here — as `devwebui.exe <verb>` from the compiled binary, which is
 * what lets a desktop .lnk drive a machine that has no repo and no Bun installed.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../shared/routes";
import type { AlertEvent, AlertMetric, AlertRule, ScanResult } from "../../shared/dto";
import { daemonUrl, focusPath } from "../../shared/constants";
import { dataDir } from "./data-dir";
import { findLiveInstance, readInstanceInfo, type InstanceInfo } from "./instance";
import { daemonLaunchVector, isCompiledBinary } from "./launch-vector";
import { type PairedClient, type PendingPairingView, withLocalAuth } from "./local-auth";
import { projectIdFromPath } from "./projects/file-store";
import pkg from "../../package.json";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from HERE until finding a marker (package.json or .git), avoiding silent breakage when files move. */
function findRepoRoot(): string {
  let current = HERE;
  const root = path.parse(current).root;
  while (current !== root) {
    if (existsSync(path.join(current, "package.json")) || existsSync(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not find repo root from ${HERE}`);
}

const REPO_ROOT = findRepoRoot();

// ── tiny arg parser (positionals + --flags; --key=val or --key val or bare boolean) ──────────
interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else if (a === "-f") out.foreground = true;
    else out._.push(a);
  }
  return out;
}

class UsageError extends Error {}

// ── connection to a running daemon ────────────────────────────────────────────────────────────
/** Base URL of the running daemon (env override → instance pointer → default). Matches mcp.ts. */
function base(): string {
  if (process.env.DEVWEBUI_URL) return process.env.DEVWEBUI_URL;
  if (process.env.DEVWEBUI_PORT) return `http://localhost:${process.env.DEVWEBUI_PORT}`;
  return readInstanceInfo()?.url ?? daemonUrl();
}

/**
 * Every daemon call is bounded. Without a timeout a request to a host that accepts the
 * connection but never answers hangs forever — and the desktop-shortcut launcher runs
 * HIDDEN (wscript, no console), so that hang would be an invisible, silent process the
 * user can only find in Task Manager. Reachable in practice: `base()` prefers a
 * DEVWEBUI_PORT/DEVWEBUI_URL override over the instance pointer, so a stale value in the
 * environment points every call at the wrong place. Failing loudly after 20s beats
 * hanging quietly forever.
 */
const API_TIMEOUT_MS = 20_000;

async function api<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
  const url = `${base()}${pathname}`;
  let res: Response;
  try {
    // withLocalAuth: send the daemon's cookie file so a DEVWEBUI_REQUIRE_AUTH=1 daemon lets us in.
    res = await fetch(url, {
      ...withLocalAuth(url, init),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
    throw new Error(`could not reach the DevWebUI daemon at ${url} (${reason})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`daemon ${res.status}: ${text || res.statusText}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** RequestInit for a JSON POST. */
const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Working directory for a spawned daemon. A checkout runs from the repo root; the
 * compiled binary has no repo (REPO_ROOT resolves into Bun's virtual filesystem and
 * does not exist on disk), and spawn() throws outright on a missing cwd — so fall
 * back to the directory the exe actually lives in.
 */
function daemonCwd(): string {
  return isCompiledBinary() ? path.dirname(process.execPath) : REPO_ROOT;
}

/** Poll until a daemon answers /api/health, or the deadline passes. */
async function awaitLive(timeoutMs: number): Promise<InstanceInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await findLiveInstance(500);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * Cold-boot the daemon, but at most once across CONCURRENT launchers.
 *
 * Desktop shortcuts make this matter: the launcher is silent by design, so an impatient
 * double-double-click fires two `open-process` processes ~200ms apart. Both probe, both
 * see no daemon (index.ts's own guard can't help — it only rejects a second instance
 * once the FIRST has written runtime.json, which takes ~2s), both spawn, and the loser
 * hops to another port. Two daemons then disagree about which is "the" instance.
 *
 * `openSync(..., "wx")` is an atomic create-exclusive: exactly one launcher wins it and
 * boots; the rest wait for that boot instead of racing it. A lock left behind by a
 * crashed launcher goes stale and is reclaimed rather than wedging shortcuts forever.
 */
const BOOT_LOCK_STALE_MS = 60_000;

async function bootDaemonShared(env: NodeJS.ProcessEnv): Promise<InstanceInfo | null> {
  const lockFile = path.join(dataDir(), "boot.lock");
  mkdirSync(dataDir(), { recursive: true });

  let fd: number;
  try {
    fd = openSync(lockFile, "wx");
  } catch {
    // Someone else holds it. If it's stale, take it over; otherwise wait for their boot.
    let stale = false;
    try {
      stale = Date.now() - statSync(lockFile).mtimeMs > BOOT_LOCK_STALE_MS;
    } catch {
      stale = true; // vanished between the open and the stat — the holder finished
    }
    if (!stale) {
      const live = await awaitLive(25_000);
      if (live) return live;
    }
    try {
      unlinkSync(lockFile);
    } catch {
      /* another launcher cleaned up first */
    }
    return bootDaemonDetached(env);
  }

  try {
    return await bootDaemonDetached(env);
  } finally {
    try {
      closeSync(fd);
      unlinkSync(lockFile);
    } catch {
      /* best-effort; a leftover lock goes stale and is reclaimed above */
    }
  }
}

/**
 * Spawn this build's daemon detached and wait until it answers /api/health.
 * Resolves null on timeout. Callers that might race a sibling launcher should go
 * through {@link bootDaemonShared} instead.
 */
async function bootDaemonDetached(
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<InstanceInfo | null> {
  const [exe, ...rest] = daemonLaunchVector();
  const child = spawn(exe!, rest, {
    cwd: daemonCwd(),
    env,
    stdio: "ignore",
    detached: true,
    // The daemon is a console program (bun, or the console-subsystem devwebui.exe), and this
    // is the path a desktop shortcut boots it through — so it must never surface a console.
    // detached already implies DETACHED_PROCESS (no console inherited, none created), which
    // makes this redundant today and CreateProcess ignores it alongside DETACHED_PROCESS;
    // it's stated anyway so "no window" survives someone dropping `detached`, and to match
    // the auto-update relaunch in index.ts, which spawns the same binary with all three.
    windowsHide: true,
  });
  child.unref();
  return awaitLive(timeoutMs);
}

/** Require a live daemon and return its instance info, else a friendly error. */
async function requireLive(): Promise<InstanceInfo> {
  const live = await findLiveInstance();
  if (!live) throw new UsageError("DevWebUI isn't running. Start it with:  devwebui start");
  return live;
}

// ── process/project view shapes (subset of server/src/process-view.ts) ────────────────────────
interface ProcessView {
  id: string;
  localId: string;
  name: string;
  port: number | null;
  projectId: string;
  projectName: string;
  status: string;
}
interface ProjectView {
  id: string;
  name: string;
  processes: ProcessView[];
}

// ── output helpers ────────────────────────────────────────────────────────────────────────────
function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ")).join("\n");
}

function printProcesses(procs: ProcessView[]): void {
  if (!procs.length) {
    console.log("No managed processes. Load a project's .devwebui file in the GUI first.");
    return;
  }
  const rows = [["STATUS", "NAME", "PORT", "PROJECT", "ID"]];
  for (const p of procs) {
    rows.push([p.status, p.name, p.port ? String(p.port) : "-", p.projectName, p.id]);
  }
  console.log(table(rows));
}

/** Resolve a user-supplied process reference (id, name, localId, or "project:local") to its id. */
async function resolveProcessId(ref: string): Promise<string> {
  const procs = await api<ProcessView[]>(ROUTES.processes);
  const exact = procs.find((p) => p.id === ref);
  if (exact) return exact.id;
  const low = ref.toLowerCase();
  const matches = procs.filter(
    (p) =>
      p.name.toLowerCase() === low ||
      p.localId.toLowerCase() === low ||
      `${p.projectName}:${p.localId}`.toLowerCase() === low,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new UsageError(
      `"${ref}" matches ${matches.length} processes — use the full id:\n` +
        matches.map((p) => `  ${p.id}  (${p.projectName} · ${p.name})`).join("\n"),
    );
  }
  throw new UsageError(`No process matches "${ref}". Run \`devwebui list\` to see them.`);
}

// ── alerts (threshold rules on process CPU/memory + fired-event history) ─────────────────────
// Mirrors the five MCP alert tools (server/src/mcp.ts) 1:1 over the same REST routes, so a
// human at a terminal and an AI agent over MCP have identical capability — see AI_GUIDE.md's
// GUI/CLI/MCP parity convention.

function parseMetric(raw: string | undefined): AlertMetric {
  if (raw === "cpu" || raw === "memory") return raw;
  throw new UsageError(`metric must be "cpu" or "memory", got ${raw ? `"${raw}"` : "nothing"}`);
}

function fmtThreshold(metric: AlertMetric, value: number): string {
  return metric === "cpu" ? `${value}%` : `${Math.round(value / 1_048_576)} MB`;
}

function printAlertRules(rules: AlertRule[]): void {
  if (!rules.length) {
    console.log(
      "No alert rules. Add one with `devwebui alerts add <process> <cpu|memory> <threshold>`.",
    );
    return;
  }
  const rows = [["ID", "PROCESS", "METRIC", "THRESHOLD", "FOR", "ENABLED"]];
  for (const r of rules) {
    rows.push([
      r.id,
      r.processId,
      r.metric,
      fmtThreshold(r.metric, r.threshold),
      `${Math.round(r.forMs / 1000)}s`,
      r.enabled ? "yes" : "no",
    ]);
  }
  console.log(table(rows));
}

function printAlertEvents(events: AlertEvent[]): void {
  if (!events.length) {
    console.log("No fired alert events.");
    return;
  }
  const rows = [["FIRED", "PROCESS", "PROJECT", "METRIC", "VALUE", "THRESHOLD"]];
  for (const e of events) {
    rows.push([
      new Date(e.firedAt).toISOString(),
      e.processName,
      e.projectName,
      e.metric,
      fmtThreshold(e.metric, e.value),
      fmtThreshold(e.metric, e.threshold),
    ]);
  }
  console.log(table(rows));
}

const ALERTS_USAGE = `Usage:
  devwebui alerts list [--json]
  devwebui alerts add <process> <cpu|memory> <threshold> [--for-secs N] [--disabled]
    threshold is percent-of-one-core for cpu, or a byte count for memory
    (matching the daemon's live process metrics — see \`devwebui status\`).
  devwebui alerts remove <ruleId>
  devwebui alerts events [--json]
  devwebui alerts clear [--process <id|name>]`;

async function alertsList(args: Args): Promise<void> {
  const rules = await api<AlertRule[]>(ROUTES.alertRules);
  if (args.json) console.log(JSON.stringify(rules, null, 2));
  else printAlertRules(rules);
}

async function alertsAdd(rest: string[], args: Args): Promise<void> {
  const [ref, metricRaw, thresholdRaw] = rest;
  if (!ref || !metricRaw || thresholdRaw === undefined) throw new UsageError(ALERTS_USAGE);
  const metric = parseMetric(metricRaw);
  const threshold = Number(thresholdRaw);
  if (!Number.isFinite(threshold)) {
    throw new UsageError(`threshold must be a number, got "${thresholdRaw}"`);
  }
  const forSecs = typeof args["for-secs"] === "string" ? Number(args["for-secs"]) : 0;
  if (!Number.isFinite(forSecs) || forSecs < 0) {
    throw new UsageError(`--for-secs must be a non-negative number, got "${args["for-secs"]}"`);
  }
  const processId = await resolveProcessId(ref);
  const rule = await api<AlertRule>(
    ROUTES.alertRules,
    jsonPost({
      processId,
      metric,
      threshold,
      forMs: Math.round(forSecs * 1000),
      enabled: args.disabled ? false : undefined,
    }),
  );
  console.log(
    `Added alert rule ${rule.id}: ${processId} ${metric} > ${fmtThreshold(metric, threshold)} for ${forSecs}s.`,
  );
}

async function alertsRemove(rest: string[]): Promise<void> {
  const [id] = rest;
  if (!id) throw new UsageError(ALERTS_USAGE);
  await api(ROUTES.alertRule.build(id), { method: "DELETE" });
  console.log(`Removed alert rule ${id}.`);
}

async function alertsEvents(args: Args): Promise<void> {
  const events = await api<AlertEvent[]>(ROUTES.alertEvents);
  if (args.json) console.log(JSON.stringify(events, null, 2));
  else printAlertEvents(events);
}

async function alertsClear(args: Args): Promise<void> {
  const processId =
    typeof args.process === "string" ? await resolveProcessId(args.process) : undefined;
  await api(
    `${ROUTES.alertEventsClear}${processId ? `?processId=${encodeURIComponent(processId)}` : ""}`,
    { method: "POST" },
  );
  console.log(processId ? `Cleared alert events for ${processId}.` : "Cleared all alert events.");
}

const PAIRING_USAGE = `Usage:
  devwebui pairing codes [--json]      Open pairing requests and the code each one waits for
  devwebui pairing clients [--json]    Paired browsers/devices
  devwebui pairing revoke <clientId>   Revoke one paired client`;

/** `devwebui pairing ...`: the trusted channel that shows a browser's pairing code (this call
 *  itself carries the cookie file, so only the owner sees codes) and manages paired clients. */
async function pairingCmd(args: Args): Promise<void> {
  await requireLive();
  const [sub, id] = args._;
  if (sub === "codes") {
    const codes = await api<PendingPairingView[]>(ROUTES.pairingCodes);
    if (args.json) console.log(JSON.stringify(codes, null, 2));
    else if (!codes.length) console.log("No open pairing requests.");
    else
      console.log(
        table([["CODE", "LABEL", "EXPIRES"], ...codes.map((p) => [p.code, p.label, p.expiresAt])]),
      );
    return;
  }
  if (sub === "clients") {
    const clients = await api<PairedClient[]>(ROUTES.pairingClients);
    if (args.json) console.log(JSON.stringify(clients, null, 2));
    else if (!clients.length) console.log("No paired clients.");
    else
      console.log(
        table([["ID", "LABEL", "PAIRED"], ...clients.map((c) => [c.id, c.label, c.createdAt])]),
      );
    return;
  }
  if (sub === "revoke" && id) {
    await api(ROUTES.pairingClient.build(id), { method: "DELETE" });
    console.log(`Revoked paired client ${id}.`);
    return;
  }
  throw new UsageError(PAIRING_USAGE);
}

async function alertsCmd(args: Args): Promise<void> {
  await requireLive(); // every subcommand needs a daemon, including the usage error below
  const [sub, ...rest] = args._;

  switch (sub) {
    case "list":
      return alertsList(args);
    case "add":
      return alertsAdd(rest, args);
    case "remove":
      return alertsRemove(rest);
    case "events":
      return alertsEvents(args);
    case "clear":
      return alertsClear(args);
    default:
      throw new UsageError(ALERTS_USAGE);
  }
}

// ── verbs ──────────────────────────────────────────────────────────────────────────────────────
async function startCmd(args: Args): Promise<void> {
  const live = await findLiveInstance();
  if (live) {
    console.log(`DevWebUI is already running  →  ${live.url}`);
    return;
  }
  const env = { ...process.env };
  if (typeof args.port === "string") env.DEVWEBUI_PORT = args.port;
  // The launch vector is process.execPath + the right arguments for THIS build: the real
  // bun binary plus index.ts from a checkout (never the string "bun" — on Windows that may
  // be a .cmd shim CreateProcess can't spawn directly; same reason as server/src/dev.ts),
  // or the compiled exe alone, which has no index.ts to point at.
  const [exe, ...rest] = daemonLaunchVector();

  // Foreground: run the daemon attached (inherit stdio + await) — behaves like `bun server/src/index.ts`.
  if (args.foreground) {
    const child = spawn(exe!, rest, { cwd: daemonCwd(), env, stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return;
  }

  // Detached (default): spawn the daemon in the background (detached + unref so it outlives this
  // CLI process), then poll until it answers /api/health and print the URL it actually bound (it
  // may have hopped off a busy port).
  const info = await bootDaemonDetached(env);
  if (!info)
    throw new Error(
      "the daemon didn't come up within 20s — try `devwebui start --foreground` to see why.",
    );
  console.log(`DevWebUI daemon started  →  ${info.url}  (pid ${info.pid})`);
}

async function stopCmd(): Promise<void> {
  const live = await findLiveInstance();
  if (!live) {
    console.log("DevWebUI isn't running.");
    return;
  }
  // The shutdown route accepts the `ui` source header without a token (see http/core.ts).
  const shutdownUrl = `${live.url}${ROUTES.shutdown}`;
  const init = { method: "POST", headers: { "x-devwebui-shutdown-source": "ui" } };
  const res = await fetch(shutdownUrl, withLocalAuth(shutdownUrl, init));
  if (!res.ok) throw new Error(`shutdown refused (${res.status}): ${await res.text()}`);
  console.log(`Stopped DevWebUI (${live.url}).`);
}

async function statusCmd(args: Args): Promise<void> {
  const live = await findLiveInstance();
  if (!live) {
    if (args.json) console.log(JSON.stringify({ running: false }, null, 2));
    else console.log("DevWebUI: not running.  Start it with `devwebui start`.");
    return;
  }
  const [projects, processes] = await Promise.all([
    api<ProjectView[]>(ROUTES.projects).catch(() => [] as ProjectView[]),
    api<ProcessView[]>(ROUTES.processes).catch(() => [] as ProcessView[]),
  ]);
  if (args.json) {
    console.log(JSON.stringify({ running: true, ...live, projects, processes }, null, 2));
    return;
  }
  const running = processes.filter((p) => p.status === "running").length;
  console.log(
    `DevWebUI  →  ${live.url}  (pid ${live.pid})\n` +
      `projects  →  ${projects.length}\n` +
      `processes →  ${processes.length} (${running} running)\n`,
  );
  printProcesses(processes);
}

async function listCmd(args: Args): Promise<void> {
  await requireLive();
  const processes = await api<ProcessView[]>(ROUTES.processes);
  if (args.json) console.log(JSON.stringify(processes, null, 2));
  else printProcesses(processes);
}

async function processActionCmd(action: string, ref: string | undefined): Promise<void> {
  await requireLive();
  if (!ref) throw new UsageError(`Usage: devwebui ${action}-process <id|name>`);
  const id = await resolveProcessId(ref);
  await api(ROUTES.processAction.build(id, action), { method: "POST" });
  console.log(`${action}: ${id}`);
}

async function bulkCmd(route: string, label: string): Promise<void> {
  await requireLive();
  await api(route, { method: "POST" });
  console.log(label);
}

/**
 * Desktop-shortcut entry point (`server/src/shortcuts.ts` bakes this into every .lnk).
 *
 * Identity arrives as (.devwebui absolute path + localId) rather than a global process
 * id so the shortcut keeps working even if the project has since been removed from
 * DevWebUI — we just load it again. The id is recomputed locally with the very same
 * `projectIdFromPath` the daemon uses, so the two can never disagree.
 *
 * The load step is guarded, and that guard is the whole point: POSTing projects/load
 * for an ALREADY-loaded project is not a no-op, it's a hard reload that purges every
 * entry — killing running children — and re-autostarts them (manager/projects.ts
 * addProject). Loading unconditionally here would mean one shortcut click restarted
 * every server in that repo. Match on id, which IS the normalized path hash.
 */
async function openCmd(kind: "process" | "project", args: Args): Promise<void> {
  const [filePath, localId] = args._;
  const usage = `Usage: devwebui open-${kind} <path-to .devwebui>${
    kind === "process" ? " <processId>" : ""
  }`;
  if (!filePath) throw new UsageError(usage);
  if (kind === "process" && !localId) throw new UsageError(usage);

  const abs = path.resolve(filePath);
  const projectId = projectIdFromPath(abs);

  // 1. A daemon must exist — it's the supervisor, and a shortcut is often the first
  //    thing touched after a reboot. Cold-boot it rather than failing, under the shared
  //    lock so an impatient double-double-click can't race two daemons into existence.
  let live = await findLiveInstance();
  if (!live) live = await bootDaemonShared({ ...process.env });
  if (!live)
    throw new Error(
      "DevWebUI's daemon didn't start within 20s — run `devwebui start --foreground` to see why.",
    );

  // 2. Register the project only if it isn't already (see the hard-reload note above).
  const projects = await api<ProjectView[]>(ROUTES.projects);
  if (!projects.some((p) => p.id === projectId)) {
    await api(ROUTES.projectsLoad, jsonPost({ path: abs }));
  }

  // 3. Start. For a process this is the ordinary start action, so linked siblings and
  //    project companions come up with it exactly as they do from the GUI; starting an
  //    already-running process is a no-op (lifecycle.ts start()), which is what makes
  //    double-clicking the shortcut twice harmless.
  if (kind === "project") {
    await api(ROUTES.projectAction.build(projectId, "start"), { method: "POST" });
  } else {
    await api(ROUTES.processAction.build(`${projectId}.${localId}`, "start"), {
      method: "POST",
    });
  }

  // 4. Show something. A process shortcut opens the focused single-process view (its
  //    Stop button is the whole reason the window exists); a project shortcut has no
  //    single subject, so it opens the dashboard. Best-effort: a machine with no
  //    Chromium still started the server, which is the point — don't fail the launch
  //    over a missing browser.
  const view = kind === "project" ? "/" : focusPath(`${projectId}.${localId}`);
  try {
    await api(ROUTES.portableWindow, jsonPost({ path: view }));
  } catch {
    /* the server is up; the window is a convenience */
  }
  console.log(kind === "project" ? `Started project ${projectId}.` : `Started ${localId}.`);
}

/**
 * Drag-and-drop entry point for the desktop shortcut. The tray adapter (misc/DevWebUI-Tray.ps1)
 * runs `devwebui open <path>` for each path dropped onto the .lnk:
 *   · a FOLDER      → scoped-scan it and ADD every .devwebui project + detectable dev-server
 *                     folder found (register only; the user asked for "add", not "run").
 *   · a .devwebui   → load it and START its servers, exactly like a project shortcut.
 * Boots the daemon first if it isn't already up (shared boot lock, like open-process/-project).
 */
async function openDropCmd(args: Args): Promise<void> {
  const paths = args._;
  if (!paths.length) throw new UsageError("Usage: devwebui open <folder-or-.devwebui> [more…]");

  let live = await findLiveInstance();
  if (!live) live = await bootDaemonShared({ ...process.env });
  if (!live)
    throw new Error(
      "DevWebUI's daemon didn't start within 20s — run `devwebui start --foreground` to see why.",
    );

  let startedAProject = false;
  for (const raw of paths) {
    const abs = path.resolve(raw);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      console.error(`Skipped (not found): ${abs}`);
      continue;
    }
    if (isDir) {
      await addFolder(abs);
    } else if (abs.toLowerCase().endsWith(".devwebui")) {
      await startProjectFile(abs);
      startedAProject = true;
    } else {
      console.error(`Skipped (not a folder or a .devwebui file): ${abs}`);
    }
  }

  // A started project already opened its own window; otherwise show the dashboard so the user
  // sees what was added. Best-effort — the work is done regardless of whether a browser exists.
  if (!startedAProject) {
    try {
      await api(ROUTES.portableWindow, jsonPost({ path: "/" }));
    } catch {
      /* the server is up; the window is a convenience */
    }
  }
}

/** Load a dropped .devwebui (only if not already loaded — see the hard-reload note on openCmd)
 *  and start its project, so every server it defines comes up. */
async function startProjectFile(abs: string): Promise<void> {
  const projectId = projectIdFromPath(abs);
  const projects = await api<ProjectView[]>(ROUTES.projects);
  if (!projects.some((p) => p.id === projectId)) {
    await api(ROUTES.projectsLoad, jsonPost({ path: abs }));
  }
  await api(ROUTES.projectAction.build(projectId, "start"), { method: "POST" });
  try {
    await api(ROUTES.portableWindow, jsonPost({ path: "/" }));
  } catch {
    /* window is a convenience */
  }
  console.log(`Started ${projectId} (${path.basename(abs)}).`);
}

/** Scoped-scan a dropped folder. A NEW project is ADDED (registered, not started) — a .devwebui
 *  already on disk is loaded as-is; a detected dev-server folder gets one scaffolded from its
 *  scripts. A project that is ALREADY added is STARTED instead (owner request: re-dropping a folder
 *  you've already added is how you run it). */
async function addFolder(dir: string): Promise<void> {
  const scan = await api<ScanResult>(
    ROUTES.projectsScan,
    jsonPost({ roots: [dir], preset: "scoped", detectPackages: true }),
  );
  const existing = new Set((await api<ProjectView[]>(ROUTES.projects)).map((p) => p.id));
  let added = 0;
  let started = 0;

  // Configured projects (a .devwebui on disk): already added → start it; otherwise → add it.
  for (const f of scan.files) {
    const id = projectIdFromPath(f.path);
    try {
      if (existing.has(id)) {
        await api(ROUTES.projectAction.build(id, "start"), { method: "POST" });
        started++;
      } else {
        await api(ROUTES.projectsLoad, jsonPost({ path: f.path }));
        added++;
      }
    } catch (e) {
      console.error(`  skipped ${f.path}: ${(e as Error).message}`);
    }
  }
  // Detected dev-server folders have no .devwebui yet, so they can never be already-added — scaffold
  // one from the detected scripts, and it becomes a registered project.
  for (const d of scan.detected) {
    try {
      const res = await api<{
        ok?: boolean;
        needsScaffold?: boolean;
        dir?: string;
        fileName?: string;
        proposal?: unknown;
      }>(ROUTES.projectsLoad, jsonPost({ path: d.path }));
      if (res.needsScaffold && res.dir && res.proposal) {
        await api(
          ROUTES.projectsScaffold,
          jsonPost({ dir: res.dir, fileName: res.fileName, project: res.proposal }),
        );
        added++;
      } else if (res.ok) {
        added++;
      }
    } catch (e) {
      console.error(`  skipped ${d.path}: ${(e as Error).message}`);
    }
  }
  console.log(
    `Scanned ${dir} — added ${added}, started ${started} already-added ` +
      `(${scan.files.length} configured, ${scan.detected.length} detected).`,
  );
}

function printHelp(): void {
  console.log(`devwebui — run & drive DevWebUI from the command line

Daemon lifecycle:
  devwebui start [--port N] [--foreground]   Boot the daemon (detached; prints the URL). -f runs attached.
  devwebui stop                              Gracefully stop the running daemon
  devwebui status [--json]                   Running? where? + project/process summary

Drive a running daemon:
  devwebui list | ps [--json]                List managed processes
  devwebui start-process   <id|name>         Start a process
  devwebui stop-process    <id|name>         Stop a process
  devwebui restart-process <id|name>         Restart a process
  devwebui enable-process  <id|name>         Enable (allow autostart) a process
  devwebui disable-process <id|name>         Disable a process
  devwebui start-all | stop-all              Start / stop every managed process
  devwebui mcp                               Run the stdio MCP server (for AI agents)

Threshold alerts ("alert if this process exceeds 80% CPU for 2 minutes"):
  devwebui alerts list [--json]              List configured alert rules
  devwebui alerts add <process> <cpu|memory> <threshold> [--for-secs N] [--disabled]
                                             Add a rule (threshold: CPU % or memory in bytes)
  devwebui alerts remove <ruleId>            Delete a rule
  devwebui alerts events [--json]            List fired alert events, most recent first
  devwebui alerts clear [--process <id|name>] Clear fired-event history (optionally one process)

Local API auth (enforced when the daemon runs with DEVWEBUI_REQUIRE_AUTH=1):
  devwebui pairing codes [--json]            Show the code a browser asking to pair is waiting for
  devwebui pairing clients [--json]          List paired browsers/devices
  devwebui pairing revoke <clientId>         Revoke one paired client

Desktop shortcuts (what a .lnk from "Add desktop shortcut" runs):
  devwebui open-process <file.devwebui> <id> Boot the daemon if needed, load the project if
                                             needed, start that process (+ its linked group)
                                             and open its focused window
  devwebui open-project <file.devwebui>      Same, for every process in the project
  devwebui open <folder | file.devwebui>     Drag-and-drop handler: a FOLDER is scanned and its
                                             projects/dev-servers are ADDED; a .devwebui file is
                                             loaded and STARTED. Boots the daemon if needed.

Connection: DEVWEBUI_URL / DEVWEBUI_PORT override the daemon location.`);
}

/** One dispatch-table entry per CLI verb; `args` is the parsed rest, `ref` is `args._[0]`. */
type CliHandler = (
  args: ReturnType<typeof parseArgs>,
  ref: string | undefined,
) => Promise<void> | void;

const CLI_COMMANDS: Record<string, CliHandler> = {
  "--version": () => console.log(pkg.version),
  version: () => console.log(pkg.version),

  start: (args) => startCmd(args),
  stop: () => stopCmd(),
  status: (args) => statusCmd(args),
  list: (args) => listCmd(args),
  ps: (args) => listCmd(args),

  "start-process": (_args, ref) => processActionCmd("start", ref),
  "stop-process": (_args, ref) => processActionCmd("stop", ref),
  "restart-process": (_args, ref) => processActionCmd("restart", ref),
  "enable-process": (_args, ref) => processActionCmd("enable", ref),
  "disable-process": (_args, ref) => processActionCmd("disable", ref),

  "start-all": () => bulkCmd(ROUTES.startAll, "Started all processes."),
  "stop-all": () => bulkCmd(ROUTES.stopAll, "Stopped all processes."),

  alerts: (args) => alertsCmd(args),
  pairing: (args) => pairingCmd(args),

  "open-process": (args) => openCmd("process", args),
  "open-project": (args) => openCmd("project", args),
  open: (args) => openDropCmd(args),

  // Run the stdio MCP server IN THIS PROCESS (it connects StdioServerTransport on import),
  // so `devwebui mcp` is exactly what a tool-calling agent spawns. Emits only JSON-RPC on stdout.
  mcp: async () => {
    await import("./mcp");
  },

  "-h": () => printHelp(),
  "--help": () => printHelp(),
  help: () => printHelp(),
};

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help";
  const args = parseArgs(argv.slice(1));
  const ref = args._[0];

  const handler = CLI_COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  await handler(args, ref);
}

/**
 * {@link main} plus the standard error formatting and exit code. Both entry points —
 * the `devwebui` bin below, and index.ts's argv dispatch inside the compiled exe —
 * go through this so they behave identically instead of each rolling their own catch.
 */
export async function run(argv: string[]): Promise<void> {
  try {
    await main(argv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err instanceof UsageError ? msg : `Error: ${msg}`);
    process.exitCode = 1;
  }
}

// Run when invoked as the bin/entrypoint (not when imported by a test, and not when
// index.ts imports this to dispatch a verb — there import.meta.main belongs to index).
if (import.meta.main) void run(process.argv.slice(2));
