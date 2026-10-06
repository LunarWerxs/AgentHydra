// What a tool row's one-line header says. Pure: no Vue, no DOM.
import type { BrowserOpenRequest } from '@shared/browser'
import type { TranscriptItem } from '@shared/protocol'

export type ToolFamily =
  | 'bash'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'web'
  | 'todo'
  | 'agent'
  | 'climayte'
  | 'browser'
  | 'mcp'
  | 'other'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The family decides the icon and the body layout. */
export function toolFamily(name: string, input?: Record<string, unknown>): ToolFamily {
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'PowerShell':
      return 'bash'
    case 'Read':
    case 'NotebookRead':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Write':
      return 'write'
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'TodoWrite':
      return 'todo'
    case 'Agent':
    case 'Task':
      return 'agent'
  }
  if (isCliMayteTool(name)) return 'climayte'
  if (input && isBrowserCall(name, input)) return 'browser'
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}

/** The tool that hands the person a file (SendUserFile, or an MCP server's own). */
export function isSendFileTool(name: string): boolean {
  return name === 'SendUserFile' || name.endsWith('__SendUserFile') || name.endsWith('__send_user_file')
}

export function isCliMayteTool(name: string): boolean {
  return name.startsWith('mcp__agenthydra__climayte_')
}

/** The AI's browser: a Connections MCP call (any server prefix) that runs a local browser_* tool. */
export function isBrowserCall(name: string, input: Record<string, unknown>): boolean {
  return (
    /^mcp__.+__connections_execute$/.test(name) &&
    input.local === true &&
    typeof input.tool_name === 'string' &&
    input.tool_name.startsWith('browser_')
  )
}

const BROWSER_VERBS: Record<string, string> = {
  navigate: 'Opened',
  click: 'Clicked',
  type: 'Typed into',
  snapshot: 'Read',
  read: 'Read',
  get_text: 'Read',
  take_screenshot: 'Screenshot of',
  profile_login: 'Sign-in window for',
  profile_find: 'Looked for a saved browser for',
  profiles: 'Listed saved browsers',
  live: 'Showed live',
}

export const DEFAULT_BROWSER = 'default browser'

/**
 * What a Browser card shows. `name` is the browser tool ("browser_navigate") or the whole MCP call name (then the
 * tool is input.tool_name). The url is params.url, else the first http(s) address in the result; the profile is
 * params.profile (or its aliases profile_id / profileId), else the default browser.
 */
