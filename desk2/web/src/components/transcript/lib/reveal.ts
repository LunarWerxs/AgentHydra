// "Open in Explorer" in the transcript: what a right-click landed on that is a local file, a folder or a
// cached video/picture made from one. Pure text rules here (tested); the element lookup uses only
// closest/getAttribute so it needs no browser.

export const MEDIA_PREFIX = '/api/media/'

/** Extensions a bare file name (no folder) must have to count as a path: `a.length` or `console.log` are not files. */
const BARE_EXT = new Set([
  'md', 'txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'vue', 'css', 'html', 'yml', 'yaml', 'toml', 'py', 'rs', 'go', 'sh', 'ps1', 'bat', 'cmd',
  'cs', 'cpp', 'java', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'webm', 'm4v', 'zip', 'exe', 'lock', 'sql', 'xml',
])

const BAD_CHARS = /[<>|"*?\n\r\t]/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

/**
 * The path a piece of text names, or null when it is not one: a Windows drive path (C:\a\b, C:/a/b, spaces
 * allowed), or a relative path with a folder in it (src/a.ts, ..\out\run.mp4, ./out/) or a bare file name with
 * a known extension (notes.md). Quotes, backticks and a trailing :line are dropped. URLs, network paths,
 * ordinary words and anything with shell punctuation are not paths.
 */
export function pathLike(raw: string): string | null {
  let t = raw.trim().replace(/^["'`<(]+/, '').replace(/["'`>),;.]+$/, '')
  if (!t || t.length > 400 || BAD_CHARS.test(t) || SCHEME.test(t)) return null
  t = t.replace(/:\d+(?::\d+)?$/, '')
  if (/^[\\/]{2}/.test(t) || /^[\\/]/.test(t)) return null
  if (/^[A-Za-z]:[\\/]/.test(t)) return t.includes(':', 2) ? null : t
  if (/\s/.test(t) || t.includes(':')) return null
  const segments = t.split(/[\\/]/)
  const last = segments[segments.length - 1]!
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(last)?.[1]?.toLowerCase()
  if (segments.length === 1) return ext && BARE_EXT.has(ext) && /^[\w.@~+-]+$/.test(last) ? t : null
  if (!segments.every((s, i) => /^(?:[\w.@~+-]+)$/.test(s) || (i === segments.length - 1 && s === ''))) return null
  if (/^\.{1,2}[\\/]/.test(t) || last === '' || ext) return t
  return null
}

/** What a right-click can open: a path (absolute, or relative to the chat's folder) and/or a cached /api/media/ file. */
export interface RevealTarget {
  /** A cached picture or video: the server knows its source file. */
  media: string | null
  /** The file or folder path as written (absolute, or relative to the chat folder). */
  path: string | null
}

interface El {
  closest(selector: string): El | null
  getAttribute(name: string): string | null
  textContent: string | null
}

const MEDIA_SELECTOR = `video[src^="${MEDIA_PREFIX}"], img[src^="${MEDIA_PREFIX}"], [data-zoom^="${MEDIA_PREFIX}"]`

/** The thing a right-click on `el` can open in Explorer, or null (everything else keeps the WebView's menu). */
export function revealTarget(el: El | null): RevealTarget | null {
  if (!el || typeof el.closest !== 'function') return null
  const known = el.closest('[data-reveal-path], [data-reveal-media]')
  if (known) {
    const path = known.getAttribute('data-reveal-path')
    const media = known.getAttribute('data-reveal-media')
    if (path || media) return { media: media || null, path: path || null }
  }
  const m = el.closest(MEDIA_SELECTOR)
  if (m) {
    const url = m.getAttribute('src') ?? m.getAttribute('data-zoom') ?? ''
    if (url.startsWith(MEDIA_PREFIX)) return { media: url, path: null }
  }
  const link = el.closest('a[href]')
  if (link) {
    const href = link.getAttribute('href') ?? ''
    if (!/^(?:[A-Za-z][A-Za-z0-9+.-]+:\/\/|mailto:|#|\/)/.test(href)) {
      let decoded = href
      try {
        decoded = decodeURI(href)
      } catch {
        // keep the raw href
      }
      const path = pathLike(decoded)
      if (path) return { media: null, path }
    }
    return null
  }
  const code = el.closest('code')
  if (code && !code.closest('pre, .md-code')) {
    const path = pathLike(code.textContent ?? '')
    if (path) return { media: null, path }
  }
  return null
}
