// Class strings the Connections chip menu and the Connections pane share, in the house style of Settings' search box and menus.
export const SEARCH_BOX =
  'flex h-8 w-full shrink-0 items-center gap-2 rounded-[var(--radius-6)] bg-fill-5 px-2 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[var(--focus-ring)]'
export const SEARCH_INPUT = 'min-w-0 flex-1 bg-transparent text-[13px] leading-[19px] text-text outline-none placeholder:text-text-muted'
/** A workspace row in the pane, the height and radius of a menu row; the current one is medium weight on the selected fill. */
export const PANE_ROW = 'flex h-6 w-full cursor-default items-center gap-1.5 rounded-[var(--radius-6)] px-2 text-left text-[13px] leading-[19px] text-text hover:bg-fill-hover data-[current=true]:bg-fill-selected data-[current=true]:font-medium'
