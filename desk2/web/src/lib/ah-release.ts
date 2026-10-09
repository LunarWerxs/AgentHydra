// Whether the daemon has a newer AgentHydra waiting, learned by Desk itself (the sidebar row must show without the
// AgentHydra pane ever opened), and the apply Settings → Updates and the row both run.

import { ref } from 'vue'
import type { PaneApi } from '@/components/panes/api'
import type { ReleaseWaiting } from './desk-update-row'

const LOOK_EVERY_MS = 180_000
// An update downloads ~100 MB or pulls, installs and rebuilds: minutes, so its request waits up to 20.
const APPLY_TIMEOUT_MS = 20 * 60_000

export interface AhUpdateProgress {
  phase: string
  message: string
  receivedBytes: number | null
  totalBytes: number | null
}

export interface ReleaseApply {
  note: string | null
  error: string | null
}

export const releaseWaiting = ref<ReleaseWaiting | null>(null)
export const releaseApplying = ref(false)
export const releaseApplyError = ref<string | null>(null)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The daemon's background check, through Desk's /ah/api proxy: a memory read, no network. */
export async function checkRelease(): Promise<void> {
  try {
    const res = await fetch('/ah/api/update/available', { cache: 'no-store' })
    releaseWaiting.value = res.ok ? ((await res.json()) as ReleaseWaiting) : null
  } catch {
    releaseWaiting.value = null
  }
}

// The daemon restarts itself after an update, so the apply request may end with the connection dropped: then
// it is the version AgentHydra comes back with that says whether it took.
async function waitForRestart(api: PaneApi): Promise<string | null> {
  const deadline = Date.now() + 90_000
  await new Promise((r) => setTimeout(r, 2000))
  while (Date.now() < deadline) {
    try {
      return (await api.agentHydra<{ version: string }>('/health', { signal: AbortSignal.timeout(2000) })).version
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  return null
}

export async function applyRelease(api: PaneApi, before: string | null, onProgress: (p: AhUpdateProgress | null) => void): Promise<ReleaseApply> {
  const poll = setInterval(() => {
    api
      .agentHydra<AhUpdateProgress>('/update/progress')
      .then(onProgress)
      .catch(() => {}) // floor-ok: one missed progress read; the next second reads again
  }, 1000)
  try {
    const r = await api.agentHydra<{ message: string; restartRequired: boolean }>('/update/apply', {
      method: 'POST',
      signal: AbortSignal.timeout(APPLY_TIMEOUT_MS),
    })
    return { note: r.restartRequired ? `${r.message} Restart AgentHydra from its tray icon to run the new code.` : r.message, error: null }
  } catch (e) {
    const version = await waitForRestart(api)
    if (version) return { note: version === before ? `AgentHydra restarted and runs v${version}.` : `Updated to v${version}.`, error: null }
    return { note: null, error: message(e) }
  } finally {
    clearInterval(poll)
    onProgress(null)
  }
}

/** The row's apply: returns whether the release went through. */
export async function applyWaitingRelease(api: PaneApi): Promise<boolean> {
  releaseApplying.value = true
  releaseApplyError.value = null
  try {
    const r = await applyRelease(api, null, () => {})
    releaseApplyError.value = r.error
    return !r.error
  } finally {
    releaseApplying.value = false
    await checkRelease()
  }
}

let watching = false

/** Looks every three minutes while the window is in sight, and at once when it comes back into view. Returns what stops it. */
export function watchRelease(): () => void {
  if (watching || typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  watching = true
  const look = () => {
    if (!document.hidden) void checkRelease()
  }
  document.addEventListener?.('visibilitychange', look)
  const every = setInterval(look, LOOK_EVERY_MS)
  look()
  return () => {
    document.removeEventListener?.('visibilitychange', look)
    clearInterval(every)
    watching = false
  }
}
