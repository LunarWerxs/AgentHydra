// transcript-groups - fold an open transcript's tool calls, tool results and reasoning into the
// collapsible "work" rows the viewer draws between messages, the way the Claude desktop app shows
// a turn's steps as one quiet line ("Read 3 files, ran 2 commands") instead of a wall of log blocks.
//
// Pure: no Vue, no i18n. It returns structure (which steps, which categories, how many), and the
// component turns that into words. The ideas (one row per run of work, results folded into their
// call, a summary of at most a few action kinds with the rest counted) follow T3 Code's work-log
// presentation (MIT, Copyright (c) 2026 T3 Tools Inc.); this is written fresh for AgentHydra's
// TailEvent shape, which every session source (Claude, Codex, OpenCode, Hermes, DSH) already shares.

export type ToolCategory =
  | 'read'
  | 'edit'
  | 'command'
  | 'search'
  | 'web'
  | 'agent'
  | 'plan'
  | 'mcp'
  | 'other'

/** The fields grouping reads. TranscriptTurn (useTranscriptDisplay) is one, with render fields. */
export interface GroupableEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
  /** Set by the daemon when the transcript itself marked the result an error (Claude `is_error`). */
  error?: boolean
  /** Find-in-transcript matches inside this event, when a find is running. */
  hits?: number
}

export interface WorkStep<E extends GroupableEvent = GroupableEvent> {
  key: string
  kind: 'thinking' | 'tool'
  /** Transcript index of the call or the reasoning block (or of an orphan result): what
   *  `data-turn` names, so an anchor or a find can land on the step. */
  index: number
  /** The tool_use, or the thinking block. Null only for a result whose call scrolled out of the
   *  loaded window. */
  call: E | null
  result: E | null
  resultIndex: number | null
  category: ToolCategory | null
  /** The tool as named in the transcript (`Read`, `mcp__hswarm__hswarm_run`, `exec_command`). */
  tool: string | null
  /** One line saying what the step touched: a path, a command, a pattern, a URL. */
  preview: string
  /** What a read or edit was aimed at, for counting distinct files. */
  target: string | null
  failed: boolean
  hits: number
}

export interface WorkGroup<E extends GroupableEvent = GroupableEvent> {
  type: 'work'
  key: string
  /** Every transcript index folded into this row, oldest first. */
  indices: number[]
  steps: WorkStep<E>[]
  /** When the work began: the end of the message before it, else its own first event. */
  startedAt: number | null
  /** Its last event's time. */
  endedAt: number | null
  failed: boolean
  hits: number
  thinkingOnly: boolean
}

export interface TurnItem<E extends GroupableEvent = GroupableEvent> {
  type: 'turn'
  key: string
  index: number
  ev: E
}

export type DisplayItem<E extends GroupableEvent = GroupableEvent> = TurnItem<E> | WorkGroup<E>

export interface SummaryPart {
  category: ToolCategory
  count: number
  /** For `mcp`: the distinct server names used, in first-use order. */
  names: string[]
}

export interface WorkSummary {
  parts: SummaryPart[]
  /** Tool calls not covered by `parts`. */
  more: number
  /** Reasoning blocks in the group (never counted as tool calls). */
  thoughts: number
}

const NAME_CATEGORY: Record<string, ToolCategory> = {
  // reading
  read: 'read',
  read_file: 'read',
  view: 'read',
  notebookread: 'read',
  ls: 'read',
  list_dir: 'read',
  list_directory: 'read',
  read_many_files: 'read',
  // changing files
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',
  create_file: 'edit',
  write_file: 'edit',
  replace: 'edit',
  patch: 'edit',
  // running things
  bash: 'command',
  powershell: 'command',
  shell: 'command',
  exec_command: 'command',
  local_shell: 'command',
  run_terminal_cmd: 'command',
  run_shell_command: 'command',
  terminal: 'command',
  bashoutput: 'command',
  killshell: 'command',
  killbash: 'command',
  write_stdin: 'command',
  // searching the code
  grep: 'search',
  glob: 'search',
  search: 'search',
  find: 'search',
  codebase_search: 'search',
  file_search: 'search',
  search_file_content: 'search',
  // the web
  webfetch: 'web',
  websearch: 'web',
  web_search: 'web',
  web_fetch: 'web',
  fetch: 'web',
  read_url: 'web',
  // delegating
  task: 'agent',
  agent: 'agent',
  spawn_agent: 'agent',
  delegate: 'agent',
  workflow: 'agent',
  // planning
  todowrite: 'plan',
  todoread: 'plan',
  update_plan: 'plan',
  exitplanmode: 'plan',
}

