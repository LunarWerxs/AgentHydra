// web/src/composables/useShortcuts.ts — one keyboard layer, and a way to find out what is on it.
//
// Before this, key handling was per-component and undiscoverable: a binding existed only where it
// was written, nothing listed them, and two views could claim the same chord without either author
// noticing. A shortcut nobody can find is barely a feature, which is why the registry and the `?`
// sheet are the same mechanism — the sheet is generated from what is actually bound, so it cannot
// drift out of date the way a hand-written help page does.
//
// TYPING BEATS SHORTCUTS. A bare-letter binding must never fire while the caret is in a text field,
// or `?` becomes impossible to type into the search box. Modified chords (Ctrl/Cmd) are allowed
// through, because that is what makes Ctrl+F work while the find bar itself has focus.
//
// SCOPE IS DECLARED, NOT INFERRED. A binding registered by a component unregisters when that
// component unmounts, so "find in session" simply does not exist while the Instances tab is open,
// and does not appear in the sheet either. The alternative — one global table with `if (view ===
// …)` guards — is how a sheet starts lying about what is available.

import { onBeforeUnmount, type Ref, ref } from 'vue'

export interface Shortcut {
  /** Canonical form: `mod+f`, `?`, `escape`. `mod` is Ctrl on Windows/Linux, Cmd on macOS. */
  keys: string
  /** i18n key for the human description. The sheet renders this, so it is never free text. */
  labelKey: string
  /** Which group the sheet lists it under, as an i18n key. */
  groupKey: string
  run: () => void
}

const registry = ref<Shortcut[]>([])
const sheetOpen = ref(false)

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

/** How a chord is written for display: ⌘ on a Mac, Ctrl elsewhere. */
export function displayKeys(keys: string): string {
  return keys
    .split('+')
    .map((part) => {
      if (part === 'mod') return IS_MAC ? '⌘' : 'Ctrl'
      if (part === 'shift') return IS_MAC ? '⇧' : 'Shift'
      if (part === 'escape') return 'Esc'
      return part.length === 1 ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1)
    })
    .join(IS_MAC ? '' : '+')
}

/** The chord this event represents, in the same canonical form the registry uses. */
function chordOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  // Shift is only part of the chord when the key is not itself shift-produced: `?` IS shift+/, and
  // writing it as "shift+/" would be an implementation detail leaking into the sheet.
  if (e.shiftKey && e.key.length > 1) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** An open dialog, popover or menu: while one is up, the keyboard is its own. The settings and queue
 *  side panels (data-slot=sidebar) are dialogs too, but they sit beside the page, not over it. */
const OVERLAY_OPEN =
  '[role=dialog][data-state=open]:not([data-slot=sidebar]), [role=alertdialog][data-state=open], [role=menu][data-state=open]'

let installed = false
function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', (e) => {
    // The page's shortcuts stand down under an overlay. Escape is the one that bit: the Sessions
    // page's Escape ran first and called preventDefault, and reka closes a dialog on Escape only
    // when nothing prevented it, so no dialog on that page closed on Escape (2026-10-02).
    const chord = chordOf(e)
    const hit = registry.value.find((s) => s.keys === chord)
    if (!hit) return
    // An unmodified chord while typing is a character the user meant to type.
    if (isTyping(e.target) && !chord.startsWith('mod+')) return
    if (document.querySelector(OVERLAY_OPEN)) return
    e.preventDefault()
    hit.run()
  })
}

/**
 * Register shortcuts for as long as the calling component is mounted.
 *
 * Call from `setup`. The bindings disappear on unmount, which is what keeps the `?` sheet honest
 * about what is available right now.
 */
export function useShortcuts(shortcuts: Shortcut[]): void {
  install()
  registry.value = [...registry.value, ...shortcuts]
  onBeforeUnmount(() => {
    registry.value = registry.value.filter((s) => !shortcuts.includes(s))
  })
}

/** The live list and the sheet's open state, for whoever renders it. */
export function useShortcutSheet(): {
  shortcuts: Ref<Shortcut[]>
  open: Ref<boolean>
} {
  install()
  return { shortcuts: registry, open: sheetOpen }
}

/** Registered once, by the app shell, so `?` works on every view. */
export function openShortcutSheet(): void {
  sheetOpen.value = true
}
