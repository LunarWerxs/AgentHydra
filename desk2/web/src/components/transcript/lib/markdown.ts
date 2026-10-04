// Markdown for assistant text and plans. Pure: markdown-it only, highlighting passed in.
import MarkdownIt from 'markdown-it'

/** Returns highlighted HTML for a code block (a whole <pre>), or null to fall back to plain text. */
export type Highlight = (code: string, lang: string) => string | null

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A code block longer than this many lines is capped with "Show more", like a long user message. */
export const CODE_CAP_LINES = 24

/** Pictures the server serves from its cache; the only image targets the window loads. */
export const MEDIA_PREFIX = '/api/media/'

// lucide Copy, Check and File (stroke 1.5), inline because markdown-it emits a string, not components.
const svg = (body: string, size = 14) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const COPY_ICON = svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>')
const CHECK_ICON = svg('<path d="M20 6 9 17l-5-5"/>')
const FILE_ICON = svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>')

/** Marks each line of a diff block (+ added, - removed, @@ hunk) on shiki's or the plain block's line spans. */
export function markDiffLines(html: string, code: string): string {
  const lines = code.split('\n')
  let i = 0
  return html.replace(/<span class="line"/g, (m) => {
    const l = lines[i++] ?? ''
    const cls = l.startsWith('+++') || l.startsWith('---') ? '' : l.startsWith('+') ? ' diff-add' : l.startsWith('-') ? ' diff-del' : l.startsWith('@@') ? ' diff-hunk' : ''
    return cls ? `<span class="line${cls}"` : m
  })
}

function plainCode(code: string, lang: string): string {
  if (lang !== 'diff' && lang !== 'patch') return `<pre><code>${escapeHtml(code)}</code></pre>`
  const body = code
    .split('\n')
    .map((l) => `<span class="line">${escapeHtml(l)}</span>`)
    .join('\n')
  return `<pre><code>${markDiffLines(body, code)}</code></pre>`
}

const fileName = (src: string) => {
  let s = src
  try {
    s = decodeURIComponent(src)
  } catch {
    // keep it encoded
  }
  return s.split(/[\\/]/).pop() || s
}

export function createMarkdown(getHighlight: () => Highlight | null = () => null): MarkdownIt {
  // html disabled: model output never injects markup into the window.
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const t = tokens[idx]
    t.attrSet('target', '_blank')
    t.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, idx, options)
  }

  // Claude Code draws a heading one level down ("## What I did" is an h3, 15.75/20.475 600: measured).
  const shift = (tokens: { tag: string }[], idx: number) => {
    const n = Math.min(6, Number(tokens[idx].tag.slice(1)) + 1)
    tokens[idx].tag = `h${n}`
  }
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    shift(tokens, idx)
    return self.renderToken(tokens, idx, options)
  }
  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    shift(tokens, idx)
    return self.renderToken(tokens, idx, options)
  }

  // Tables scroll sideways in their own box instead of widening the column.
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) => `<div class="md-table">${self.renderToken(tokens, idx, options)}`
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) => `${self.renderToken(tokens, idx, options)}</div>`

  // A picture from the server's cache opens in the lightbox; any other target (a local path the
  // transcript never named, a remote URL) is a file chip and is never loaded.
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx]
    const src = t.attrGet('src') ?? ''
    const alt = t.content || fileName(src)
    if (src.startsWith(MEDIA_PREFIX) && /^\/api\/media\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(src)) {
      return `<button type="button" class="md-img" data-zoom="${escapeHtml(src)}" aria-label="Open ${escapeHtml(alt)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"></button>`
    }
    return `<span class="md-file-chip" title="${escapeHtml(fileName(src))}">${FILE_ICON}<span>${escapeHtml(alt)}</span></span>`
  }

  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx]
    const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase()
    const code = t.content.replace(/\n$/, '')
    const hl = getHighlight()
    const highlighted = hl && lang ? hl(code, lang) : null
    const body = highlighted ? (lang === 'diff' || lang === 'patch' ? markDiffLines(highlighted, code) : highlighted) : plainCode(code, lang)
    const long = code.split('\n').length > CODE_CAP_LINES
    return (
      `<div class="md-code${long ? ' md-code-long' : ''}">` +
      `<div class="md-code-head"><span class="md-code-lang">${escapeHtml(lang || 'text')}</span>` +
      `<button type="button" class="md-copy" data-copy aria-label="Copy">` +
      `<span class="md-copy-idle">${COPY_ICON}Copy</span><span class="md-copy-done">${CHECK_ICON}Copied</span></button></div>` +
      `<div class="md-code-body">${body}</div>` +
      (long ? `<button type="button" class="md-code-more" data-more aria-expanded="false">Show more</button>` : '') +
      `</div>`
    )
  }
  md.renderer.rules.code_block = md.renderer.rules.fence

  return md
}

/** Plain-markdown instance for tests and callers without highlighting. */
export const plainMarkdown = createMarkdown()

export function renderMarkdown(text: string, md: MarkdownIt = plainMarkdown): string {
  return md.render(text)
}
