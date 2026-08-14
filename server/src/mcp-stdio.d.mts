// Types for the shared MCP engine (mcp-stdio.mjs). Hand-written so the TypeScript apps
// (RepoYeti, DevWebUI) get a typed import without depending on bun-types/@types from the kit.

/** One MCP tool as the engine consumes it: metadata for `tools/list` + a `run` for `tools/call`.
 *  Each app builds these as thin proxies to its own HTTP API (binding any backend into `run`). */
export interface McpEngineTool {
  name: string;
  description: string;
  /** JSON Schema object advertised for this tool's arguments. */
  inputSchema: unknown;
  /** Validate `args`, perform the action, and return a JSON-serialisable value (or throw). */
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** What every dispatch/loop call needs: the server identity + the live tool set. */
export interface McpServerContext {
  serverInfo: { name: string; version: string };
  tools: McpEngineTool[];
  /** Standing guidance returned in the `initialize` handshake. The client shows it to the model
   *  once per session, before any tool call, so an app can ship its own operating rules instead of
   *  relying on a human to repeat them. Keep it SHORT: it is in context for the whole session. */
  instructions?: string;
}

/** A JSON-RPC -32700 parse-error response (id null) for a transport to emit on malformed input. */
export function parseErrorResponse(): object;

/** Dispatch one parsed JSON-RPC message; returns the response object, or null for a notification. */
export function handleRpc(msg: unknown, ctx: McpServerContext): Promise<object | null>;

/** Process one raw stdin line; returns the JSON string to write, or null for a notification/blank. */
export function processLine(line: string, ctx: McpServerContext): Promise<string | null>;

/** Run the newline-delimited JSON-RPC stdio server loop until stdin closes. */
export function runMcpStdio(ctx: McpServerContext): Promise<void>;
