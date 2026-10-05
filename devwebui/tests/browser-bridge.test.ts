// Browser bridge (server/src/browser-bridge.ts): the request map that fans an agent's question out
// to live dev-app tabs. Pins the three settle rules the MCP tools depend on - resolve as soon as
// every tab answered, resolve with the PARTIAL set when the timeout fires, reject only when no tab
// answered - plus the one CORS exception http/index.ts makes so a page on another loopback port
// can reach the bridge at all.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { expect, test } from "bun:test";
import { BrowserBridge, type BridgeRequest } from "../server/src/browser-bridge";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import { ROUTES } from "../shared/routes";

/** Connect a fake tab that records the requests pushed to it. */
function fakeTab(bridge: BrowserBridge, url: string) {
  const seen: BridgeRequest[] = [];
  const tabId = bridge.connect({ url, title: url }, (req) => {
    seen.push(req);
  });
  return { tabId, seen };
}

test("resolves as soon as every tab answered, without waiting for the timeout", async () => {
  const bridge = new BrowserBridge();
  const a = fakeTab(bridge, "http://localhost:5173/");
  const b = fakeTab(bridge, "http://localhost:5173/about");
  const started = Date.now();
  const pending = bridge.request("errors", { timeoutMs: 10_000 });
  expect(a.seen).toHaveLength(1);
  expect(bridge.reply(a.seen[0]!.requestId, a.tabId, { result: [] })).toBe(true);
  expect(bridge.reply(b.seen[0]!.requestId, b.tabId, { error: "boom" })).toBe(true);
  const res = await pending;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(res).toMatchObject({ expected: 2, answered: 2, timedOut: false });
  expect(res.tabs.find((t) => t.tabId === b.tabId)?.error).toBe("boom");
});

test("resolves with the partial answers when a tab stays silent past the timeout", async () => {
  const bridge = new BrowserBridge();
  const a = fakeTab(bridge, "http://localhost:5173/");
  fakeTab(bridge, "http://localhost:5173/frozen");
  const pending = bridge.request("metadata", { timeoutMs: 50 });
  bridge.reply(a.seen[0]!.requestId, a.tabId, {
    result: { title: "ok" },
    url: "http://localhost:5173/next",
  });
  const res = await pending;
  expect(res).toMatchObject({ expected: 2, answered: 1, timedOut: true });
  // The answer carries the URL the page reported, not the one it connected with.
  expect(res.tabs[0]!.url).toBe("http://localhost:5173/next");
  // A late answer to a settled request is refused rather than recorded.
  expect(bridge.reply(a.seen[0]!.requestId, a.tabId, { result: 1 })).toBe(false);
});

test("rejects when no tab answered, and when no tab is connected", async () => {
  const bridge = new BrowserBridge();
  await expect(bridge.request("errors")).rejects.toThrow(/no browser tab is connected/);
  fakeTab(bridge, "http://localhost:5173/");
  await expect(bridge.request("errors", { timeoutMs: 30 })).rejects.toThrow(/answered within/);
});

test("a tab that disconnects stops the request waiting on it", async () => {
  const bridge = new BrowserBridge();
  const a = fakeTab(bridge, "http://localhost:5173/");
  const b = fakeTab(bridge, "http://localhost:5173/closing");
  const pending = bridge.request("errors", { timeoutMs: 10_000 });
  bridge.reply(a.seen[0]!.requestId, a.tabId, { result: [] });
  bridge.disconnect(b.tabId);
  expect(await pending).toMatchObject({ expected: 2, answered: 1, timedOut: false });
});

test("a port filter reaches only that app's tabs", async () => {
  const bridge = new BrowserBridge();
  fakeTab(bridge, "http://localhost:5173/");
  const other = fakeTab(bridge, "http://localhost:3000/");
  expect(bridge.listTabs({ port: 3000 }).map((t) => t.tabId)).toEqual([other.tabId]);
  expect(bridge.listTabs({ port: 80 })).toEqual([]);
});

test("only the bridge's page paths grant CORS to another loopback origin", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const app = createApp(manager, { port: 4000 });
  const preflight = (path: string, origin: string) =>
    app.request(path, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
  const devPage = "http://localhost:5173";
  expect(
    (await preflight(ROUTES.browserReply, devPage)).headers.get("access-control-allow-origin"),
  ).toBe(devPage);
  expect(
    (await preflight(ROUTES.startAll, devPage)).headers.get("access-control-allow-origin"),
  ).toBeNull();
  expect(
    (await preflight(ROUTES.browserReply, "https://evil.example")).headers.get(
      "access-control-allow-origin",
    ),
  ).toBeNull();
});
