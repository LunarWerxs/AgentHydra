// The one DevWebUI client of the window's two views of it: the sidebar's Dev servers list and the right-hand servers
// pane. Both read the daemon's status and its project list from here, and each says it is on screen with `use()`:
// the polling loop runs while at least one is, and the window is visible, so they never disagree and never ask twice.
// Turning the first one on starts the server manager when none answers (once; `tryAgain` starts it again), as the pane
// always did. `on` is the title bar's Dev servers button (the sidebar shows the list, remembered like the cloud's).
// `focus` is the list's request to the pane: show this server of this project, whatever chat is open (DeskFrame).
import { ref, shallowRef } from 'vue'
import type { DevWebProcess, DevWebProject, DevWebStatus } from '@shared/devwebui'
import { projectDir } from '@shared/devwebui'
import { devwebStart, devwebStatus, listProjects, processAction, projectAction, RouteMissing } from './api'
import { allKey, isUp } from './logic'

export interface ServerFocus {
  /** The folder the pane is shown for: the project's own (`projectDir`). */
  cwd: string
  procId: string
  /** Each click is a new request, even for the same server. */
  seq: number
}

const ON_KEY = 'hydra-desk.devservers.on'
const POLL_MS = 2000
const STARTING_POLL_MS = 1000
const storage = typeof localStorage === 'undefined' ? null : localStorage

function createDevServers() {
  const on = ref(storage?.getItem(ON_KEY) === '1')
  const status = ref<DevWebStatus | null>(null)
  const statusMissing = ref(false)
  // Replaced whole by each answer, never edited in place.
  const projects = shallowRef<DevWebProject[] | null>(null)
  const projectsError = ref<string | null>(null)
  const busy = ref(new Set<string>())
  const actionError = ref<string | null>(null)
  /** Counts up with each finished refresh: a view that keeps more data of its own (the pane) reloads it on a change. */
  const answered = ref(0)
  const focus = ref<ServerFocus | null>(null)

  const setOn = (v: boolean) => {
    on.value = v
    try {
      storage?.setItem(ON_KEY, v ? '1' : '0')
    } catch {
      // floor-ok: a full or blocked store: the button just is not remembered
    }
  }

  let started = false
  async function once(): Promise<void> {
    let s: DevWebStatus
    try {
      s = await devwebStatus()
      statusMissing.value = false
    } catch (err) {
      if (err instanceof RouteMissing) statusMissing.value = true
      return
    }
    if (s.state === 'stopped' && !started) {
      // Show 'starting' while the automatic start runs, so the stopped card only appears once a start has failed.
      started = true
      status.value = { state: 'starting', url: null }
      status.value = await devwebStart().catch((err) => ({ state: 'failed', url: null, reason: err instanceof Error ? err.message : String(err) }) as DevWebStatus)
    } else status.value = s
    if (status.value.state !== 'running') {
      projects.value = null
      return
    }
    try {
      projects.value = await listProjects()
      projectsError.value = null
    } catch (err) {
      projectsError.value = err instanceof Error ? err.message : String(err)
    }
  }

  // A refresh asked for while one runs runs once more after it, so an action's refresh never reads what was already in flight.
  let running: Promise<void> | null = null
  let queued = false
  let lastAt = 0
  async function drain(): Promise<void> {
    do {
      queued = false
      lastAt = Date.now()
      await once()
      lastAt = Date.now()
      answered.value++
    } while (queued)
  }
  function refresh(): Promise<void> {
    if (running) queued = true
    else running = drain().finally(() => (running = null))
    return running
  }

  // ---- polling: only while a view is on screen, and the window is ----
  let viewers = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // One loop at a time: stopTimer moves `gen` on, so a refresh that was running when the window was hidden does not
  // schedule a second loop behind the new one.
  let gen = 0
  function schedule(g = gen) {
    if (!viewers || document.hidden || g !== gen) return
    timer = setTimeout(async () => {
      await refresh()
      schedule(g)
    }, status.value?.state === 'starting' ? STARTING_POLL_MS : POLL_MS)
  }
  function stopTimer() {
    gen++
    if (timer) clearTimeout(timer)
    timer = null
  }
  function begin() {
    const g = gen
    void refresh().then(() => schedule(g))
  }
  function onVisibility() {
    stopTimer()
    if (!document.hidden && viewers) begin()
  }

  /** A view is on screen: polling runs until the returned function is called. A view that joins one already polling gets its answer, fresh enough, at once. */
  function use(): () => void {
    viewers++
    if (viewers === 1) {
      document.addEventListener('visibilitychange', onVisibility)
      if (!document.hidden) begin()
    } else if (Date.now() - lastAt > POLL_MS - 500) void refresh()
    let done = false
    return () => {
      if (done) return
      done = true
      viewers--
      if (viewers) return
      stopTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  /** The server manager did not start or stopped: start it again. */
  async function tryAgain(): Promise<void> {
    started = false
    const pending: DevWebStatus = { state: 'starting', url: null }
    status.value = pending
    await refresh()
    // A status error that refresh returned on leaves the view as on first open (loading, polling goes on), not starting for good.
    if (status.value === pending) status.value = null
  }

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    actionError.value = null
    busy.value = new Set(busy.value).add(key)
    try {
      await fn()
      await refresh()
    } catch (err) {
      actionError.value = err instanceof Error ? err.message : String(err)
    } finally {
      const next = new Set(busy.value)
      next.delete(key)
      busy.value = next
    }
  }
  /** A server just asked to start reads as starting until DevWebUI's next answer, not as the stopped it still was. */
  function markStarting(id: string) {
    const list = projects.value
    if (list) projects.value = list.map((pr) => ({ ...pr, processes: pr.processes.map((x) => (x.id === id && !isUp(x.status) ? { ...x, status: 'starting' as const } : x)) }))
  }
  function act(p: Pick<DevWebProcess, 'id'>, action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (action === 'start') markStarting(p.id)
    return run(p.id, () => processAction(p.id, action))
  }
  const actAll = (project: Pick<DevWebProject, 'id'>, action: 'start' | 'stop') => run(allKey(project), () => projectAction(project.id, action))

  /** The list's click: ask the pane to show this server. */
  let seq = 0
  function show(project: DevWebProject, proc: Pick<DevWebProcess, 'id'>): void {
    focus.value = { cwd: projectDir(project), procId: proc.id, seq: ++seq }
  }

  return { on, setOn, status, statusMissing, projects, projectsError, busy, actionError, answered, focus, refresh, use, tryAgain, run, act, actAll, show }
}

let servers: ReturnType<typeof createDevServers> | null = null

/** The window's one DevWebUI client state. */
export function useDevServers(): ReturnType<typeof createDevServers> {
  if (!servers) servers = createDevServers()
  return servers
}
