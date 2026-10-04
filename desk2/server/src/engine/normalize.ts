// SDK messages -> transcript items, streaming deltas, chat patches and notifications (SPEC "Normalize").
// Pure: one normalizer per live runtime, fed every SDKMessage in order. Never throws; unknown
// message types are ignored.
//
// Stable ids: assistant text / thinking = `${message.id}:${block index}` (the API message id, which
// the stream_event message_start and every assistant message of that response share; the CLI sends
// one assistant message per finished block, in block order, so a per-message counter equals the
// stream's content_block index); tool_use = the tool_use id; todos = 'todos'; tasks = `task:<id>`.
//
// Notifications here: 'finished' / 'error' from a result, 'limited' from a rejected rate_limit_event.
// 'needs_you' comes from canUseTool, which the runtime owns.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  MAX_TOOL_RESULT_CHARS,
  type ChatSummary,
  type ImageRef,
  type PermissionMode,
  type TodoEntry,
  type ToolResult,
  type TranscriptItem,
} from '@shared/protocol'
import { cut, describeToolActivity } from './describe'
import { resetsAtMs, type NotifyReason } from './status'
import { classifyUserText, taskItemFrom, taskKindOf } from './system-text'
import { MEDIA_ROUTE, mediaCache, RENDERABLE, type MediaCache } from '../media/cache'

export type Emission =
  | { type: 'upsert'; item: TranscriptItem }
  | { type: 'delta'; itemId: string; text: string }
  | { type: 'chat'; patch: Partial<ChatSummary> }
  | { type: 'notify'; reason: NotifyReason; title: string; body: string }

export interface NormalizerOptions {
  now?: () => number
  /** The chat's folder: activity lines show paths relative to it. */
  cwd?: string | null
  /** The chat's cost before this runtime started; result.total_cost_usd is cumulative per query(). */
  baseCostUsd?: number
  /** A query already under way (a chat adopted from its host after a server restart): the total it had reached and the turns it had run. */
  priorTotalCostUsd?: number
  firstTurn?: number
  /** Notification title (the chat title). */
  title?: () => string
  /** Named in usage-limit lines ("#68 eek (Max 20x)"). */
  accountLabel?: () => string | null
  /** Renders an epoch-ms reset time; defaults to the local time string. */
  formatTime?: (ms: number) => string
  /** A session's own history (its .jsonl): the person's messages become user items. Live, the runtime writes them. */
  echoUserText?: boolean
  /** Where pictures go instead of base64 (default: the data home's cache; null: pictures are left out). */
  media?: MediaCache | null
}

export interface Normalizer {
  handle(msg: SDKMessage): Emission[]
  /** The runtime denied this tool call (canUseTool deny): its item ends 'denied', now or when its result lands. */
  markDenied(toolUseId: string): Emission[]
  /** The runtime interrupted the turn: its error result is shown as "Interrupted" and does not notify. */
  noteInterrupt(): void
  /** A query already under way: what the stored transcript knows that its later messages build on (running tasks, denied calls). */
  seed(items: TranscriptItem[]): void
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
type TaskItem = Extract<TranscriptItem, { kind: 'task' }>
type Streamed = { kind: 'assistant_text' | 'thinking'; text: string; ts: number; parent: string | null; upserted: boolean }

// Loose views of the SDK shapes this file reads (sdk.d.ts names in comments). The Anthropic block
// types come from @anthropic-ai/sdk; only the fields used here are spelled out.
type Block = { type: string; [k: string]: unknown }
type Loose = Record<string, unknown>

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** A rate_limit_event's rateLimitType as the limit lines name it. */
export const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
}

function kTokens(n: unknown): string {
  return typeof n === 'number' ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : '?'
}

/** An Anthropic image block ({ source: { type: 'base64', media_type, data } }) as a cached picture; never base64. */
export function imageBlockRef(b: Block, media: MediaCache | null, name?: string): ImageRef | null {
  const src = (b.source ?? {}) as Loose
  if (src.type !== 'base64' || typeof src.data !== 'string') return null
  return media?.putBase64(src.data, name) ?? null
}

