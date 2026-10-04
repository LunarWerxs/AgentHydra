// The Background tasks panel's model (the real app's side panel, with CliMayte as its workflows): the
// CliMayte workers a chat dispatched, one unit per group (a worker without a group is its own unit),
// plus the chat's own background tasks still running. Pure, so the grouping and the labels are tested.
import type { CliMayteWorker, TranscriptItem } from '@shared/protocol'
import { modelName } from '@/components/shell/logic'
import { chatWorkers } from '@/components/climayte/dock'

type TaskItem = Extract<TranscriptItem, { kind: 'task' }>

export type AgentState = 'running' | 'waiting' | 'done' | 'failed'

export interface TaskAgent {
  id: string
  name: string
  model: string // 'Opus 5.5', '' when unknown
  tokens: number | null
  startedAt: number | null
  endedAt: number | null
  state: AgentState
  sessionId: string | null
}

export interface TaskPhase {
  name: string
  done: number
  total: number
  agents: TaskAgent[]
}

export interface TaskUnit {
  /** 'group:<name>', 'worker:<id>' or 'task:<item id>': stable, and what the cleared list stores. */
  id: string
  name: string
  /** The bold word before the elapsed time: 'CliMayte' for workers, the task's kind otherwise. */
  label: string
  running: boolean
  startedAt: number | null
  endedAt: number | null
  agents: number
  tokens: number | null
  description: string
  account: string | null // '#68', or '#68, #41' when its workers ran on several
  phases: TaskPhase[]
  /** Active worker ids, for Stop. Empty for a transcript task (Hydra Desk cannot stop those). */
  stoppable: string[]
  /** The ids the trash button hides: its workers, or the task item. */
  keys: string[]
}

export const FINISHED_CAP = 25

export function agentState(w: CliMayteWorker): AgentState {
  if (w.status === 'running' || w.status === 'checking') return 'running'
  if (w.active) return 'waiting'
  if (w.status === 'failed' || w.status === 'cancelled' || w.error || (w.verdict && w.verdict !== 'ok' && w.verdict !== 'pass')) return 'failed'
  return 'done'
}

const firstLine = (s: string | null | undefined): string => (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

const sumOrNull = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? ok.reduce((a, b) => a + b, 0) : null
}

const minOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.min(...ok) : null
}
const maxOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.max(...ok) : null
}

function toAgent(w: CliMayteWorker): TaskAgent {
  return {
    id: w.id,
    name: w.title,
    model: w.model ? modelName(w.model) : '',
    tokens: w.tokens,
    startedAt: w.startedAt,
    endedAt: w.active ? null : (w.endedAt ?? w.lastActivityAt),
    state: agentState(w),
    sessionId: w.sessionId
  }
}

/** One phase per stage (the worker's kind), in the order the stages started. */
function phasesOf(workers: CliMayteWorker[]): TaskPhase[] {
  const byStage = new Map<string, CliMayteWorker[]>()
  for (const w of [...workers].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const stage = capital(w.kind ?? '') || 'Tasks'
    byStage.set(stage, [...(byStage.get(stage) ?? []), w])
  }
  return [...byStage].map(([name, ws]) => {
    const agents = ws.map(toAgent).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.startedAt ?? 0) - (b.startedAt ?? 0))
    return { name, done: agents.filter((a) => a.state === 'done' || a.state === 'failed').length, total: agents.length, agents }
  })
}

const STATE_ORDER: Record<AgentState, number> = { running: 0, waiting: 1, done: 2, failed: 2 }

function workerUnit(id: string, name: string, workers: CliMayteWorker[]): TaskUnit {
  const running = workers.some((w) => w.active)
  const oldest = [...workers].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0]!
  const accounts = [...new Set(workers.map((w) => w.account).filter((a): a is string => !!a))]
  return {
    id,
    name,
    label: 'CliMayte',
    running,
    startedAt: minOf(workers.map((w) => w.startedAt)),
    endedAt: running ? null : maxOf(workers.map((w) => w.endedAt ?? w.lastActivityAt)),
    agents: workers.length,
    tokens: sumOrNull(workers.map((w) => w.tokens)),
    description: firstLine(oldest.description) || (workers.length > 1 ? '' : firstLine(oldest.lastActivity)),
    account: accounts.length ? accounts.join(', ') : null,
    phases: phasesOf(workers),
    stoppable: workers.filter((w) => w.active).map((w) => w.id),
    keys: workers.map((w) => w.id)
  }
}

