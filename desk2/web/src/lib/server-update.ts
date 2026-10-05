// Restart to update (server/src/plugins/60-update.ts): the window asks whether the server's own code changed
// after it started, on every hello and every minute, and the Menu restarts the server onto that code. A change
// to the window alone needs no restart (stale-bundle.ts).

import { computed, ref } from 'vue'
import type { ServerUpdate } from '@shared/protocol'

const LOOK_EVERY_MS = 60_000

export const serverUpdate = ref<ServerUpdate | null>(null)
/** A restart asked for and not yet answered by the new server's hello, or why it could not start. */
export const restartState = ref<{ restarting: true } | { error: string } | null>(null)

/** What the Menu shows: null while the server runs the code on disk. */
export interface UpdateOffer {
  restartable: boolean
  restarting: boolean
  error: string | null
}

export function offerOf(update: ServerUpdate | null, state: typeof restartState.value): UpdateOffer | null {
  if (!update?.stale) return null
  return {
    restartable: update.restartable,
    restarting: !!state && 'restarting' in state,
    error: state && 'error' in state ? state.error : null,
  }
}

export const updateOffer = computed(() => offerOf(serverUpdate.value, restartState.value))

/** The window asks the server, which says whether its code is older than the files. */
export async function checkServerUpdate(): Promise<void> {
  try {
    const res = await fetch('/api/server/update', { cache: 'no-store' })
    // A server older than this route is older than this window: it needs a restart it cannot do itself.
    if (res.status === 404) serverUpdate.value = { stale: true, restartable: false }
    else if (res.ok) serverUpdate.value = (await res.json()) as ServerUpdate
  } catch {
    // Unreachable (restarting, say): the next hello asks again.
  }
}

/** A server said hello: a restart asked for is over (the new one is up), and it says whether it is current. */
export function serverHello(): void {
  if (restartState.value && 'restarting' in restartState.value) restartState.value = null
  void checkServerUpdate()
}

let watching = false

/** Asks every minute while the window is in sight (once per window). */
export function watchServerUpdate(): void {
  if (watching || typeof window === 'undefined' || typeof document === 'undefined') return
  watching = true
  setInterval(() => {
    if (!document.hidden) void checkServerUpdate()
  }, LOOK_EVERY_MS)
}

/** Restarts the server onto the code on disk (launcher/restart.ps1); the chats run on and the window reconnects. */
export async function restartServer(): Promise<void> {
  restartState.value = { restarting: true }
  try {
    const res = await fetch('/api/server/restart', { method: 'POST' })
    if (res.ok) return
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
    restartState.value = { error: typeof error === 'string' && error ? error : `${res.status} ${res.statusText}` }
  } catch (err) {
    restartState.value = { error: (err as Error).message }
  }
}

/** A refusal's sentence; "no route ..." means the server is older than this window. */
export function refusalText(status: number, error: unknown): string | null {
  if (typeof error !== 'string' || !error) return null
  return status === 404 && error.startsWith('no route ') ? "Hydra Desk 2's server is older than this window: Menu > Restart to update" : error
}
