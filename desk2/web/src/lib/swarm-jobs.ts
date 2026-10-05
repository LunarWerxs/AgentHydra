// Hydra Desk 2: HSwarm's jobs for the sidebar (GET /api/swarm/jobs; the server reads them through AgentHydra at
// most every 10 s). Read while a sidebar wants them (the task toggle on) and the page is in view, every 10 s.
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { SwarmJob } from '@shared/protocol'

export const SWARM_POLL_MS = 10_000

const jobs = ref<SwarmJob[]>([])
let users = 0
let timer: ReturnType<typeof setInterval> | null = null

async function read(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return
  try {
    const res = await fetch('/api/swarm/jobs', { cache: 'no-store' })
    if (res.ok) jobs.value = (await res.json()) as SwarmJob[]
  } catch {
    // Keeps the last list; the next read tries again.
  }
}

function start(): void {
  if (users++ === 0) {
    void read()
    timer = setInterval(() => void read(), SWARM_POLL_MS)
  }
}
function stop(): void {
  if (--users === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** The jobs, read while `on` is true; the reads end with the calling component. */
export function useSwarmJobs(on: Ref<boolean>): Readonly<Ref<SwarmJob[]>> {
  let active = false
  watch(
    on,
    (v) => {
      if (v && !active) start()
      else if (!v && active) stop()
      active = v
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    if (active) stop()
  })
  return jobs
}
