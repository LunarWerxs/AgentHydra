// Sessions Hydra Desk does not run (Claude Desktop chats, terminal CLIs, CliMayte workers, Codex), and
// their transcripts converted to TranscriptItems (SPEC.md "Elsewhere").
//
// WHERE "working / needs you / idle" COMES FROM. Of AgentHydra's candidates only GET /api/agent-status
// says it truthfully: Claude Code's own hooks (UserPromptSubmit, PreToolUse, Notification, Stop) land
// there, so `working` and `blocked` (a permission prompt or question waiting on a person) are facts,
// not guesses, and a row restored after a daemon restart is flagged and ignored here.
// /api/sessions/live and /api/chats only say an engine PROCESS is alive (a chat idle for hours has a
// live engine too), and /api/sessions only has the transcript's last write. But the hook rows exist
// only once the hooks are installed (POST /api/agent-status/hooks; on 2026-10-03 they were not, and the
// list was empty). Without a hook row we fall back to the transcript: written in the last 30 s means
// working, else idle, else stale after 2 h. That fallback never claims needs_you, which only a hook
// can know. CliMayte workers use their own status (running/checking = working).
//
// WHICH SESSIONS. The union, deduplicated by session id, in this order of precedence: active CliMayte
// workers, this PC's unarchived Claude Desktop chats (/api/chats), running or not (owner, 2026-10-08: with the
// cloud off "I should see all my chats"; a chat whose engine had stopped left the list while the cloud list
// kept it, so the two lists looked like they disagreed about which chats are local; the other PC's chats
// never come through /api/chats), the live registry (/api/sessions/live), hook rows
// that say working or blocked, and any indexed transcript written in the last 10 minutes (a CLI or Codex
// session outside ~/.claude; working for its first 30 s, idle after), or of any age when it is the one
// session asked for by id. Minus the session ids of Hydra Desk's own chats, and minus HSwarm's job
// transcripts (source 'zswarm'), which have their own tab. Both rules are against rows popping in and out
// (owner, 2026-10-05): an HSwarm job writes in bursts, and while 30 s was the whole window, each burst
// put it in the list and each pause of 30 s took it out again.

import type { ExternalSession, TranscriptItem } from '@shared/protocol'
import { MAX_TOOL_RESULT_CHARS } from '@shared/protocol'
import type { AhAgentStatus, AhChatRow, AhLiveSession, AhSessionRow, AhTail, AhWorker, AhWorkerDetail } from './client'
import { isActiveWorkerStatus, workerAccountLabel } from './climayte'
import { canResume, configRootOf, type ResumeQuery } from './resume'
import { classifyUserText, taskItemFrom, userTurns } from '../engine/system-text'
import { mediaCache } from '../media/cache'

/** A transcript written this recently is working (when no hook says otherwise). */
export const WORKING_WINDOW_MS = 30_000
/** A session only the transcript index knows stays listed this long after its last write, idle after the first 30 s. */
export const LISTED_AFTER_WRITE_MS = 10 * 60 * 1000
/** No activity for this long is stale. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000

export interface ExternalInputs {
  agentStatus: AhAgentStatus[]
  live: AhLiveSession[]
  chats: AhChatRow[]
  sessions: AhSessionRow[]
  workers: AhWorker[]
  /** Session ids listed from their index row however old they are (one session asked for by id). */
  wanted?: ReadonlySet<string>
}

const STATUS_ORDER: Record<ExternalSession['status'], number> = { needs_you: 0, working: 1, idle: 2, stale: 3 }

const iso = (s: string | null | undefined): number | null => {
  const t = s ? Date.parse(s) : Number.NaN
  return Number.isFinite(t) ? t : null
}

const maxOf = (...xs: (number | null | undefined)[]): number | null => {
  const ok = xs.filter((x): x is number => typeof x === 'number' && x > 0)
  return ok.length ? Math.max(...ok) : null
}

function recencyStatus(last: number | null, now: number): ExternalSession['status'] {
  if (last !== null && now - last <= WORKING_WINDOW_MS) return 'working'
  if (last === null || now - last > STALE_AFTER_MS) return 'stale'
  return 'idle'
}

function hookStatus(
  h: AhAgentStatus | undefined,
  last: number | null,
  now: number,
): ExternalSession['status'] | null {
  if (!h) return null
  if (h.state === 'blocked') return 'needs_you'
  if (h.state === 'working') return 'working'
  return last !== null && now - last > STALE_AFTER_MS ? 'stale' : 'idle'
}

function hookActivity(h: AhAgentStatus | undefined): string | null {
  if (!h) return null
  if (h.state === 'blocked') return h.waiting === 'rate-limit' ? 'At a usage limit' : 'Waiting on you'
  if (h.state === 'working' && h.subagents > 0) return `${h.subagents} sub-agent${h.subagents === 1 ? '' : 's'} running`
  return null
}

export const sessionSource = (s: string | undefined): ExternalSession['source'] =>
  s === 'codex' ? 'codex' : s === 'claude' || s === undefined ? 'cli' : 'other'

