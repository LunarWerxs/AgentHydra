// The HSwarm tab is a list of pages (Hydra Desk 2, owner 2026-10-05: CliMayte moves into HSwarm and shows
// as an entry of its sidebar). Desk's sidebar lists them at the top, each page's own rows under its entry.
// A page is data here (Routing was added so): one more line in HSWARM_PAGES and its component.
import { ref } from 'vue'
import type { EmbedIcon } from '@desk/shared/hydra-embed'

export interface HSwarmPage {
  /** Also the `view` its component describes its sidebar part with (useDeskSidebar). */
  id: string
  /** The entry's label, an i18n key. */
  labelKey: string
  icon: EmbedIcon
}

/** The entries in the order Desk lists them. HSwarm's own page (its tree, which stays as it was) is last. */
export const HSWARM_PAGES: readonly HSwarmPage[] = [
  { id: 'climayte', labelKey: 'app.tabClimayte', icon: 'network' },
  { id: 'routing', labelKey: 'app.tabRouting', icon: 'route' },
  { id: 'hswarm', labelKey: 'app.tabHswarm', icon: 'layers' },
]

/** The key of a page's entry row in the sidebar model; a click on it comes back with this key. */
export const PAGE_KEY_PREFIX = 'page:'

const PAGE_STORE_KEY = 'agenthydra.hswarm.page'

export function parseHSwarmPage(raw: string | null | undefined): string | null {
  return HSWARM_PAGES.some((p) => p.id === raw) ? (raw as string) : null
}

function readPage(): string {
  try {
    return parseHSwarmPage(localStorage.getItem(PAGE_STORE_KEY)) ?? HSWARM_PAGES[0].id
  } catch {
    return HSWARM_PAGES[0].id
  }
}

/** The page on screen in the HSwarm tab, remembered across reloads. */
export const hswarmPage = ref<string>(readPage())

/** Shows a page (the tab itself is chosen by the caller: view.value = 'hswarm'). */
export function showHSwarmPage(id: string): void {
  if (!parseHSwarmPage(id)) return
  hswarmPage.value = id
  try {
    localStorage.setItem(PAGE_STORE_KEY, id)
  } catch {
    // storage blocked: the page is not remembered, nothing else
  }
}
