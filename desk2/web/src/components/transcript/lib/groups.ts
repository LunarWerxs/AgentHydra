// What the transcript lays out, after nesting: runs of tool calls fold into one status row
// ("Ran 3 commands, read screen-half.png"), as the real Claude Code desktop does. Pure: no Vue, no DOM.
import { CONTINUED_LINE, type TranscriptItem } from '@shared/protocol'
import { formatElapsed, isSendFileTool, parseMcpName, shortPath, toolFamily } from './tools'
import { toolDiff } from './diff'

export type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
export type TaskItem = Extract<TranscriptItem, { kind: 'task' }>

/** The user message that started a turn: what Retry under its finished reply sends again. */
export interface TurnPrompt {
  text: string
  images: Extract<TranscriptItem, { kind: 'user' }>['images']
}

// One prompt object per user message, so a row's prompt keeps its identity while the list is laid out again.
const prompts = new WeakMap<TranscriptItem, TurnPrompt>()

export type DisplayRow =
  | { id: string; kind: 'item'; item: TranscriptItem; endOfTurn: boolean; prompt?: TurnPrompt | null }
  /** A tool run; `tasks` are background tasks that settled inside it ("finished 2 background tasks"). */
  | { id: string; kind: 'tools'; items: ToolItem[]; tasks?: TaskItem[] }
  /** Settled background tasks in a row: "18 background commands completed". */
  | { id: string; kind: 'tasks'; items: TaskItem[] }

/** Sub-agent calls keep their own card and handed-over files their own row; every other tool call, MCP ones included, folds into a status row. */
function folds(it: TranscriptItem): it is ToolItem {
  return it.kind === 'tool_use' && toolFamily(it.name) !== 'agent' && !isSendFileTool(it.name)
}

/** Status rows: a folded tool run, settled tasks, a thinking block, a finished-turn line. They sit tighter than prose. */
export function isStatusRow(r: DisplayRow): boolean {
  return r.kind === 'tools' || r.kind === 'tasks' || r.item.kind === 'thinking' || r.item.kind === 'result' || r.item.kind === 'system'
}

/**
 * How a background task shows in the flow, as the real app does: a workflow that runs, or settled in the
 * last turn, is its own card; any other running task is left to the running-tasks row under the
 * transcript; settled ones fold into the tool run they sit in, else into one muted line. A workflow that
 * finished in an earlier turn is a muted line (owner, 2026-10-05: "the chat literally shows ... two
 * running somethings").
 */
function taskPlace(it: TaskItem, lastTurn: boolean): 'card' | 'hidden' | 'settled' {
  if (it.taskKind === 'workflow' && (it.status === 'running' || lastTurn)) return 'card'
  return it.status === 'running' ? 'hidden' : 'settled'
}

/**
 * Consecutive tool calls become one 'tools' row (id `tools:<first id>`, stable while the run grows).
 * Background tasks are placed by taskPlace. The last turn starts at the latest of the last user message
 * and the last settle time (ts + durationMs) of a task: each settle woke the session with a
 * <task-notification>, which starts a new turn. A settled workflow with a settle time is in the last
 * turn when it settled at or after that start; one without keeps the index rule (after the last user
 * message). The last assistant text before the next user message (or the end) is marked endOfTurn: it
 * carries the message actions toolbar, unless it is still streaming.
 */