/** Hydra Desk's marks as AgentHydra's list has them: none (the engine's session-meta store adds its own). */
const UNMARKED = { pinned: false, archived: false, unread: false, group: null }

/**
 * `resume` names the CLI instance whose folder already holds a session (resume.ts resumeAccount), or
 * null: an idle Claude Code session then continues as a copy under the account the window lands it on.
 */
export function mapExternal(
  inp: ExternalInputs,
  exclude: ReadonlySet<string>,
  now = Date.now(),
  resume: (q: ResumeQuery) => string | null = () => null,
): ExternalSession[] {
  const hooks = new Map(inp.agentStatus.filter((h) => !h.restoredUnconfirmed).map((h) => [h.sessionId, h]))
  const index = new Map(inp.sessions.map((s) => [s.session_id, s]))
  const chats = new Map(inp.chats.filter((c) => c.sessionId && !c.archived).map((c) => [c.sessionId, c]))
  const out = new Map<string, ExternalSession>()
  const add = (s: ExternalSession) => {
    if (!s.id || exclude.has(s.id) || out.has(s.id)) return
    out.set(s.id, s)
  }

  for (const w of inp.workers) {
    if (!w.sessionId || !isActiveWorkerStatus(w.status)) continue
    const h = hooks.get(w.sessionId)
    const running = w.status === 'running' || w.status === 'checking'
    const last = maxOf(w.updatedAt, iso(h?.at))
    add({
      id: w.sessionId,
      title: w.title,
      cwd: w.cwd || null,
      source: 'climayte',
      instance: workerAccountLabel(w),
      status: hookStatus(h, last, now) ?? (running ? 'working' : 'idle'),
      activity:
        hookActivity(h) ??
        (w.status === 'queued' ? 'Queued' : w.status === 'waiting' ? 'Waiting for an account' : w.status === 'checking' ? 'Running its check' : w.lastActivity),
      lastActivityAt: last,
      model: w.reportedModel ?? w.model ?? null,
      accountId: w.accountId,
      canResume: false,
      fromPc: null, // a worker runs on this PC's CLI accounts
      ...UNMARKED,
    })
  }

  const fromIndex = (
    id: string,
    source: ExternalSession['source'],
    base: { title?: string | null; cwd?: string | null; instance?: string | null; last?: number | null; root?: string | null; unread?: boolean },
  ) => {
    const row = index.get(id)
    const h = hooks.get(id)
    const last = maxOf(base.last, row?.last_activity_at, iso(h?.at))
    const status = hookStatus(h, last, now) ?? recencyStatus(last, now)
    const accountId = resume({
      source,
      instance: base.instance ?? row?.instance ?? null,
      instanceNum: row?.instance_num ?? null,
      configRoot: base.root ?? null,
    })
    add({
      id,
      title: base.title || row?.title || id.slice(0, 8),
      cwd: base.cwd || row?.cwd || h?.cwd || null,
      source,
      instance: base.instance ?? row?.instance ?? (row?.instance_num ? `#${row.instance_num}` : null),
      status,
      activity: hookActivity(h),
      lastActivityAt: last,
      model: null,
      accountId,
      canResume: canResume({ status, source }),
      // The chat sync's mark on its index row: the row draws a cloud for another PC's chat, as the cloud list does.
      fromPc: row?.from_pc || null,
      ...UNMARKED,
      unread: base.unread ?? false,
    })
  }

  for (const c of chats.values())
    fromIndex(c.sessionId, 'desktop', { title: c.title, cwd: c.cwd, instance: c.instance, last: iso(c.lastActivityAt), unread: c.unread })
  for (const l of inp.live)
    fromIndex(l.sessionId, l.hostSessionId ? 'desktop' : 'cli', { cwd: l.cwd, last: l.startedAt, root: configRootOf(l.transcriptPath) })
  for (const h of hooks.values())
    if (h.state !== 'done') fromIndex(h.sessionId, sessionSource(index.get(h.sessionId)?.source), { cwd: h.cwd })
  for (const s of inp.sessions)
    if (inp.wanted?.has(s.session_id) || (s.source !== 'zswarm' && now - s.last_activity_at <= LISTED_AFTER_WRITE_MS))
      fromIndex(s.session_id, sessionSource(s.source), {})

  return [...out.values()].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  )
}

// --- transcripts --------------------------------------------------------------------------------

type ToolUseItem = Extract<TranscriptItem, { kind: 'tool_use' }>
type TaskItem = Extract<TranscriptItem, { kind: 'task' }>

