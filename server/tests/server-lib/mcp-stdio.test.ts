// Tests for the shared MCP stdio engine (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/mcp-stdio.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir). Imports the lib as "../../src/mcp-stdio.mjs",
// so it is synced ONLY to apps whose `serverLib` === `serverRoot` (mcp-stdio sits at the server
// root there); RepoYeti keeps its MCP engine in a `src/mcp/` subdir, so `../../src/mcp-stdio.mjs`
// would not resolve and sync.mjs deliberately skips it there. NOT runnable inside the kit repo.
//
// Exercises the PURE dispatch surface (handleRpc / processLine / parseErrorResponse) — no stdin/
// stdout, so it is fully hermetic. The runMcpStdio stream loop is left to integration.
import { test, expect } from "bun:test";
import { handleRpc, parseErrorResponse, processLine } from "../../src/mcp-stdio.mjs";

// handleRpc is typed as `Promise<object | null>` (deliberately opaque in the .d.mts), so this
// narrows the response for property assertions without reaching for `any` (which the recommended
// biome preset flags). Full-shape checks use `expect(res).toEqual(...)` on the raw value instead.
type RpcResponse = {
  jsonrpc: string;
  id: number | null;
  result?: {
    protocolVersion?: string;
    serverInfo?: unknown;
    instructions?: string;
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};
const rpc = (r: object | null): RpcResponse | null => r as RpcResponse | null;

const serverInfo = { name: "testsvc", version: "1.0.0" };
const echoSchema = { type: "object", properties: { msg: { type: "string" } } };
const boomSchema = { type: "object" };
const tools = [
  {
    name: "echo",
    description: "echoes its args back",
    inputSchema: echoSchema,
    run: (args: Record<string, unknown>) => ({ echoed: typeof args.msg === "string" ? args.msg : null }),
  },
  {
    name: "boom",
    description: "always throws",
    inputSchema: boomSchema,
    run: () => {
      throw new Error("tool exploded");
    },
  },
];
const ctx = { serverInfo, tools };

test("initialize echoes the client protocolVersion and advertises tools + serverInfo", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx);
  expect(res).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo },
  });
});

test("initialize falls back to the engine's protocol version when the client omits one", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, ctx);
  expect(rpc(res)?.result?.protocolVersion).toBe("2024-11-05");
});

test("initialize carries the app's standing instructions when it supplies any", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, {
    ...ctx,
    instructions: "Check your quota before fanning out.",
  });
  expect(rpc(res)?.result?.instructions).toBe("Check your quota before fanning out.");
});

test("initialize omits `instructions` entirely when there are none", async () => {
  // Absent, not empty: an empty string is still a field the client has to render, and a blank
  // guidance block reads as "this server has nothing to say" rather than "it did not opt in".
  for (const instructions of [undefined, "", "   "]) {
    const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { ...ctx, instructions });
    expect(rpc(res)?.result).not.toHaveProperty("instructions");
  }
});

test("ping returns an empty result", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 2, method: "ping" }, ctx);
  expect(res).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
});

test("tools/list projects each tool to name/description/inputSchema (no run fn leaked)", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx);
  expect(rpc(res)?.result?.tools).toEqual([
    { name: "echo", description: "echoes its args back", inputSchema: echoSchema },
    { name: "boom", description: "always throws", inputSchema: boomSchema },
  ]);
});

test("tools/call runs the tool and wraps the JSON result as text content", async () => {
  const res = await handleRpc(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } },
    ctx,
  );
  expect(rpc(res)?.result?.content?.[0]).toEqual({ type: "text", text: JSON.stringify({ echoed: "hi" }, null, 2) });
  expect(rpc(res)?.result?.isError).toBeUndefined();
});

test("a throwing tool becomes an isError RESULT (not a JSON-RPC protocol error)", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } }, ctx);
  expect(rpc(res)?.result?.isError).toBe(true);
  expect(rpc(res)?.result?.content?.[0]?.text).toBe("tool exploded");
  expect(rpc(res)?.error).toBeUndefined();
});

test("tools/call for an unknown tool is an INVALID_PARAMS (-32602) error", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, ctx);
  expect(rpc(res)?.error?.code).toBe(-32602);
});

test("an unknown method is METHOD_NOT_FOUND (-32601)", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", id: 7, method: "frobnicate" }, ctx);
  expect(rpc(res)?.error?.code).toBe(-32601);
});

test("a non-object message is INVALID_REQUEST (-32600) with id null", async () => {
  const res = await handleRpc(null, ctx);
  expect(res).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
});

test("a message with no id is a notification → no response", async () => {
  const res = await handleRpc({ jsonrpc: "2.0", method: "ping" }, ctx);
  expect(res).toBeNull();
});

test("parseErrorResponse is a -32700 envelope with id null", () => {
  expect(parseErrorResponse()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
});

test("processLine: blank line ignored, bad JSON → parse-error string, valid → response string", async () => {
  expect(await processLine("   ", ctx)).toBeNull();

  const parseErr = await processLine("{ not json", ctx);
  expect(JSON.parse(parseErr ?? "").error.code).toBe(-32700);

  const ok = await processLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }), ctx);
  expect(JSON.parse(ok ?? "")).toEqual({ jsonrpc: "2.0", id: 9, result: {} });

  // A notification line produces nothing to write.
  expect(await processLine(JSON.stringify({ jsonrpc: "2.0", method: "ping" }), ctx)).toBeNull();
});
