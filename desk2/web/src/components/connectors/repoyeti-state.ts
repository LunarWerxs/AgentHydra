// RepoYeti's connector entry, read from GET /api/connectors and shared by the Changes pane's switch and the RepoYeti side. One
// polling loop for whoever watches it (the window while a chat is open, the pane while it is shown).
import { computed, ref } from 'vue'
import { CONNECTORS, REPOYETI_REGISTER, connectorAction, type ConnectorAction, type ConnectorsResponse, type ConnectorView, type RepoYetiRegisterResult } from '@shared/connectors'
import { parseChangesTab, pollDelay, repoYetiOf, type ChangesTab } from './logic'

const list = ref<ConnectorView[] | null>(null)
export const repoYeti = computed(() => repoYetiOf(list.value))

export async function refreshConnectors(): Promise<void> {
  try {
    const res = await fetch(CONNECTORS)
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) list.value = ((await res.json()) as ConnectorsResponse).connectors
  } catch {
    /* the server is restarting: keep what was last seen */
  }
}

/** POST an action for RepoYeti; the answer is its new view, which is shown at once. */
export async function repoYetiAction(action: ConnectorAction): Promise<void> {
  const res = await fetch(connectorAction('repoyeti', action), { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const view = (await res.json()) as ConnectorView
  if (list.value) list.value = list.value.map((c) => (c.id === view.id ? view : c))
  else await refreshConnectors()
}

let watchers = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Start watching; call the returned function to stop. The loop runs while at least one watcher is left. */
export function watchRepoYeti(): () => void {
  watchers++
  if (watchers === 1) {
    const tick = async (): Promise<void> => {
      if (!document.hidden) await refreshConnectors()
      if (watchers > 0) timer = setTimeout(tick, pollDelay(repoYeti.value))
    }
    void tick()
  }
  let done = false
  return () => {
    if (done) return
    done = true
    if (--watchers === 0 && timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/** Asks Desk to add the chat's folder to RepoYeti; null when it would not (not a git folder, RepoYeti down): the pane just shows its list. */
export async function registerRepoYetiFolder(cwd: string): Promise<RepoYetiRegisterResult | null> {
  try {
    const res = await fetch(REPOYETI_REGISTER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }) })
    return res.ok ? ((await res.json()) as RepoYetiRegisterResult) : null
  } catch {
    return null
  }
}

// Which side of the Changes pane is open: one choice for the whole Desk, remembered in this browser.
const CHANGES_TAB_KEY = 'hydra-desk.changes.tab'
const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
export const changesTab = ref<ChangesTab>(parseChangesTab(store()?.getItem(CHANGES_TAB_KEY)))

export function setChangesTab(t: ChangesTab): void {
  changesTab.value = t
  try {
    store()?.setItem(CHANGES_TAB_KEY, t)
  } catch {
    /* storage is full or blocked: the choice lasts until the window closes */
  }
}
