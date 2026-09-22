// web/src/composables/useRunningCode.ts — "the daemon is older than its folder; restart it".
//
// A source install keeps serving the code it booted on after the checkout moves (a commit, a pull),
// and until this nothing on screen said so: new routes simply 404'd into the app shell. The daemon
// reports the comparison in /api/health (server/src/core/running-code.ts); this polls it once a
// minute and offers the in-place restart the daemon already has. Module scope, one poller per window.

import { ref } from 'vue'
import { getHealth, restartDaemon } from '@/lib/api'

const POLL_MS = 60_000

const restartNeeded = ref(false)
const bootCommit = ref<string | null>(null)
const diskCommit = ref<string | null>(null)
const restarting = ref(false)
const restartError = ref<string | null>(null)
let timer: number | null = null

async function refresh(): Promise<void> {
  try {
    const health = await getHealth(5000)
    restartNeeded.value = health.runningCode?.restartNeeded === true
    bootCommit.value = health.runningCode?.bootCommit ?? null
    diskCommit.value = health.runningCode?.diskCommit ?? null
  } catch {
    // An unreachable daemon is not a stale one; leave the last answer alone.
  }
}

/** Poll /api/health until the relaunched daemon answers, then reload so the page runs its code. */
async function restart(): Promise<void> {
  if (restarting.value) return
  restarting.value = true
  restartError.value = null
  try {
    const result = await restartDaemon()
    if (!result.ok) throw new Error(result.error ?? result.detail ?? 'restart refused')
    // A beat first: the predecessor answers for about a second after it spawns its successor.
    await new Promise((r) => setTimeout(r, 2000))
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      try {
        const health = await getHealth()
        if (health.ok && health.runningCode?.restartNeeded !== true) {
          window.location.reload()
          return
        }
      } catch {
        // Still handing the port over.
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error('the daemon did not come back within 90s')
  } catch (error) {
    restartError.value = error instanceof Error ? error.message : String(error)
  } finally {
    restarting.value = false
  }
}

function start(): void {
  if (timer !== null) return
  void refresh()
  timer = window.setInterval(() => void refresh(), POLL_MS)
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
}

export function useRunningCode() {
  return { restartNeeded, bootCommit, diskCommit, restarting, restartError, restart, start, stop }
}