const TASK_LABEL: Record<NonNullable<TaskItem['taskKind']>, string> = {
  workflow: 'Workflow',
  bash: 'Background command',
  agent: 'Agent',
  other: 'Task'
}

function taskUnit(t: TaskItem): TaskUnit {
  const running = t.status === 'running'
  return {
    id: `task:${t.id}`,
    name: firstLine(t.description) || 'Background task',
    label: TASK_LABEL[t.taskKind ?? 'other'],
    running,
    startedAt: t.ts,
    endedAt: running ? null : t.durationMs !== undefined ? t.ts + t.durationMs : null,
    agents: t.agents ?? 0,
    tokens: t.tokens ?? null,
    description: firstLine(t.summary),
    account: null,
    phases: [],
    stoppable: [],
    keys: [`task:${t.id}`]
  }
}

/** Workers grouped into units: a group is one unit, a worker with no group its own. */
export function workerUnits(workers: CliMayteWorker[]): TaskUnit[] {
  const groups = new Map<string, CliMayteWorker[]>()
  const units: TaskUnit[] = []
  for (const w of workers) {
    if (w.group) groups.set(w.group, [...(groups.get(w.group) ?? []), w])
    else units.push(workerUnit(`worker:${w.id}`, w.title, [w]))
  }
  for (const [g, ws] of groups) units.push(workerUnit(`group:${g}`, g, ws))
  return units
}

export interface PanelLists {
  running: TaskUnit[]
  finished: TaskUnit[]
}

/**
 * What the panel lists. `workerIds` (the server's match) scope it to the workers this chat dispatched (`all`:
 * every worker AgentHydra lists); `items` adds the chat's own task items that still run. Running
 * units newest first; finished ones most recent first, minus the cleared, capped at FINISHED_CAP.
 */
export function panelLists(o: {
  workers: CliMayteWorker[]
  items?: TranscriptItem[]
  sessionId: string | null | undefined
  workerIds?: readonly string[]
  all?: boolean
  cleared?: ReadonlySet<string>
}): PanelLists {
  const scoped = o.all ? o.workers : chatWorkers(o.workers, o.sessionId, o.workerIds)
  const tasks = (o.items ?? []).filter((i): i is TaskItem => i.kind === 'task' && i.status === 'running').map(taskUnit)
  const units = [...workerUnits(scoped), ...tasks]
  const cleared = o.cleared ?? new Set<string>()
  const running = units.filter((u) => u.running).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const finished = units
    .filter((u) => !u.running && !u.keys.every((k) => cleared.has(k)))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
    .slice(0, FINISHED_CAP)
  return { running, finished }
}

/** The inline row under the last message: '1 running task', '3 running tasks · 2 finished', '4 finished tasks', '' when none. */
export function runningLabel(n: number, finished = 0): string {
  const done = finished > 0 ? `${finished}${finished >= FINISHED_CAP ? '+' : ''} finished` : ''
  if (n <= 0) return done ? `${done} ${finished === 1 ? 'task' : 'tasks'}` : ''
  const running = `${n} running ${n === 1 ? 'task' : 'tasks'}`
  return done ? `${running} · ${done}` : running
}

/** '11m 06s', '45s', '1h 02m'. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export function elapsedOf(start: number | null, end: number | null, now: number): string {
  return start === null ? '–' : formatElapsed((end ?? now) - start)
}

/** '539.6k', '1.2M', '812'; a dash when nothing says. */
export function formatTokens(n: number | null): string {
  if (n === null) return '–'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The progress squares of a phase: one per agent, finished first, then running, then waiting. */
export function phaseSquares(p: TaskPhase): AgentState[] {
  const order: AgentState[] = ['done', 'failed', 'running', 'waiting']
  return [...p.agents].map((a) => a.state).sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/** The phase opened at first: the first with a running agent, else the last. */
export function openPhase(u: TaskUnit): string | null {
  return (u.phases.find((p) => p.agents.some((a) => a.state === 'running')) ?? u.phases.at(-1))?.name ?? null
}
