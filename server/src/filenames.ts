// server/src/filenames.ts — build a filesystem-safe download name for a session transcript.
//
// A LEAF module on purpose: pure string logic, zero imports (no bun:sqlite, no node:fs), so the
// web bundle can import it at runtime via the '@agenthydra/server/filenames' export the same way
// it already type-imports '@agenthydra/server/types'. Both the download <a> in the SPA and the
// server's /file Content-Disposition run THIS one function, so the two never disagree — which they
// otherwise would, because the browser honors the <a download> name only for a same-origin fetch
// (prod) and the server's Content-Disposition filename only cross-origin (dev on :5173, or remote).

/** Characters invalid in a Windows filename (also awkward on POSIX). Plain string so no raw
 *  control-char bytes live in this source (mirrors core/shortcut.ts safeShortcutBase). */
const INVALID_FILENAME_CHARS = '<>:"/\\|?*'

/** Windows reserved device names — unusable as a bare leaf even with an extension, case-insensitive. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** Longest leaf we'll emit before the extension — titles are already ~120 chars (sessions.ts
 *  oneLine), and a leaf well under the 255-char filesystem limit leaves room for the browser's
 *  own " (1)" de-duplication suffix on repeat downloads of the same title. */
const MAX_BASE = 120

/**
 * Turn a human session title into a safe file leaf (no extension). Drops filename-invalid and
 * control characters, collapses whitespace, trims trailing dots/spaces (Windows strips those
 * silently), caps the length, and refuses the reserved device names. Returns '' when nothing
 * usable survives — callers supply their own fallback (the session id).
 */
export function safeFileBase(title: string): string {
  const cleaned = Array.from(title)
    .map((ch) => (ch.charCodeAt(0) <= 31 || INVALID_FILENAME_CHARS.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots and spaces from a filename — remove them ourselves so
    // the name the user sees is the name that lands on disk.
    .replace(/[. ]+$/, '')
    .slice(0, MAX_BASE)
    .replace(/[. ]+$/, '') // re-trim in case the slice landed on a dot/space
  if (!cleaned) return ''
  if (WINDOWS_RESERVED.has(cleaned.toLowerCase())) return `_${cleaned}`
  return cleaned
}

/**
 * The full download filename for a session transcript: '<safe title>.jsonl', falling back to the
 * session id when the title has no filesystem-safe characters (an all-emoji or all-symbol title).
 */
export function safeTranscriptFilename(
  title: string | null | undefined,
  sessionId: string,
): string {
  const base = safeFileBase(title ?? '') || sessionId
  return `${base}.jsonl`
}

/**
 * A `Content-Disposition` value that carries BOTH an ASCII-only `filename=` (a legal HTTP header
 * ByteString for every client) and an RFC 5987 `filename*=UTF-8''…` (the exact Unicode name for
 * modern browsers). Interpolating a raw emoji/non-Latin1 title straight into the header throws in
 * Bun/undici's Headers (values must be a valid ByteString) — that would turn a cosmetic naming
 * bug into a 500 on the /file route, so the ASCII copy is transliterated to '?'-free safety and
 * any quote/backslash is escaped out of the quoted-string form.
 */
export function contentDispositionAttachment(filename: string): string {
  // ASCII fallback: replace any non-ASCII byte and strip quotes/backslashes that would break the
  // quoted-string. Guaranteed a valid header ByteString.
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
