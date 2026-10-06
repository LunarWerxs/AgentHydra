// The servers pane's class strings, shared by the pane and its saved-browsers view.
import type { Dot } from './logic'

export const DOT: Record<Dot, string> = {
  run: 'bg-[var(--success)]',
  wait: 'bg-[var(--warning)] animate-pulse',
  bad: 'bg-[var(--danger)]',
  off: 'bg-[var(--text-muted)] opacity-50'
}
export const ICON_BTN =
  'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
export const TEXT_BTN =
  'flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-[var(--text)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'
export const INPUT =
  'h-6 min-w-0 flex-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none'
const TAB =
  'flex h-6 shrink-0 cursor-default items-center gap-1 rounded-[var(--radius-6)] px-2 transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none'
export const tab = (on: boolean) => [TAB, on ? 'bg-[var(--fill-selected)] font-medium text-[var(--text)]' : 'text-[var(--text-2)] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]']
