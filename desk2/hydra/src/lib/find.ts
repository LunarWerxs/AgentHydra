// web/src/lib/find.ts — find-within-the-open-session, over HTML we generated ourselves.
//
// THE PROBLEM. A transcript message is rendered as HTML (lib/markdown.ts), so a naive
// `html.replace(query, …)` would happily match inside a tag name, a class attribute or an href, and
// splice a <mark> into the middle of a tag. It would also miss the thing a reader typed: a message
// containing `a & b` is the string `a &amp; b` by the time it is HTML, so searching for "&" finds
// nothing and searching for "amp" finds a hit that is not on screen.
//
// THE APPROACH. Split the HTML into tag spans and text spans, and only ever touch the text. Within
// a text span, decode our own escaping to get what the reader actually sees, search THAT, and map
// the match back to offsets in the escaped source. The <mark> therefore wraps the original escaped
// slice, so the escaping guarantee from lib/markdown.ts survives untouched: this file never
// unescapes anything into the output and never inserts a tag that is not <mark>.
//
// The decode table is closed and small because the input is not arbitrary HTML — it is exactly what
// escapeHtml() produces, which is these five entities and nothing else.
//
// No DOM is used. A DOMParser round-trip would work in the browser but would make this untestable
// under `bun test`, and the string form is what the tests below pin.

/** Exactly the entities escapeHtml() emits, longest-first is unnecessary (no shared prefixes). */
const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
]

/**
 * Lower-case without changing length.
 *
 * `'İ'.toLowerCase()` is two code units, and one such character anywhere in a message would shift
 * every match offset after it. Folding per code point and keeping any character whose lower-case
 * form is a different length keeps the index arithmetic exact; the cost is that those few
 * characters only match case-sensitively, which is the right way to be wrong here.
 */
function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/**
 * Decode one escaped text span.
 *
 * Returns the visible text plus, for each visible character, its offset in the escaped source
 * (`map[i]`), with one extra entry so `map[text.length]` is the source end. That is what lets a
 * match found in the visible text be cut back out of the source exactly.
 */
function decode(span: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  let i = 0
  outer: while (i < span.length) {
    if (span[i] === '&') {
      for (const [entity, char] of ENTITIES) {
        if (span.startsWith(entity, i)) {
          map.push(i)
          text += char
          i += entity.length
          continue outer
        }
      }
    }
    map.push(i)
    text += span[i]
    i++
  }
  map.push(span.length)
  return { text, map }
}

export interface HighlightResult {
  html: string
  /** How many matches were wrapped. The caller adds this to its running total. */
  count: number
}

/**
 * Wrap every case-insensitive occurrence of `query` in `<mark>`.
 *
 * `offset` is the number of matches already found in earlier messages: each mark is stamped with
 * its global index (`data-find`), which is what next/previous navigates by. `active` gets an extra
 * class so the current hit is distinguishable from the rest.
 *
 * `html` must be output from lib/markdown.ts or escapeHtml() — not arbitrary HTML from elsewhere.
 */
export function highlightHtml(
  html: string,
  query: string,
  offset = 0,
  active = -1,
): HighlightResult {
  const needle = fold(query)
  if (!needle) return { html, count: 0 }

  let out = ''
  let count = 0
  let cursor = 0

  const emit = (span: string) => {
    const { text, map } = decode(span)
    const hay = fold(text)
    let from = 0
    let at = hay.indexOf(needle)
    if (at === -1) {
      out += span
      return
    }
    while (at !== -1) {
      const index = offset + count
      out += span.slice(map[from], map[at])
      const cls = index === active ? 'find-hit find-hit-active' : 'find-hit'
      out += `<mark class="${cls}" data-find="${index}">${span.slice(map[at], map[at + needle.length])}</mark>`
      count++
      from = at + needle.length
      at = hay.indexOf(needle, from)
    }
    out += span.slice(map[from])
  }

  // A tag is `<` … `>` with no `>` inside; true of everything lib/markdown.ts writes, and any `>`
  // in the CONTENT is `&gt;` by then, so this cannot mistake text for a tag.
  const TAG = /<[^>]*>/g
  let m = TAG.exec(html)
  while (m) {
    if (m.index > cursor) emit(html.slice(cursor, m.index))
    out += m[0]
    cursor = m.index + m[0].length
    m = TAG.exec(html)
  }
  if (cursor < html.length) emit(html.slice(cursor))

  return { html: out, count }
}