/**
 * A tool_result block's content as text: text blocks joined, images as "[image]", cut to the max. With a
 * media cache, the pictures it carries (a Read of a PNG, a screenshot tool) are cached and listed.
 */
export function toolResultText(content: unknown, isError: boolean, media: MediaCache | null = null): ToolResult {
  let text = ''
  const images: ImageRef[] = []
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as Block[]) {
      if (b?.type === 'text') parts.push(str(b.text))
      else if (b?.type === 'image') {
        parts.push('[image]')
        const ref = imageBlockRef(b, media)
        if (ref) images.push(ref)
      }
    }
    text = parts.join('\n')
  }
  const out: ToolResult =
    text.length > MAX_TOOL_RESULT_CHARS ? { text: text.slice(0, MAX_TOOL_RESULT_CHARS), isError, truncated: true } : { text, isError }
  if (images.length) out.images = images
  return out
}

const IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\/(?!api\/))[^\s"'<>|*?\n]*?\.(?:png|jpe?g|gif|webp|svg)\b/gi

/** The key a path is remembered by: slashes one way, case folded (Windows paths are case-insensitive). */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Files a tool input names: Read/Write/Edit file_path, SendUserFile files[]. */
function inputPaths(name: string, input: Loose): string[] {
  const out: string[] = []
  if (typeof input.file_path === 'string') out.push(input.file_path)
  if (isSendFile(name) && Array.isArray(input.files)) for (const f of input.files) if (typeof f === 'string') out.push(f)
  return out
}

const isSendFile = (name: string) => name === 'SendUserFile' || name.endsWith('__SendUserFile') || name.endsWith('__send_user_file')

/** A markdown image target that is a local absolute path ("C:\a\b.png", "C:/a/b.png", "file:///C:/a/b.png"). */
function localTarget(raw: string): string | null {
  let t = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  if (/^file:\/\//i.test(t)) {
    try {
      t = decodeURIComponent(t.replace(/^file:\/\/\/?/i, ''))
    } catch {
      return null
    }
    if (!/^[A-Za-z]:/.test(t)) t = `/${t}`
  }
  return /^[A-Za-z]:[\\/]/.test(t) || (t.startsWith('/') && !t.startsWith(MEDIA_ROUTE)) ? t : null
}

const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g

/**
 * Markdown images whose target is a local file this transcript named become the cached picture's url;
 * any other local target is left as written (the window shows it as a file chip, never loads it).
 */
export function rewriteLocalImages(text: string, named: ReadonlySet<string>, media: MediaCache | null): string {
  if (!media || !text.includes('![')) return text
  return text.replace(MD_IMAGE, (all, alt: string, target: string, title: string | undefined) => {
    const path = localTarget(target)
    if (!path || !named.has(pathKey(path)) || !RENDERABLE.test(path)) return all
    const ref = media.fileRef(path)
    return ref?.url ? `![${alt}](${ref.url}${title ?? ''})` : all
  })
}

/** The result text of a tool that started something in the background: "... launched in background. Task ID: x" or "... running in background with ID: x". */
const BACKGROUND_TASK = /^\s*(?:Workflow launched in background\.\s*Task ID:|Command running in background with ID:)\s*([\w-]+)/

/** A background task the transcript only knows from its launching tool call, running until its notification settles it. */
function backgroundTaskItem(tool: ToolItem, taskId: string, ts: number): TaskItem {
  const input = tool.input
  const scriptName = /name:\s*['"]([^'"]+)['"]/.exec(str(input.script))?.[1]
  const description = str(input.name) || str(input.description) || str(input.title) || scriptName || firstLine(str(input.command)) || firstLine(str(input.prompt))
  const taskKind: TaskItem['taskKind'] = tool.name === 'Workflow' ? 'workflow' : tool.name === 'Bash' ? 'bash' : 'agent'
  const item: TaskItem = { kind: 'task', id: `task:${taskId}`, ts, taskId, description: cut(description, 200), status: 'running', taskKind, toolUseId: tool.id }
  if (str(input.command)) item.command = cut(str(input.command), 500)
  return item
}

const TASK_TYPE_KIND: Record<string, TaskItem['taskKind']> = {
  local_workflow: 'workflow',
  local_bash: 'bash',
  local_agent: 'agent',
  remote_agent: 'agent',
}

/** Tokens and run time from an SDK task usage block ({ total_tokens, tool_uses, duration_ms }). */
function withUsage(item: TaskItem, usage: unknown): TaskItem {
  const u = (usage ?? {}) as Loose
  if (typeof u.total_tokens === 'number') item.tokens = u.total_tokens
  if (typeof u.duration_ms === 'number') item.durationMs = u.duration_ms
  return item
}

function todosFrom(input: Loose): TodoEntry[] | null {
  // TodoWriteInput.todos: { content, status, activeForm }[] (sdk-tools.d.ts)
  if (!Array.isArray(input.todos)) return null
  const out: TodoEntry[] = []
  for (const t of input.todos as Loose[]) {
    const status = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending'
    const entry: TodoEntry = { content: str(t.content), status }
    if (typeof t.activeForm === 'string') entry.activeForm = t.activeForm
    out.push(entry)
  }
  return out
}

export function createNormalizer(opts: NormalizerOptions = {}): Normalizer {
  const now = opts.now ?? Date.now
  const formatTime = opts.formatTime ?? ((ms: number) => new Date(ms).toLocaleString())
  const title = () => opts.title?.() ?? 'Hydra Desk'

  const currentMsg = new Map<string, string>() // parent key ('' = main thread) -> streaming API message id
  const blockCount = new Map<string, number>() // API message id -> assistant blocks seen
  const streamed = new Map<string, Streamed>()
  const tools = new Map<string, ToolItem>()
  const denied = new Set<string>()
  const tasks = new Map<string, TaskItem>()
  const media = opts.media === undefined ? mediaCache() : opts.media
  // Local files this transcript named (tool inputs, tool results): the only ones a markdown image may load.
  const named = new Set<string>()
  let lastTotalCost = opts.priorTotalCostUsd ?? 0
  let turn = opts.firstTurn ?? 0
  let activity: string | null = null
  let interruptedTurn = false
  let limitedTurn = false

  function withParent<T extends TranscriptItem>(item: T, parent: string | null | undefined): T {
    if (parent) item.parentToolUseId = parent
    return item
  }

  function setActivity(out: Emission[], next: string | null) {
    if (next === activity) return
    activity = next
    out.push({ type: 'chat', patch: { activity: next } })
  }

  function mainActivityAfterTool(): string {
    for (const t of tools.values()) {
      if (t.status === 'running' && !t.parentToolUseId) return describeToolActivity(t.name, t.input, opts.cwd)
    }
    return 'Thinking'
  }

  function system(out: Emission[], id: string, level: 'info' | 'warn' | 'error', text: string) {
    out.push({ type: 'upsert', item: { kind: 'system', id, ts: now(), level, text } })
  }

  function finalizeStreams(out: Emission[]) {
    for (const [id, s] of streamed) {
      if (s.upserted) out.push({ type: 'upsert', item: withParent({ kind: s.kind, id, ts: s.ts, text: s.text, streaming: false }, s.parent) })
    }
    streamed.clear()
  }

  // stream_event (SDKPartialAssistantMessage): BetaRawMessageStreamEvent
  function onStream(msg: Loose, out: Emission[]) {
    const ev = msg.event as Loose | undefined
    if (!ev) return
    const parent = (msg.parent_tool_use_id as string | null) ?? null
    const key = parent ?? ''
    if (ev.type === 'message_start') {
      const id = str((ev.message as Loose | undefined)?.id)
      if (id) currentMsg.set(key, id)
      return
    }
    const msgId = currentMsg.get(key) ?? `stream:${key}`
    const itemId = `${msgId}:${ev.index}`
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block as Block | undefined
      if (cb?.type === 'text' || cb?.type === 'thinking') {
        const kind = cb.type === 'text' ? 'assistant_text' : 'thinking'
        const s: Streamed = { kind, text: '', ts: now(), parent, upserted: false }
        streamed.set(itemId, s)
        append(out, itemId, s, str(cb.type === 'text' ? cb.text : cb.thinking))
        if (!parent) setActivity(out, kind === 'thinking' ? 'Thinking' : 'Writing')
      }
      return
    }
    if (ev.type === 'content_block_delta') {
      const s = streamed.get(itemId)
      const d = ev.delta as Block | undefined
      if (!s || !d) return
      if (d.type === 'text_delta') append(out, itemId, s, str(d.text))
      else if (d.type === 'thinking_delta') append(out, itemId, s, str(d.thinking))
    }
  }

  function append(out: Emission[], id: string, s: Streamed, text: string) {
    if (!text) return
    s.text += text
    if (s.upserted) {
      out.push({ type: 'delta', itemId: id, text })
    } else {
      s.upserted = true
      out.push({ type: 'upsert', item: withParent({ kind: s.kind, id, ts: s.ts, text: s.text, streaming: true }, s.parent) })
    }
  }

  // assistant (SDKAssistantMessage): message is a BetaMessage
  function onAssistant(msg: Loose, out: Emission[]) {
    const message = msg.message as Loose | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    const parent = (msg.parent_tool_use_id as string | null) ?? null
    const msgId = str(message?.id) || str(msg.uuid)
    for (const block of content as Block[]) {
      const index = blockCount.get(msgId) ?? 0
      blockCount.set(msgId, index + 1)
      if (block.type === 'text' || block.type === 'thinking') {
        const id = `${msgId}:${index}`
        const s = streamed.get(id)
        streamed.delete(id)
        const kind = block.type === 'text' ? 'assistant_text' : 'thinking'
        // Thinking shown as "updates" finalizes with an empty block: keep what streamed.
        const said = str(block.type === 'text' ? block.text : block.thinking) || s?.text || ''
        const text = kind === 'assistant_text' ? rewriteLocalImages(said, named, media) : said
        if (text || s?.upserted) {
          out.push({ type: 'upsert', item: withParent({ kind, id, ts: s?.ts ?? now(), text, streaming: false }, parent) })
        }
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const id = str(block.id)
        if (!id) continue
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Loose
        const name = str(block.name) || block.type
        for (const p of inputPaths(name, input)) named.add(pathKey(p))
        const prev = tools.get(id)
        const item: ToolItem = withParent(
          {
            ...prev,
            kind: 'tool_use',
            id,
            ts: prev?.ts ?? now(),
            name,
            input,
            status: prev?.status ?? 'running',
            startedAt: prev?.startedAt ?? now(),
          },
          parent,
        )
        tools.set(id, item)
        out.push({ type: 'upsert', item })
        if (name === 'TodoWrite') {
          const todos = todosFrom(input)
          if (todos) out.push({ type: 'upsert', item: { kind: 'todos', id: 'todos', ts: now(), todos } })
        }
        if (!parent && item.status === 'running') setActivity(out, describeToolActivity(name, input, opts.cwd))
      }
    }
  }

  function finishTool(out: Emission[], id: string, result?: ToolResult) {
    const tool = tools.get(id)
    if (!tool) return
    const status: ToolItem['status'] = denied.has(id) ? 'denied' : result?.isError ? 'error' : 'done'
    const { progress: _progress, ...rest } = tool
    const item: ToolItem = { ...rest, status, endedAt: tool.endedAt ?? now() }
    if (result) item.result = result
    tools.set(id, item)
    out.push({ type: 'upsert', item })
  }

  // user (SDKUserMessage / SDKUserMessageReplay): tool_result blocks finish tool items. Text the harness
  // injected (task notifications, reminders, command echoes) goes through classifyUserText. The
  // person's own prompts are written by the runtime when sent, so live they are not echoed.
  function onUser(msg: Loose, out: Emission[]) {
    const raw = (msg.message as Loose | undefined)?.content
    const content: Block[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? (raw as Block[]) : []
    // A compaction's summary is shown by its compact_boundary line.
    if (msg.isCompactSummary === true || msg.isVisibleInTranscriptOnly === true) return
    const uuid = str(msg.uuid) || `user:${turn}:${now()}`
    const userText: string[] = []
    const images: ImageRef[] = []
    let part = 0
    for (const b of content) {
      if (b.type === 'image' && opts.echoUserText && msg.isMeta !== true) {
        const ref = imageBlockRef(b, media)
        if (ref) images.push(ref)
      }
      if (b.type !== 'text') continue
      for (const p of classifyUserText(str(b.text), msg.isMeta === true)) {
        if (p.kind === 'user') userText.push(p.text)
        else if (p.kind === 'system') system(out, `${uuid}:sys:${part++}`, 'info', p.text)
        else {
          const next = taskItemFrom(p.task, tasks.get(p.task.taskId), now())
          tasks.set(next.taskId, next)
          out.push({ type: 'upsert', item: next })
        }
      }
    }
    if (opts.echoUserText && (userText.length || images.length)) {
      const item: Extract<TranscriptItem, { kind: 'user' }> = { kind: 'user', id: uuid, ts: now(), text: userText.join('\n\n') }
      if (images.length) item.images = images
      out.push({ type: 'upsert', item })
    }
    let finishedMain = false
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      const id = str(b.tool_use_id)
      const tool = tools.get(id)
      if (!tool) continue
      const result = toolResultText(b.content, b.is_error === true, media)
      for (const p of result.text.match(IMAGE_PATH) ?? []) named.add(pathKey(p))
      if (isSendFile(tool.name) && !result.isError) {
        const files = (Array.isArray(tool.input.files) ? tool.input.files : []).filter((f): f is string => typeof f === 'string')
        const refs = media ? files.map((f) => media.fileRef(f)).filter((r): r is ImageRef => !!r) : []
        if (refs.length) result.images = [...(result.images ?? []), ...refs]
      }
      finishTool(out, id, result)
      const background = BACKGROUND_TASK.exec(result.text)
      if (background && !result.isError && !tasks.has(background[1]!)) {
        const task = backgroundTaskItem(tool, background[1]!, now())
        tasks.set(task.taskId, task)
        out.push({ type: 'upsert', item: task })
      }
      if (!tool.parentToolUseId) finishedMain = true
    }
    if (finishedMain) setActivity(out, mainActivityAfterTool())
  }

  // result (SDKResultMessage)
  function onResult(msg: Loose, out: Emission[]) {
    finalizeStreams(out)
    const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : lastTotalCost
    const turnCost = Math.max(0, total - lastTotalCost)
    lastTotalCost = total
    const ok = msg.subtype === 'success' && msg.is_error !== true
    const errors = Array.isArray(msg.errors) ? (msg.errors as string[]).filter(Boolean) : []
    const error = ok ? undefined : interruptedTurn ? 'Interrupted' : errors.join('\n') || str(msg.result) || str(msg.subtype)
    const item: TranscriptItem = {
      kind: 'result',
      id: `result:${str(msg.uuid) || turn}`,
      ts: now(),
      ok,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
      costUsd: turnCost,
      turns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
    }
    if (error !== undefined) item.error = error
    out.push({ type: 'upsert', item })
    out.push({ type: 'chat', patch: { costUsd: (opts.baseCostUsd ?? 0) + total } })
    if (ok) {
      out.push({ type: 'notify', reason: 'finished', title: title(), body: cut(firstLine(str(msg.result)), 120) || 'Finished' })
    } else if (!interruptedTurn && !limitedTurn) {
      out.push({ type: 'notify', reason: 'error', title: title(), body: cut(firstLine(error ?? ''), 120) || 'The turn failed' })
    }
    activity = null
    interruptedTurn = false
    limitedTurn = false
    turn++
  }

  function onRateLimit(msg: Loose, out: Emission[]) {
    const info = msg.rate_limit_info as Loose | undefined
    if (!info) return
    const type = str(info.rateLimitType)
    const label = LIMIT_LABEL[type] ?? 'usage'
    const account = opts.accountLabel?.() ?? null
    if (info.status === 'rejected') {
      const resetsAt = resetsAtMs(info.resetsAt as number | undefined)
      const on = account ? ` on ${account}` : ''
      const when = resetsAt !== null ? ` Resets ${formatTime(resetsAt)}.` : ''
      const text = `Usage limit reached (${label})${on}.${when}`
      limitedTurn = true
      // Keyed by the event: turns count from 0 again in each runtime, and a chat moved off a limited
      // account starts a new one, whose limit line must not replace the first.
      system(out, `rate_limit:${str(msg.uuid) || turn}`, 'error', text)
      out.push({ type: 'chat', patch: { limitResetsAt: resetsAt } })
      out.push({ type: 'notify', reason: 'limited', title: title(), body: text })
    } else if (info.status === 'allowed_warning') {
      const u = typeof info.utilization === 'number' ? info.utilization : null
      const pct = u === null ? null : Math.round(u <= 1 ? u * 100 : u)
      system(out, `rate_limit_warning:${type || 'usage'}`, 'warn', pct === null ? `Approaching the ${label} limit` : `${pct}% of the ${label} limit used`)
    }
  }

  function onSystem(msg: Loose, out: Emission[]) {
    const uuid = str(msg.uuid)
    switch (msg.subtype) {
      case 'init':
        if (msg.session_id) out.push({ type: 'chat', patch: { sessionId: str(msg.session_id) } })
        return
      case 'status': {
        // SDKStatusMessage: status 'compacting' | 'requesting' | null, permissionMode when it changed
        const mode = msg.permissionMode as PermissionMode | undefined
        if (mode && PERMISSION_MODES.includes(mode)) out.push({ type: 'chat', patch: { permissionMode: mode } })
        if (msg.status === 'compacting') setActivity(out, 'Compacting')
        return
      }
      case 'compact_boundary': {
        const meta = (msg.compact_metadata ?? {}) as Loose
        const after = meta.post_tokens !== undefined ? ` → ${kTokens(meta.post_tokens)}` : ''
        system(out, `compact:${uuid}`, 'info', `Conversation compacted (${str(meta.trigger) || 'auto'}, ${kTokens(meta.pre_tokens)}${after} tokens)`)
        return
      }
      case 'api_retry': {
        const status = typeof msg.error_status === 'number' ? ` ${msg.error_status}` : ''
        const secs = typeof msg.retry_delay_ms === 'number' ? Math.round(msg.retry_delay_ms / 1000) : 0
        system(out, `api_retry:${turn}`, 'warn', `API error${status} (${str(msg.error) || 'unknown'}), retrying in ${secs}s (attempt ${msg.attempt} of ${msg.max_retries})`)
        return
      }
      case 'model_refusal_fallback':
        system(out, `refusal:${uuid}`, 'warn', str(msg.content) || `The model declined; retried on ${str(msg.fallback_model)}`)
        return
      case 'model_refusal_no_fallback':
        system(out, `refusal:${uuid}`, 'error', str(msg.content) || 'The model declined to answer')
        return
      case 'hook_response': {
        if (msg.outcome !== 'error') return
        const exit = typeof msg.exit_code === 'number' ? ` (exit ${msg.exit_code})` : ''
        const why = firstLine(str(msg.stderr) || str(msg.output) || str(msg.stdout))
        system(out, `hook:${str(msg.hook_id) || uuid}`, 'warn', cut(`Hook ${str(msg.hook_name)} (${str(msg.hook_event)}) failed${exit}${why ? `: ${why}` : ''}`, 300))
        return
      }
      case 'informational': {
        // level 'info' shows only in the CLI's transcript mode; skip it like the CLI does.
        if (msg.level === 'info') return
        system(out, `info:${uuid}`, msg.level === 'warning' ? 'warn' : 'info', str(msg.content))
        return
      }
      case 'permission_denied': {
        const id = str(msg.tool_use_id)
        denied.add(id)
        const tool = tools.get(id)
        if (tool && tool.status !== 'running') finishTool(out, id, tool.result)
        return
      }
      case 'task_started': {
        if (msg.skip_transcript || msg.ambient) return
        const taskId = str(msg.task_id)
        const item: TaskItem = { kind: 'task', id: `task:${taskId}`, ts: now(), taskId, description: str(msg.description), status: 'running' }
        item.taskKind = TASK_TYPE_KIND[str(msg.task_type)] ?? (msg.workflow_name ? 'workflow' : 'agent')
        if (msg.tool_use_id) item.toolUseId = str(msg.tool_use_id)
        const command = str(tools.get(str(msg.tool_use_id))?.input.command)
        if (command) item.command = cut(command, 500)
        tasks.set(taskId, item)
        out.push({ type: 'upsert', item })
        return
      }
      case 'task_updated': {
        const t = tasks.get(str(msg.task_id))
        const patch = (msg.patch ?? {}) as Loose
        if (!t) return
        const next: TaskItem = { ...t }
        if (patch.status === 'completed' || patch.status === 'failed') next.status = patch.status
        else if (patch.status === 'killed') next.status = 'stopped'
        else if (patch.status) next.status = 'running'
        if (typeof patch.description === 'string') next.description = patch.description
        if (typeof patch.error === 'string' && patch.error) next.summary = patch.error
        tasks.set(t.taskId, next)
        out.push({ type: 'upsert', item: next })
        return
      }
      case 'task_progress': {
        const t = tasks.get(str(msg.task_id))
        if (!t) return
        const next: TaskItem = withUsage({ ...t }, msg.usage)
        if (typeof msg.summary === 'string' && msg.summary) next.summary = msg.summary
        if (next.summary === t.summary && next.tokens === t.tokens && next.durationMs === t.durationMs) return
        tasks.set(t.taskId, next)
        out.push({ type: 'upsert', item: next })
        return
      }
      case 'task_notification': {
        const taskId = str(msg.task_id)
        const t = tasks.get(taskId)
        if (!t && (msg.skip_transcript || msg.ambient)) return
        const status = msg.status === 'completed' || msg.status === 'failed' || msg.status === 'stopped' ? msg.status : 'completed'
        const next: TaskItem = withUsage(
          { ...(t ?? { kind: 'task', id: `task:${taskId}`, ts: now(), taskId, description: '' }), status },
          msg.usage,
        )
        if (typeof msg.summary === 'string' && msg.summary) next.summary = cut(msg.summary, 280)
        next.taskKind ??= taskKindOf(str(msg.summary))
        if (msg.tool_use_id) next.toolUseId = str(msg.tool_use_id)
        if (msg.output_file) next.outputFile = str(msg.output_file)
        tasks.set(taskId, next)
        out.push({ type: 'upsert', item: next })
        return
      }
    }
  }

  // tool_progress (SDKToolProgressMessage)
  function onToolProgress(msg: Loose, out: Emission[]) {
    const tool = tools.get(str(msg.tool_use_id))
    if (!tool || tool.status !== 'running' || typeof msg.elapsed_time_seconds !== 'number') return
    const progress = `${Math.round(msg.elapsed_time_seconds)}s`
    if (tool.progress === progress) return
    const item: ToolItem = { ...tool, progress }
    tools.set(tool.id, item)
    out.push({ type: 'upsert', item })
    if (!tool.parentToolUseId) setActivity(out, describeToolActivity(tool.name, tool.input, opts.cwd))
  }

  return {
    handle(msg: SDKMessage): Emission[] {
      const out: Emission[] = []
      try {
        const m = msg as unknown as Loose
        switch (m?.type) {
          case 'stream_event':
            onStream(m, out)
            break
          case 'assistant':
            onAssistant(m, out)
            break
          case 'user':
            onUser(m, out)
            break
          case 'result':
            onResult(m, out)
            break
          case 'rate_limit_event':
            onRateLimit(m, out)
            break
          case 'system':
            onSystem(m, out)
            break
          case 'tool_progress':
            onToolProgress(m, out)
            break
        }
      } catch {
        // A shape this code did not expect: keep what was emitted, never break the stream.
      }
      return out
    },

    markDenied(toolUseId: string): Emission[] {
      denied.add(toolUseId)
      const out: Emission[] = []
      const tool = tools.get(toolUseId)
      if (tool && tool.status !== 'running') finishTool(out, toolUseId, tool.result)
      return out
    },

    noteInterrupt(): void {
      interruptedTurn = true
    },

    seed(items: TranscriptItem[]): void {
      for (const item of items) {
        if (item.kind === 'task' && item.status === 'running') tasks.set(item.taskId, item)
        else if (item.kind === 'tool_use' && item.status === 'denied') denied.add(item.id)
        else if (item.kind === 'permission' && item.state === 'denied' && item.toolUseId) denied.add(item.toolUseId)
      }
    },
  }
}

