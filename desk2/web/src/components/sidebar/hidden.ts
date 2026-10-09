// The project groups hidden from the sidebar (a group header's right-click → Hide) and the Filter menu's
// Show hidden, one per window, read by both lists (the desk list and the cloud list, logic.ts dropHidden),
// so the cloud button hides the same groups. Not archive: the chats stay as they are (owner, 2026-10-05:
// "I don't want to like archive because they're meant to be there, but I also don't feel like seeing").
// A group is known by its key (logic.ts groupOrderKey: its folder, or its moved-to name). This viewer's browser
// remembers both.
import { ref } from 'vue'
import { setHidden } from './logic'

const HIDDEN_KEY = 'hydra-desk.sidebar.hidden'
const SHOW_KEY = 'hydra-desk.sidebar.showHidden'

function createHidden() {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  function read(): string[] {
    try {
      const v = JSON.parse(storage?.getItem(HIDDEN_KEY) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const hidden = ref<ReadonlySet<string>>(new Set(read()))
  const showHidden = ref(storage?.getItem(SHOW_KEY) === 'true')
  function write(key: string, value: string): void {
    try {
      storage?.setItem(key, value)
    } catch {
      // storage full or blocked: it holds for this window only
    }
  }
  return {
    hidden,
    showHidden,
    /** Hide (`on`) or Unhide the group with this groupOrderKey. */
    hide(key: string, on: boolean): void {
      hidden.value = setHidden(hidden.value, key, on)
      write(HIDDEN_KEY, JSON.stringify([...hidden.value]))
    },
    setShowHidden(on: boolean): void {
      showHidden.value = on
      write(SHOW_KEY, String(on))
    }
  }
}

let one: ReturnType<typeof createHidden> | null = null

/** The window's hidden groups. */
export function useHiddenGroups(): ReturnType<typeof createHidden> {
  if (!one) one = createHidden()
  return one
}