/** A user-role text through the classifier: the person's words, a task notice (one item per task id) or muted lines. */
function userParts(items: TranscriptItem[], tasks: Map<string, TaskItem>, id: string, ts: number, text: string): void {
  classifyUserText(text).forEach((p, i) => {
    if (p.kind === 'user') {
      items.push(...userTurns({ id: i ? `${id}:${i}` : id, ts, kind: 'user', text: p.text }, mediaCache()))
    } else if (p.kind === 'system') items.push({ id: `${id}:${i}`, ts, kind: 'system', level: 'info', text: p.text })
    else {
      const prev = tasks.get(p.task.taskId)
      const next = taskItemFrom(p.task, prev, ts)
      tasks.set(next.taskId, next)
      if (prev) items[items.indexOf(prev)] = next
      else items.push(next)
    }
  })
}

function parseInput(text: string): Record<string, unknown> {
  // AgentHydra sends the input as compact JSON cut at 1200 chars; a cut one no longer parses.
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // fall through
  }
  return { raw: text }
}

/**
 * AgentHydra's tail (GET /api/sessions/:id/tail) as TranscriptItems. The tail carries no tool_use ids,
 * so results are paired with calls in order: each tool_result finishes the oldest open call. Once
 * results have come in, the next call or message closes any call left open (its result was empty,
 * which the tail drops) as done without a result. Calls still open at the end are running.
 */
export function tailToItems(tail: AhTail): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const tasks = new Map<string, TaskItem>()
  let open: ToolUseItem[] = []
  let sawResult = false
  const seen = new Map<string, number>()
  const closeOpen = () => {
    for (const t of open) {
      t.status = 'done'
      t.endedAt = t.startedAt
    }
    open = []
    sawResult = false
  }

  for (const e of tail.events) {
    const ts = iso(e.timestamp) ?? 0
    const key = `${e.timestamp ?? 'na'}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    const id = `${tail.session_id}:${key}:${n}`

    if (e.kind === 'tool_result') {
      const t = open.shift()
      if (!t) continue
      sawResult = true
      const isError = e.text.startsWith('<tool_use_error>')
      const text = e.text.slice(0, MAX_TOOL_RESULT_CHARS)
      t.status = isError ? 'error' : 'done'
      t.result = { text, isError, ...(e.text.endsWith('…') || text.length < e.text.length ? { truncated: true } : {}) }
      t.endedAt = ts || t.startedAt
      continue
    }
    if (e.kind === 'tool_use') {
      if (sawResult) closeOpen()
      const t: ToolUseItem = {
        id,
        ts,
        kind: 'tool_use',
        name: e.tool_name ?? 'tool',
        input: parseInput(e.text),
        status: 'running',
        startedAt: ts,
      }
      items.push(t)
      open.push(t)
      continue
    }
    closeOpen()
    if (e.kind === 'thinking') items.push({ id, ts, kind: 'thinking', text: e.text })
    else if (e.role === 'user') userParts(items, tasks, id, ts, e.text)
    else items.push({ id, ts, kind: 'assistant_text', text: e.text, ...(e.uuid ? { branchFrom: e.uuid } : {}) })
  }
  return items
}

const TOOL_ARG: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
}

/**
 * A CliMayte worker's transcript when the daemon's tail cannot find it (workers run in their CLI
 * instance's config folder, outside the transcript index): its task, its last 60 event lines
 * (summarizeEvent: 'started (model)', 'said: text', 'Tool arg', 'finished (...)') and its report.
 */
export function workerDetailToItems(w: AhWorkerDetail): TranscriptItem[] {
  const base = w.sessionId ?? w.id
  const ts = w.updatedAt
  const items: TranscriptItem[] = [
    {
      id: `${base}:note`,
      ts: w.createdAt,
      kind: 'system',
      level: 'info',
      text: 'CliMayte worker: AgentHydra holds a summary of this session, not its full transcript.',
    },
    { id: `${base}:task`, ts: w.createdAt, kind: 'user', text: w.prompt },
  ]
  let lastTool: ToolUseItem | null = null
  w.events.forEach((line, i) => {
    const id = `${base}:ev:${i}`
    if (line.startsWith('said: ')) {
      items.push({ id, ts, kind: 'assistant_text', text: line.slice(6) })
    } else if (/^(started|finished) \(/.test(line)) {
      items.push({ id, ts, kind: 'system', level: 'info', text: line })
    } else {
      const sp = line.indexOf(' ')
      const name = sp === -1 ? line : line.slice(0, sp)
      const arg = sp === -1 ? '' : line.slice(sp + 1)
      lastTool = {
        id,
        ts,
        kind: 'tool_use',
        name,
        input: arg ? { [TOOL_ARG[name] ?? 'description']: arg } : {},
        status: 'done',
        startedAt: ts,
        endedAt: ts,
      }
      items.push(lastTool)
    }
  })
  const running = w.status === 'running'
  const tail = items[items.length - 1]
  if (running && lastTool && tail === lastTool) {
    ;(lastTool as ToolUseItem).status = 'running'
    delete (lastTool as ToolUseItem).endedAt
  }
  if (!running && w.result) items.push({ id: `${base}:result`, ts, kind: 'assistant_text', text: w.result })
  if (w.error) items.push({ id: `${base}:error`, ts, kind: 'system', level: 'error', text: w.error })
  return items
}