export function toolCategory(name: string | null | undefined): ToolCategory {
  if (!name) return 'other'
  if (name.startsWith('mcp__')) return 'mcp'
  return NAME_CATEGORY[name.toLowerCase()] ?? 'other'
}

/** `mcp__hswarm__hswarm_run` -> { server: 'hswarm', tool: 'hswarm_run' }. Server names can hold
 *  single underscores, so the split is on the double ones. */
export function mcpParts(name: string): { server: string; tool: string } {
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  return cut < 0
    ? { server: rest, tool: '' }
    : { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

const PREVIEW_MAX = 140

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat
}

/** The last two segments of a path: enough to recognise a file, short enough for one line. */
export function shortPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

/** A tool's input as an object. The daemon sends it as compact JSON cut at 1200 characters, so a
 *  long input arrives truncated and will not parse; the regex fallback still finds the leading
 *  string fields, which is all a one-line preview needs. */
function inputFields(text: string): Record<string, unknown> {
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // truncated: fall through to the field scan
    }
  }
  const out: Record<string, unknown> = {}
  // A complete string field, or a complete array of strings (Codex's argv-style `cmd`).
  const field = /"([A-Za-z_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|\[\s*(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\])/g
  for (const m of t.matchAll(field)) {
    if (m[1] in out) continue
    try {
      out[m[1]] = JSON.parse(m[2])
    } catch {
      out[m[1]] = m[2]
    }
  }
  return out
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v
  // Codex's shell tool takes argv: ["bash", "-lc", "git status"]. The last word is the command.
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string'))
    return v.at(-1) as string
  return null
}

function firstField(f: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(f[k])
    if (v) return v
  }
  return null
}

const PATH_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'filePath',
  'file',
  'filename',
  'target_file',
]

/** What one call touched, as one line, plus the file it aimed at when it aimed at one. */
export function describeCall(
  name: string | null,
  text: string,
): { preview: string; target: string | null } {
  const category = toolCategory(name)
  // apply_patch (Codex) sends the raw patch, not JSON: the file names are in its headers.
  if (category === 'edit' && /\*\*\* (?:Update|Add|Delete) File: /.test(text)) {
    const files = [...text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)].map((m) =>
      m[1].trim(),
    )
    return { preview: files.map(shortPath).join(', '), target: files[0] ?? null }
  }
  const f = inputFields(text)
  switch (category) {
    case 'read':
    case 'edit': {
      const p = firstField(f, PATH_KEYS)
      return { preview: p ? shortPath(p) : oneLine(text), target: p }
    }
    case 'command': {
      const c = firstField(f, ['command', 'cmd', 'script', 'input', 'chars', 'bash_id', 'shell_id'])
      return { preview: oneLine(c ?? firstField(f, ['description']) ?? text), target: null }
    }
    case 'search': {
      const pat = firstField(f, ['pattern', 'query', 'glob', 'regex', 'q'])
      const where = firstField(f, ['path', 'glob', 'include'])
      const p = pat && where && where !== pat ? `${pat}  ·  ${shortPath(where)}` : pat
      return { preview: oneLine(p ?? text), target: null }
    }
    case 'web':
      return { preview: oneLine(firstField(f, ['url', 'query', 'q']) ?? text), target: null }
    case 'agent':
      return {
        preview: oneLine(
          firstField(f, ['description', 'subagent_type', 'name', 'prompt', 'message']) ?? text,
        ),
        target: null,
      }
    case 'plan':
      return { preview: '', target: null }
    default: {
      // mcp and the rest: the first short string argument says the most in the least space.
      const v = Object.values(f).find((x) => typeof x === 'string' && x.trim() && x.length < 400)
      return { preview: oneLine(typeof v === 'string' ? v : text), target: null }
    }
  }
}

