// Guardrail against a test that does REAL subprocess work on bun's 5s default timeout.
//
// This is not a style rule. CI's windows-latest failed the 2026-08-08 run on
// server/tests/sessions-scan-cache.test.ts's first test at 5083.99ms — 84ms over the default — while
// the same test takes 533ms on a developer machine. A test that spawns a child process is not
// measuring its own assertions; it is measuring the runner, and a loaded, cold Windows CI box has
// been observed at ~9.5x local. The failure that produces is the worst kind: red on a commit that
// changed nothing related, green again on re-run, and a maintainer who learns to re-run CI instead
// of reading it.
//
// The rule: if a test reaches a subprocess, it must state a timeout explicitly. Any value counts.
// The point is that someone decided, rather than inheriting 5s by accident. A repo-wide
// `bun test --timeout N` counts as deciding, for every test at once, and stands this check down
// (see globalTimeoutMs) — for a suite where nearly everything spawns, that IS the better answer.
// tests/launcher.test.ts
// already worked this out the hard way ("20s timeout: two real PowerShell spawns + COM. A cold CI
// runner has taken 6.8s against the 5s default (flaked the 2026-07-16 run)"), and that lesson only
// ever got applied to the one test that happened to go red. This makes it apply to all of them.
//
// WHY A HELPER HOP MATTERS, and why an inline-only scan is not good enough: the four tests that
// actually flaked reach their spawn through a `child()` helper defined at module scope, so a scan
// for `Bun.spawn(` inside the test body finds NOTHING in exactly the file that caused the outage.
// Module-level helpers are therefore resolved first, and transitively (a helper calling a spawny
// helper is itself spawny) — listOne() -> child() -> Bun.spawnSync is a two-hop chain and is the
// common case, not the exotic one.
//
// DELIBERATELY NOT FLAGGED:
//   · A test that spawns only INDIRECTLY through imported production code (dispatch.dispatchItem
//     launches a real runner). Following imports is a different and much larger problem, and
//     guessing at it would trade this check's precision for coverage it cannot justify.
//   · Anything inside a comment or a string literal. Both are blanked before the scan, because this
//     repo's tests embed VBS and PowerShell source in template literals and discuss their own
//     spawns in prose. spawn-console-window.mjs shipped without this and read a SENTENCE as a spawn.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'subprocess-test-without-explicit-timeout'

