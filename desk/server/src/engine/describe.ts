// Short human lines for what a chat is doing (SPEC "The engine": activity, titles, contextPct). Pure.

export const ACTIVITY_MAX = 60
export const TITLE_MAX = 60

/** Cuts to max chars, ending with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  const s = text.trim()
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim()) ?? ''
}

/** A path shown relative to cwd when inside it, always with forward slashes. */
export function shortPath(path: string, cwd?: string | null): string {
  const p = path.replace(/\\/g, '/')
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (p.toLowerCase().startsWith(base.toLowerCase() + '/')) return p.slice(base.length + 1)
  }
  return p
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * "Bash: bun test", "Edit: web/src/App.vue", "Read: notes.txt", "Searching", ... cut to 60 chars.
 * Input shapes follow sdk-tools.d.ts (BashInput.command, FileEditInput.file_path, ...).
 */
export function describeToolActivity(name: string, input: Record<string, unknown> | null | undefined, cwd?: string | null): string {
  const i = input ?? {}
  const path = (key: string) => shortPath(str(i[key]), cwd)
  let line: string
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      line = i.command ? `${name}: ${firstLine(str(i.command))}` : name
      break
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      line = i.file_path ? `${name}: ${path('file_path')}` : name
      break
    case 'NotebookEdit':
      line = i.notebook_path ? `Edit: ${path('notebook_path')}` : 'Edit'
      break
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
      line = 'Searching'
      break
    case 'WebSearch':
      line = i.query ? `Searching the web: ${str(i.query)}` : 'Searching the web'
      break
    case 'WebFetch':
      line = i.url ? `Fetching: ${host(str(i.url))}` : 'Fetching'
      break
    case 'TodoWrite':
      line = 'Updating todos'
      break
    case 'Agent':
    case 'Task':
      line = i.description ? `Agent: ${str(i.description)}` : 'Agent'
      break
    case 'AskUserQuestion':
      line = 'Asking you a question'
      break
    case 'ExitPlanMode':
      line = 'Proposing a plan'
      break
    case 'Skill':
      line = i.skill ? `Skill: ${str(i.skill)}` : 'Skill'
      break
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      line = m ? `${m[1]}: ${m[2]}` : name
    }
  }
  return cut(line, ACTIVITY_MAX)
}

/** A chat title from its first prompt: the first non-empty line, at most 60 chars. */
export function titleFromPrompt(text: string): string {
  const line = firstLine(text).replace(/\s+/g, ' ')
  return line ? cut(line, TITLE_MAX) : 'New chat'
}

/**
 * 0..100 share of the context window used, from query.getContextUsage()
 * (SDKControlGetContextUsageResponse: percentage, totalTokens, maxTokens). null when unknown.
 */
export function contextPct(usage: { percentage?: number; totalTokens?: number; maxTokens?: number } | null | undefined): number | null {
  if (!usage) return null
  let pct: number | null = null
  if (typeof usage.percentage === 'number' && Number.isFinite(usage.percentage)) pct = usage.percentage
  else if (typeof usage.totalTokens === 'number' && typeof usage.maxTokens === 'number' && usage.maxTokens > 0)
    pct = (usage.totalTokens / usage.maxTokens) * 100
  if (pct === null) return null
  return Math.min(100, Math.max(0, Math.round(pct)))
}
