// shiki, loaded the first time a code block renders. Until it is ready code shows plain; once it is,
// `shikiReady` flips and every markdown block re-renders highlighted.
import { ref } from 'vue'
import type { HighlighterCore } from 'shiki/core'
import { createMarkdown, type Highlight } from './markdown'

export const shikiReady = ref(false)

let highlighter: HighlighterCore | null = null
let loading: Promise<void> | null = null

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  jsonc: 'json',
  json5: 'json',
  htm: 'html',
  golang: 'go',
  cs: 'csharp',
  'c#': 'csharp',
  patch: 'diff',
}

export function ensureShiki(): void {
  if (highlighter || loading || typeof window === 'undefined') return
  loading = (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    highlighter = await createHighlighterCore({
      themes: [import('shiki/themes/github-dark-default.mjs')],
      langs: [
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/bash.mjs'),
        import('shiki/langs/powershell.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/csharp.mjs'),
        import('shiki/langs/vue.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/toml.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/diff.mjs'),
        import('shiki/langs/markdown.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    })
    shikiReady.value = true
  })().catch((err) => {
    console.warn('shiki failed to load; code stays plain', err)
  })
}

// Highlighted blocks by language and code: a streaming reply renders again on every frame, and the code
// blocks it already closed come from here. The oldest are dropped past the cap.
const highlighted = new Map<string, string>()
const KEEP_BLOCKS = 200

// V8 stores a block sliced out of a reply that holds any character above U+00FF (an em dash, a curly quote)
// as a two-byte string even when the block itself is plain ASCII, and every shiki regex then takes its slower
// two-byte path: a 240-line TypeScript block highlighted 2.3x slower cold and 3.3x slower warm (MPC-Plex,
// 2026-10-06; the same finding as claude.ai's speed sprint, claude.dev 2026-09-23). A block whose own characters
// all fit in one byte is copied back into a one-byte string before it is highlighted.
const ONE_BYTE = /^[\u0000-\u00ff]*$/

function oneByte(code: string): string {
  if (!ONE_BYTE.test(code)) return code
  let out = ''
  for (let i = 0; i < code.length; i += 4096) {
    const part = code.slice(i, i + 4096)
    const units = new Array<number>(part.length)
    for (let j = 0; j < part.length; j++) units[j] = part.charCodeAt(j)
    out += String.fromCharCode(...units)
  }
  return out
}

const highlight: Highlight = (code, lang) => {
  if (!highlighter) {
    ensureShiki()
    return null
  }
  const id = ALIASES[lang] ?? lang
  if (!highlighter.getLoadedLanguages().includes(id)) return null
  const key = `${id}\u0000${code}`
  const kept = highlighted.get(key)
  if (kept !== undefined) return kept
  try {
    const html = highlighter.codeToHtml(oneByte(code), { lang: id, theme: 'github-dark-default' })
    highlighted.set(key, html)
    if (highlighted.size > KEEP_BLOCKS) highlighted.delete(highlighted.keys().next().value!)
    return html
  } catch {
    return null
  }
}

/** The window's markdown: html off, links in a new tab, shiki once loaded. */
export const markdown = createMarkdown(() => highlight)