// The spawn APIs this repo's tests actually use are Bun.spawn, Bun.spawnSync and execFileSync; the
// child_process siblings are listed so a future test reaching for one is caught on its first day
// rather than on the first cold-runner flake. `Bun.$` and a bare `$\`` are Bun's shell.
//
// The `execFileSync` family also matches through a NAMESPACE: `import cp from "node:child_process"`
// then `cp.execFileSync(...)` is the same spawn, and the leading `(?<![\w.$])` rejected it outright
// because the preceding character is a dot. That miss is not hypothetical, it is ReDesign's
// tray-launcher hook exactly, the one that held its windows-latest leg red. Any identifier is
// allowed as the qualifier for the four unambiguous names (nothing but child_process exports an
// `execFileSync`), while a BARE `spawn` stays unqualified-only, since `queue.spawn(` and friends are
// common enough that qualifying it would trade real precision for no recall.
const SPAWN_CALL =
  /(?<![\w.$])(?:Bun\.spawnSync|Bun\.spawn|Bun\.\$|(?:[A-Za-z_$][\w$]*\.)?(?:spawnSync|execFileSync|execSync|execFile)|spawn)\s*\(|\$`/

// `test(`, `it(`, and the modifier forms. `.if`/`.skipIf` are CURRIED — test.if(cond)(name, fn, ms)
// — which is handled at the call site below, not here.
const TEST_HEAD = /(?<![\w.$])(?:test|it)(?:\.(?:skipIf|todoIf|if|only|failing|each|skip|todo))?\s*\(/g

// Lifecycle hooks spawn too, and a hook on the 5s default is WORSE than a test on it: bun reports
// the timeout against an unnamed test ("a beforeEach/afterEach hook timed out for this test"), so
// the failure does not even name the hook that caused it. Missing this cost ReDesign a permanently
// red windows-latest leg (2026-08-12): its tray-launcher beforeAll shells out to PowerShell to
// regenerate a .lnk, 0.35s locally, over 5s on the runner, 5057ms. This check said ✓ the whole time
// because it only ever looked inside test bodies.
//
// Their timeout is the SECOND argument, not the third: beforeAll(fn, ms).
const HOOK_HEAD = /(?<![\w.$])(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/g

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.arkitect', 'coverage', 'build'])
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Recursively yield every test file under `dir`. */
function* testFiles(dir) {
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
      if (!SKIP_DIRS.has(e.name)) yield* testFiles(p)
    } else if (TEST_FILE.test(e.name)) {
      yield p
    }
  }
}

/** Index just past the regex literal opening at `start`, or -1 if it does not close on that line.
 *  `/` inside a `[...]` class is literal, so classes are tracked. */
function endOfRegex(text, start) {
  let inClass = false
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === '\n') return -1
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '/') return j + 1
  }
  return -1
}

// A `/` opens a regex only where an expression is expected. A missed regex is not cosmetic: it can
// carry a bare quote, which opens a string that never closes and inverts code/string for the rest of
// the file — the failure mode that made spawn-console-window.mjs's first fix a no-op.
const REGEX_OPENS_AFTER = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'],
)
const REGEX_OPENS_AFTER_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/

/** Blank comments and the INTERIOR of every string/template literal, replacing them with spaces so
 *  that every surviving character keeps its original index (line numbers are computed against the
 *  untouched text). Quotes and braces are preserved so call spans still balance. A spawn cannot
 *  happen inside a comment or a string, so removing both is what makes the scan precise: these
 *  tests embed VBS and PowerShell source in template literals and name their own spawns in prose. */
function blankNonCode(text) {
  const out = text.split('')
  let inString = null
  let prev = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        // Blank the escape pair, but never a newline: line numbering depends on them surviving.
        if (text[i] !== '\n') out[i] = ' '
        if (text[i + 1] !== '\n') out[i + 1] = ' '
        i += 2
        continue
      }
      if (ch === inString) {
        inString = null
        prev = ch
        i++
        continue
      }
      if (ch !== '\n') out[i] = ' '
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' '
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' '
      continue
    }
    if (
      ch === '/' &&
      (prev === '' ||
        REGEX_OPENS_AFTER.has(prev) ||
        REGEX_OPENS_AFTER_KEYWORD.test(text.slice(0, i).trimEnd()))
    ) {
      const end = endOfRegex(text, i)
      if (end !== -1) {
        for (; i < end; i++) if (text[i] !== '\n') out[i] = ' '
        prev = '/'
        continue
      }
    }
    if (!/\s/.test(ch)) prev = ch
    i++
  }
  return out.join('')
}

/** Extract `text` from `open` (a bracket) through its match. Operates on already-blanked code, so
 *  no string tracking is needed here. */
function extractBalanced(text, open, oc = '(', cc = ')') {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === oc) depth++
    else if (c === cc) {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

/** The top-level arguments of a call span like `(a, b, c)`, as raw strings. Used to ask whether a
 *  third argument (bun's timeout) is present, without depending on how the formatter wrapped it. */
function topLevelArgs(call) {
  const args = []
  let depth = 0
  let start = 1
  for (let i = 1; i < call.length; i++) {
    const c = call[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (c === ')' && depth === 0) {
        args.push(call.slice(start, i))
        break
      }
      depth--
    } else if (c === ',' && depth === 0) {
      args.push(call.slice(start, i))
      start = i + 1
    }
  }
  return args.map((a) => a.trim())
}

/** Module-level helpers whose body reaches a spawn, closed transitively so a two-hop chain
 *  (listOne -> child -> Bun.spawnSync) resolves. Operates on blanked code. */
function spawnyHelpers(code) {
  const bodies = new Map()
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/g)) {
    const brace = code.indexOf('{', m.index + m[0].length - 1)
    if (brace !== -1) bodies.set(m[1], extractBalanced(code, brace, '{', '}'))
  }
  for (const m of code.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g,
  )) {
    const after = m.index + m[0].length
    const brace = code.indexOf('{', after)
    const nl = code.indexOf('\n', after)
    bodies.set(
      m[1],
      brace !== -1 && (nl === -1 || brace < nl)
        ? extractBalanced(code, brace, '{', '}')
        : code.slice(after, nl === -1 ? code.length : nl),
    )
  }
  const spawny = new Set()
  for (const [n, b] of bodies) if (SPAWN_CALL.test(b)) spawny.add(n)
  for (let changed = true; changed; ) {
    changed = false
    for (const [n, b] of bodies) {
      if (spawny.has(n)) continue
      for (const s of spawny) {
        if (new RegExp(`(?<![\\w.$])${s}\\s*[(<]`).test(b)) {
          spawny.add(n)
          changed = true
          break
        }
      }
    }
  }
  return spawny
}

/** Every test in `text` that reaches a subprocess (directly, or through a module-level helper) and
 *  does not pass an explicit timeout. Exported so the rule can be unit-tested against fixture
 *  strings rather than only against the live tree. */
export function findViolations(text) {
  const code = blankNonCode(text)
  const helpers = spawnyHelpers(code)
  const helperHit = (span) =>
    [...helpers].find((h) => new RegExp(`(?<![\\w.$])${h}\\s*[(<]`).test(span))

  const hits = []
  // `test(name, fn, ms)` puts the timeout third; `beforeAll(fn, ms)` puts it second. Everything else
  // about the rule is identical, so the two only differ by which argument has to be present.
  for (const [head, timeoutArg, kind] of [
    [TEST_HEAD, 2, 'test'],
    [HOOK_HEAD, 1, 'hook'],
  ]) {
    head.lastIndex = 0
    for (const m of code.matchAll(head)) {
      const open = m.index + m[0].length - 1
      let call = extractBalanced(code, open)
      // `test.if(cond)(name, fn, ms)`: the first span is the condition and the real call is the next
      // one. Without this the entire form reads as having no body and no timeout.
      const after = open + call.length
      if (code[after] === '(') call = extractBalanced(code, after)

      const direct = SPAWN_CALL.test(call)
      const via = direct ? null : helperHit(call)
      if (!direct && !via) continue

      const args = topLevelArgs(call)
      // an explicit timeout, whatever its value
      if (args.length > timeoutArg && args[timeoutArg].length > 0) continue

      hits.push({ index: m.index, via, kind })
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** A repo-wide timeout, if this project sets one: `bun test --timeout 20000` in package.json's test
 *  script, or `timeout = N` under bunfig.toml's [test]. Returns the ms value, or null.
 *
 *  This exists because the per-test third argument is NOT the only way to state a timeout, and
 *  assuming it was made this check wrong in the most embarrassing direction: pointed at RepoYeti,
 *  whose every test shells out to git through a helper and whose test script is already
 *  `bun test tests --timeout 20000`, it reported 230 violations of a rule that repo had solved more
 *  thoroughly than AgentHydra has. For a suite where essentially every test spawns, one global
 *  allowance IS the better answer, and a check that can't see it is just noise. If a global timeout
 *  is set, the 5s default this whole check is about does not apply and there is nothing to find. */
export function globalTimeoutMs(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const script = pkg?.scripts?.test
    const m = typeof script === 'string' && script.match(/--timeout[=\s]+(\d+)/)
    if (m) return Number(m[1])
  } catch {}
  try {
    const bunfig = readFileSync(join(root, 'bunfig.toml'), 'utf8')
    // Only under a [test] table; a timeout elsewhere in bunfig means something else entirely.
    const testTable = bunfig.split(/^\s*\[/m).find((s) => s.startsWith('test]'))
    const m = testTable?.match(/^\s*timeout\s*=\s*(\d+)/m)
    if (m) return Number(m[1])
  } catch {}
  return null
}

export const audit = {
  id: ID,
  title: 'a test that spawns a subprocess must set an explicit timeout, not inherit the 5s default',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: the whole cost of this class is paid in CI, on someone else's schedule, as a red run
  // that has nothing to do with the commit under it.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const findings = []

    // A repo-wide allowance settles it for every test at once; there is no 5s default left to
    // inherit, so per-test annotations would be ceremony rather than protection.
    const global = globalTimeoutMs(root)
    if (global !== null) {
      return {
        failed: false,
        findings: [],
        report:
          `This project sets a repo-wide test timeout of ${global}ms, so no test inherits the 5s ` +
          'default and this check has nothing to enforce. ✓',
      }
    }

    for (const file of testFiles(root)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      let text
      try {
        if (statSync(file).size > 2_000_000) continue
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!SPAWN_CALL.test(text)) continue // cheap reject before the call-span scan
      for (const hit of findViolations(text)) {
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          severity: 'error',
          message:
            `This ${hit.kind} reaches a subprocess ${hit.via ? `via ${hit.via}()` : 'directly'} ` +
            "but takes bun's 5s default timeout. Its runtime is set by the machine, not by its " +
            "assertions: sessions-scan-cache.test.ts runs in 533ms locally and took 5083.99ms on " +
            "CI's windows-latest, failing the 2026-08-08 run 84ms over the line." +
            (hit.kind === 'hook'
              ? ' A hook is the worse case: bun blames the timeout on an unnamed test rather than ' +
                'on the hook, so the red run does not even say what timed out. ReDesign lost its ' +
                'windows-latest leg to exactly this on 2026-08-12.'
              : ''),
          fix:
            (hit.kind === 'hook'
              ? 'Pass an explicit timeout as the second argument: `beforeAll(fn, 30_000)`. '
              : 'Pass an explicit timeout as the third argument: `test(name, fn, 30_000)`. ') +
            'Any value counts; the point is that it was chosen. Prefer a named constant with a ' +
            'comment recording the measured local cost, as sessions-scan-cache.test.ts and ' +
            'launcher.test.ts do, so the next person can tell a generous allowance from a guess. ' +
            'If MOST tests in this project spawn (RepoYeti shells out to git nearly everywhere), ' +
            'set one repo-wide allowance instead — `bun test --timeout 20000` in the test script, ' +
            'or [test] timeout in bunfig.toml — and this check stands down entirely.',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} subprocess test(s)/hook(s) on the 5s default:\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join('\n')}`
      : 'Every test that spawns a subprocess sets an explicit timeout. ✓'

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. During an arkitect
// run the module is only IMPORTED, so this block is inert there; it fires only on direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
