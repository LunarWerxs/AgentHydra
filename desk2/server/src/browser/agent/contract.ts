// The call surface of AgentHydra's own browser tools: the names, the caller, and the answer of one call.
// Read-only: none of these tools launches a Chrome or drives a page's input. The tool list itself lives in registry.ts.

export interface ToolParams {
  browser_profiles: Record<string, never>
  browser_status: { attachPort?: number }
  browser_profile_find: { for: string }
  browser_targets: { attachPort?: number; profile?: string }
  browser_frames: { attachPort?: number; profile?: string }
}

export type ToolName = keyof ToolParams

/** What the service answers for GET /api/tools: the part a client needs to list a tool to a model. */
export interface ToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolCaller {
  /** The Desk chat's id (its Claude session id); owns the pages it drives in the tab ledger. */
  chat?: string
  /** The CliMayte worker's id, when a worker is calling. */
  worker?: string
  /** The folder the chat works in; picks the saved-browser workspace. */
  cwd?: string
  /** The caller's current Claude Code session id: the one that owns the pages it drives in the tab ledger. */
  session?: string
}

export type CallResult = { ok: true; text: string } | { ok: false; status: number; error: string }