/** A failed result: the transcript said so, or the output opens the way tool errors do. Read from
 *  the START only, so a file that merely mentions "error" on line 40 is not a failure. */
export function resultFailed(ev: GroupableEvent | null): boolean {
  if (!ev) return false
  if (ev.error) return true
  return /^\s*(<tool_use_error>|error\b|exit code:? *[1-9]|process exited with code [1-9]|command failed)/i.test(
    ev.text.slice(0, 200),
  )
}

function time(ts: string | null): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

/** A key that survives the window sliding: the 4 s poll drops the oldest turn as a new one
 *  arrives, so an index would hand one message's expanded state to its neighbour. */
export function eventKey(ev: GroupableEvent, i: number): string {
  return `${ev.timestamp ?? `#${i}`}|${ev.kind}|${ev.tool_name ?? ''}|${ev.text.length}|${ev.text.slice(0, 32)}`
}

function step<E extends GroupableEvent>(ev: E, i: number): WorkStep<E> {
  if (ev.kind === 'thinking') {
    return {
      key: eventKey(ev, i),
      kind: 'thinking',
      index: i,
      call: ev,
      result: null,
      resultIndex: null,
      category: null,
      tool: null,
      preview: oneLine(ev.text),
      target: null,
      failed: false,
      hits: ev.hits ?? 0,
    }
  }
  const call = ev.kind === 'tool_use'
  const { preview, target } = call
    ? describeCall(ev.tool_name, ev.text)
    : { preview: '', target: null }
  return {
    key: eventKey(ev, i),
    kind: 'tool',
    index: i,
    call: call ? ev : null,
    result: call ? null : ev,
    resultIndex: call ? null : i,
    category: toolCategory(ev.tool_name),
    tool: ev.tool_name,
    preview: call ? preview : oneLine(ev.text),
    target,
    failed: call ? false : resultFailed(ev),
    hits: ev.hits ?? 0,
  }
}

/**
 * The transcript as the viewer draws it: every message on its own, and every run of tool calls,
 * tool results and reasoning between two messages folded into one work group.
 *
 * Results pair with their calls in order (Claude and Codex both answer parallel calls in the order
 * they were made); a result that names its tool (DSH, Hermes) pairs with the oldest open call of
 * that name first. A result with no open call (its call is above the loaded window) stays a step
 * of its own rather than being dropped.
 */
export function buildDisplayItems<E extends GroupableEvent>(
  events: readonly E[],
): DisplayItem<E>[] {
  const items: DisplayItem<E>[] = []
  let group: WorkGroup<E> | null = null
  let open: WorkStep<E>[] = []

  const close = () => {
    if (!group) return
    group.thinkingOnly = group.steps.every((s) => s.kind === 'thinking')
    group.failed = group.steps.some((s) => s.failed)
    group.hits = group.steps.reduce((n, s) => n + s.hits, 0)
    items.push(group)
    group = null
    open = []
  }

  events.forEach((ev, i) => {
    if (ev.kind === 'text') {
      close()
      items.push({ type: 'turn', key: eventKey(ev, i), index: i, ev })
      return
    }
    if (!group) {
      group = {
        type: 'work',
        key: `w:${eventKey(ev, i)}`,
        indices: [],
        steps: [],
        startedAt: time(ev.timestamp),
        endedAt: null,
        failed: false,
        hits: 0,
        thinkingOnly: false,
      }
    }
    group.indices.push(i)
    group.endedAt = time(ev.timestamp) ?? group.endedAt
    if (ev.kind === 'tool_result') {
      const at = ev.tool_name ? open.findIndex((s) => s.tool === ev.tool_name) : -1
      const pair = open.splice(at >= 0 ? at : 0, 1)[0]
      if (pair) {
        pair.result = ev
        pair.resultIndex = i
        pair.failed = resultFailed(ev)
        pair.hits += ev.hits ?? 0
        return
      }
    }
    const s = step(ev, i)
    group.steps.push(s)
    if (ev.kind === 'tool_use') open.push(s)
  })
  close()

  // The work began when the message before it ended (the prompt it answers, or the line the model
  // wrote before reaching for a tool), not at its own first event: a transcript stamps a reasoning
  // block when it is written out, after the thinking it records. Two work rows are never adjacent
  // (only a message ends one), so the item before a work row is always a message.
  for (let k = 1; k < items.length; k++) {
    const it = items[k]
    const prev = items[k - 1]
    if (it.type === 'work' && prev.type === 'turn')
      it.startedAt = time(prev.ev.timestamp) ?? it.startedAt
  }
  return items
}

