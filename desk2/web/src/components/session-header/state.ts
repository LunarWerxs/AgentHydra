// The session header's state, one per window: open or folded (the title bar's toggle), and what the
// transcript shows (its ⋯ menu's Display), both remembered.
import { ref, watch } from 'vue'
import { DEFAULT_DISPLAY, type DisplayPrefs } from './logic'

const storage = typeof localStorage === 'undefined' ? null : localStorage
const OPEN_KEY = 'hydra-desk.session-header.open'
const DISPLAY_KEY = 'hydra-desk.session-header.display'

function readDisplay(): DisplayPrefs {
  try {
    const saved = JSON.parse(storage?.getItem(DISPLAY_KEY) ?? 'null') as Partial<DisplayPrefs> | null
    const pick = (k: keyof DisplayPrefs) => (typeof saved?.[k] === 'boolean' ? saved[k] : DEFAULT_DISPLAY[k])
    return { humanOnly: pick('humanOnly'), showTools: pick('showTools'), showThinking: pick('showThinking'), compact: pick('compact') }
  } catch {
    return { ...DEFAULT_DISPLAY }
  }
}

/** Open unless folded away; the title bar's toggle flips it. */
export const headerOpen = ref(storage?.getItem(OPEN_KEY) !== '0')
watch(headerOpen, (v) => storage?.setItem(OPEN_KEY, v ? '1' : '0'))

export const displayPrefs = ref<DisplayPrefs>(readDisplay())
watch(displayPrefs, (v) => storage?.setItem(DISPLAY_KEY, JSON.stringify(v)), { deep: true })
