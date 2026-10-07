// Which of the sidebar Dev servers list's groups are open, remembered across reloads (owner, 2026-10-07: groups are
// "collapsible" and "default collapsed"). Only what a person opened or closed is kept; any other group takes the default
// its caller gives (closed, but Other servers open). Keys: `c:` a company, `p:` a project, `o` Other servers, `oc:` a
// company in it, `f` Found on this PC, `fc:` and `fp:` a company and a project folder in it.
import { ref } from 'vue'

const KEY = 'hydra-desk.devservers.open'
// Reading `localStorage` itself throws where a page's storage is blocked; the groups are then just not remembered.
const storage = ((): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
})()

function read(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
  } catch {
    return {}
  }
}

const state = ref<Record<string, boolean>>(read())

function save(next: Record<string, boolean>) {
  state.value = next
  try {
    storage?.setItem(KEY, JSON.stringify(next))
  } catch {
    // floor-ok: a full or blocked store: the groups just are not remembered
  }
}

export function useOpenGroups() {
  const isOpen = (key: string, dflt = false): boolean => state.value[key] ?? dflt
  /** Opens or closes every group named (one chevron, or Expand all / Collapse all). */
  const setAll = (keys: readonly string[], open: boolean): void => save({ ...state.value, ...Object.fromEntries(keys.map((k) => [k, open])) })
  return { isOpen, setAll }
}
