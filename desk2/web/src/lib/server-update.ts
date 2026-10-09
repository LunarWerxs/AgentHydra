// Restart to update (server/src/plugins/60-update.ts): the window asks whether the server's own code changed
// after it started, on every hello and every minute, and the Menu restarts the server onto that code. A change
// to the window alone needs no restart (stale-bundle.ts).

import { computed, ref } from 'vue'
import type { ServerUpdate } from '@shared/protocol'

const LOOK_EVERY_MS = 60_000
const SEEN_KEY = 'hydra-desk.menu.updateSeen'
const ASK_MS = 4_000
// Long enough to outlast a busy server's stall (up to 15 s measured): the restart it would answer 202 to
// at once is the one thing that clears the stall.
const RESTART_MS = 20_000
/** How long a restart may go without the new server's hello before the row says it did not happen
 *  (owner, 2026-10-09: "I can't get the restart button to restart"; the row said Restarting… for good). */
export const RESTART_WAIT_MS = 60_000
export const RESTART_LOST = 'The server did not restart: it did not answer. Click to try again.'
const storage = typeof localStorage === 'undefined' ? null : localStorage

export const serverUpdate = ref<ServerUpdate | null>(null)
/**
 * The Menu was opened while the server was stale: its blue dot is off. The server says only whether it is stale,
 * so the dot returns for a change only after a restart has made it current (owner, 2026-10-07).
 */
export const updateSeen = ref(storage?.getItem(SEEN_KEY) === '1')
export function markUpdateSeen(seen: boolean): void {
  updateSeen.value = seen
  storage?.setItem(SEEN_KEY, seen ? '1' : '0')
}
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

function setServerUpdate(update: ServerUpdate): void {
  serverUpdate.value = update
  if (!update.stale && updateSeen.value) markUpdateSeen(false)
}

/** The window asks the server, which says whether its code is older than the files. */
export async function checkServerUpdate(): Promise<void> {
  try {
    const res = await fetch('/api/server/update', { cache: 'no-store', signal: AbortSignal.timeout(ASK_MS) })
    // A server older than this route is older than this window: it needs a restart it cannot do itself.
    if (res.status === 404) setServerUpdate({ stale: true, restartable: false })
    else if (res.ok) setServerUpdate((await res.json()) as ServerUpdate)
  } catch {
    // Unreachable (restarting, say): the next hello asks again.
  }
}

let restartWatch: ReturnType<typeof setTimeout> | null = null

function stopRestartWatch(): void {
  if (restartWatch) clearTimeout(restartWatch)
  restartWatch = null
}

/** A restart no hello ends within `ms` did not happen: the row says so and takes a click again. */
function watchRestart(ms: number): void {
  stopRestartWatch()
  restartWatch = setTimeout(() => {
    restartWatch = null
    if (restartState.value && 'restarting' in restartState.value) restartState.value = { error: RESTART_LOST }
  }, ms)
}

/** A server said hello: a restart asked for is over (the new one is up), and it says whether it is current. */
export function serverHello(): void {
  stopRestartWatch()
  if (restartState.value && 'restarting' in restartState.value) restartState.value = null
  void checkServerUpdate()
}

let watching = false

const onVisibility = () => {
  if (!document.hidden) void checkServerUpdate()
}

/** Asks every minute while the window is in sight, and at once when it comes back into view (once per window). Returns what stops it. */
export function watchServerUpdate(): () => void {
  if (watching || typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  watching = true
  document.addEventListener?.('visibilitychange', onVisibility)
  const every = setInterval(() => {
    if (!document.hidden) void checkServerUpdate()
  }, LOOK_EVERY_MS)
  return () => {
    document.removeEventListener?.('visibilitychange', onVisibility)
    clearInterval(every)
    watching = false
  }
}

/** Restarts the server onto the code on disk (launcher/restart.ps1); the chats run on and the window reconnects. */
export async function restartServer(waitMs = RESTART_WAIT_MS): Promise<void> {
  restartState.value = { restarting: true }
  watchRestart(waitMs)
  try {
    const res = await fetch('/api/server/restart', {
      method: 'POST',
      headers: { 'X-Desk-Caller': 'window' },
      signal: AbortSignal.timeout(RESTART_MS),
    })
    if (res.ok) return
    stopRestartWatch()
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
    restartState.value = { error: typeof error === 'string' && error ? error : `${res.status} ${res.statusText}` }
  } catch (err) {
    // A server that is already restarting may not answer in time: the next hello ends the restarting state,
    // and with no hello by `waitMs` the watch says the restart did not happen.
    if ((err as Error).name === 'TimeoutError') return
    stopRestartWatch()
    restartState.value = { error: (err as Error).message }
  }
}

/** A refusal's sentence; "no route ..." means the server is older than this window. */
export function refusalText(status: number, error: unknown): string | null {
  if (typeof error !== 'string' || !error) return null
  return status === 404 && error.startsWith('no route ') ? "This window's server is older than the window: Menu > Restart to update" : error
}
