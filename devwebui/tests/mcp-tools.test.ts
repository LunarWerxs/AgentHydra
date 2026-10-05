// All 31 tools in server/src/mcp.ts are thin wrappers mapping args to a REST call — a typo'd
// ROUTES.* build() call or a wrong HTTP method is the entire risk (server/src/mcp.ts's own header
// comment says as much). Nothing in that file is exported, and its top-level code ends in
// `await runMcpStdio(...)`, which reads process.stdin forever — importing it unmodified would
// hang the test process (verified: mcp-stdio.mjs's runMcpStdio does `for await (const chunk of
// process.stdin)`, which never sees EOF under `bun test`).
//
// So this mocks "./mcp-stdio.mjs" (the module mcp.ts imports it from) with a stub `runMcpStdio`
// that just captures `ctx.tools` and resolves immediately, instead of looping. `mock.module`
// resolves by the mocked specifier's ABSOLUTE path, not by string-matching it against mcp.ts's
// own "./mcp-stdio.mjs" import text, so a relative path from THIS file still intercepts the same
// module (confirmed against a throwaway repro before writing this file). Once mcp.ts's top-level
// await resolves, the captured `tools` array is the real TOOLS table, unexported but reachable.
//
// `mock.module` replaces the module in the process-wide registry — bun runs every test FILE in
// one shared process, so without restoring it in afterAll, every OTHER file that imports
// mcp-stdio.mjs after this one (server/tests/server-lib/mcp-stdio.test.ts imports handleRpc from
// it directly) would get this stub instead and fail with "Export named 'handleRpc' not found"
// (reproduced while writing this file). Capture the real module first, put it back afterward.
import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import (mcp.ts imports ./instance)
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as realMcpStdio from "../server/src/mcp-stdio.mjs";
import type { McpEngineTool } from "../server/src/mcp-stdio.mjs";

let TOOLS: McpEngineTool[] = [];
const originalFetch = globalThis.fetch;

// !! SNAPSHOT THE REAL EXPORTS HERE, AT MODULE SCOPE, BEFORE ANY mock.module CALL.
// `import * as realMcpStdio` is a LIVE namespace: once mock.module swaps the module in the
// process-wide registry, that binding reflects the STUB, so restoring with
// `mock.module(path, () => realMcpStdio)` in afterAll put the stub back rather than the real
// module. The symptom was not an import error - it was silence. Every later file got a
// `runMcpStdio` that resolves immediately without reading input or writing output, so
// server-lib/mcp-stdio.test.ts's four stream tests waited for responses that could never
// come and failed as timeouts. That looked like a bug in runMcpStdio and was this line.
// A spread taken before the mock is a plain object and cannot be re-pointed.
const realExports = { ...realMcpStdio };
let calls: { url: string; init?: RequestInit }[] = [];

beforeAll(async () => {
  process.env.DEVWEBUI_URL = "http://test-daemon.local"; // pin daemonBase() — no real network, no instance-file lookup
  mock.module("../server/src/mcp-stdio.mjs", () => ({
    ...realMcpStdio,
    runMcpStdio: async (ctx: { tools: McpEngineTool[] }) => {
      TOOLS = ctx.tools;
    },
  }));
  await import("../server/src/mcp.ts");
});

afterAll(() => {
  mock.module("../server/src/mcp-stdio.mjs", () => realExports); // the snapshot, NOT the live namespace
  globalThis.fetch = originalFetch;
  delete process.env.DEVWEBUI_URL;
});

/** Stub global fetch to record the call and answer with an empty-but-valid JSON body. */
function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
}

function toolNamed(name: string): McpEngineTool {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" not found — ${TOOLS.length} tools loaded`);
  return t;
}

test("all 43 tools are loaded", () => {
  expect(TOOLS.length).toBe(43);
});

