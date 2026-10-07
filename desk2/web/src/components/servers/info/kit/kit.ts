// The info pane's look (owner, 2026-10-07: "a nice, like, card display" with "charts or stats", never tables): the
// class strings its cards, buttons and fields share, in the window's tokens (Settings' buttons and fields, the
// servers pane's tabs). Each view of the pane builds from these and the components beside this file.

/** A card: the panel fill one step above the page, a hairline ring, a 10px radius. */
export const CARD = 'rounded-[var(--radius-10)] bg-bg-panel shadow-[inset_0_0_0_1px_var(--border)]'
/** A card's small heading: Connections' and Settings' uppercase label. */
export const EYEBROW = 'text-[11px] font-medium uppercase leading-4 tracking-wide text-text-muted'
/** A section's heading above a card or a group of cards. */
export const SECTION_TITLE = 'text-[13px] font-medium leading-5 text-text'

// A button is its shape, one size and one look; the sizes and looks never repeat a property, so no class string has
// to be overridden by another (two heights or two inks on one element resolve by stylesheet order, not by intent).
const BTN_SHAPE =
  'inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-[var(--radius-6)] transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45'
const MD = 'h-7 px-2.5 text-[13px] leading-[19px]'
/** The small size, for a card's row or an inline confirm. */
const SM = 'h-6 px-2 text-[12px] leading-4'
const PRIMARY = 'bg-accent font-medium text-white hover:bg-accent-hover'
const PLAIN = 'bg-[var(--fill-secondary)] text-text hover:bg-[var(--fill-secondary-hover)]'
const GHOST = 'text-text-2 hover:bg-fill-hover hover:text-text'
const DANGER = 'bg-danger-bg text-danger-text hover:bg-[color-mix(in_srgb,var(--danger)_28%,transparent)]'
/** The one main action of a view (Start, Save, Add): the accent fill. */
export const BTN_PRIMARY = `${BTN_SHAPE} ${MD} ${PRIMARY}`
/** An ordinary action: Settings' button fill. */
export const BTN = `${BTN_SHAPE} ${MD} ${PLAIN}`
/** A quiet action (Cancel, Show more): no fill until hovered. */
export const BTN_GHOST = `${BTN_SHAPE} ${MD} ${GHOST}`
/** A destructive action. */
export const BTN_DANGER = `${BTN_SHAPE} ${MD} ${DANGER}`
export const BTN_SM = `${BTN_SHAPE} ${SM} ${PLAIN}`
export const BTN_GHOST_SM = `${BTN_SHAPE} ${SM} ${GHOST}`
export const BTN_DANGER_SM = `${BTN_SHAPE} ${SM} ${DANGER}`

const ICON_SHAPE =
  'inline-flex shrink-0 cursor-default items-center justify-center rounded-[var(--radius-6)] transition-colors duration-[60ms] hover:bg-fill-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45'
/** A small square icon button (edit, remove, copy). */
export const ICON_BTN = `${ICON_SHAPE} size-7 text-text-2 hover:text-text`
/** An icon button that is on (Follow new lines): the selected fill and full ink. */
export const ICON_BTN_ON = `${ICON_SHAPE} size-7 bg-fill-selected text-text`
/** A smaller icon button, for a row or a chip. */
export const ICON_BTN_SM = `${ICON_SHAPE} size-6 text-text-muted hover:text-text`
/** The smaller icon button of a destructive action (remove): danger ink on hover. */
export const ICON_BTN_SM_DANGER = `${ICON_SHAPE} size-6 text-text-muted hover:text-danger-text`

const FIELD_SHAPE =
  'h-8 w-full min-w-0 rounded-[var(--radius-6)] bg-fill-5 px-2.5 text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-shadow duration-[60ms] placeholder:text-text-muted hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus:shadow-[var(--focus-ring)] disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]'
/** A text field: Settings' field, one size up so a form breathes. */
export const INPUT = `${FIELD_SHAPE} text-[13px] leading-[19px]`
/** A monospace text field (commands, paths, ids, env): never INPUT plus MONO, which would set two font sizes. */
export const INPUT_MONO = `${FIELD_SHAPE} font-mono text-[12px] leading-[19px]`
/** The same as a native select. */
export const SELECT = `${INPUT} cursor-default appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='12'%20height='12'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%23898781'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='m6%209%206%206%206-6'/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7`
/** A monospace field (commands, paths, ids, env). */
export const MONO = 'font-mono text-[12px]'

const CHIP_SHAPE = 'inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-[var(--radius-5)] px-1.5 text-[11px] leading-4'
/** A chip: a small rounded label on the fill (owner, project, framework). */
export const CHIP = `${CHIP_SHAPE} bg-fill-5 text-text-2 shadow-[inset_0_0_0_1px_var(--border)]`

/** A tone's tinted fill, its ink and its dot: success (running), warning (waiting, firing), danger (crashed, errors), accent, neutral. */
export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral'
export const TONE_BG: Record<Tone, string> = {
  success: 'bg-success-bg text-success-text',
  warning: 'bg-warning-bg text-warning-text',
  danger: 'bg-danger-bg text-danger-text',
  accent: 'bg-accent-bg text-accent-text',
  neutral: 'bg-fill-5 text-text-2'
}
/** A chip in a tone's tint (Firing, Crashed, 3 of 3 running); the neutral one is CHIP. */
export const chip = (tone: Tone): string => (tone === 'neutral' ? CHIP : `${CHIP_SHAPE} ${TONE_BG[tone]}`)
export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  accent: 'text-accent-text',
  neutral: 'text-text-2'
}
/** A chart's line in each tone, as a CSS color. */
export const TONE_COLOR: Record<Tone, string> = {
  success: 'var(--success-text)',
  warning: 'var(--warning)',
  danger: 'var(--danger-text)',
  accent: 'var(--accent-text)',
  neutral: 'var(--text-2)'
}

/** The pane's tabs: the servers pane's tab look, one size up. */
export const tabClass = (on: boolean): string[] => [
  'inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-[var(--radius-6)] px-2.5 text-[13px] leading-[19px] transition-colors duration-[60ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none',
  on ? 'bg-fill-selected font-medium text-text' : 'text-text-2 hover:bg-fill-hover hover:text-text'
]

/** A server's or project's color choices (ColorPicker), DevWebUI's eight. */
export const SWATCHES = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#14b8a6']

/** A chart's point (Sparkline): a moment and its value, null where nothing was measured. */
export interface ChartPoint {
  t: number
  v: number | null
}
