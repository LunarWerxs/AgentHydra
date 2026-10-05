// DevWebUI MCP server (stdio) — a thin client over the running daemon's REST API, so the GUI,
// the CLI, and agents share one source of truth. Start the daemon first (`devwebui start`);
// point elsewhere with DEVWEBUI_URL / DEVWEBUI_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is
// only the app-specific part: an HTTP client + a tool table, each tool a 1:1 wrapper over a
// ROUTES.* endpoint. Replaces the previous @modelcontextprotocol/sdk-based server (dep dropped).
import { daemonUrl } from "./constants";
import { readInstanceInfo } from "./instance";
import { withLocalAuth } from "./local-auth";
import { ROUTES } from "../../shared/routes";
import { runMcpStdio } from "./mcp-stdio.mjs";
import pkg from "../../package.json";
import type { McpEngineTool } from "./mcp-stdio.mjs";
import { findSourceFrames } from "../../shared/source-frames";
import type { ErrorEvent } from "../../shared/dto";

// Resolve the base URL per call: an explicit DEVWEBUI_URL/DEVWEBUI_PORT always wins, else follow
// the port the daemon ACTUALLY bound (~/.devwebui/runtime.json), so an auto-hopped port still works.
function daemonBase(): string {
  if (process.env.DEVWEBUI_URL) return process.env.DEVWEBUI_URL;
  if (process.env.DEVWEBUI_PORT) return `http://localhost:${process.env.DEVWEBUI_PORT}`;
  return readInstanceInfo()?.url ?? daemonUrl();
}

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    // The cookie file is what lets the shim through once the daemon enforces local auth.
    const url = `${daemonBase()}${pathname}`;
    res = await fetch(url, withLocalAuth(url, init));
  } catch (e) {
    throw new Error(
      `couldn't reach the DevWebUI daemon at ${daemonBase()} — start it with \`devwebui start\`. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!res.ok) throw new Error(`DevWebUI ${res.status}: ${await res.text()}`);
  return res.json();
}

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
const S = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const JSON_HEADERS = { "content-type": "application/json" };
const str = (v: unknown): string => String(v ?? "");

// Shared JSON-Schema fragment for a process's editable config (add_process / update_process).
// Mirrors the ProcessInput DTO — `env` is intentionally omitted (schema-only; the GUI doesn't
// edit it either, and update_process preserves an entry's existing env when the body omits it).
const PROCESS_FIELDS: Record<string, unknown> = {
  id: {
    type: "string",
    description: "Process id — unique within the project; letters, numbers, . _ -",
  },
  name: { type: "string", description: "Display name shown on the process's card." },
  command: {
    type: "string",
    description: "Shell command that starts the server, e.g. 'bun run dev'.",
  },
  cwd: {
    type: "string",
    description: "Working directory, relative to the .devwebui file (optional).",
  },
  color: {
    type: "string",
    description: "Accent color as a hex string, e.g. '#22c55e' (optional).",
  },
  port: {
    type: "number",
    description: "Port the server listens on — enables conflict detection + free_port (optional).",
  },
  url: {
    type: "string",
    description:
      "Click-through target: an http(s):// URL, or a /path appended to the host (optional).",
  },
  autostart: { type: "boolean", description: "Launch when DevWebUI starts (optional)." },
  starred: {
    type: "boolean",
    description: "Float this process to the top of every list (optional).",
  },
  runtime: {
    type: "string",
    enum: ["node", "bun"],
    description: "Runtime to launch under; omit for the global default (optional).",
  },
  waitForPort: {
    type: ["number", "string"],
    description:
      "Wait for this port (number) or sibling process id (string) to be listening before starting (optional).",
  },
  links: {
    type: "array",
    items: { type: "string" },
    description:
      "Sibling process ids that start/stop as one linked group with this one (optional).",
  },
  companion: {
    type: "boolean",
    description:
      "Start whenever any other process in the project is started individually (optional).",
  },
};

// Pick just the process-config keys out of a tool's args → the ProcessInput body the daemon
// expects. JSON.stringify drops the `undefined` keys, so only the provided fields are sent.
const procBody = (a: Record<string, unknown>) => ({
  id: a.id,
  name: a.name,
  command: a.command,
  cwd: a.cwd,
  color: a.color,
  port: a.port,
  url: a.url,
  autostart: a.autostart,
  starred: a.starred,
  runtime: a.runtime,
  waitForPort: a.waitForPort,
  links: a.links,
  companion: a.companion,
});

// Browser-bridge tools: each fans one question out to the live tabs of a supervised app (see
// server/src/browser-bridge.ts) and returns one answer per tab, partial if some tab is slow.
const TAB_TARGET: Record<string, unknown> = {
  processId: {
    type: "string",
    description: "Only tabs whose page is on this process's declared port (optional).",
  },
  tabId: { type: "string", description: "Only this tab, from list_browser_tabs (optional)." },
  timeoutMs: {
    type: "number",
    description: "How long to wait for slow tabs, in ms (optional; default 5000, max 30000).",
  },
};
const browserQuery = (kind: string, a: Record<string, unknown>, extra: object = {}) =>
  api(ROUTES.browserQuery, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      kind,
      processId: a.processId,
      tabId: a.tabId,
      timeoutMs: a.timeoutMs,
      ...extra,
    }),
  });
const BROWSER_QUERY_TOOLS: McpEngineTool[] = [
  {
    name: "get_browser_errors",
    description:
      "Client-side runtime errors buffered in the live browser tabs of a dev app (uncaught errors, failed resource loads, unhandled promise rejections, console.error), most recent last, one entry per tab. These never reach the dev server's stdout, so list_errors cannot see them. Needs the page to load DevWebUI's browser snippet.",
    inputSchema: S(TAB_TARGET),
    run: (a) => browserQuery("errors", a),
  },
  {
    name: "get_page_metadata",
    description:
      "What each live tab of a dev app is showing: URL, title, ready state, viewport, meta tags, load timing, buffered error count and the names of tools the page registered. Needs the page to load DevWebUI's browser snippet.",
    inputSchema: S(TAB_TARGET),
    run: (a) => browserQuery("metadata", a),
  },
  {
    name: "list_page_tools",
    description:
      "Inspection tools a dev app registered on its own page with window.__devwebui.register(name, { description, inputSchema, run }) - e.g. a component tree or element-to-source-file lookup. Returns each tab's tool names, descriptions and input schemas; run one with call_page_tool.",
    inputSchema: S(TAB_TARGET),
    run: (a) => browserQuery("tools", a),
  },
  {
    name: "call_page_tool",
    description:
      "Run one tool a dev app registered on its page (see list_page_tools) with `args`, in exactly ONE tab: pass tabId or processId when more than one tab is connected. A tool that throws comes back as that tab's `error`.",
    inputSchema: S(
      {
        tool: { type: "string", description: "The page tool's name." },
        args: { type: "object", description: "Arguments for the tool (optional)." },
        ...TAB_TARGET,
      },
      ["tool"],
    ),
    run: (a) => browserQuery("call", a, { tool: a.tool, args: a.args }),
  },
];

const TOOLS: McpEngineTool[] = [
  {
    name: "list_projects",
    description: "List loaded projects (codebases), each with its processes and live status.",
    inputSchema: S(),
    run: () => api(ROUTES.projects),
  },
  {
    name: "load_project",
    description:
      "Load a .devwebui file by absolute path (registers its processes and remembers it).",
    inputSchema: S({ path: { type: "string" } }, ["path"]),
    run: (a) =>
      api(ROUTES.projectsLoad, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: a.path }),
      }),
  },
  {
    name: "update_project",
    description:
      "Rename and/or recolor a project (rewrites its .devwebui file). Omit `name` to keep the current name; pass `color` as a hex like '#22c55e', or an empty string to clear it back to the theme default. Leaves the project's processes and their running state untouched.",
    inputSchema: S(
      {
        id: { type: "string" },
        name: {
          type: "string",
          description: "New project name (optional; omit to keep the current one).",
        },
        color: {
          type: "string",
          description: "New accent color hex, or '' to clear back to default (optional).",
        },
      },
      ["id"],
    ),
    run: (a) =>
      api(ROUTES.projectUpdate.build(str(a.id)), {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: a.name, color: a.color }),
      }),
  },
  {
    name: "clone_project",
    description:
      "Clone a git repo into `dest`, then load it (or report that it needs scaffolding). Both are absolute paths on this machine.",
    inputSchema: S({ url: { type: "string" }, dest: { type: "string" } }, ["url", "dest"]),
    run: (a) =>
      api(ROUTES.projectsClone, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ url: a.url, dest: a.dest }),
      }),
  },
  {
    name: "scan_projects",
    description:
      "Sweep the machine for existing .devwebui files (and, with detectPackages, folders whose dev scripts could become one). Returns found files + detected folders; loads nothing. `preset`: startup | quick | deep | scoped.",
    inputSchema: S({
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Absolute dirs to scan (optional; defaults to sensible roots).",
      },
      preset: {
        type: "string",
        enum: ["startup", "quick", "deep", "scoped"],
        description: "Server-owned scan profile (optional).",
      },
      detectPackages: {
        type: "boolean",
        description: "Also detect package.json dev scripts as candidate projects (optional).",
      },
      maxDepth: {
        type: "number",
        description: "Override the preset's directory depth (optional).",
      },
      limit: { type: "number", description: "Max results before truncating (optional)." },
      budgetMs: { type: "number", description: "Time budget in milliseconds (optional)." },
    }),
    run: (a) =>
      api(ROUTES.projectsScan, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          roots: a.roots,
          preset: a.preset,
          detectPackages: a.detectPackages,
          maxDepth: a.maxDepth,
          limit: a.limit,
          budgetMs: a.budgetMs,
        }),
      }),
  },
  {
    name: "remove_project",
    description: "Unload a project by id (stops its processes and forgets it).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "remove"), { method: "POST" }),
  },
  {
    name: "start_project",
    description:
      "Start every process in a project now (transient — does NOT change each process's saved on/off preference; use enable_project to also flip it on).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "start"), { method: "POST" }),
  },
  {
    name: "stop_project",
    description:
      "Stop every process in a project now (transient — does NOT change each process's saved on/off preference; use disable_project to also flip it off).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "stop"), { method: "POST" }),
  },
  {
    name: "list_processes",
    description:
      "List every managed dev-server process with its live status, pid, uptime, CPU and memory.",
    inputSchema: S(),
    run: () => api(ROUTES.processes),
  },
  {
    // Saves an agent the list/ps-then-guess-the-URL dance: one block to paste into its context.
    name: "get_runtime_services",
    description:
      "Get a paste-ready <RUNTIME_SERVICES> block (plus the same data as `services`) listing every running dev server as reachable from THIS machine: its base URL, status, pid, and the NAMES (never values) of its .devwebui env vars that hold credentials. Also lists the DevWebUI daemon with its health URL. Pass includeStopped:true to list stopped/crashed processes too.",
    inputSchema: S({
      includeStopped: {
        type: "boolean",
        description: "Also list processes that are not running (optional; default false).",
      },
    }),
    run: (a) => api(`${ROUTES.runtimeServices}${a.includeStopped ? "?all=1" : ""}`),
  },
  {
    name: "add_process",
    description:
      "Add a new process to a project's .devwebui file. Requires the project id plus the process id, name and command; every other field is optional. The daemon reloads the project so the new process appears immediately.",
    inputSchema: S(
      {
        projectId: {
          type: "string",
          description: "The project (codebase) id to add the process into.",
        },
        ...PROCESS_FIELDS,
      },
      ["projectId", "id", "name", "command"],
    ),
    run: (a) =>
      api(ROUTES.projectProcesses.build(str(a.projectId)), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(procBody(a)),
      }),
  },
  {
    name: "update_process",
    description:
      "Replace a process's entire config in a project's .devwebui file. `localId` identifies the existing entry; send its FULL definition (id, name, command + any options), not just the changed field. Renaming the id follows every sibling link. Unchanged running processes keep running.",
    inputSchema: S(
      {
        projectId: { type: "string", description: "The project (codebase) id." },
        localId: {
          type: "string",
          description: "The process's CURRENT in-file id (the entry being edited).",
        },
        ...PROCESS_FIELDS,
      },
      ["projectId", "localId", "id", "name", "command"],
    ),
    run: (a) =>
      api(ROUTES.projectProcess.build(str(a.projectId), str(a.localId)), {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(procBody(a)),
      }),
  },
  {
    name: "remove_process",
    description:
      "Delete a process from a project's .devwebui file by its in-file id. A project must keep at least one process (remove the whole project instead). Prunes the removed id from every sibling's links.",
    inputSchema: S({ projectId: { type: "string" }, localId: { type: "string" } }, [
      "projectId",
      "localId",
    ]),
    run: (a) =>
      api(ROUTES.projectProcess.build(str(a.projectId), str(a.localId)), { method: "DELETE" }),
  },
  {
    name: "set_process_starred",
    description:
      "Star or unstar a process (starred processes float to the top of every list). `starred: true` to star, `false` to unstar.",
    inputSchema: S(
      {
        projectId: { type: "string" },
        localId: { type: "string" },
        starred: { type: "boolean" },
      },
      ["projectId", "localId", "starred"],
    ),
    run: (a) =>
      api(ROUTES.projectProcessStar.build(str(a.projectId), str(a.localId)), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ starred: !!a.starred }),
      }),
  },
  {
    name: "create_process_shortcut",
    description:
      "Create a Windows Desktop shortcut that starts one process later without opening the dashboard. Double-clicking it boots the daemon if needed, loads the project if needed, starts the process (plus its linked/companion processes) and opens a focused window with a Stop button. Windows-only: elsewhere it returns { ok: false, reason: 'unsupported-platform' }.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processShortcut.build(str(a.id)), { method: "POST" }),
  },
  {
    name: "create_project_shortcut",
    description:
      "Create a Windows Desktop shortcut that starts EVERY process in a project. Same behaviour as create_process_shortcut, but project-wide and it opens the dashboard rather than a single-process window.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectShortcut.build(str(a.id)), { method: "POST" }),
  },
  {
    name: "start_process",
    description:
      "Start a managed process by id. Its linked processes (`links`) and the project's companion processes start with it.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "start"), { method: "POST" }),
  },
  {
    name: "stop_process",
    description:
      "Stop a managed process by id. Its linked processes (`links`) stop with it; companions are left running.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "stop"), { method: "POST" }),
  },
  {
    name: "restart_process",
    description: "Restart a managed process by id.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "restart"), { method: "POST" }),
  },
  {
    name: "start_all",
    description: "Start every managed process.",
    inputSchema: S(),
    run: () => api(ROUTES.startAll, { method: "POST" }),
  },
  {
    name: "stop_all",
    description: "Stop every managed process.",
    inputSchema: S(),
    run: () => api(ROUTES.stopAll, { method: "POST" }),
  },
  {
    name: "get_logs",
    description: "Get recent log lines for a process (most recent last).",
    inputSchema: S({ id: { type: "string" }, limit: { type: "number" } }, ["id"]),
    run: async (a) => {
      const data = (await api(ROUTES.processLogs.build(str(a.id)))) as {
        id: string;
        lines: unknown[];
      };
      if (typeof a.limit === "number" && Array.isArray(data.lines))
        data.lines = data.lines.slice(-a.limit);
      return data;
    },
  },
  {
    name: "get_log_file",
    description:
      "Tail a process's on-disk rotating log file (Time-Travel Log Vault) — survives daemon restarts and the in-memory line cap, unlike get_logs. Returns the last `lines` lines (default 200).",
    inputSchema: S({ id: { type: "string" }, lines: { type: "number" } }, ["id"]),
    run: (a) =>
      api(
        ROUTES.processLogFile.build(str(a.id), typeof a.lines === "number" ? a.lines : undefined),
      ),
  },
  {
    name: "free_port",
    description:
      "Free a process's declared port. A DevWebUI-managed holder is stopped cleanly; EXTERNAL owners are only reported back (needsConfirm + owners) unless you pass confirm:true, which kills those exact PIDs.",
    inputSchema: S(
      {
        id: { type: "string" },
        confirm: {
          type: "boolean",
          description:
            "Also kill external (unmanaged) processes holding the port (optional; default false).",
        },
      },
      ["id"],
    ),
    run: (a) =>
      api(ROUTES.processFreePort.build(str(a.id)), {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ confirm: !!a.confirm }),
      }),
  },
  {
    name: "list_errors",
    description:
      "List the de-duplicated record of process errors (stderr / crashes / error-looking stdout), most recent first. Each carries `frames`: the file:line:col locations found in its sample, ready for open_in_editor.",
    inputSchema: S(),
    // The frames are parsed here rather than stored, so the persisted log and the GUI's copy
    // of it stay exactly the ErrorEvent shape; an agent just gets the locations pre-extracted.
    run: async () => {
      const errors = await api(ROUTES.errors);
      if (!Array.isArray(errors)) return errors;
      return errors.map((e: ErrorEvent) => ({
        ...e,
        frames: findSourceFrames(e.sample ?? "").map(({ file, line, column }) => ({
          file,
          line,
          column,
        })),
      }));
    },
  },
  {
    name: "open_in_editor",
    description:
      "Open a source location (e.g. a frame from list_errors) in the editor the developer already has running (VS Code family, JetBrains, Zed, Sublime, Notepad++), or DEVWEBUI_EDITOR. Pass processId for a path relative to that process's cwd. Returns { ok, editor } or { ok: false, reason }.",
    inputSchema: S(
      {
        file: { type: "string", description: "Absolute path, or relative to the process's cwd." },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1, description: "Optional; defaults to 1." },
        processId: {
          type: "string",
          description: "The process that logged the frame (resolves a relative path).",
        },
      },
      ["file", "line"],
    ),
    run: (a) =>
      api(ROUTES.openInEditor, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          file: a.file,
          line: a.line,
          column: a.column,
          processId: a.processId,
        }),
      }),
  },
  {
    name: "clear_errors",
    description: "Clear the recorded error log (optionally for a single process id).",
    inputSchema: S({ processId: { type: "string" } }),
    run: (a) =>
      api(
        `${ROUTES.errorsClear}${a.processId ? `?processId=${encodeURIComponent(str(a.processId))}` : ""}`,
        { method: "POST" },
      ),
  },
  {
    name: "list_browser_tabs",
    description:
      "List the live browser tabs of supervised dev apps that loaded DevWebUI's browser snippet (<script src=\"<daemon>/api/browser/client.js\">), with each tab's id, current URL and title. Pass a tabId from here to target one tab.",
    inputSchema: S(),
    run: () => api(ROUTES.browserTabs),
  },
  ...BROWSER_QUERY_TOOLS,
  {
    name: "list_alert_rules",
    description:
      "List configured threshold alert rules (fire when a process's CPU or memory sample stays over a threshold for a continuous duration).",
    inputSchema: S(),
    run: () => api(ROUTES.alertRules),
  },
  {
    name: "add_alert_rule",
    description:
      "Create a threshold alert rule: fire once a process's CPU or memory sample stays over `threshold`, continuously, for `forMs` milliseconds.",
    inputSchema: S(
      {
        processId: { type: "string", description: "Process id to watch." },
        metric: {
          type: "string",
          enum: ["cpu", "memory"],
          description: "Which live metric to watch.",
        },
        threshold: {
          type: "number",
          description: "CPU percent-of-one-core, or memory bytes, that trips the rule.",
        },
        forMs: {
          type: "number",
          description:
            "How long the metric must stay over threshold before firing, in ms (optional, default 0).",
        },
        enabled: {
          type: "boolean",
          description: "Whether the rule is active (optional, default true).",
        },
      },
      ["processId", "metric", "threshold"],
    ),
    run: (a) =>
      api(ROUTES.alertRules, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          processId: a.processId,
          metric: a.metric,
          threshold: a.threshold,
          forMs: a.forMs ?? 0,
          enabled: a.enabled,
        }),
      }),
  },
  {
    name: "remove_alert_rule",
    description: "Delete an alert rule by id.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.alertRule.build(str(a.id)), { method: "DELETE" }),
  },
  {
    name: "list_alert_events",
    description: "List the history of fired alert events, most recent first.",
    inputSchema: S(),
    run: () => api(ROUTES.alertEvents),
  },
  {
    name: "clear_alert_events",
    description: "Clear the fired-alert-event history (optionally for a single process id).",
    inputSchema: S({ processId: { type: "string" } }),
    run: (a) =>
      api(
        `${ROUTES.alertEventsClear}${a.processId ? `?processId=${encodeURIComponent(str(a.processId))}` : ""}`,
        { method: "POST" },
      ),
  },
  {
    name: "enable_process",
    description:
      "Enable a process (turn it on) and start it; the on/off choice persists across daemon restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "enable"), { method: "POST" }),
  },
  {
    name: "disable_process",
    description:
      "Disable a process (turn it off) and stop it; it stays off across daemon restarts until re-enabled.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processAction.build(str(a.id), "disable"), { method: "POST" }),
  },
  {
    name: "enable_project",
    description:
      "Enable every process in a project (turn the whole codebase on) and start them; persists across restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "enable"), { method: "POST" }),
  },
  {
    name: "disable_project",
    description:
      "Disable every process in a project (turn the whole codebase off) and stop them; persists across restarts.",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.projectAction.build(str(a.id), "disable"), { method: "POST" }),
  },
  {
    name: "diagnose_process",
    description:
      "Incident Autopilot: correlate a process's exit code, its de-duped error log, live port ownership, and its configured script/command into a structured root-cause guess (rootCause, confidence, evidence) plus a SUGGESTED remediation (never auto-executed — you decide whether to act on it).",
    inputSchema: S({ id: { type: "string" } }, ["id"]),
    run: (a) => api(ROUTES.processDiagnose.build(str(a.id))),
  },
  {
    name: "take_over_autostart",
    description:
      "Retire a repo's EXTERNAL dev-server auto-start (VS Code tasks.json runOn:folderOpen, the 'Vite' extension's vite.autoStart) so DevWebUI is the sole launcher. Backs each edited file up first. Pass the project FOLDER (absolute path).",
    inputSchema: S({ dir: { type: "string" } }, ["dir"]),
    run: (a) =>
      api(ROUTES.projectsTakeOver, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ dir: a.dir }),
      }),
  },
];

// The app's own version (the one index.ts reports), not a literal that drifts: this said
// "0.1.0" through 0.8.8.
await runMcpStdio({ serverInfo: { name: "devwebui", version: pkg.version }, tools: TOOLS });
