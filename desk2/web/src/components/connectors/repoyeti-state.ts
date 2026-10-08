// RepoYeti's connector entry, read from the shared connector list (connections-api.ts) and used by the Changes pane's switch and the RepoYeti side.
import { computed, ref } from 'vue'
import { REPOYETI_REGISTER, connectorAction, type ConnectorAction, type ConnectorView, type RepoYetiRegisterResult } from '@shared/connectors'
import { connectorList, refreshConnectorList, watchConnectors } from './connections-api'
import { parseChangesTab, pollDelay, repoYetiOf, type ChangesTab } from './logic'

export const repoYeti = computed(() => repoYetiOf(connectorList.value))

/** POST an action for RepoYeti; the answer is its new view, which is shown at once. */
export async function repoYetiAction(action: ConnectorAction): Promise<void> {
  const res = await fetch(connectorAction('repoyeti', action), { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const view = (await res.json()) as ConnectorView
  if (connectorList.value) connectorList.value = connectorList.value.map((c) => (c.id === view.id ? view : c))
  else await refreshConnectorList()
}

/** Start watching; call the returned function to stop. The shared loop polls at the delay RepoYeti's state asks for. */
export function watchRepoYeti(): () => void {
  return watchConnectors(() => pollDelay(repoYeti.value))
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
