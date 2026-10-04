// Which CliMayte workers belong to a chat (ChatSummary.workerIds, the server's match), and the ids the
// user cleared from the Background tasks panel. (The agents chip above the composer is gone.)
import type { CliMayteWorker } from '@shared/protocol'

/**
 * The workers that belong to a chat: the ids the server matched to it (`workerIds`, kept for finished ones too),
 * or, before the server has matched it, a worker whose originSessionId is the chat's current session.
 */
export function chatWorkers(workers: CliMayteWorker[], sessionId: string | null | undefined, workerIds: readonly string[] = []): CliMayteWorker[] {
  const ids = new Set(workerIds)
  return workers.filter((w) => ids.has(w.id) || (!!sessionId && w.originSessionId === sessionId))
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
