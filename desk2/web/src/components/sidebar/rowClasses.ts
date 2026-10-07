import type { StatusGlyph } from './logic'

// The sidebar list's measured row and header look, as class strings, so every list drawn in it (the cloud list, the
// Dev servers list) has the same row height, padding, type and hover.
export const LIST_ROW =
  'group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none'
export const LIST_HEADER = 'group/head flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-3 text-[12px] leading-4 text-text-muted'
export const HEADER_BTN = 'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text'

/** A row's title colour when its dot says it is closed or stale: muted, unless the row is selected. Every row kind uses it. */
export function dimText(glyph: Pick<StatusGlyph, 'dim'> | undefined, selected: boolean): string {
  return glyph?.dim && !selected ? 'text-text-muted' : ''
}
