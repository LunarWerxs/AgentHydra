// The new-session env pills (folder, branch, Add another folder) as measured on
// new-session-tip-and-composer.png: h24, r6, #ffffff1a on the page, padding 6, 16px glyph, gap 6, 13px #c3c2b7.
export const ENV_PILL =
  'flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-1.5 text-[13px] leading-[19px] text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

/** A pill that does something: hover and open states like the real buttons (60ms paint). */
export const ENV_PILL_BUTTON = `${ENV_PILL} transition-colors duration-[60ms] hover:bg-[var(--fill-secondary-hover)] hover:text-text data-[state=open]:bg-[var(--fill-secondary-hover)]`

/** The pill text sits 1.5px higher than centred: our fallback font's caps are a pixel shorter than the real. */
export const PILL_TEXT = 'relative -top-[1.5px]'
