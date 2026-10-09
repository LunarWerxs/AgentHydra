// The one dev-servers client of the window's views of it: the sidebar's Dev servers list, the Dev servers page, the
// right-hand servers pane and Settings -> Connectors' row. All read the service's status (and the lists, their project list) from here, and each
// says it is on screen with `use()`: the polling loop runs while at least one is, and the window is visible, so they never
// disagree and never ask twice. There is no daemon to start: Desk starts the service for the first request that needs it,
// so the first list read of a list view is that request (shown as 'starting' while it is in flight). It is made once per
// page load: a service stopped from Settings stays stopped until a request or `tryAgain` starts it. A Settings-only view
// (`use({ quiet: true })`) reads the status and asks for nothing. `on` is the title bar's Dev servers button (the sidebar shows the list, remembered like the cloud's, and the page slides in).
// Its last answer is kept in memory and in a versioned localStorage snapshot (a day old at most), so a return paints at once and
// `refreshing` says a live answer is on its way; a few seconds after the window starts one basic read fills the first open (never starting the service).
// `focus` is the list's request to the pane: show this server of this project, whatever chat is open (DeskFrame).
import { ref, shallowRef } from 'vue'
import type { DevWebFound, DevWebProcess, DevWebProject, DevWebStatus } from '@shared/devwebui'
import { projectDir } from '@shared/devwebui'
import { devwebService, devwebStatus, foundList, listProjects, processAction, projectAction, RouteMissing, setStarred } from './api'
import type { DevSelection } from './info/selection'
import { allKey, isUp, startReused } from './logic'

export interface ServerFocus {
  /** The folder the pane is shown for: the project's own (`projectDir`). */
  cwd: string
  procId: string
  /** Each click is a new request, even for the same server. */
  seq: number
}

const ON_KEY = 'hydra-desk.devservers.on'
/** 2 s while a server is starting or stopping, else 5 s; the found list at most every 15 s. */
const POLL_MS = 2000
const IDLE_POLL_MS = 5000
const STARTING_POLL_MS = 1000
const FOUND_EVERY_MS = 15_000
/**
 * Missed list reads in a row before a shown list gives way to "did not answer": on a PC at full CPU one read in 60 still
 * passed the 2 s limit (2026-10-07), and the next one answered.
 */
const MISSES_SHOWN = 3
const storage = typeof localStorage === 'undefined' ? null : localStorage
/**
 * The last answer (status and project list only), kept so the first paint after a window reload is not blank. Versioned by
 * its key; a snapshot older than a day is ignored. Written only when it changes, or once a minute at most.
 */
const SNAPSHOT_KEY = 'hydra-desk.devservers.snapshot.v1'
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_EVERY_MS = 60_000
/** The one basic read the window makes on its own, a few seconds after it starts, so the first open is already filled. */
const WARM_MS = 3000

interface Snapshot {
  v: 1
  at: number
  status: DevWebStatus
  projects: DevWebProject[] | null
}

function readSnapshot(): Snapshot | null {
  try {
    const snap = JSON.parse(storage?.getItem(SNAPSHOT_KEY) ?? 'null') as Partial<Snapshot> | null
    if (!snap || snap.v !== 1 || typeof snap.at !== 'number' || !snap.status) return null
    if (Date.now() - snap.at > SNAPSHOT_MAX_AGE_MS) return null
    return snap as Snapshot
  } catch {
    return null
  }
}

