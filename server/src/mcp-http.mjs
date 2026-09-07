/**
 * MCP over HTTP - the transport that costs ZERO processes per client.
 *
 * WHY THIS EXISTS. Stdio MCP is one server PROCESS PER CLIENT: every Claude Code tab open on the
 * machine spawns its own `bun server/src/mcp.ts`, and that shim's entire job is to relay JSON-RPC
 * to this daemon over HTTP. Measured on MPC-HELL 2026-09-06: 19 open tabs, ~900 processes, 24 GB,
 * ~12 processes per tab across the three configured MCP servers. The daemon is ALREADY a single
 * shared long-lived process, so answering MCP from it directly takes AgentHydra's share of that
 * per-tab cost to nothing - N clients, one server, no relay.
 *
 * WHY IT CANNOT DRIFT FROM THE STDIO SERVER. It does not re-implement the protocol. `handleRpc`
 * (mcp-stdio.mjs) is pure and transport-agnostic - its own doc comment says "both a stdio server
 * and an in-process HTTP endpoint can share it" - so both transports dispatch the same messages
 * against the same `{ serverInfo, tools, instructions }` context. Adding a tool, or changing the
 * instructions, updates both at once because there is only one of each.
 *
 * WHY IT IS STATELESS. `Mcp-Session-Id` is OPTIONAL in the Streamable HTTP spec, and every
 * AgentHydra tool already derives its state from the daemon itself (the sqlite db, the instance
 * registry, runtime.json) rather than from a connection. There is nothing a session id would key,
 * so a client that reconnects mid-task loses nothing and no server-side session can leak.
 *
 * MOUNT IT UNDER THE PATH THE LOOPBACK GUARD COVERS (`/api/*`). The guard lets a non-browser
 * client through (no `Sec-Fetch-Site`, no `Origin`, loopback `Host` - exactly an MCP client) while
 * refusing a drive-by POST from any web page the owner happens to be visiting. That matters more
 * on this route than on a read route: `tools/call` can launch instances and move chats.
 */

/**
 * Dispatch one MCP HTTP request. Pure apart from the tool calls themselves, so it is directly
 * testable without booting the daemon.
 *
 * @param {unknown} body - the already-parsed JSON body, or the symbol `PARSE_ERROR` when the
 *   request body was not valid JSON (the caller owns reading the stream, this owns the protocol).
 * @param {{serverInfo: object, tools: unknown[], instructions?: string}} ctx
 * @param {(msg: unknown, ctx: unknown, signal?: AbortSignal) => Promise<unknown>} dispatch
 * @returns {Promise<{status: number, json: unknown|null}>} `json: null` means send an empty body.
 */
export const PARSE_ERROR = Symbol('mcp-http-parse-error');

export async function handleMcpHttp(body, ctx, dispatch) {
  if (body === PARSE_ERROR) {
    // -32700 per JSON-RPC. There is no id to answer against, so it is explicitly null.
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }

  // A JSON-RPC batch is an array. Each element dispatches independently; notifications return
  // null and drop out, so a batch of nothing but notifications answers 202 with no body - the
  // same rule as a single notification, applied elementwise.
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => dispatch(m, ctx)))).filter((r) => r !== null && r !== undefined);
    return out.length === 0 ? { status: 202, json: null } : { status: 200, json: out };
  }

  const res = await dispatch(body, ctx);
  // A notification produces NO response. 202 with an empty body - never the JSON document `null`,
  // which a client would try to parse as a result.
  return res === null || res === undefined ? { status: 202, json: null } : { status: 200, json: res };
}
