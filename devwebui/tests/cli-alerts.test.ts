// `devwebui alerts ...` mirrors the five MCP alert tools (tests/mcp-tools.test.ts) 1:1 over the
// same REST routes - the entire risk is a typo'd ROUTES.* build() call, a wrong HTTP method, or a
// wrong unit conversion (--for-secs -> forMs, MB -> bytes stays the CLI's job for memory rules
// the GUI already speaks in bytes for; the CLI stays in the API's raw units, see cli.ts's
// ALERTS_USAGE). Removing the feature (or breaking a route/verb) should fail one of these.
//
// findLiveInstance() (server/src/instance-pointer.mjs) requires a runtime.json pointer PLUS a
// live-looking /api/health response ({ ok: true, service: "devwebui" }) before any other route is
// even attempted - so every case here stubs fetch to answer that shape first.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { clearInstanceInfo, writeInstanceInfo } from "../server/src/instance";
import { main } from "../server/src/cli";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];

const PROCESSES = [
  {
    id: "p1.api",
    localId: "api",
    name: "API",
    port: 4000,
    projectId: "p1",
    projectName: "Demo",
    status: "running",
  },
];

/** 200 + a JSON body, the shape every stubbed route answers with. */
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

/** One stubbed route: an optional HTTP method (omitted = any method), a URL predicate, and the
 *  reply. Listed in the order they must be tested — the first match wins. */
interface StubRoute {
  method?: string;
  matches: (url: string) => boolean;
  reply: (body: unknown) => Response;
}

const STUB_ROUTES: StubRoute[] = [
  {
    matches: (u) => u.endsWith("/api/health"),
    reply: () => json({ ok: true, service: "devwebui" }),
  },
  { matches: (u) => u.endsWith("/api/processes"), reply: () => json(PROCESSES) },
  {
    method: "POST",
    matches: (u) => u.endsWith("/api/alerts/rules"),
    reply: (body) => json({ id: "rule1", ...(body as object), createdAt: 1 }),
  },
  { method: "GET", matches: (u) => u.endsWith("/api/alerts/rules"), reply: () => json([]) },
  { method: "DELETE", matches: (u) => u.includes("/api/alerts/rules/"), reply: () => json({}) },
  { method: "GET", matches: (u) => u.endsWith("/api/alerts/events"), reply: () => json([]) },
  { method: "POST", matches: (u) => u.includes("/api/alerts/events/clear"), reply: () => json({}) },
];

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    const route = STUB_ROUTES.find((r) => (!r.method || r.method === method) && r.matches(url));
    if (!route) throw new Error(`unstubbed request: ${method} ${url}`);
    return route.reply(body);
  }) as typeof fetch;
}

beforeAll(() => {
  writeInstanceInfo(59991); // pins the pointer file findLiveInstance() reads
});
afterAll(() => {
  clearInstanceInfo();
  globalThis.fetch = ORIGINAL_FETCH;
});
beforeEach(() => {
  stubFetch();
  console.log = () => {}; // the commands print human-readable summaries; only the HTTP calls matter here
});
afterEach(() => {
  console.log = ORIGINAL_LOG;
});

function calledPost(pathname: string): Call | undefined {
  return calls.find((c) => c.method === "POST" && c.url.endsWith(pathname));
}

test("alerts add resolves the process ref and posts the rule with converted units", async () => {
  await main(["alerts", "add", "p1.api", "cpu", "80", "--for-secs", "120"]);
  const post = calledPost("/api/alerts/rules");
  expect(post).toBeDefined();
  expect(post?.body).toEqual({ processId: "p1.api", metric: "cpu", threshold: 80, forMs: 120000 });
});

test("alerts add --disabled sends enabled: false", async () => {
  await main(["alerts", "add", "p1.api", "memory", "512", "--disabled"]);
  const post = calledPost("/api/alerts/rules");
  expect(post?.body).toMatchObject({ processId: "p1.api", metric: "memory", enabled: false });
});

test("alerts add rejects a bad metric before making any alerts call", async () => {
  await expect(main(["alerts", "add", "p1.api", "gpu", "80"])).rejects.toThrow(/cpu.*memory/i);
  expect(calls.some((c) => c.url.includes("/api/alerts"))).toBe(false);
});

test("alerts remove deletes by id", async () => {
  await main(["alerts", "remove", "rule1"]);
  expect(
    calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/alerts/rules/rule1")),
  ).toBe(true);
});

test("alerts list fetches the rules route", async () => {
  await main(["alerts", "list"]);
  expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/alerts/rules"))).toBe(true);
});

test("alerts events fetches the events route", async () => {
  await main(["alerts", "events"]);
  expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/alerts/events"))).toBe(true);
});

test("alerts clear with no --process clears everything", async () => {
  await main(["alerts", "clear"]);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/alerts/events/clear"));
  expect(post?.url.endsWith("/api/alerts/events/clear")).toBe(true);
});

test("alerts clear --process resolves the ref and scopes the query", async () => {
  await main(["alerts", "clear", "--process", "p1.api"]);
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/alerts/events/clear"));
  expect(post?.url.endsWith("/api/alerts/events/clear?processId=p1.api")).toBe(true);
});

test("an unknown alerts subcommand is a usage error, not a silent no-op", async () => {
  await expect(main(["alerts", "bogus"])).rejects.toThrow();
});
