// LunarWerx shared MCP engine, the canonical JSON-RPC 2.0 / MCP dispatch + newline-delimited
// stdio loop, shared by every sibling app's MCP server (RepoYeti, Reimagine, ...). Synced verbatim
// into each app's server tree by sync.mjs; edit HERE, never the synced copies.
//
// Zero dependencies and runtime-agnostic (runs identically under Bun and Node): it touches only
// `process.stdin` / `process.stdout` and, indirectly, whatever the caller's tools do. Each app
// supplies its own `serverInfo` + a `tools` array, `{ name, description, inputSchema, run(args) }`,
// each tool a thin proxy to that app's own HTTP API, and this engine owns everything protocol:
// the initialize / ping / tools/list / tools/call switch, the JSON-RPC error envelopes, the
// tool-error → MCP `isError` result wrapping, and the stdin→dispatch→stdout loop.
//
// STDOUT is the protocol channel, only JSON-RPC responses (one per line) are ever written there;
// diagnostics go to STDERR so a stray log can't corrupt the stream.

const PROTOCOL_VERSION = "2024-11-05";

/** Standard JSON-RPC error codes we use. */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

const rpcResult = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** A -32700 parse-error response (id null), used by transports on malformed input. */
export function parseErrorResponse() {
  return rpcError(null, ERR.PARSE, "Parse error");
}

/**
 * Dispatch one parsed JSON-RPC message against `ctx` ({ serverInfo, tools }). Returns the response
 * object, or null when the message is a notification (no `id`), the caller must then emit nothing.
 * Pure (no IO): both a stdio server and an in-process HTTP endpoint can share it.
 */
export async function handleRpc(msg, ctx) {
  if (msg === null || typeof msg !== "object") {
    return rpcError(null, ERR.INVALID_REQUEST, "Invalid Request");
  }
  const method = typeof msg.method === "string" ? msg.method : "";
  // A message with no `id` is a notification → never produces a response.
  const isNotification = !("id" in msg) || msg.id === undefined;
  if (isNotification) return null;
  const id = msg.id == null ? null : msg.id;

  switch (method) {
    case "initialize": {
      const params = msg.params && typeof msg.params === "object" ? msg.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: ctx.serverInfo,
        // `instructions` is the MCP handshake's one channel for STANDING guidance: the client
        // shows it to the model once per session, before any tool is called. That is the only
        // place an app can say "here is how to use me" without a human typing it into every
        // prompt, and without paying for it again on every tool result. Omitted entirely when the
        // app supplies none, since an empty string is a field the client still has to render.
        ...(typeof ctx.instructions === "string" && ctx.instructions.trim()
          ? { instructions: ctx.instructions }
          : {}),
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: ctx.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const params = msg.params && typeof msg.params === "object" ? msg.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const tool = ctx.tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, ERR.INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const value = await tool.run(args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } catch (e) {
        // A tool-level failure → an MCP error RESULT (not a JSON-RPC protocol error) the agent can
        // read and react to, exactly like a normal tool output.
        return rpcResult(id, {
          content: [{ type: "text", text: e?.message ? e.message : String(e) }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, ERR.METHOD_NOT_FOUND, "Method not found");
  }
}

/** Process one already-sliced line; return the JSON string to write (or null for a notification). */
export async function processLine(line, ctx) {
  const trimmed = String(line).trim();
  if (trimmed === "") return null; // blank keep-alive line, ignore
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return JSON.stringify(parseErrorResponse());
  }
  const res = await handleRpc(msg, ctx);
  return res ? JSON.stringify(res) : null;
}

/**
 * Read stdin as newline-delimited JSON (sequentially via async iteration, works under both Bun
 * and Node), dispatch each line against `ctx`, and write each non-null response as one line to
 * stdout. Resolves when stdin closes (the client disconnected). All logging goes to stderr.
 */
export async function runMcpStdio(ctx) {
  process.stderr.write(`${ctx.serverInfo.name} mcp: stdio server ready\n`);
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const out = await processLine(line, ctx);
        if (out !== null) process.stdout.write(`${out}\n`);
      } catch (e) {
        // A processing failure is logged to stderr only, never poison stdout with non-protocol text.
        process.stderr.write(
          `${ctx.serverInfo.name} mcp: error handling line: ${e?.message ? e.message : e}\n`,
        );
      }
    }
  }
  // Stream closed: flush any final line that lacked a trailing newline.
  if (buffer.trim() !== "") {
    const out = await processLine(buffer, ctx);
    if (out !== null) process.stdout.write(`${out}\n`);
  }
}