export function parseBrowserCall(
  name: string,
  input: Record<string, unknown>,
  resultText?: string,
): { verb: string; url: string; profile: string } {
  const tool = (name.startsWith('mcp__') ? str(input.tool_name) : name).replace(/^browser_/, '')
  const verb = BROWSER_VERBS[tool] ?? (tool ? tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Browser')
  const params = input.params && typeof input.params === 'object' ? (input.params as Record<string, unknown>) : {}
  const fromResult = resultText ? (/https?:\/\/[^\s"'<>)\]}\\]+/.exec(resultText)?.[0] ?? '') : ''
  return { verb, url: str(params.url) || fromResult, profile: str(params.profile) || str(params.profile_id) || str(params.profileId) || DEFAULT_BROWSER }
}

/** What a click on a Browser card asks the pane to show: no profile for the person's own (default) browser. */
export function browserOpenRequest(info: { url: string; profile: string }): BrowserOpenRequest {
  return { profile: info.profile === DEFAULT_BROWSER ? undefined : info.profile, url: info.url || undefined }
}

/** mcp__server__tool -> { server, tool }; null for built-in tools. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { server: m[1], tool: m[2] } : null
}

/** The name shown in the header: "Bash", "agenthydra · climayte_run". */
export function toolLabel(name: string): string {
  const mcp = parseMcpName(name)
  return mcp ? `${mcp.server} · ${mcp.tool}` : name
}

/** Shorten an absolute path under cwd to a relative one; always forward slashes. */
export function shortPath(path: string, cwd?: string | null): string {
  const p = path.replace(/\\/g, '/')
  if (cwd) {
    const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (c && p.toLowerCase().startsWith(c.toLowerCase() + '/')) return p.slice(c.length + 1)
  }
  return p
}

function firstLine(s: string, max = 160): string {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const multi = s.trim().includes('\n')
  const t = line.trim()
  if (t.length > max) return t.slice(0, max - 1) + '…'
  return multi ? t + ' …' : t
}

// Argument names an MCP tool's key argument is most often under, in order of preference.
const MCP_KEYS = ['query', 'q', 'url', 'path', 'file_path', 'command', 'prompt', 'name', 'id', 'title', 'text']

/** The key argument shown after the tool name: the Bash command, the file path, the pattern, the URL. */
export function keyArgument(name: string, input: Record<string, unknown>, cwd?: string | null): string {
  const path = (k = 'file_path') => shortPath(str(input[k]), cwd)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(str(input.command))
    case 'BashOutput':
      return str(input.bash_id)
    case 'KillShell':
      return str(input.shell_id)
    case 'Read': {
      const off = typeof input.offset === 'number' ? input.offset : null
      const lim = typeof input.limit === 'number' ? input.limit : null
      if (off !== null && lim !== null) return `${path()} · lines ${off}-${off + lim - 1}`
      if (off !== null) return `${path()} · from line ${off}`
      if (lim !== null) return `${path()} · lines 1-${lim}`
      return path()
    }
    case 'NotebookRead':
    case 'NotebookEdit':
      return path('notebook_path')
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return path()
    case 'Grep': {
      const where = str(input.path) ? shortPath(str(input.path), cwd) : str(input.glob)
      const pat = str(input.pattern)
      return where ? `${pat} · ${where}` : pat
    }
    case 'Glob': {
      const where = str(input.path) ? shortPath(str(input.path), cwd) : ''
      return where ? `${str(input.pattern)} · ${where}` : str(input.pattern)
    }
    case 'LS':
      return path('path')
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      const done = todos.filter((t: any) => t?.status === 'completed').length
      return `${done}/${todos.length} done`
    }
    case 'Agent':
    case 'Task': {
      const d = str(input.description) || firstLine(str(input.prompt), 100)
      const t = str(input.subagent_type)
      return t && t !== 'general-purpose' ? `${d} · ${t}` : d
    }
  }
  if (isCliMayteTool(name)) {
    const tasks = Array.isArray(input.tasks) ? input.tasks : null
    if (tasks) return `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
  }
  for (const k of MCP_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return firstLine(k.includes('path') ? shortPath(v, cwd) : v, 120)
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return firstLine(v, 120)
  }
  return ''
}

/** Bash exit state from the result text: Claude Code reports a failing command as "Exit code N". */
export function bashExit(
  status: 'running' | 'done' | 'error' | 'denied',
  resultText: string | undefined,
): { label: string; ok: boolean | null } {
  if (status === 'running') return { label: 'running', ok: null }
  if (status === 'denied') return { label: 'denied', ok: false }
  const m = resultText ? /(?:^|\n)\s*Exit code:?\s*(-?\d+)/i.exec(resultText) : null
  if (m) {
    const code = Number(m[1])
    return { label: `exit ${code}`, ok: code === 0 }
  }
  if (status === 'error') return { label: 'failed', ok: false }
  return { label: 'exit 0', ok: true }
}

/** Long tool output: the first `maxLines` lines (and at most `maxChars`), plus what was hidden. */
export function truncateText(
  text: string,
  maxLines = 30,
  maxChars = 4000,
): { shown: string; truncated: boolean; totalLines: number; hiddenLines: number } {
  const lines = text.split('\n')
  const totalLines = lines.length
  let shown = lines.slice(0, maxLines).join('\n')
  if (shown.length > maxChars) shown = shown.slice(0, maxChars)
  const truncated = shown.length < text.length
  const shownLines = shown === '' ? 0 : shown.split('\n').length
  return { shown, truncated, totalLines, hiddenLines: truncated ? Math.max(0, totalLines - shownLines) : 0 }
}

export interface CliMayteTask {
  title: string
  cwd?: string
  kind?: string
}

/** What a CliMayte card shows: the action, the tasks dispatched and the worker ids the result named. */
export function parseCliMayte(
  name: string,
  input: Record<string, unknown>,
  resultText?: string,
): { action: string; tasks: CliMayteTask[]; workerIds: string[] } {
  const action = name.replace(/^mcp__agenthydra__climayte_/, '')
  const rawTasks = Array.isArray(input.tasks) ? (input.tasks as Record<string, unknown>[]) : []
  const tasks = rawTasks.map((t) => ({
    title: str(t?.title) || firstLine(str(t?.prompt), 110) || '(task)',
    cwd: str(t?.cwd) || undefined,
    kind: str(t?.kind) || undefined,
  }))
  const ids = new Set<string>()
  for (const k of ['id', 'workerId', 'worker_id']) if (str(input[k])) ids.add(str(input[k]))
  if (resultText) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(resultText)
    } catch {
      parsed = null
    }
    if (parsed !== null) collectIds(parsed, ids, 0)
    else {
      const re = /\b(?:worker[ _-]?id|workerId|"id")["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{5,})/gi
      for (let m = re.exec(resultText); m; m = re.exec(resultText)) ids.add(m[1])
    }
  }
  return { action, tasks, workerIds: [...ids] }
}

function collectIds(v: unknown, ids: Set<string>, depth: number) {
  if (depth > 4 || v === null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    v.forEach((x) => collectIds(x, ids, depth + 1))
    return
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === 'id' || k === 'workerId' || k === 'worker_id') && typeof x === 'string' && x) ids.add(x)
    else if ((k === 'workerIds' || k === 'worker_ids') && Array.isArray(x)) {
      x.forEach((y) => typeof y === 'string' && ids.add(y))
    } else if (k === 'workers' || k === 'tasks' || k === 'results' || k === 'worker') collectIds(x, ids, depth + 1)
  }
}

/** "820ms", "12s", "2m 05s", "1h 03m". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** The id of the newest browser call of each profile (the default browser has none): its card is the one that may show live. */
export function newestBrowserCalls(items: readonly TranscriptItem[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const it of items) {
    if (it.kind !== 'tool_use' || !isBrowserCall(it.name, it.input)) continue
    const { profile } = parseBrowserCall(it.name, it.input)
    if (profile !== DEFAULT_BROWSER) out.set(profile, it.id)
  }
  return out
}
