// The agents chip above the composer: Hydra Desk's version of the real app's background-tasks
// pill. It counts only the CliMayte workers this chat dispatched (ChatSummary.workerIds, the server's
// match); pure functions here so the label and states are testable.
import type { CliMayteWorker } from '@shared/protocol'

export type DockTone = 'running' | 'done' | 'none'

export interface DockSummary {
  running: number
  done: number
  tone: DockTone
  label: string
}

/**
 * The workers that belong to a chat: the ids the server matched to it (`workerIds`, kept for finished ones too),
 * or, before the server has matched it, a worker whose originSessionId is the chat's current session.
 */
export function chatWorkers(workers: CliMayteWorker[], sessionId: string | null | undefined, workerIds: readonly string[] = []): CliMayteWorker[] {
  const ids = new Set(workerIds)
  return workers.filter((w) => ids.has(w.id) || (!!sessionId && w.originSessionId === sessionId))
}

/**
 * The chip: "1 agent running", "3 agents running", "2 running, 1 done", "1 agent done", "4 agents done".
 * `climayteActive` (ChatSummary) covers workers the list has not reported yet; done workers the user
 * cleared (dismissed ids) no longer count.
 */
export function summarizeDock(workers: CliMayteWorker[], climayteActive = 0, dismissed: ReadonlySet<string> = new Set()): DockSummary {
  const running = Math.max(workers.filter((w) => w.active).length, climayteActive)
  const done = workers.filter((w) => !w.active && !dismissed.has(w.id)).length
  const agents = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`
  if (running && done) return { running, done, tone: 'running', label: `${running} running, ${done} done` }
  if (running) return { running, done, tone: 'running', label: `${agents(running)} running` }
  if (done) return { running, done, tone: 'done', label: `${agents(done)} done` }
  return { running, done, tone: 'none', label: '' }
}

const DISMISSED_KEY = 'hydra-desk:dock-dismissed'

/** Done workers the user cleared from the dock, kept across reloads (newest 500). */
export function loadDismissed(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): Set<string> {
  try {
    const raw = storage?.getItem(DISMISSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
export function saveDismissed(ids: Set<string>, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null) {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-500)))
  } catch {
    // storage full or blocked: clearing just does not survive a reload
  }
}