// One row per tool: the args it's invoked with, and the request it MUST produce. `body` is
// omitted for GET/bodyless calls; when present it's checked as a parsed-JSON deep-equal (not a
// raw string) so key order in the tool's source can't cause a spurious failure.
interface Case {
  name: string;
  args: Record<string, unknown>;
  method: string;
  url: string;
  body?: unknown;
}

const cases: Case[] = [
  { name: "list_projects", args: {}, method: "GET", url: "/api/projects" },
  {
    name: "load_project",
    args: { path: "C:/repo/.devwebui" },
    method: "POST",
    url: "/api/projects/load",
    body: { path: "C:/repo/.devwebui" },
  },
  {
    name: "update_project",
    args: { id: "p1", name: "New", color: "#fff" },
    method: "PUT",
    url: "/api/projects/p1",
    body: { name: "New", color: "#fff" },
  },
  {
    name: "clone_project",
    args: { url: "https://example.test/repo.git", dest: "C:/dest" },
    method: "POST",
    url: "/api/projects/clone",
    body: { url: "https://example.test/repo.git", dest: "C:/dest" },
  },
  {
    name: "scan_projects",
    args: { roots: ["C:/"], preset: "quick" },
    method: "POST",
    url: "/api/projects/scan",
    body: { roots: ["C:/"], preset: "quick" },
  },
  {
    name: "remove_project",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/remove",
  },
  { name: "start_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/start" },
  { name: "stop_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/stop" },
  { name: "list_processes", args: {}, method: "GET", url: "/api/processes" },
  { name: "get_runtime_services", args: {}, method: "GET", url: "/api/runtime-services" },
  {
    name: "get_runtime_services",
    args: { includeStopped: true },
    method: "GET",
    url: "/api/runtime-services?all=1",
  },
  {
    name: "add_process",
    args: { projectId: "p1", id: "api", name: "API", command: "bun run dev" },
    method: "POST",
    url: "/api/projects/p1/processes",
    body: { id: "api", name: "API", command: "bun run dev" },
  },
  {
    name: "update_process",
    args: { projectId: "p1", localId: "api", id: "api", name: "API", command: "bun run dev" },
    method: "PUT",
    url: "/api/projects/p1/processes/api",
    body: { id: "api", name: "API", command: "bun run dev" },
  },
  {
    name: "remove_process",
    args: { projectId: "p1", localId: "api" },
    method: "DELETE",
    url: "/api/projects/p1/processes/api",
  },
  {
    name: "set_process_starred",
    args: { projectId: "p1", localId: "api", starred: true },
    method: "POST",
    url: "/api/projects/p1/processes/api/star",
    body: { starred: true },
  },
  {
    name: "create_process_shortcut",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/shortcut",
  },
  {
    name: "create_project_shortcut",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/shortcut",
  },
  {
    name: "start_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/start",
  },
  {
    name: "stop_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/stop",
  },
  {
    name: "restart_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/restart",
  },
  { name: "start_all", args: {}, method: "POST", url: "/api/processes/start-all" },
  { name: "stop_all", args: {}, method: "POST", url: "/api/processes/stop-all" },
  { name: "get_logs", args: { id: "p1.api" }, method: "GET", url: "/api/processes/p1.api/logs" },
  {
    name: "get_log_file",
    args: { id: "p1.api", lines: 50 },
    method: "GET",
    url: "/api/processes/p1.api/logfile?lines=50",
  },
  {
    name: "free_port",
    args: { id: "p1.api", confirm: true },
    method: "POST",
    url: "/api/processes/p1.api/free-port",
    body: { confirm: true },
  },
  { name: "list_errors", args: {}, method: "GET", url: "/api/errors" },
  {
    name: "open_in_editor",
    args: { file: "src/app.ts", line: 12, column: 5, processId: "p1.api" },
    method: "POST",
    url: "/api/open-in-editor",
    body: { file: "src/app.ts", line: 12, column: 5, processId: "p1.api" },
  },
  {
    name: "clear_errors",
    args: { processId: "p1.api" },
    method: "POST",
    url: "/api/errors/clear?processId=p1.api",
  },
  { name: "list_browser_tabs", args: {}, method: "GET", url: "/api/browser/tabs" },
  {
    name: "get_browser_errors",
    args: { processId: "p1.web" },
    method: "POST",
    url: "/api/browser/query",
    body: { kind: "errors", processId: "p1.web" },
  },
  {
    name: "get_page_metadata",
    args: { tabId: "t1", timeoutMs: 2000 },
    method: "POST",
    url: "/api/browser/query",
    body: { kind: "metadata", tabId: "t1", timeoutMs: 2000 },
  },
  {
    name: "list_page_tools",
    args: {},
    method: "POST",
    url: "/api/browser/query",
    body: { kind: "tools" },
  },
  {
    name: "call_page_tool",
    args: { tool: "componentAt", args: { selector: "#app" }, tabId: "t1" },
    method: "POST",
    url: "/api/browser/query",
    body: { kind: "call", tool: "componentAt", args: { selector: "#app" }, tabId: "t1" },
  },
  { name: "list_alert_rules", args: {}, method: "GET", url: "/api/alerts/rules" },
  {
    name: "add_alert_rule",
    args: { processId: "p1.api", metric: "cpu", threshold: 80, forMs: 120000 },
    method: "POST",
    url: "/api/alerts/rules",
    body: { processId: "p1.api", metric: "cpu", threshold: 80, forMs: 120000 },
  },
  {
    name: "remove_alert_rule",
    args: { id: "rule1" },
    method: "DELETE",
    url: "/api/alerts/rules/rule1",
  },
  { name: "list_alert_events", args: {}, method: "GET", url: "/api/alerts/events" },
  {
    name: "clear_alert_events",
    args: { processId: "p1.api" },
    method: "POST",
    url: "/api/alerts/events/clear?processId=p1.api",
  },
  {
    name: "enable_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/enable",
  },
  {
    name: "disable_process",
    args: { id: "p1.api" },
    method: "POST",
    url: "/api/processes/p1.api/disable",
  },
  { name: "enable_project", args: { id: "p1" }, method: "POST", url: "/api/projects/p1/enable" },
  {
    name: "disable_project",
    args: { id: "p1" },
    method: "POST",
    url: "/api/projects/p1/disable",
  },
  {
    name: "diagnose_process",
    args: { id: "p1.api" },
    method: "GET",
    url: "/api/processes/p1.api/diagnose",
  },
  {
    name: "take_over_autostart",
    args: { dir: "C:/repo" },
    method: "POST",
    url: "/api/projects/take-over",
    body: { dir: "C:/repo" },
  },
];

for (const c of cases) {
  test(`${c.name}: builds ${c.method} ${c.url}`, async () => {
    stubFetch();
    await toolNamed(c.name).run(c.args);
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`http://test-daemon.local${c.url}`);
    expect((call.init?.method ?? "GET").toUpperCase()).toBe(c.method);
    if (c.body !== undefined) {
      expect(JSON.parse(String(call.init?.body))).toEqual(c.body);
    } else {
      expect(call.init?.body).toBeUndefined();
    }
  });
}

// list_errors is the one tool that reshapes its response: it adds `frames` so an agent can go
// straight from an error to open_in_editor without re-parsing the sample itself.
test("list_errors: attaches the file:line:col frames found in each sample", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          fingerprint: "f1",
          sample: "TypeError: x is undefined\n    at run (/srv/app/src/main.ts:12:5)",
        },
        { fingerprint: "f2", sample: "plain failure, no location" },
      ]),
      { status: 200 },
    )) as typeof fetch;
  const out = (await toolNamed("list_errors").run({})) as { frames: unknown[] }[];
  expect(out[0]?.frames).toEqual([{ file: "/srv/app/src/main.ts", line: 12, column: 5 }]);
  expect(out[1]?.frames).toEqual([]);
});
