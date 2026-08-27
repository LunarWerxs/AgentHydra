// web/src/lib/highlight.ts — colour the code blocks that actually appear in transcripts.
//
// SCOPE COMES FROM A CENSUS, NOT A GUESS. Across 150 real transcripts there were 682 fenced code
// blocks:
//
//     (no language tag) ... 57%      json ....  6%
//     python .............. 11%      rust/sql/yaml/go/... under 1% each
//     typescript + ts ..... 14%      shell (bash + sh) ...  8%
//     javascript .......... 2%
//
// Five families cover 99%, and the single largest group has no language at all, so most blocks need
// a monospace treatment rather than colour. That is why there is no grammar library here: shipping
// dozens of grammars to serve this distribution is most of a megabyte for the 1% tail, and every
// one of those grammars would also need auditing, because the input is untrusted.
//
// UNTRUSTED INPUT, SAME RULE AS THE RENDERER. Everything here operates on text that markdown.ts has
// ALREADY HTML-escaped, and it only ever wraps spans around slices of it. Nothing is unescaped and
// no new markup can originate from the code being highlighted. The tokenizer therefore cannot
// introduce an injection even if its patterns are wrong; a bad pattern makes a keyword the wrong
// colour, not a script tag.
//
// An unrecognised language falls through to `plain`, which returns the text untouched. Wrong-looking
// colour is worse than no colour, so a guess is never made.

export type Language = 'js' | 'python' | 'json' | 'shell' | 'plain'

const LANGUAGE_BY_LABEL: Record<string, Language> = {
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  py: 'python',
  python: 'python',
  json: 'json',
  jsonc: 'json',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
}

/** Map a fence's label onto one of the families we actually support. */
export function normalizeLanguage(label: string): Language {
  return LANGUAGE_BY_LABEL[label.trim().toLowerCase()] ?? 'plain'
}

const KEYWORDS: Record<Exclude<Language, 'plain' | 'json'>, Set<string>> = {
  js: new Set(
    'as async await break case catch class const continue default delete do else export extends finally for from function if implements import in instanceof interface let new of return satisfies static switch this throw try type typeof var void while yield true false null undefined'.split(
      ' ',
    ),
  ),
  python: new Set(
    'and as assert async await break class continue def del elif else except finally for from global if import in is lambda none nonlocal not or pass raise return try while with yield True False None self'.split(
      ' ',
    ),
  ),
  shell: new Set(
    'if then else elif fi for while do done case esac function return export local source echo cd set unset trap exit'.split(
      ' ',
    ),
  ),
}

const span = (cls: string, text: string) => `<span class="hl-${cls}">${text}</span>`

/**
 * One tokenizer, parameterised by the few things that differ between these families: what starts a
 * comment, and which quote characters open a string. Handling them in a single left-to-right pass
 * is what keeps a "#" inside a string from being read as a comment, and a keyword inside a comment
 * from being coloured as code.
 */
interface Grammar {
  lineComment: string[]
  quotes: string[]
  keywords: Set<string> | null
}

const GRAMMARS: Record<Exclude<Language, 'plain'>, Grammar> = {
  js: { lineComment: ['//'], quotes: ['"', "'", '`'], keywords: KEYWORDS.js },
  python: { lineComment: ['#'], quotes: ['"', "'"], keywords: KEYWORDS.python },
  shell: { lineComment: ['#'], quotes: ['"', "'"], keywords: KEYWORDS.shell },
  json: { lineComment: [], quotes: ['"'], keywords: null },
}

// Escaped source means a quote is the 6-character entity &#39; or &quot;, not one character. The
// tokenizer walks the escaped text, so it has to recognise them in that form.
const ENTITY: Record<string, string> = { '"': '&quot;', "'": '&#39;' }
const openerAt = (src: string, i: number, quotes: string[]): string | null => {
  for (const q of quotes) {
    const token = ENTITY[q] ?? q
    if (src.startsWith(token, i)) return token
  }
  return null
}

const WORD_START = /[A-Za-z_$]/
const WORD_CHAR = /[A-Za-z0-9_$]/

/** Index where a quoted string that opened at `i` (with `opener` already matched there) ends. */
function stringEnd(src: string, i: number, opener: string): number {
  let j = i + opener.length
  while (j < src.length) {
    if (src[j] === '\n') break
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src.startsWith(opener, j)) {
      j += opener.length
      break
    }
    j++
  }
  return Math.min(j, src.length)
}

/** Index just past the identifier that starts at `i`. */
function identifierEnd(src: string, i: number): number {
  let j = i
  while (j < src.length && WORD_CHAR.test(src[j] ?? '')) j++
  return j
}

/**
 * Highlight already-escaped code.
 *
 * Returns HTML built only from the input's own slices wrapped in spans this file writes, so the
 * escaping guarantee established in markdown.ts carries through unchanged.
 */
export function highlight(escapedCode: string, lang: Language): string {
  if (lang === 'plain') return escapedCode
  const g = GRAMMARS[lang]
  let out = ''
  let i = 0

  while (i < escapedCode.length) {
    const rest = escapedCode.slice(i)

    // line comment, to end of line
    const comment = g.lineComment.find((c) => rest.startsWith(c))
    if (comment) {
      const end = escapedCode.indexOf('\n', i)
      const stop = end === -1 ? escapedCode.length : end
      out += span('comment', escapedCode.slice(i, stop))
      i = stop
      continue
    }

    // string, to its matching closer (or end of line, so an unterminated quote cannot swallow the
    // rest of the block)
    const opener = openerAt(escapedCode, i, g.quotes)
    if (opener) {
      const stop = stringEnd(escapedCode, i, opener)
      out += span('string', escapedCode.slice(i, stop))
      i = stop
      continue
    }

    // number
    const num = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest)
    if (num && (i === 0 || !WORD_CHAR.test(escapedCode[i - 1] ?? ''))) {
      out += span('number', num[0])
      i += num[0].length
      continue
    }

    // identifier, which may be a keyword
    if (WORD_START.test(escapedCode[i] ?? '')) {
      const j = identifierEnd(escapedCode, i)
      const word = escapedCode.slice(i, j)
      out += g.keywords?.has(word) ? span('keyword', word) : word
      i = j
      continue
    }

    // JSON has no keywords, but its property names are the thing worth seeing; they are already
    // covered by the string rule above, so everything else is punctuation.
    out += escapedCode[i]
    i++
  }
  return out
}
