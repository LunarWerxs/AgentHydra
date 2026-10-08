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

// A peek: the folded header slides out for a moment and back, never saved. A session opened from a search
// shows its id and account this way (owner, 2026-10-08: "it should appear for, like, a second or two, and
// then re-hide if it was set to be hidden").
const PEEK_MS = 2000
const PEEK_AFTER_HOVER_MS = 1000
export const headerPeek = ref(false)
let peekTimer: ReturnType<typeof setTimeout> | null = null
let peekHeld = false
function armPeek(ms: number) {
  if (peekTimer) clearTimeout(peekTimer)
  peekTimer = setTimeout(() => {
    peekTimer = null
    if (!peekHeld) headerPeek.value = false
  }, ms)
}
/** Shows the folded header for a moment; an open one is left as it is. */
export function peekHeader(): void {
  if (headerOpen.value) return
  // A peek starts from a click elsewhere (the sidebar): whatever hover the header last saw is over.
  peekHeld = false
  headerPeek.value = true
  armPeek(PEEK_MS)
}
/** The session's facts arrived: the moment counts from now, so it is not spent on a bar still empty. */
export function restartPeek(): void {
  if (headerPeek.value) armPeek(PEEK_MS)
}
/** The pointer on the peeking header keeps it out (its id can be clicked); leaving gives it a second more. */
export function holdPeek(held: boolean): void {
  peekHeld = held
  if (!held && headerPeek.value) armPeek(PEEK_AFTER_HOVER_MS)
}
// Unfolded for real, the peek is over; folded again later, it stays folded.
watch(headerOpen, (open) => {
  if (!open) return
  headerPeek.value = false
  if (peekTimer) clearTimeout(peekTimer)
  peekTimer = null
})

export const displayPrefs = ref<DisplayPrefs>(readDisplay())
watch(displayPrefs, (v) => storage?.setItem(DISPLAY_KEY, JSON.stringify(v)), { deep: true })
