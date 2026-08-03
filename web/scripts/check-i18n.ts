#!/usr/bin/env bun
/**
 * i18n compliance checker. Run with `bun run check:i18n` (also gates `bun run build`).
 *
 * Three guarantees, each a hard failure (exit 1):
 *   1. No hardcoded UI strings — rendered template text and user-facing static attributes
 *      (aria-label, title, placeholder, …) must go through i18n.
 *   2. Every referenced key resolves — every static `t("a.b")` / `keypath="a.b"` points at a
 *      real key in the English base catalog.
 *   3. Locale parity — every non-base locale has exactly the same key shape as English.
 *
 * Escape hatches: brand names in ALLOWLIST; an `<!-- i18n-ignore -->` comment immediately
 * before an element suppresses checks for that node and its subtree.
 */
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { Glob } from 'bun'
import { LOCALES } from '../src/i18n/locales'
import enBase from '../src/i18n/locales/en'

const TEXT = 2
const COMMENT = 3
const INTERPOLATION = 5
const ATTRIBUTE = 6

const TRANSLATABLE_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
])

// Intentional non-translatable literals (brand names, etc.). Keep this list tiny.
const ALLOWLIST = new Set(['AgentHydra'])

const HAS_LETTER = /\p{L}/u
const SENTENCE_LIKE = /\s/
const ENDS_SENTENCE = /[.…!?:]$/

interface AstNode {
  type: number
  content?: string | { content?: string }
  loc: { start: { line: number } }
  props?: Array<{ type: number; name: string; value?: { content?: string }; loc: AstNode['loc'] }>
  children?: AstNode[]
}

type Severity = 'error' | 'warn'
interface Finding {
  file: string
  line: number
  severity: Severity
  rule: string
  detail: string
}
const findings: Finding[] = []
function add(file: string, line: number, severity: Severity, rule: string, detail: string) {
  findings.push({ file, line, severity, rule, detail })
}

function flatten(obj: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') flatten(v, path, out)
      else out.add(path)
    }
  }
  return out
}
const enKeys = flatten(enBase)

function checkTemplate(file: string, source: string) {
  let descriptor: ReturnType<typeof parse>['descriptor']
  try {
    ;({ descriptor } = parse(source, { filename: file }))
  } catch (e) {
    add(file, 1, 'error', 'parse', `failed to parse SFC: ${(e as Error).message}`)
    return
  }
  const ast = descriptor.template?.ast as AstNode | null | undefined
  if (!ast) return

  const visit = (node: AstNode | null | undefined) => {
    if (!node) return
    if (node.type === TEXT) {
      const text = String(node.content ?? '').trim()
      if (text && HAS_LETTER.test(text) && !ALLOWLIST.has(text)) {
        add(file, node.loc.start.line, 'error', 'hardcoded-text', JSON.stringify(text))
      }
      return
    }
    if (node.type === INTERPOLATION) {
      const expr = (typeof node.content === 'object' ? node.content?.content : undefined) ?? ''
      for (const m of expr.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
        const lit = m[2]
        if (
          HAS_LETTER.test(lit) &&
          (SENTENCE_LIKE.test(lit) || ENDS_SENTENCE.test(lit)) &&
          !ALLOWLIST.has(lit.trim())
        ) {
          add(file, node.loc.start.line, 'warn', 'hardcoded-in-expr', JSON.stringify(lit))
        }
      }
      return
    }
    if (Array.isArray(node.props)) {
      for (const p of node.props) {
        if (p.type === ATTRIBUTE && TRANSLATABLE_ATTRS.has(p.name)) {
          const val = String(p.value?.content ?? '').trim()
          if (val && HAS_LETTER.test(val) && !ALLOWLIST.has(val)) {
            add(
              file,
              p.loc.start.line,
              'error',
              'hardcoded-attr',
              `${p.name}=${JSON.stringify(val)}`,
            )
          }
        }
      }
    }
    visitChildren(node.children)
  }

  const visitChildren = (children: AstNode[] | undefined) => {
    if (!Array.isArray(children)) return
    for (let i = 0; i < children.length; i++) {
      const prev = children[i - 1]
      const ignored =
        prev && prev.type === COMMENT && String(prev.content).trim().toLowerCase() === 'i18n-ignore'
      if (ignored) continue
      visit(children[i])
    }
  }

  visitChildren(ast.children)
}