export interface HistoryOptions {
  cwd?: string | null
  media?: MediaCache | null
  now?: () => number
}

/** A background command's completion is filed as a queued_command attachment, not a user message: its XML, or ''. */
function queuedNotification(rec: Loose): string {
  const a = (rec.attachment ?? {}) as Loose
  const prompt = a.type === 'queued_command' ? str(a.prompt) : ''
  return prompt.trimStart().startsWith('<task-notification>') ? prompt : ''
}

/** A background task the file shows launched but never settled, this long ago, is taken as gone. */
const STALE_TASK_MS = 24 * 3_600_000

/**
 * A Claude Code session's own .jsonl records (one parsed line each, in file order) as transcript items,
 * through the same normalizer the live stream uses, the person's messages echoed. Records of other
 * kinds (attachments, queue operations, titles) and sidechains are skipped; a timestamp-less record
 * takes the last one seen.
 */
export function historyToItems(records: Iterable<unknown>, o: HistoryOptions = {}): TranscriptItem[] {
  let clock = 0
  const n = createNormalizer({ now: () => clock, cwd: o.cwd ?? null, echoUserText: true, media: o.media })
  const items = new Map<string, TranscriptItem>()
  for (const r of records) {
    const rec = r as Loose
    if (!rec || typeof rec !== 'object' || rec.isSidechain === true) continue
    const t = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    if (Number.isFinite(t)) clock = t
    let msg: Loose | null = null
    if (rec.type === 'user' || rec.type === 'assistant') msg = rec
    else if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      const meta = (rec.compactMetadata ?? {}) as Loose
      msg = { ...rec, compact_metadata: { trigger: meta.trigger, pre_tokens: meta.preTokens, post_tokens: meta.postTokens } }
    } else if (rec.type === 'attachment' && queuedNotification(rec)) {
      msg = { type: 'user', uuid: rec.uuid, message: { role: 'user', content: queuedNotification(rec) } }
    } else if (rec.type === 'system' && rec.subtype === 'local_command') {
      msg = { type: 'user', uuid: rec.uuid, message: { role: 'user', content: str(rec.content) } }
    } else if (rec.type === 'system' && (rec.subtype === 'informational' || String(rec.subtype).startsWith('model_refusal'))) msg = rec
    if (!msg) continue
    for (const e of n.handle(msg as unknown as SDKMessage)) {
      if (e.type !== 'upsert') continue
      const prev = items.get(e.item.id)
      items.set(e.item.id, prev ? { ...e.item, ts: prev.ts } : e.item)
    }
  }
  // The file ends mid-turn: what was still streaming is what it is.
  const cutoff = (o.now ?? Date.now)() - STALE_TASK_MS
  return [...items.values()].map((it) => {
    if ((it.kind === 'assistant_text' || it.kind === 'thinking') && it.streaming) return { ...it, streaming: false }
    if (it.kind === 'task' && it.status === 'running' && it.ts < cutoff) return { ...it, status: 'stopped' as const }
    return it
  })
}

/** Parses .jsonl text (a whole file or a tail that may start mid-line) into records; bad lines are skipped. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a cut first line of a tail read, or a line being written
    }
  }
  return out
}