export function groupRows(items: TranscriptItem[]): DisplayRow[] {
  const out: DisplayRow[] = []
  let lastUser = -1
  let turnStart = -Infinity
  const settledAt = (it: TranscriptItem) =>
    it.kind === 'task' && it.status !== 'running' && it.durationMs !== undefined ? it.ts + it.durationMs : undefined
  items.forEach((it, i) => {
    // A program's note starts a turn as a message does.
    if (it.kind === 'user' || it.kind === 'note') {
      lastUser = i
      turnStart = Math.max(turnStart, it.ts)
    }
    const s = settledAt(it)
    if (s !== undefined) turnStart = Math.max(turnStart, s)
  })
  let prompt: TurnPrompt | null = null
  items.forEach((it, i) => {
    const last = out[out.length - 1]
    if (it.kind === 'user' && !it.parentToolUseId && !it.queued) {
      let p = prompts.get(it)
      if (!p || p.text !== it.text || p.images !== it.images) prompts.set(it, (p = { text: it.text, images: it.images }))
      prompt = p
    }
    // A reply to a note has no prompt of the person's to send again.
    if (it.kind === 'note') prompt = null
    // A handoff's continuation right after CliMayte's move line says nothing that line has not (owner,
    // 2026-10-05: only the move line). The move line's id is `moved:<ts>` (server chat-manager systemLine).
    if (it.kind === 'system' && it.text.startsWith(CONTINUED_LINE) && last?.kind === 'item' && last.item.id.startsWith('moved:')) return
    if (folds(it)) {
      if (last?.kind === 'tools') last.items.push(it)
      else out.push({ id: `tools:${it.id}`, kind: 'tools', items: [it] })
    } else if (it.kind === 'task') {
      const s = settledAt(it)
      const place = taskPlace(it, s !== undefined ? s >= turnStart : i > lastUser)
      if (place === 'hidden') return
      if (place === 'card') out.push({ id: it.id, kind: 'item', item: it, endOfTurn: false })
      else if (last?.kind === 'tools') (last.tasks ??= []).push(it)
      else if (last?.kind === 'tasks') last.items.push(it)
      else out.push({ id: `tasks:${it.id}`, kind: 'tasks', items: [it] })
    } else out.push(it.kind === 'assistant_text' ? { id: it.id, kind: 'item', item: it, endOfTurn: false, prompt } : { id: it.id, kind: 'item', item: it, endOfTurn: false })
  })
  let seenText = false
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]
    if (r.kind !== 'item') continue
    if (r.item.kind === 'user' || r.item.kind === 'note') seenText = false
    else if (r.item.kind === 'assistant_text' && !seenText) {
      seenText = true
      r.endOfTurn = !r.item.streaming
    }
  }
  return out
}

/**
 * Space under a row: the 20px turn gap, 8px less on each side that is a status row and 8px less under a
 * user message (its hidden actions toolbar overlaps). Measured on whole-window.png and user/window.webp:
 * prose to status row 12, status row to prose 12, user bubble to status row 4 below the toolbar.
 */
export function rowGap(rows: DisplayRow[], i: number): number {
  if (i >= rows.length - 1) return 0
  const a = rows[i]
  const user = a.kind === 'item' && a.item.kind === 'user'
  // Prose to the settled-tasks line: 15 (line centres 37 apart in real-markdown-and-file-card.png).
  if (rows[i + 1].kind === 'tasks' && !isStatusRow(a) && !user) return 15
  return Math.max(0, 20 - (isStatusRow(a) || user ? 8 : 0) - (isStatusRow(rows[i + 1]) ? 8 : 0))
}

/** One clause of a status row: muted text, an optional target in primary text ("read" + "a.png"), then a muted note ("(1 failed)"). */
export interface Phrase {
  text: string
  target?: string
  after?: string
}

export interface ToolSummary {
  phrases: Phrase[]
  running: boolean
  failed: number
  added: number
  removed: number
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const base = (p: string) => p.split('/').pop() || p
const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

type Cat = 'bash' | 'read' | 'edit' | 'write' | 'search' | 'fetch' | 'websearch' | 'todo' | 'tool'

function category(it: ToolItem): Cat {
  if (it.name === 'WebFetch') return 'fetch'
  if (it.name === 'WebSearch') return 'websearch'
  const f = toolFamily(it.name)
  return f === 'bash' || f === 'read' || f === 'edit' || f === 'write' || f === 'search' || f === 'todo' ? f : 'tool'
}

const n = (k: number, one: string, many: string) => (k === 1 ? one : `${k} ${many}`)

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return clip(url)
  }
}

