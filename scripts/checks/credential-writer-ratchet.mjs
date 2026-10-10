// Ratchet over every credential WRITER in the daemon's source: a file that writes a login's
// credential file, a token-store key or a token value to disk must be one of the deliberate owners
// listed in CREDENTIAL_WRITERS below. Idea from stablyai/orca's credential-persistence ratchet (MIT,
// https://github.com/stablyai/orca); written fresh for this repo's layout.
//
// THE FAILURE. A login here is a file (`<configDir>/.credentials.json`, a Codex home's `auth.json`,
// a Free instance's `session.dpapi`) or a key inside one (Desktop's config.json `oauth:tokenCacheV2`).
// A second module that writes one of those can overwrite a freshly refreshed token with a stale copy,
// or leave a half-written login behind. Each login works today because one module owns its writes.
//
// THE RULE. A write sink (writeFile*, appendFile*, copyFile*, rename*, cpSync, Bun.write, writeAtomic)
// is a violation when either:
//   A. its arguments reach a credential: a credential file name, a token value (accessToken,
//      refreshToken, access_token, refresh_token), or a name bound to one of those in its own block; or
//   B. its top-level block touches a token store: a credential file name, an oauth:tokenCache key, or a
//      name bound to one of those (module-level or in the block). Reading and deleting a login are not
//      writes, so they never trip the rule; a sink next to one does, because the block is the unit.
// A file in CREDENTIAL_WRITERS is exempt. Each entry must still be a writer: a stale entry fails too,
// so the list cannot drift from the code it describes.
//
// DELIBERATELY NOT FLAGGED: comments and prose (blanked first); a write to a file named with none of
// the credential names (a cache, a transcript, a config that holds no login key).
//
// KNOWN LIMITS. Matching is by name, not by resolved import: a helper this file imports under another
// name is missed unless it is listed in CREDENTIAL_HELPERS. A sync token kept under the plain key
// `token` (core/cli-login-sync.ts's config) is not named here, so that write is not seen. Add the name
// when one appears. Errs toward a false red, never a false green, on a same-named unrelated variable.
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'credential-writer-ratchet'

// The folders whose TypeScript is the daemon: the main server and the desk2 server.
const ROOTS = ['server/src', 'desk2/server/src']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.output'])
const SOURCE_FILE = /\.ts$/
const TEST_FILE = /\.(?:test|spec)\.ts$|\.d\.ts$/

/**
 * Who may write a credential, and why. One line per reason; a new entry needs one too.
 * Repo-relative paths, forward slashes.
 */
export const CREDENTIAL_WRITERS = {
  'server/src/core/cli-login-move.ts':
    'moves a CLI login between PCs: writes the verbatim .credentials.json into an instance and the sealed bundle',
  'server/src/core/desktop-cli-feed.ts':
    'gives a linked CLI instance its desktop login: rewrites the .credentials.json it reads',
  'server/src/core/desktop-login-sync.ts':
    'desktop login sync and renewal: writes the encrypted oauth:tokenCacheV2 into a profile config.json',
  'server/src/core/instance-logout.ts':
    'desktop logout: rewrites config.json with the login keys removed',
  'desk2/server/src/free-instances/storage.ts':
    'legacy harness migration: copies each provider session.dpapi into its new Free instance folder',
}

const CRED_FILE = /['"`](?:\.credentials\.json|auth\.json|session\.dpapi)['"`]/
const TOKEN_KEY = /['"`]oauth:tokenCache(?:V2)?['"`]/
const TOKEN_VALUE = /\b(?:accessToken|refreshToken|access_token|refresh_token)\b/
// Names this repo hands a credential path to by name. desktop-cli-feed.ts imports credPath from
// core/cli-login-move.ts, so the literal is not in its file; the name is what it can see.
const CREDENTIAL_HELPERS = ['credPath']
// A write sink, and the open paren its arguments start at (the last character of the match). A bare
// `rename(` is left out: a method declared as rename(id, value) is not an fs call. fs/promises is
// used as `await rename(`, which is what counts.
const SINK =
  /(?<![\w$])(?:writeFile|appendFile|copyFile|writeAtomic)(?:Sync)?\s*\(|(?<![\w$])(?:renameSync|(?<=await\s+)rename)\s*\(|(?<![\w$])cpSync\s*\(|\bBun\.write\s*\(/g

/** Index just past the string literal that opens at `i`. A quote ends at its line, a template at its backtick. */
function stringEnd(src, i) {
  const quote = src[i]
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === quote) return j + 1
    if (c === '\n' && quote !== '`') return j
  }
  return src.length
}

/** Blank comments, keeping strings and every newline, so a `//` inside a string survives and line numbers hold. */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(src, i)
      out += src.slice(i, end)
      i = end
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const stop = close < 0 ? src.length : close + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Index of the bracket that closes the one opened at `open`, skipping strings; the text's end if none. */
function matchingClose(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i = stringEnd(text, i) - 1
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return text.length
}

/** Where a right-hand side ends: a `;` or a line break at depth 0, or the bracket that closes it. */
function expressionEnd(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      i = stringEnd(text, i) - 1
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (c === ';' || (c === '\n' && text.slice(from, i).trim()))) {
      return i
    }
  }
  return text.length
}

/** Every binding in a text: `const|let|var NAME = expr`, `for (const NAME of expr`, and `function NAME(...) {body}`. */
function bindingsIn(text) {
  const out = []
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?!=)/g
  for (const m of text.matchAll(decl)) {
    const from = m.index + m[0].length
    out.push({ name: m[1], index: m.index, expr: text.slice(from, expressionEnd(text, from)) })
  }
  const loop = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g
  for (const m of text.matchAll(loop)) {
    const from = m.index + m[0].length
    out.push({ name: m[1], index: m.index, expr: text.slice(from, expressionEnd(text, from)) })
  }
  const fn = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g
  for (const m of text.matchAll(fn)) {
    const params = m.index + m[0].length - 1
    const brace = text.indexOf('{', matchingClose(text, params))
    if (brace < 0) continue
    out.push({ name: m[1], index: m.index, expr: text.slice(brace, matchingClose(text, brace)) })
  }
  return out
}

/** True when the line holding `index` starts at column 0: a module-level declaration. */
function atColumnZero(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1
  return !/[ \t]/.test(text[lineStart] ?? ' ')
}

/** Top-level blocks: each run of text from a line that starts at column 0 to the next such line. */
function topLevelBlocks(text) {
  const starts = [0]
  for (const m of text.matchAll(/\n(?=\S)/g)) starts.push(m.index + 1)
  return starts.map((start, k) => ({
    start,
    end: k + 1 < starts.length ? starts[k + 1] : text.length,
  }))
}

const mentionsName = (code, name) =>
  new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)

