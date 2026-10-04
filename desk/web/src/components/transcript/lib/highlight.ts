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

const highlight: Highlight = (code, lang) => {
  if (!highlighter) {
    ensureShiki()
    return null
  }
  const id = ALIASES[lang] ?? lang
  if (!highlighter.getLoadedLanguages().includes(id)) return null
  try {
    return highlighter.codeToHtml(code, { lang: id, theme: 'github-dark-default' })
  } catch {
    return null
  }
}

/** The window's markdown: html off, links in a new tab, shiki once loaded. */
export const markdown = createMarkdown(() => highlight)
