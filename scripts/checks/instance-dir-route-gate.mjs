// Guardrail: an `/api/instances/:dir/...` route must resolve `:dir` against the instance LIST
// before it acts, never use it as a path as given.
//
// The bug this exists to prevent, observed 2026-09-03. Every per-instance route read its param
// with `decodeURIComponent(c.req.param('dir'))` and handed the result straight to the action. A
// caller who passed a bare folder name rather than a full dir - `POST /api/instances/thomas/open`,
// the spelling a script or an MCP caller reaches for first - got that name resolved as a RELATIVE
// path against the daemon's working directory, which for the installed service is System32's
// driver store. claude.exe was launched with
// `--user-data-dir=C:\Windows\System32\DriverStore\FileRepository\...\amd64\thomas`: a stray
// process, a profile written somewhere nobody would look for it, and nothing in the UI to stop it.
// The web UI never hit this because it passes back the exact dir it was listed with; every OTHER
// caller is the exposed one.
//
// Why a check and not just the test suite. server/tests/instance-dir.test.ts proves the gate
// BEHAVES correctly (the matcher, a real Hono request, live discovery). It cannot prove the gate is
// APPLIED everywhere, and that is the half that actually regressed: the first pass at the fix wired
// index.ts's nine routes and left instance-mode.ts's four - a second daemon, its own port, the same
// paths, `openInstance`/`focusInstance`/`quitInstance` still taking the param as given. That fix
// then sat on a branch while the full daemon's routes moved out of index.ts into
// server/src/routes/instances.ts and routes/usage.ts and grew two more (login-history, logout),
// all ungated, until it was ported onto main on 2026-10-03. A per-route test only covers the routes
// someone remembered to write one for. This scans all of server/src, so a surface that grows or
// moves these routes is covered on the day it is written.
//
// WHAT COUNTS AS SATISFIED: the route registration's call text contains `instanceDirParam(c)`,
// which returns either the listed instance's own `dir` or the 404 Response the route returns in its
// place (see server/src/instance-dir-param.ts).
//
// DELIBERATELY NOT FLAGGED:
//   · server/src/instance-dir-param.ts itself. It is the one place `c.req.param('dir')` is
//     legitimate, because reading the param is its entire job.
//   · `:id` route families (`/api/cli-instances/:id`, `/api/codex-instances/:id`,
//     `/api/sessions/:id`). Those params are identities looked up in their own stores, not paths
//     joined against a filesystem, so this rule does not describe them. If one of them ever does
//     reach a path sink, it needs its own rule rather than a widened regex here.
//   · A route path built from a variable or a template. A text scan cannot resolve those, and a
//     wrong guess is worse than a miss - narrow and low-false-positive beats clever. Nothing in
//     this repo registers a route that way today.
//
// Self-contained by design: imports nothing from the arkitect core (a bare
// `import "connections-arkitect"` doesn't resolve from a check that lives in the repo rather than
// the runner's node_modules), and returns plain finding objects, which the runner accepts as-is.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'instance-dir-route-without-gate'

// A route registration for a per-instance path. Covers the plain verb methods and `app.on([...],
// path)`, since Hono accepts both. The literal `'/api/instances/:dir` must be the path argument of
// the registration call, which is what keeps this from matching the same text in prose (the route
// files describe this very rule in their comments) or in a fetch() on the client side.
const ROUTE_HEAD =
  /\b(?:app|\w+)\s*\.\s*(?:get|post|put|patch|delete|all|on)\s*\(\s*(?:\[[^\]]*\]\s*,\s*)?['"]\/api\/instances\/:dir/g

// The gate call that makes a route compliant.
const GATE = /instanceDirParam\s*\(\s*c\s*[,)]/

// The exact shape of the bug: the param read directly off the request.
const RAW_PARAM = /c\s*\.\s*req\s*\.\s*param\s*\(\s*['"]dir['"]\s*\)/g

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.arkitect', 'coverage', 'build'])
const EXTS = ['.ts', '.mjs']
// Reading the `dir` param is this module's whole purpose; it is the gate, not a bypass of it.
const RAW_PARAM_ALLOWED = new Set(['server/src/instance-dir-param.ts'])

/** Recursively yield every scannable source file under `dir`. */
function* sourceFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(p)
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      yield p
    }
  }
}

