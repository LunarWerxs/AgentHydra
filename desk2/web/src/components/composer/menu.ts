// Measured menu and toolbar classes (docs/reference/real DESIGN.md "Menus" and "Composer"), shared by
// the composer, its pickers and the effort popover so every menu in the dock looks the same.

/** Menu panel: r10, #20201f, inset ring white 10%, popover shadow, padding 4, 128..320 wide, max-h 480. */
export const MENU =
  'min-w-32 max-w-80 max-h-[480px] rounded-[var(--radius-10)] bg-[var(--bg-popover)] p-1 text-[13px] leading-[19px] text-[var(--text)] shadow-(--shadow-menu-ringed) ring-0'

/** Menu item: h24, r6, px8, py2.5, gap6, 13/19, highlight white 7.5%. */
export const ITEM =
  'min-h-6 gap-1.5 rounded-[var(--radius-6)] px-2 py-[2.5px] text-[13px] leading-[19px] focus:bg-[var(--fill-hover)] data-[initial]:bg-[var(--fill-hover)] [&_svg:not([class*=size-])]:size-4'

/** Submenu trigger: a 16px muted chevron whose stroke ends at the item's padding edge (menu-plus.png at 8x). */
export const SUB_TRIGGER = '[&>svg:last-child]:!size-4 [&>svg:last-child]:-mr-[5px] [&>svg:last-child]:!text-[var(--text-muted)]'

/** Menu glyph: 14px drawn in the 16px slot, strokes about 1.5px like the real glyphs (menu-plus.png at 8x). */
export const MENU_GLYPH = '!size-3.5 mx-px [stroke-width:2.5]'

/** Item with a description line under the label: 40.5px high. */
export const ITEM_TALL = 'h-[40.5px] items-center'

/** Header ("Mode"): 13px/500 muted, 23 high. */
export const HEADER = 'flex h-[23px] items-center px-2 py-1 text-[13px] font-medium text-[var(--text-muted)]'

/** Separator: 1px, inset 8. */
export const SEPARATOR = 'mx-2 my-1 h-px bg-[var(--border)]'

/** Shortcut on the right: 13px tabular-nums #a5a49a. */
export const SHORTCUT = 'tnum ml-auto pl-3 text-[13px] text-[var(--text-shortcut)]'

/** Description under a label: 13px muted. */
export const DESCRIPTION = 'text-[13px] leading-[16.5px] text-[var(--text-muted)]'

const TOOL_TEXT =
  'flex h-5 shrink-0 items-center gap-1 rounded-[var(--radius-5)] px-1.5 text-[12px] leading-[17px] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] data-[state=open]:bg-[var(--fill-hover)] data-[state=open]:text-[var(--text)]'

/** Toolbar text button below the box: h20, r5, px6, 12px #c3c2b7 (the mode). */
export const TOOL_BUTTON = `${TOOL_TEXT} text-[var(--text-2)]`

/** Toolbar value button (model, effort): the same button in #f0efec. */
export const TOOL_VALUE = `${TOOL_TEXT} text-[var(--text)]`

/** Toolbar icon button: 20x20, r5, 16px icon. */
export const TOOL_ICON =
  'flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-5)] text-[var(--text-2)] [&>svg]:[stroke-width:2.5] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] data-[state=open]:bg-[var(--fill-hover)] data-[state=open]:text-[var(--text)] disabled:opacity-50 disabled:hover:bg-transparent'

/** Repo strip button: h24, r6, px5. */
export const STRIP_BUTTON =
  'flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-6)] px-[5px] text-[13px] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)]'