/** Category order when there are more kinds than the summary shows: the ones that change things
 *  first, then the ones that look, then the rest. */
const PRIORITY: Record<ToolCategory, number> = {
  edit: 0,
  command: 0,
  agent: 0,
  read: 1,
  search: 1,
  web: 1,
  mcp: 1,
  plan: 2,
  other: 2,
}

/** At most `maxParts` action kinds, shown in the order they first happened; every call left out is
 *  still counted in `more`. Reads and edits count distinct files, the rest count calls. */
export function summarizeWork(steps: readonly WorkStep[], maxParts = 3): WorkSummary {
  const byCat = new Map<
    ToolCategory,
    { first: number; calls: number; targets: Set<string>; untargeted: number; names: string[] }
  >()
  let thoughts = 0
  steps.forEach((s, i) => {
    if (s.kind === 'thinking') {
      thoughts++
      return
    }
    const cat = s.category ?? 'other'
    let g = byCat.get(cat)
    if (!g) {
      g = { first: i, calls: 0, targets: new Set(), untargeted: 0, names: [] }
      byCat.set(cat, g)
    }
    g.calls++
    if (s.target) g.targets.add(s.target.replace(/\\/g, '/').toLowerCase())
    else g.untargeted++
    if (cat === 'mcp' && s.tool) {
      const server = mcpParts(s.tool).server
      if (!g.names.includes(server)) g.names.push(server)
    }
  })
  const all = [...byCat].map(([category, g]) => ({
    category,
    first: g.first,
    calls: g.calls,
    count: category === 'read' || category === 'edit' ? g.targets.size + g.untargeted : g.calls,
    names: g.names,
  }))
  const shown = [...all]
    .sort((a, b) => PRIORITY[a.category] - PRIORITY[b.category] || a.first - b.first)
    .slice(0, maxParts)
    .sort((a, b) => a.first - b.first)
  const covered = shown.reduce((n, p) => n + p.calls, 0)
  const total = all.reduce((n, p) => n + p.calls, 0)
  return {
    parts: shown.map(({ category, count, names }) => ({ category, count, names })),
    more: total - covered,
    thoughts,
  }
}

/** "12s", "4m 05s", "1h 07m": how long a run of work took. Null under a second, where a number
 *  would only be noise. */
export function formatElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 1000) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A tool's input the way a person reads it: one `key: value` line per argument, a string shown as
 *  written (a multi-line command or an edit's old and new text keeps its line breaks, indented under
 *  its key), anything else as compact JSON. Input that is not one whole JSON object (the daemon
 *  cuts long inputs at 1200 characters, and apply_patch sends a raw patch) comes back unchanged,
 *  since half an object re-laid out would read as if it were all of it. */
export function formatToolInput(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{')) return text
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch {
    return text
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return text
  const lines: string[] = []
  for (const [key, val] of Object.entries(v)) {
    if (typeof val !== 'string') lines.push(`${key}: ${JSON.stringify(val)}`)
    else if (!val.includes('\n')) lines.push(`${key}: ${val}`)
    else lines.push(`${key}:`, ...val.split('\n').map((l) => `  ${l}`))
  }
  return lines.length ? lines.join('\n') : text
}