/** The status row's sentence for a run of tool calls, in first-seen order; present tense while a call runs. */
export function toolSummary(items: ToolItem[], cwd?: string | null, tasks: TaskItem[] = []): ToolSummary {
  const order: Cat[] = []
  const byCat = new Map<Cat, ToolItem[]>()
  for (const it of items) {
    const c = category(it)
    if (!byCat.has(c)) {
      order.push(c)
      byCat.set(c, [])
    }
    byCat.get(c)!.push(it)
  }
  const phrases: Phrase[] = []
  for (const c of order) {
    const list = byCat.get(c)!
    const live = list.some((i) => i.status === 'running')
    const v = (past: string, now: string) => (live ? now : past)
    const files = [...new Set(list.map((i) => shortPath(str(i.input.file_path || i.input.notebook_path), cwd)))]
    const k = list.length
    const bad = list.filter((i) => i.status === 'error').length
    const at = phrases.length
    switch (c) {
      case 'bash':
        phrases.push({ text: `${v('ran', 'running')} ${n(k, 'a command', 'commands')}` })
        break
      case 'read':
      case 'edit':
      case 'write': {
        const verb = c === 'read' ? v('read', 'reading') : c === 'edit' ? v('edited', 'editing') : v('wrote', 'writing')
        // An image read is a primary-text target (screen-half.png in whole-window.png); a code file is
        // muted like the rest of the row (index.ts in user/window.webp).
        if (files.length === 1 && IMAGE.test(files[0])) phrases.push({ text: verb, target: base(files[0]) })
        else if (files.length === 1) phrases.push({ text: `${verb} ${base(files[0])}` })
        else phrases.push({ text: `${verb} ${files.length} files` })
        break
      }
      case 'search':
        phrases.push({ text: `${v('searched', 'searching')} code` })
        break
      case 'fetch':
        if (k === 1) phrases.push({ text: v('fetched', 'fetching'), target: host(str(list[0].input.url)) })
        else phrases.push({ text: `${v('fetched', 'fetching')} ${k} pages` })
        break
      case 'websearch':
        phrases.push({ text: `${v('searched', 'searching')} the web${k > 1 ? ` ${k} times` : ''}` })
        break
      case 'todo':
        phrases.push({ text: `${v('updated', 'updating')} the to-do list` })
        break
      default: {
        const mcp = items.length === 1 ? parseMcpName(list[0].name) : null
        if (mcp) phrases.push({ text: `${v('used', 'using')} ${mcp.server}: ${mcp.tool.replace(/_/g, ' ')}` })
        else if (items.length === 1) phrases.push({ text: `${v('used', 'using')} ${list[0].name}` })
        else phrases.push({ text: `${v('used', 'using')} ${n(k, 'a tool', 'tools')}` })
      }
    }
    if (bad && phrases[at]) phrases[at] = { ...phrases[at], after: `(${bad} failed)` }
  }
  if (tasks.length) {
    const bad = tasks.filter((t) => t.status === 'failed').length
    const p: Phrase = { text: `finished ${n(tasks.length, 'a background task', 'background tasks')}` }
    if (bad) p.after = `(${bad} failed)`
    phrases.push(p)
  }
  if (phrases.length) phrases[0] = { ...phrases[0], text: phrases[0].text[0].toUpperCase() + phrases[0].text.slice(1) }

  let added = 0
  let removed = 0
  for (const it of items) {
    const f = toolFamily(it.name)
    if (f !== 'edit' && f !== 'write') continue
    const d = toolDiff(it.name, it.input)
    if (d) {
      added += d.added
      removed += d.removed
    }
  }
  return {
    phrases,
    running: items.some((i) => i.status === 'running'),
    failed: items.filter((i) => i.status === 'error').length,
    added,
    removed,
  }
}

const TASK_NOUN: Record<NonNullable<TaskItem['taskKind']>, [string, string]> = {
  bash: ['background command', 'background commands'],
  workflow: ['workflow', 'workflows'],
  agent: ['agent', 'agents'],
  other: ['background task', 'background tasks'],
}

/** The muted line for settled background tasks: "18 background commands completed", "1 workflow and 2 agents completed (1 failed)". */
export function tasksLine(items: TaskItem[]): string {
  const order: NonNullable<TaskItem['taskKind']>[] = []
  const count = new Map<NonNullable<TaskItem['taskKind']>, number>()
  for (const t of items) {
    const k = t.taskKind ?? 'other'
    if (!count.has(k)) order.push(k)
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  const parts = order.map((k) => {
    const c = count.get(k)!
    return `${c} ${TASK_NOUN[k][c === 1 ? 0 : 1]}`
  })
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
  const bad = items.filter((t) => t.status === 'failed').length
  return `${list} completed${bad ? ` (${bad} failed)` : ''}`
}

export type DotState = 'done' | 'running' | 'pending' | 'failed'

/** One progress square per agent (3 when the count is not known yet): accent while running, settled blue when done. */
export function workflowDots(t: TaskItem): DotState[] {
  const n = Math.max(1, Math.min(12, t.agents ?? 3))
  const fill: DotState = t.status === 'running' ? 'running' : t.status === 'completed' || t.status === 'failed' ? 'done' : 'pending'
  const dots: DotState[] = Array.from({ length: n }, () => fill)
  if (t.status === 'failed') dots[n - 1] = 'failed'
  return dots
}

/** "11m 00s": the run time it reported, else the time since it started while it runs. */
export function workflowElapsed(t: TaskItem, now: number): string {
  if (t.durationMs !== undefined) return formatElapsed(t.durationMs)
  return t.status === 'running' ? formatElapsed(Math.max(0, now - t.ts)) : ''
}