/** Extract `text` from `openParenIndex` (the `(` of a call) through its matching `)`, skipping
 *  parens inside string/template literals. Falls back to the rest of the file on an unterminated
 *  call (shouldn't happen in valid source, but never throw over it). */
function extractCall(text, openParenIndex) {
  let depth = 0
  let inString = null
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openParenIndex, i + 1)
    }
  }
  return text.slice(openParenIndex)
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** True when the line containing `index` is a comment line. Enough for this rule: the only way
 *  either pattern shows up in prose here is a `//` line or a `*` continuation inside a block
 *  comment, and a comment can neither register a route nor read a param. */
function isCommentLine(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const before = text.slice(lineStart, index)
  if (before.includes('//')) return true
  return /^\s*\*/.test(before)
}

/**
 * Every per-instance route in `text` whose registration does not call the gate, plus every raw
 * read of the `dir` param. Exported so the rule can be unit-tested against fixture strings rather
 * than only against the live tree.
 */
export function findViolations(text, { rawParamAllowed = false } = {}) {
  const hits = []

  ROUTE_HEAD.lastIndex = 0
  for (const head of text.matchAll(ROUTE_HEAD)) {
    if (isCommentLine(text, head.index)) continue
    const openParenIndex = text.indexOf('(', head.index)
    if (openParenIndex === -1) continue
    const callText = extractCall(text, openParenIndex)
    if (GATE.test(callText)) continue
    // Recover the route path for the message, so the finding names the route rather than a line.
    const path = callText.match(/['"](\/api\/instances\/:dir[^'"]*)['"]/)
    hits.push({ index: head.index, kind: 'route-without-gate', route: path ? path[1] : '/api/instances/:dir' })
  }

  if (!rawParamAllowed) {
    RAW_PARAM.lastIndex = 0
    for (const raw of text.matchAll(RAW_PARAM)) {
      if (isCommentLine(text, raw.index)) continue
      hits.push({ index: raw.index, kind: 'raw-param', route: null })
    }
  }

  return hits.sort((a, b) => a.index - b.index)
}

export const audit = {
  id: ID,
  title: 'every /api/instances/:dir route resolves :dir against the instance list',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: an ungated route does not crash or look broken. It launches a real process against a
  // directory the caller named, outside the instance store, and the route still returns ok.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const start = join(root, 'server', 'src')
    const findings = []

    for (const file of sourceFiles(start)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      let text
      try {
        if (statSync(file).size > 2_000_000) continue // no source file here is this big
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // Cheap reject before the call-extraction scan.
      if (!text.includes('/api/instances/:dir') && !text.includes("param('dir')")) continue

      for (const hit of findViolations(text, { rawParamAllowed: RAW_PARAM_ALLOWED.has(rel) })) {
        const rawParam = hit.kind === 'raw-param'
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          kind: hit.kind,
          severity: 'error',
          message: rawParam
            ? "Reads the `dir` route param directly. That value is whatever the caller typed, and " +
              'every action behind these routes treats it as a path: a bare folder name resolves ' +
              "RELATIVE to the daemon's working directory (System32's driver store, for the " +
              'installed service), so `thomas` becomes a profile written under System32 and a ' +
              'claude.exe launched against it.'
            : `Registers \`${hit.route}\` without taking \`:dir\` through instanceDirParam. The ` +
              'param reaches the action as the caller spelled it, so a bare folder name is ' +
              "resolved as a relative path against the daemon's working directory rather than " +
              'being recognised as an instance (or refused).',
          fix: rawParam
            ? 'Replace it with the gate: `const dir = await instanceDirParam(c)` then `if (dir instanceof Response) return dir`. The value you get back is the LISTED instance\'s own dir, already normalized.'
            : 'Open the handler with `const dir = await instanceDirParam(c)` and `if (dir instanceof Response) return dir`, then act on `dir`. See server/src/instance-dir-param.ts and the routes in server/src/routes/instances.ts.',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} ungated per-instance route reference(s):\n` +
        findings
          .map(
            (f) =>
              `- ${f.file}:${f.line} ${f.kind === 'raw-param' ? 'reads the dir param directly' : 'route registered without instanceDirParam'}`,
          )
          .join('\n')
      : 'Every /api/instances/:dir route resolves :dir against the instance list. ✓'

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): `bun|node <thisfile>` prints the report and exits 1 on any
// violation. During an arkitect run the module is only IMPORTED (process.argv[1] = the arkitect
// bin, not this file), so this block is inert there; it fires only on a direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