function createDevServers() {
  const on = ref(storage?.getItem(ON_KEY) === '1')
  // A snapshot from the last day paints at once and is marked as refreshing until the live answer arrives.
  const shot = readSnapshot()
  const status = ref<DevWebStatus | null>(shot?.status ?? null)
  const statusMissing = ref(false)
  const refreshing = ref(!!shot)
  // Replaced whole by each answer, never edited in place.
  const projects = shallowRef<DevWebProject[] | null>(shot?.projects ?? null)
  const projectsError = ref<string | null>(null)
  const found = shallowRef<DevWebFound | null>(null)
  const busy = ref(new Set<string>())
  const actionError = ref<string | null>(null)
  /** Counts up with each finished refresh: a view that keeps more data of its own (the pane) reloads it on a change. */
  const answered = ref(0)
  const focus = ref<ServerFocus | null>(null)
  /** Counts up with each Start that found the server already up: the pane shows its small notice. */
  const reused = ref(0)

  const setOn = (v: boolean) => {
    on.value = v
    try {
      storage?.setItem(ON_KEY, v ? '1' : '0')
    } catch {
      // floor-ok: a full or blocked store: the button just is not remembered
    }
  }

  // The first status read of a list view ends the automatic request, whatever it said: a service stopped later is not restarted behind the person's back.
  let asked = false
  let misses = 0
  async function once(): Promise<void> {
    const read = await readStatus()
    if (!read) return
    let s = read
    const loud = lists > 0
    let loaded = false
    if (loud && !asked) {
      asked = true
      if (s.state === 'stopped') {
        const started = await startWithList(s)
        s = started.s
        loaded = started.loaded
      }
    }
    status.value = s
    if (s.state !== 'running' || !loud) {
      if (s.state !== 'running') projects.value = null
      return
    }
    if (loaded) return
    await readProjects()
    await readFound()
  }

  /** The service's status, or null when the read failed (a missing route is remembered). */
  async function readStatus(): Promise<DevWebStatus | null> {
    try {
      const s = await devwebStatus()
      statusMissing.value = false
      return s
    } catch (err) {
      if (err instanceof RouteMissing) statusMissing.value = true
      return null
    }
  }

  /** The list read is the request that starts a stopped service; 'starting' shows while it is in flight, so the stopped view only appears after a stop. */
  async function startWithList(before: DevWebStatus): Promise<{ s: DevWebStatus; loaded: boolean }> {
    status.value = { state: 'starting', pid: null }
    let failure: string | null = null
    let loaded = false
    try {
      projects.value = await listProjects()
      projectsError.value = null
      loaded = true
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
    let s = await devwebStatus().catch(() => before)
    if (failure && s.state !== 'running') s = { state: 'failed', pid: null, reason: failure }
    return { s, loaded }
  }

  async function readProjects(): Promise<void> {
    try {
      // Never the read that starts it: a Stop clicked while this was on its way must stay a stop.
      projects.value = await listProjects({ start: false })
      projectsError.value = null
      misses = 0
    } catch (err) {
      // A list already on screen stays through a missed read or two; with none yet, the reason shows at once.
      if (!projects.value || ++misses >= MISSES_SHOWN) projectsError.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** The found list rides the same poll, read at most every 15 s unless a view or an action asked; a failed read keeps the last one. */
  async function readFound(): Promise<void> {
    if (!foundNow && Date.now() - foundAt < FOUND_EVERY_MS) return
    foundNow = false
    found.value = await foundList({ start: false }).catch(() => found.value)
    foundAt = Date.now()
  }

  // A refresh asked for while one runs runs once more after it, so an action's refresh never reads what was already in flight.
  let running: Promise<void> | null = null
  let queued = false
  let lastAt = 0
  async function drain(): Promise<void> {
    refreshing.value = true
    try {
      do {
        queued = false
        lastAt = Date.now()
        await once()
        lastAt = Date.now()
        persist()
        answered.value++
      } while (queued)
    } finally {
      refreshing.value = false
    }
  }
  let foundNow = true
  let foundAt = 0
  function request(foundToo: boolean): Promise<void> {
    if (foundToo) foundNow = true
    if (running) queued = true
    else running = drain().finally(() => (running = null))
    return running
  }

  // The snapshot: written when the answer changed, and at most once a minute otherwise.
  let savedBody = ''
  let savedAt = 0
  function persist(): void {
    const s = status.value
    // A status still starting is not an answer to keep.
    if (!s || s.state === 'starting' || !storage) return
    const body = JSON.stringify({ status: s, projects: projects.value })
    if (body === savedBody && Date.now() - savedAt < SNAPSHOT_EVERY_MS) return
    const shot: Snapshot = { v: 1, at: Date.now(), status: s, projects: projects.value }
    try {
      storage.setItem(SNAPSHOT_KEY, JSON.stringify(shot))
      savedBody = body
      savedAt = Date.now()
    } catch {
      // floor-ok: a full or blocked store: the first paint after a reload just waits for the live answer
    }
  }

  /**
   * The window's own first read, a few seconds after it starts. It never starts the service (a stopped one answers
   * 'stopped'), and it yields to a view on screen, which reads for itself.
   */
  function warm(): Promise<void> {
    if (running || viewers) return running ?? Promise.resolve()
    running = (async () => {
      refreshing.value = true
      try {
        const read = await readStatus()
        if (read) {
          status.value = read
          if (read.state === 'running') await readProjects()
          else projects.value = null
          persist()
        }
      } finally {
        refreshing.value = false
      }
    })().finally(() => (running = null))
    return running
  }
  const refresh = (): Promise<void> => request(true)
  const moving = (): boolean => (projects.value ?? []).some((p) => p.processes.some((x) => x.status === 'starting' || x.status === 'stopping'))
  const pollMs = (): number => (status.value?.state === 'starting' ? STARTING_POLL_MS : moving() ? POLL_MS : IDLE_POLL_MS)

  // ---- polling: only while a view is on screen, and the window is ----
  let viewers = 0
  /** The views that show the project list (the sidebar's list and the pane); Settings' row only needs the status. */
  let lists = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // One loop at a time: stopTimer moves `gen` on, so a refresh that was running when the window was hidden does not
  // schedule a second loop behind the new one.
  let gen = 0
  function schedule(g = gen) {
    if (!viewers || document.hidden || g !== gen) return
    timer = setTimeout(async () => {
      await request(false)
      schedule(g)
    }, pollMs())
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
  function use(opts: { quiet?: boolean } = {}): () => void {
    viewers++
    if (!opts.quiet) lists++
    if (viewers === 1) {
      document.addEventListener('visibilitychange', onVisibility)
      if (!document.hidden) begin()
    } else if (Date.now() - lastAt > POLL_MS - 500 || (!opts.quiet && lists === 1)) void refresh()
    let done = false
    return () => {
      if (done) return
      done = true
      viewers--
      if (!opts.quiet) lists--
      if (viewers) return
      stopTimer()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  /** The service did not start or was stopped: start it (Settings' Restart and Stop go through here too). */
  async function service(action: 'start' | 'stop' | 'restart'): Promise<void> {
    asked = true
    if (action !== 'stop') status.value = { state: 'starting', pid: null }
    status.value = await devwebService(action).catch((err) => ({ state: 'failed', pid: null, reason: err instanceof Error ? err.message : String(err) }) as DevWebStatus)
    if (status.value.state !== 'running') projects.value = null
    await refresh()
  }
  const tryAgain = (): Promise<void> => service('start')

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    // One action per server (or project) at a time: a second click while the first runs is the same click.
    if (busy.value.has(key)) return
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
  /** A server just asked to start reads as starting until the service's next answer, not as the stopped it still was. */
  function markStarting(id: string) {
    const list = projects.value
    if (list) projects.value = list.map((pr) => ({ ...pr, processes: pr.processes.map((x) => (x.id === id && !isUp(x.status) ? { ...x, status: 'starting' as const } : x)) }))
  }
  function act(p: Pick<DevWebProcess, 'id'>, action: 'start' | 'stop' | 'restart'): Promise<void> {
    return run(p.id, async () => {
      if (action === 'start') markStarting(p.id)
      const answer = await processAction(p.id, action)
      if (action === 'start' && startReused(answer)) reused.value++
    })
  }
  const actAll = (project: Pick<DevWebProject, 'id'>, action: 'start' | 'stop') => run(allKey(project), () => projectAction(project.id, action))
  /** Stars or unstars a server (the pane's star, the list row's): it reads as changed at once, and the service's answer settles it. */
  function star(id: string, on: boolean): Promise<void> {
    const list = projects.value
    if (list) projects.value = list.map((pr) => ({ ...pr, processes: pr.processes.map((x) => (x.id === id ? { ...x, starred: on } : x)) }))
    return run(`star:${id}`, () => setStarred(id, on))
  }

  /** The list's click: ask the pane to show this server. */
  let seq = 0
  function show(project: DevWebProject, proc: Pick<DevWebProcess, 'id'>): void {
    focus.value = { cwd: projectDir(project), procId: proc.id, seq: ++seq }
  }

  /**
   * The Dev servers page (owner, 2026-10-07: "just be its own page ... have it slide in like Hydra slides in"): whether
   * it is on screen, and what it shows, null being its overview of every project. A selection opens it; DeskFrame slides
   * it in and out. Closing it clears the selection, so the list highlights nothing.
   */
  const page = ref(false)
  const selection = ref<DevSelection | null>(null)
  const select = (sel: DevSelection | null): void => {
    selection.value = sel
    if (sel) page.value = true
  }
  const openPage = (): void => {
    page.value = true
  }
  const closePage = (): void => {
    page.value = false
    selection.value = null
  }

  if (typeof window !== 'undefined') setTimeout(() => void warm(), WARM_MS)

  return { on, setOn, status, statusMissing, refreshing, projects, projectsError, found, busy, actionError, answered, focus, reused, page, selection, select, openPage, closePage, refresh, use, tryAgain, service, run, act, actAll, star, show }
}

let servers: ReturnType<typeof createDevServers> | null = null

/** The window's one dev-servers client state. */
export function useDevServers(): ReturnType<typeof createDevServers> {
  if (!servers) servers = createDevServers()
  return servers
}
