// What a running turn is doing now, said as Claude Desktop's working line says it (owner, 2026-10-08, showing its "Reading
// how lastCwd and session files are derived 1m 33s" and "Land the tightened ceiling file alone 9m 8s": "dynamically change
// ... what task it's running right now", and a timer "since the last human-written message"). The words are the turn's
// newest step on the main thread: the description its tool call gave (a command's, a sub-agent's), else what the step is
// ("Reading notes.txt"). A sub-agent's own steps stay inside it: its task is the line. The clock starts at the person's last
// message: a program's note, a queued message and a sub-agent's prompt do not restart it.
import type { TranscriptItem } from '@shared/protocol'
import { parseMcpName, shortPath } from './tools'

export interface NowDoing {
  /** The line's words; null before anything is known (the caller says "Working"). */
  text: string | null
  /** When the person last wrote (epoch ms), or null when the transcript has no message of theirs. */
  since: number | null
}

type Tool = Extract<TranscriptItem, { kind: 'tool_use' }>

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One step in words: its own description when the call gave one, else what kind of step it is. */
export function stepLine(t: Pick<Tool, 'name' | 'input'>, cwd?: string | null): string {
  const i = t.input ?? {}
  const own = firstLine(str(i.description))
  if (own) return own
  const path = (key: string) => shortPath(str(i[key]), cwd)
  switch (t.name) {
    case 'Bash':
    case 'PowerShell':
      return i.command ? `Running ${firstLine(str(i.command))}` : 'Running a command'
    case 'Read':
      return i.file_path ? `Reading ${path('file_path')}` : 'Reading a file'
    case 'Edit':
    case 'MultiEdit':
      return i.file_path ? `Editing ${path('file_path')}` : 'Editing a file'
    case 'NotebookEdit':
      return i.notebook_path ? `Editing ${path('notebook_path')}` : 'Editing a notebook'
    case 'Write':
      return i.file_path ? `Writing ${path('file_path')}` : 'Writing a file'
    case 'Grep':
      return i.pattern ? `Searching for ${str(i.pattern)}` : 'Searching'
    case 'Glob':
      return i.pattern ? `Finding ${str(i.pattern)}` : 'Finding files'
    case 'WebSearch':
      return i.query ? `Searching the web for ${str(i.query)}` : 'Searching the web'
    case 'WebFetch':
      return i.url ? `Fetching ${host(str(i.url))}` : 'Fetching a page'
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as { status?: unknown; activeForm?: unknown; content?: unknown }[]) : []
      const now = todos.find((x) => x?.status === 'in_progress')
      return (now && (str(now.activeForm) || str(now.content))) || 'Updating the to-do list'
    }
    case 'Agent':
    case 'Task':
      return 'Running a sub-agent'
    case 'Skill':
      return i.skill ? `Using the ${str(i.skill)} skill` : 'Using a skill'
    case 'ToolSearch':
      return 'Loading tools'
    case 'AskUserQuestion':
      return 'Asking you a question'
    case 'ExitPlanMode':
      return 'Proposing a plan'
  }
  const mcp = parseMcpName(t.name)
  return mcp ? `Using ${mcp.server} ${mcp.tool.replace(/_/g, ' ')}` : `Using ${t.name}`
}

/** What the transcript's last turn is doing now and when the person last wrote. Reads back only to their last message. */
export function nowDoing(items: readonly TranscriptItem[], cwd?: string | null): NowDoing {
  let newest: TranscriptItem | null = null // the newest main-thread step of the turn
  let tool: Tool | null = null // its newest tool call
  let found = false // the step is known; what is left is finding the message
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]
    if (it.parentToolUseId) continue
    if (it.kind === 'user' && !it.queued) return { text: line(newest, tool, cwd), since: it.ts }
    // A program's note begins a turn of its own: the steps before it are an earlier turn's.
    if (it.kind === 'note') found = true
    if (found || (it.kind !== 'assistant_text' && it.kind !== 'thinking' && it.kind !== 'tool_use')) continue
    newest ??= it
    if (it.kind === 'tool_use') {
      tool = it
      found = true
    }
  }
  return { text: line(newest, tool, cwd), since: null }
}

// Writing or thinking as it streams says so; otherwise the turn's newest call names it, even between calls, so the line
// holds still while the next one is being worked out. A turn with no call yet is thinking.
function line(newest: TranscriptItem | null, tool: Tool | null, cwd?: string | null): string | null {
  if (!newest) return null
  if (newest.kind === 'assistant_text' && newest.streaming) return 'Writing'
  if (newest.kind === 'thinking' && newest.streaming) return 'Thinking'
  return tool ? stepLine(tool, cwd) : 'Thinking'
}

/** A running time the way Claude Desktop shows it: "33s", "1m 33s", "1h 28m 23s". */
export function runningFor(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`
}
