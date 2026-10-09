// The call surface of AgentHydra's own browser tools: the names, the caller, and the answer of one call.
// browser_navigate is the only tool that starts a Chrome or drives a page; the others read. The tool list itself lives in registry.ts.

export interface ToolParams {
  browser_profiles: Record<string, never>
  browser_status: { attachPort?: number }
  browser_profile_find: { for: string }
  browser_targets: { attachPort?: number; profile?: string }
  browser_frames: { attachPort?: number; profile?: string }
  browser_profile_note: { profile: string; note?: string; title?: string }
  browser_profile_claim: { profile: string; from?: string }
  browser_handoff: { profile: string; urls?: string[] }
  browser_profile_login: { profile: string; url?: string; verify?: boolean; note?: string }
  browser_navigate: { url: string; headed?: boolean; waitMs?: number; attachPort?: number; profile?: string }
  browser_snapshot: { mode?: string; maxLines?: number; attachPort?: number; profile?: string }
  browser_get_text: { attachPort?: number; profile?: string }
  browser_read: { selector: string; attr?: string; attachPort?: number; profile?: string }
  browser_evaluate: { expression: string; timeoutMs?: number; attachPort?: number; profile?: string }
  browser_upload_file: {
    file?: string
    files?: string[]
    selector?: string
    waitMs?: number
    attachPort?: number
    profile?: string
  }
  browser_click: {
    ref?: string
    text?: string
    selector?: string
    x?: number
    y?: number
    double?: boolean
    button?: string
    waitMs?: number
    attachPort?: number
    profile?: string
  }
  browser_hover: {
    ref?: string
    text?: string
    selector?: string
    x?: number
    y?: number
    waitMs?: number
    attachPort?: number
    profile?: string
  }
  browser_select: {
    option: string
    selector?: string
    trigger?: string
    x?: number
    y?: number
    attachPort?: number
    profile?: string
  }
  browser_type: {
    text?: string
    secret?: string
    ref?: string
    selector?: string
    attachPort?: number
    profile?: string
  }
  browser_press_key: { key: string; waitMs?: number; attachPort?: number; profile?: string }
  browser_take_screenshot: {
    path?: string
    fullPage?: boolean
    grid?: boolean
    gridStep?: number
    detail?: string
    format?: string
    quality?: number
    maxWidth?: number
    attachPort?: number
    profile?: string
  }
  browser_resize: { width: number; height: number; mobile?: boolean; attachPort?: number; profile?: string }
  browser_wait_idle: { idleMs?: number; timeoutMs?: number; attachPort?: number; profile?: string }
  browser_wait_tab: { match?: string; timeoutMs?: number; attachPort?: number; profile?: string }
  browser_tab_errors: { match?: string; timeoutMs?: number; attachPort?: number; profile?: string }
  browser_tab: { match?: string; attachPort?: number; profile?: string }
  browser_close: { attachPort?: number; profile?: string }
  browser_script: { steps: Record<string, unknown>[]; attachPort?: number; headed?: boolean; profile?: string }
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

export interface ToolImage {
  data: string
  mimeType: string
}

/** What a tool answers: its text, and optionally an image the model sees inline. */
export type ToolReply = string | { text: string; image?: ToolImage }

export type CallResult = { ok: true; text: string; image?: ToolImage } | { ok: false; status: number; error: string }
