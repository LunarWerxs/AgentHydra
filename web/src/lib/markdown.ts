// web/src/lib/markdown.ts — render a transcript message as markdown, safely.
//
// TRANSCRIPT CONTENT IS UNTRUSTED. It is whatever a model wrote, whatever a tool printed, and
// whatever a web page a tool fetched happened to contain. Rendering it as HTML is a real XSS
// surface, and it is reached by simply opening a session.
//
// THE SAFETY PROPERTY IS "ESCAPE FIRST", and it is worth stating exactly, because it is what makes
// the rest of this file boring: the source text is HTML-escaped ONCE, up front, before any markdown
// is interpreted. Every tag in the output is therefore one this file wrote. There is no path where
// a "<" from the transcript becomes a "<" in the output, so there is no sanitiser to configure, no
// allowlist to keep in step with a parser, and no gap between what the parser accepts and what the
// sanitiser strips, which is where sanitiser bypasses live. A model that writes a script tag gets a
// visible script tag on screen, which is also what a reader wants to see.
//
// The one place a URL reaches an attribute is a link, and only http/https/mailto/in-page targets
// survive; anything else renders as plain text rather than a live javascript: href.
//
// WHY NOT A LIBRARY. Measured across 150 real transcripts: 682 fenced code blocks, of which 57%
// carry no language tag at all, and five families (JS/TS, Python, JSON, shell, plus untagged) cover
// 99%. A markdown library plus a sanitiser plus a highlighter shipping dozens of grammars would be
// three dependencies and about a megabyte to serve a corpus that narrow. See lib/highlight.ts.

import { highlight, type Language, normalizeLanguage } from './highlight'

/** The one and only place raw transcript text becomes HTML-safe. Runs before anything else. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Schemes a link may use. Anything else (javascript:, data:, vbscript:, a scheme-relative //host)
 * is refused and the link renders as its label alone.
 *
 * Whitespace and control characters are stripped before the test, because "java\tscript:" is the
 * classic bypass of a naive prefix check.
 */
const SAFE_URL = /^(https?:\/\/|mailto:|#|\/(?!\/))/i
function safeHref(raw: string): string | null {
  // Everything at or below the space character goes, tabs and newlines included. Done by code
  // point rather than a regex range: the range needs literal control characters in the source,
  // which is unreadable and exactly what a lint rule should object to.
  const cleaned = [...raw].filter((c) => (c.codePointAt(0) ?? 0) > 0x20).join('')
  return SAFE_URL.test(cleaned) ? cleaned : null
}

/**
 * Inline markup, applied to text that is ALREADY escaped.
 *
 * One left-to-right pass with a single alternation, rather than a chain of replaces. That ordering
 * is what makes a code span opaque: it matches first, so asterisks and brackets inside `like this`
 * are never re-read as emphasis or as a link, with no placeholder substitution needed to protect
 * them.
 */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]*)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~/g

function inline(escaped: string): string {
  let out = ''
  let last = 0
  for (const m of escaped.matchAll(INLINE)) {
    const at = m.index ?? 0
    out += escaped.slice(last, at)
    if (m[1] !== undefined) out += `<code class="md-code">${m[1]}</code>`
    else if (m[2] !== undefined) {
      const href = safeHref(m[3] ?? '')
      out += href
        ? `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer nofollow">${m[2]}</a>`
        : m[2]
    } else if (m[4] !== undefined) out += `<strong>${m[4]}</strong>`
    else if (m[5] !== undefined) out += `<em>${m[5]}</em>`
    else if (m[6] !== undefined) out += `<del>${m[6]}</del>`
    last = at + m[0].length
  }
  return out + escaped.slice(last)
}

/** Render one fenced block: a language chip plus highlighted, already-escaped code. */
function renderFence(label: string, lang: Language, code: string): string {
  const chip = label ? `<span class="md-lang">${escapeHtml(label)}</span>` : ''
  return `<pre class="md-pre">${chip}<code class="md-block">${highlight(code, lang)}</code></pre>`
}

/**
 * Render a message body as HTML.
 *
 * Supports the subset that actually appears in transcripts: fenced code, ATX headings, unordered
 * and ordered lists, blockquotes, horizontal rules, and the inline set above. Anything else stays
 * as its own literal text, which for a transcript is the honest outcome: this is a reading surface,
 * not a document authoring tool.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split('\n')
  const out: string[] = []

  let listKind: 'ul' | 'ol' | null = null
  let quoting = false
  let paragraph: string[] = []

  const closeList = () => {
    if (listKind) {
      out.push(`</${listKind}>`)
      listKind = null
    }
  }
  const closeQuote = () => {
    if (quoting) {
      out.push('</blockquote>')
      quoting = false
    }
  }
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join('\n'))}</p>`)
      paragraph = []
    }
  }
  const closeAll = () => {
    flushParagraph()
    closeList()
    closeQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      closeAll()
      const label = fence[1] ?? ''
      const body: string[] = []
      i++
      // An unterminated fence (a truncated transcript, a message still streaming) renders as a code
      // block to the end rather than swallowing the rest of the message into nothing.
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      out.push(renderFence(label, normalizeLanguage(label), body.join('\n')))
      continue
    }

    if (!line.trim()) {
      closeAll()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeAll()
      const level = (heading[1] ?? '#').length
      out.push(`<h${level} class="md-h">${inline(heading[2] ?? '')}</h${level}>`)
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeAll()
      out.push('<hr class="md-hr" />')
      continue
    }

    // '>' is already escaped by this point, so a blockquote marker reads as &gt;
    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      closeList()
      if (!quoting) {
        out.push('<blockquote class="md-quote">')
        quoting = true
      }
      out.push(`<p>${inline(quote[1] ?? '')}</p>`)
      continue
    }
    closeQuote()

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const kind = bullet ? 'ul' : 'ol'
      if (listKind !== kind) {
        closeList()
        out.push(`<${kind} class="md-list">`)
        listKind = kind
      }
      out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? '')}</li>`)
      continue
    }
    closeList()

    paragraph.push(line)
  }

  closeAll()
  return out.join('')
}

/** Cheap test for whether rendering would change anything, so plain prose keeps its plain path. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)|\*\*|`[^`\n]+`|\[[^\]\n]*\]\(/.test(text)
}
