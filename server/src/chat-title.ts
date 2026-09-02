// server/src/chat-title.ts -
// the naming REQUIREMENT. A chat must never end a move with a generic name, so every surface
// that lands a chat somewhere demands a title decision from its caller: supply a real new
// name, or explicitly confirm the existing one - and confirming means restating it exactly,
// which is only possible after actually reading it. (Owner directive, verbatim gist: "it just
// requires you to put the name in, so the AI every time pretty much has to either put a new
// name in or accept the existing name, in which case it had to review programmatically.")
//
// ONE definition of "generic": these patterns used to live as module-locals in
// session-launch.ts's title janitor; they are owned here now so the janitor, the routes and
// any future surface cannot drift apart on what counts as a non-name.

/** Titles the desktop app manufactures when nothing named the chat - never acceptable. */
export const GENERIC_CHAT_TITLE = /^(untitled|general coding session|new (chat|session))$/i
/** A retired seed-preamble marker - replaceable, never writable. */
export const PLUMBING_CHAT_TITLE = /^\[plumbing\]/i

const MAX_TITLE_LEN = 200

/** The form the generic patterns match against: zero-width/soft-hyphen characters stripped and
 *  whitespace collapsed, so 'Untitled\u200b' and 'new  chat' cannot slip past an exact-match
 *  regex while looking generic on screen (review-confirmed hole in the first cut). */
function canonicalForMatch(title: string): string {
  return title
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isGenericChatTitle(title: string | null | undefined): boolean {
  const t = canonicalForMatch(title ?? '')
  return t.length === 0 || GENERIC_CHAT_TITLE.test(t) || PLUMBING_CHAT_TITLE.test(t)
}

export type TitleResolution = { ok: true; title: string } | { ok: false; error: string }

/**
 * The AUTOMATED landing paths' title resolution (queue imports, monitor landings): no AI is in
 * the loop to decide a name, so it is derived deterministically - the stored row title, else
 * the session list's title for the thread - and null means NO real name exists and the landing
 * must fail honestly rather than produce an Untitled chat. One definition (consolidation pass,
 * 2026-08-29): dispatch.ts and monitor.ts each grew this chain within hours of each other.
 */
export async function resolveAutomatedTitle(
  sessionId: string,
  rowTitle: string | null,
): Promise<string | null> {
  if (rowTitle !== null && !isGenericChatTitle(rowTitle)) return rowTitle.trim()
  try {
    const { getSession } = await import('./sessions')
    const listed = (await getSession(sessionId, 'claude'))?.title ?? null
    if (listed !== null && !isGenericChatTitle(listed)) return listed.trim()
  } catch {
    // fall through - no real name
  }
  return null
}

/**
 * The route-level contract. Exactly one of two doors:
 *   - `title`: a real new name (non-empty, not generic, not plumbing, <= 200 chars).
 *   - `confirmTitle`: the caller restates the chat's CURRENT title exactly (trimmed), which is
 *     accepted only when that current title is itself a real name. A mismatch is refused
 *     WITHOUT echoing the actual title - the caller proves review by reading it themselves
 *     (the dossier answers in one query), not by copying it out of this error.
 */
export function resolveRequiredTitle(opts: {
  title?: unknown
  confirmTitle?: unknown
  currentTitle: string | null
}): TitleResolution {
  const supplied = typeof opts.title === 'string' ? opts.title.trim() : ''
  if (supplied) {
    if (supplied.length > MAX_TITLE_LEN)
      return { ok: false, error: `title too long (max ${MAX_TITLE_LEN} chars)` }
    if (isGenericChatTitle(supplied))
      return {
        ok: false,
        error: `title '${supplied}' is a generic non-name; give the chat a real name`,
      }
    return { ok: true, title: supplied }
  }
  const confirm = typeof opts.confirmTitle === 'string' ? opts.confirmTitle.trim() : ''
  if (confirm) {
    const current = (opts.currentTitle ?? '').trim()
    if (isGenericChatTitle(current))
      return {
        ok: false,
        error: 'the current title is generic; confirming it is not allowed - supply a real title',
      }
    if (confirm !== current)
      return {
        ok: false,
        error:
          'confirm_title does not match the current title - read the chat (the dossier answers in one query) and restate it exactly, or supply a new title',
      }
    return { ok: true, title: current }
  }
  return {
    ok: false,
    error:
      "a title decision is required: pass 'title' (a real new name) or 'confirm_title' (the current title restated exactly, after reviewing it)",
  }
}
