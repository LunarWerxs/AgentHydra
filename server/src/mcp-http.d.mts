// Types for the MCP-over-HTTP transport (mcp-http.mjs). Hand-written, matching the convention
// used by mcp-stdio.d.mts so the TypeScript daemon gets a typed import with no build step.

import type { McpServerContext } from './mcp-stdio.d.mts';

/** Passed as `body` when the request payload was not valid JSON, so the transport can answer
 *  -32700 without the caller having to model "no body" and "null body" as the same thing. */
export const PARSE_ERROR: unique symbol;

/** What the route should send back. `json: null` means an empty body (a notification or a batch
 *  of nothing but notifications, answered 202). */
export interface McpHttpReply {
  status: number;
  json: unknown | null;
}

/** Dispatch one MCP HTTP request. `dispatch` is `handleRpc` from mcp-stdio.mjs - injected rather
 *  than imported so a test can drive the protocol shape without the tool set behind it. */
export function handleMcpHttp(
  body: unknown,
  ctx: McpServerContext,
  dispatch: (msg: unknown, ctx: McpServerContext, signal?: AbortSignal) => Promise<object | null>,
): Promise<McpHttpReply>;