const T_CALL = /(?<![\w.])\$?t\(\s*["']([\w.]+)["']/g
const KEYPATH = /keypath\s*=\s*["']([\w.]+)["']/g
const DYNAMIC_T = /(?<![\w.])\$?t\(\s*`/g

// Keys seen through a precise `t("a.b")` / `keypath="a.b"` match. Used by the reverse
// (unused-key) pass below as a fast-path — anything already proven live here doesn't need
// the whole-source substring scan.
const referencedKeys = new Set<string>()

function checkKeyRefs(file: string, source: string) {
  for (const re of [T_CALL, KEYPATH]) {
    re.lastIndex = 0
    for (const m of source.matchAll(re)) {
      const key = m[1]
      referencedKeys.add(key)
      if (!enKeys.has(key)) {
        const line = source.slice(0, m.index).split('\n').length
        add(file, line, 'error', 'missing-key', `t("${key}") has no entry in en.ts`)
      }
    }
  }
  DYNAMIC_T.lastIndex = 0
  for (const m of source.matchAll(DYNAMIC_T)) {
    const line = source.slice(0, m.index).split('\n').length
    add(file, line, 'warn', 'dynamic-key', 'dynamic t(`...`) key — not statically verified')
  }
}

// Reverse pass: is every catalog key actually referenced somewhere?
//
// The precise scan above only sees a key when it's a string literal argument to `t(...)`
// / `$t(...)` / `keypath="..."` right there in the call. It's blind to INDIRECT reference —
// a key threaded through a variable or lookup table before it ever reaches `t()`, e.g.
// `computed(() => ({ titleKey: 'instances.desktopMsixTitle', bodyKey: 'instances.desktopMsixBody' }))`
// followed by `$t(desktopWarning.titleKey)` elsewhere, or a helper like
// `usageReasonMessageKey(reason)` that returns a key string via an internal switch/map.
// Naively treating anything not matched above as "unused" would misreport every one of
// those as dead (or, in a stricter checker, delete/flag a key that's genuinely load-bearing).
//
// The fix: before calling a key unused, check whether its FULL dotted key string appears
// anywhere in the app's source tree as a quoted string literal — not just inside a `t()`
// shaped call. That one substring check covers every indirection (lookup table, ternary,
// helper return, object literal) in a single pass, because the key has to be written down
// as a literal *somewhere* for any of those patterns to work.
//
// Deliberately matched as the FULL "area.name" string, never a bare last segment
// ("desktopMsixTitle" alone) — matching only the tail would make near enough every key look
// "used" by coincidence and silently hide real dead keys, defeating the point of the check.
function findUnusedKeys(): void {
  let wholeSource = ''
  for (const path of new Glob('src/**/*.vue').scanSync('.'))
    wholeSource += readFileSync(path, 'utf8')
  for (const path of new Glob('src/**/*.ts').scanSync('.'))
    wholeSource += readFileSync(path, 'utf8')

  const isQuotedLiteral = (key: string) =>
    wholeSource.includes(`'${key}'`) ||
    wholeSource.includes(`"${key}"`) ||
    wholeSource.includes(`\`${key}\``)

  for (const key of [...enKeys].sort()) {
    if (referencedKeys.has(key)) continue
    if (isQuotedLiteral(key)) continue
    add(
      'src/i18n/locales/en.ts',
      1,
      'warn',
      'unused-key',
      `"${key}" is defined but never referenced (no t()/keypath call and no matching string literal anywhere in src/)`,
    )
  }
}

async function checkLocaleParity() {
  for (const meta of LOCALES) {
    if (meta.code === 'en') continue
    let mod: { default?: unknown }
    try {
      mod = await import(`../src/i18n/locales/${meta.code}.ts`)
    } catch {
      add(
        `src/i18n/locales/${meta.code}.ts`,
        1,
        'error',
        'locale-missing',
        `registered locale "${meta.code}" has no catalog file`,
      )
      continue
    }
    const keys = flatten(mod.default)
    for (const k of enKeys)
      if (!keys.has(k))
        add(`src/i18n/locales/${meta.code}.ts`, 1, 'error', 'locale-missing-key', `missing "${k}"`)
    for (const k of keys)
      if (!enKeys.has(k))
        add(
          `src/i18n/locales/${meta.code}.ts`,
          1,
          'error',
          'locale-extra-key',
          `extra "${k}" (not in en.ts)`,
        )
  }
}

// Vendored/synced kit files are library code (not app copy) — exempt from the scan, same
// as the siblings' checkers. Covers components/ui, shell, and the synced lib/* modules
// (which carry their own i18n keys from the kit, e.g. relativeTime's `time.*`).
const SYNCED_LIB = /lib[\\/](utils|theme|httpClient|i18n-core|relativeTime|useSelfUpdate)\.ts$/
const SKIP = (path: string) =>
  path.includes('i18n/locales') ||
  path.includes('i18n\\locales') ||
  path.includes('components/ui') ||
  path.includes('components\\ui') ||
  path.includes('src/shell') ||
  path.includes('src\\shell') ||
  SYNCED_LIB.test(path)

for (const path of new Glob('src/**/*.vue').scanSync('.')) {
  if (SKIP(path)) continue
  const src = readFileSync(path, 'utf8')
  checkTemplate(path, src)
  checkKeyRefs(path, src)
}
for (const path of new Glob('src/**/*.ts').scanSync('.')) {
  if (SKIP(path)) continue
  checkKeyRefs(path, readFileSync(path, 'utf8'))
}
await checkLocaleParity()
findUnusedKeys()

const errors = findings.filter((f) => f.severity === 'error')
const warns = findings.filter((f) => f.severity === 'warn')
const norm = (p: string) => p.replaceAll('\\', '/')

for (const f of [...errors, ...warns].sort(
  (a, b) => norm(a.file).localeCompare(norm(b.file)) || a.line - b.line,
)) {
  const tag = f.severity === 'error' ? '✖' : '⚠'
  console.log(`${tag} ${norm(f.file)}:${f.line}  [${f.rule}] ${f.detail}`)
}
console.log(
  `\ni18n check: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'} across ${enKeys.size} keys.`,
)
if (errors.length) {
  console.log(
    'Fix by routing the string through i18n (t() / <i18n-t>), or mark an intentional literal with <!-- i18n-ignore -->.',
  )
  process.exit(1)
}
