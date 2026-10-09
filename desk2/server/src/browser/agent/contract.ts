// The call surface of AgentHydra's own browser tools: the names, the caller, and the answer of one call.
// Read-only: none of these tools launches a Chrome or drives a page's input.

export const READ_TOOLS = [
  'browser_profiles',
  'browser_status',
  'browser_profile_find',
  'browser_targets',
  'browser_frames',
] as const

export type ReadToolName = (typeof READ_TOOLS)[number]

export interface ToolParams {
  browser_profiles: Record<string, never>
  browser_status: { attachPort?: number }
  browser_profile_find: { for: string }
  browser_targets: { attachPort?: number; profile?: string }
  browser_frames: { attachPort?: number; profile?: string }
}

export interface ToolCaller {
  /** The Desk chat's id (its Claude session id); owns the pages it drives in the tab ledger. */
  chat?: string
  /** The CliMayte worker's id, when a worker is calling. */
  worker?: string
  /** The folder the chat works in; picks the saved-browser workspace. */
  cwd?: string
}

export type CallResult = { ok: true; text: string } | { ok: false; status: number; error: string }

export function isReadTool(name: string): name is ReadToolName {
  return (READ_TOOLS as readonly string[]).includes(name)
}