const anyName = (code, names) => [...names].some((name) => mentionsName(code, name))

/** Every name bound, directly or through another bound name, to one of the `marks` or to `seed`. */
function settle(seed, decls, marks) {
  const names = new Set(seed)
  let changed = true
  while (changed) {
    changed = false
    for (const d of decls) {
      if (names.has(d.name)) continue
      if (marks.some((re) => re.test(d.expr)) || anyName(d.expr, names)) {
        names.add(d.name)
        changed = true
      }
    }
  }
  return names
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** Every write that reaches a credential or sits in a block that touches a token store. Pure: no allowlist. */
export function findViolations(text) {
  const code = stripComments(text)
  const decls = bindingsIn(code)
  const moduleDecls = decls.filter((d) => atColumnZero(code, d.index))
  const moduleStore = settle(CREDENTIAL_HELPERS, moduleDecls, [CRED_FILE, TOKEN_KEY])
  const moduleValue = settle(moduleStore, moduleDecls, [CRED_FILE, TOKEN_KEY, TOKEN_VALUE])

  const findings = []
  for (const block of topLevelBlocks(code)) {
    const body = code.slice(block.start, block.end)
    const localDecls = bindingsIn(body)
    const store = settle(moduleStore, localDecls, [CRED_FILE, TOKEN_KEY])
    const value = settle([...moduleValue, ...store], localDecls, [CRED_FILE, TOKEN_KEY, TOKEN_VALUE])
    const blockTouchesStore = CRED_FILE.test(body) || TOKEN_KEY.test(body) || anyName(body, store)

    for (const m of body.matchAll(SINK)) {
      const open = m.index + m[0].length - 1
      const args = body.slice(open, matchingClose(body, open) + 1)
      const argsReachValue =
        CRED_FILE.test(args) || TOKEN_VALUE.test(args) || anyName(args, value)
      if (!argsReachValue && !blockTouchesStore) continue
      findings.push({
        line: lineAt(code, block.start + m.index),
        call: m[0].replace(/\s*\($/, ''),
        why: argsReachValue
          ? 'writes a credential file, token or a value bound to one'
          : 'sits in a block that also touches a credential file or token store',
      })
    }
  }
  return findings
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (SOURCE_FILE.test(e.name) && !TEST_FILE.test(e.name)) out.push(p)
  }
  return out
}

export const audit = {
  id: ID,
  title: 'Only a deliberate owner writes a credential file or token store',
  gating: true,
  async run({ root }) {
    const paths = []
    for (const r of ROOTS) {
      const dir = join(root, r)
      try {
        if (statSync(dir).isDirectory()) walk(dir, paths)
      } catch {}
    }

    const writers = new Map()
    for (const p of paths) {
      const rel = relative(root, p).split(sep).join('/')
      const hits = findViolations(readFileSync(p, 'utf8'))
      if (hits.length) writers.set(rel, hits)
    }

    const findings = []
    for (const [file, hits] of writers) {
      if (file in CREDENTIAL_WRITERS) continue
      for (const hit of hits) {
        findings.push({
          id: ID,
          file,
          line: hit.line,
          severity: 'error',
          symbol: hit.call,
          message:
            `${hit.call}(...) ${hit.why}, and ${file} is not a deliberate owner of logins. ` +
            'A second writer can put a stale or half-written login over the owner\'s.',
          fix:
            'Move the write into the module that owns this login (core/cli-login-move.ts, ' +
            'core/cli-logout.ts, core/desktop-login-sync.ts). If this file IS a deliberate owner, ' +
            'add it to CREDENTIAL_WRITERS in scripts/checks/credential-writer-ratchet.mjs with a ' +
            'one-line reason.',
        })
      }
    }
    for (const file of Object.keys(CREDENTIAL_WRITERS)) {
      if (writers.has(file)) continue
      findings.push({
        id: ID,
        file,
        line: 1,
        severity: 'error',
        symbol: 'CREDENTIAL_WRITERS',
        message: `${file} is listed as a credential writer but no longer writes one. The ratchet only holds if its list is exact.`,
        fix: `Remove its entry from CREDENTIAL_WRITERS in scripts/checks/${ID}.mjs.`,
      })
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} credential-write finding(s):\n${findings
          .map((f) => `- ${f.file}:${f.line} ${f.symbol}: ${f.message}`)
          .join('\n')}`
      : `Only the ${Object.keys(CREDENTIAL_WRITERS).length} deliberate credential owner(s) write a login in ${paths.length} source file(s). ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
