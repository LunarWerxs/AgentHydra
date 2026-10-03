// Guardrail against a fixer that nothing calls but its own test.
//
// THE FAILURE, shipped TWICE: reassertAutomationStamps (the permission stamp) and
// sweepUntitledDesktopChats (the title janitor) were each written, unit-tested, documented as
// running on a timer, and then called from nowhere but their own test file. The janitor sat like
// that for eleven days after the v1 orchestrator that owned its watcher tick was retired whole on
// 2026-08-29, while its doc comment and the CHANGELOG both still said it ran. Both were found only
// because a user reported the very symptom the fixer existed to prevent. A green unit test proves
// a function works and says nothing about whether anything calls it.
//
// THE RULE (2026-10-03): an exported symbol whose name matches ^(sweep|reassert|run.*Once) - the
// names this repo gives a fixer that some timer, route or launch is meant to fire - must be named
// by at least one piece of production code: a non-test file other than its own, or its own file
// beyond the declaration (a timer that calls it in-module is a caller). One that is named ONLY by
// test code (a *.test.* / *.spec.* file, or any file under a tests/ folder) fails the build.
//
// Wire it at its root, or delete it with its test. Never allowlist one here: an allowlist entry is
// exactly the "documented as running, called from nowhere" state this check exists to refuse.
//
// DELIBERATELY NOT FLAGGED:
//   · An exported fixer no file names at all, test or otherwise. That is dead code, a different
//     finding, and the shape that shipped twice always had its test.
//   · Comments and string literals: both are blanked before the scan, so a doc comment or a
//     CHANGELOG-style sentence naming the fixer is never mistaken for a caller (nor a test's
//     `expect(src).toContain('sweepX')` for a reference).
//
// KNOWN LIMIT: references are matched by identifier, not by resolved import, so an unrelated
// symbol of the same name in production code reads as a caller. That errs toward a false green,
// never a false red, which is the right side for a gating check.
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'fixer-only-called-by-its-test'

// The folders that hold this repo's TypeScript and JavaScript, production and test alike.
const ROOTS = ['server', 'web', 'orchestrator', 'cloud', 'scripts', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'tmp', '.output', '__pycache__'])
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

const FIXER_NAME = /^(?:sweep|reassert|run.*Once)/
// A cheap raw-text pre-filter, so only a file that could declare a fixer is blanked and parsed.
const FIXER_DECL_RAW = /\bexport\s[^\n]*?\b(?:sweep|reassert|run[\w$]*Once)/
const EXPORTED_DECL =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g

/** Blank a line comment, stopping AT the newline - which is code and must survive. */
function scanLineComment(src, i) {
  const n = src.length
  let out = ''
  while (i < n && src[i] !== '\n') {
    out += ' '
    i++
  }
  return { i, out }
}

/** Blank a block comment through its closing delimiter, keeping newlines so line numbers hold. */
function scanBlockComment(src, i) {
  const n = src.length
  let out = ''
  while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
    out += src[i] === '\n' ? '\n' : ' '
    i++
  }
  out += '  '
  i += 2
  return { i, out }
}

/** Blank one string or template literal, honouring backslash escapes and keeping newlines. */
function scanStringLiteral(src, i) {
  const n = src.length
  const quote = src[i]
  let out = ' '
  i++
  while (i < n) {
    if (src[i] === '\\') {
      out += '  '
      i += 2
      continue
    }
    if (src[i] === quote) {
      out += ' '
      i++
      break
    }
    out += src[i] === '\n' ? '\n' : ' '
    i++
  }
  return { i, out }
}

/** Blank comments and string/template literals so prose can never be read as code. */
function blankNonCode(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    let scanned = null
    if (c === '/' && next === '/') scanned = scanLineComment(src, i)
    else if (c === '/' && next === '*') scanned = scanBlockComment(src, i)
    else if (c === '"' || c === "'" || c === '`') scanned = scanStringLiteral(src, i)
    if (scanned) {
      out += scanned.out
      i = scanned.i
      continue
    }
    out += c
    i++
  }
  return out
}


const lineAt = (text, index) => text.slice(0, index).split('\n').length

const isTestPath = (rel) => TEST_FILE.test(rel) || rel.split('/').includes('tests')

const mentions = (code, name) =>
  (code.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) ?? []).length

/** Every exported fixer and every orphan among them, across a set of files. Only a file whose raw
 *  text could declare or name a fixer is blanked and searched: on this repo that is a few dozen of
 *  ~1,100 files, which keeps the check inside a loaded box's 5s test budget. */
function scan(files) {
  const blanked = new Map()
  const codeOf = (f) => {
    if (!blanked.has(f.path)) blanked.set(f.path, blankNonCode(f.text))
    return blanked.get(f.path)
  }

  const fixers = []
  for (const f of files) {
    if (isTestPath(f.path) || !FIXER_DECL_RAW.test(f.text)) continue
    for (const m of codeOf(f).matchAll(EXPORTED_DECL)) {
      if (FIXER_NAME.test(m[1])) fixers.push({ file: f, name: m[1], index: m.index })
    }
  }

  const findings = []
  for (const { file, name, index } of fixers) {
    // Its own file names it once in the declaration; any further mention is an in-module caller.
    let prodCallers = mentions(codeOf(file), name) > 1 ? 1 : 0
    const testCallers = []
    for (const other of files) {
      if (other === file || !other.text.includes(name) || mentions(codeOf(other), name) === 0) continue
      if (isTestPath(other.path)) testCallers.push(other.path)
      else prodCallers++
    }
    if (prodCallers > 0 || testCallers.length === 0) continue
    findings.push({
      id: ID,
      file: file.path,
      line: lineAt(file.text, index),
      severity: 'error',
      symbol: name,
      message:
        `${name} is a fixer that only test code calls (${testCallers.join(', ')}). A green ` +
        'unit test proves it works, not that anything runs it. reassertAutomationStamps and ' +
        'sweepUntitledDesktopChats both shipped in exactly this state, documented as running on ' +
        'a timer, until a user reported the symptom each one existed to prevent.',
      fix:
        'Call it from the production path that is meant to fire it (a guarded timer tick, a ' +
        'route, a launch step), or delete it together with its test. Do not allowlist it.',
    })
  }
  return { fixers: fixers.length, findings }
}

/** Every orphaned fixer across a set of files. `files` is [{ path, text }] with repo-relative,
 *  forward-slash paths. Exported so tests/guardrails.test.ts can plant a tree and watch it fire,
 *  rather than trusting a clean one. */
export function findOrphans(files) {
  return scan(files).findings
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      walk(p, out)
    } else if (CODE_FILE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

export const audit = {
  id: ID,
  title: 'A fixer must not be called only by its own test',
  gating: true,
  async run({ root }) {
    const paths = []
    for (const r of ROOTS) {
      const dir = join(root, r)
      try {
        if (statSync(dir).isDirectory()) walk(dir, paths)
      } catch {}
    }
    const files = paths.map((p) => ({
      path: relative(root, p).split(sep).join('/'),
      text: readFileSync(p, 'utf8'),
    }))
    const { fixers, findings } = scan(files)

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} fixer(s) called only by test code:\n${findings
          .map((f) => `- ${f.file}:${f.line} ${f.symbol}`)
          .join('\n')}`
      : `All ${fixers} exported fixer(s) across ${files.length} file(s) have a production caller. ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
