// The measured menu look (DESIGN.md "Menus"), as class overrides for the ui/ menu primitives.
import { shortcutItem, type RowMenuEntry } from './logic'

export const MENU_CONTENT =
  'min-w-32 max-w-80 rounded-[var(--radius-10)] bg-bg-popover p-1 shadow-(--shadow-menu-ringed) ring-0'
export const MENU_ITEM =
  'h-6 min-h-0 cursor-default gap-1.5 rounded-[var(--radius-6)] px-2 py-0 text-[13px] leading-[19px] text-text [&_svg:not([class*=size-])]:size-4'
export const MENU_SEPARATOR = 'mx-2 my-1 h-px bg-border'
export const MENU_SHORTCUT = 'ms-auto pl-4 text-[13px] tracking-normal text-text-shortcut tnum'

const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * The row menu's letter hints: the key runs its item. Listened to in the capture phase, before the
 * menu's own type-to-find, and run by clicking the item so the menu closes as it does on a click.
 * Only for keys typed in the menu itself: the submenus (Move to group, Open in, Account) render inside
 * it without a portal, and an "a" typed there is their type-to-find, not Archive. A text field keeps
 * its letters too.
 */
export function runShortcut(e: KeyboardEvent, entries: RowMenuEntry[]): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const root = e.currentTarget as HTMLElement | null
  const from = e.target as Element | null
  if (!root || !from || typeof from.closest !== 'function') return
  if (from.closest('[role="menu"]') !== root || from.closest(TEXT_FIELD)) return
  const item = shortcutItem(entries, e.key)
  const el = item ? root.querySelector<HTMLElement>(`[data-shortcut="${item.shortcut}"]`) : null
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  el.click()
}

/** The real menus open with their first item highlighted, by mouse as well as by keyboard. */
export function focusFirstItem(e: Event): void {
  const menu = e.target instanceof HTMLElement ? e.target : null
  const first = menu?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
  if (!first) return
  e.preventDefault()
  first.focus()
}
