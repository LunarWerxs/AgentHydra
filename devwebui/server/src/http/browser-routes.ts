// REST surface of the browser bridge (server/src/browser-bridge.ts): the page snippet, the SSE
// stream tabs hold open, their answers, and the two agent-facing reads (tab list, fanned-out
// query) that the MCP tools wrap. Follows alert-routes.ts's shape: one handler per route and a
// thin registration function.
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BrowserBridge, type BridgeKind, type TabFilter } from "../browser-bridge";
import { BROWSER_CLIENT_JS } from "../browser-client";
import type { Manager } from "../manager";
import { ROUTES } from "../routes";
import { fail, guard, readBody } from "./core";

const KINDS: BridgeKind[] = ["errors", "metadata", "tools", "call"];
// A tab's answer is agent context, not a data channel: cap it so one page cannot balloon the
// daemon's memory or an agent's context window.
const MAX_REPLY_BYTES = 256 * 1024;

/** The paths a dev page on ANOTHER loopback port must be able to read cross-origin; http/index.ts
 *  widens CORS to loopback origins for exactly these. */
export const BROWSER_PAGE_PATHS: readonly string[] = [ROUTES.browserConnect, ROUTES.browserReply];

/** Resolve the tab filter from a query body: an explicit tabId, a port, or a process's port. */
function parseFilter(
  c: Context,
  manager: Manager,
  b: Record<string, unknown>,
): TabFilter | Response {
  const filter: TabFilter = {};
  if (typeof b.tabId === "string" && b.tabId) filter.tabId = b.tabId;
  if (typeof b.processId === "string" && b.processId) {
    const v = manager.view(b.processId);
    if (!v) return fail(c, "unknown process", 404);
    if (!v.port) return fail(c, "process has no declared port to match its tabs by");
    filter.port = v.port;
  }
  return filter;
}

async function handleQuery(c: Context, manager: Manager, bridge: BrowserBridge) {
  const b = ((await readBody(c)) ?? {}) as Record<string, unknown>;
  if (typeof b.kind !== "string" || !KINDS.includes(b.kind as BridgeKind))
    return fail(c, `kind must be one of: ${KINDS.join(", ")}`);
  const kind = b.kind as BridgeKind;
  const filter = parseFilter(c, manager, b);
  if (filter instanceof Response) return filter;
  if (kind === "call") {
    if (typeof b.tool !== "string" || !b.tool) return fail(c, "tool is required");
    // A page tool may have side effects: run it in exactly one tab, never fanned out.
    const matches = bridge.listTabs(filter);
    if (matches.length > 1)
      return fail(c, `${matches.length} tabs match - pass tabId (see list_browser_tabs)`);
  }
  const timeoutMs = Math.min(Math.max(Number(b.timeoutMs) || 5000, 250), 30000);
  const opts = { tool: typeof b.tool === "string" ? b.tool : undefined, args: b.args, filter };
  return guard(c, async () => c.json(await bridge.request(kind, { ...opts, timeoutMs })));
}

async function handleReply(c: Context, bridge: BrowserBridge) {
  const text = await c.req.text();
  if (text.length > MAX_REPLY_BYTES) return fail(c, "answer too large", 413);
  let b: Record<string, unknown> | null = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (!b || typeof b !== "object") return fail(c, "answer is not a JSON object");
  const ok = bridge.reply(String(b.requestId ?? ""), String(b.tabId ?? ""), {
    result: b.result,
    error: typeof b.error === "string" ? b.error : undefined,
    url: typeof b.url === "string" ? b.url : undefined,
    title: typeof b.title === "string" ? b.title : undefined,
  });
  return ok ? c.json({ ok: true }) : fail(c, "no such pending request for this tab", 404);
}

export function registerBrowserRoutes(app: Hono, manager: Manager) {
  const bridge = new BrowserBridge();

  app.get(ROUTES.browserClient, (c) =>
    c.body(BROWSER_CLIENT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  app.get(ROUTES.browserConnect, (c) =>
    streamSSE(c, async (stream) => {
      const tabId = bridge.connect(
        { url: c.req.query("url") ?? "", title: c.req.query("title") ?? "" },
        (req) => stream.writeSSE({ event: "request", data: JSON.stringify(req) }),
      );
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ tabId }) });
      const ping = setInterval(
        () => void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {}),
        15000,
      );
      stream.onAbort(() => {
        clearInterval(ping);
        bridge.disconnect(tabId);
      });
      while (!stream.aborted) await stream.sleep(60000);
    }),
  );

  app.post(ROUTES.browserReply, (c) => handleReply(c, bridge));
  app.get(ROUTES.browserTabs, (c) => c.json({ tabs: bridge.listTabs() }));
  app.post(ROUTES.browserQuery, (c) => handleQuery(c, manager, bridge));
}
