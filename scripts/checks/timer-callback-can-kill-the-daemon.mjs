// Guardrail against a repeating timer whose callback can take the whole daemon down.
//
// THE FAILURE, found by an adversarial audit on 2026-08-30 in TWO separate timers at once:
// this process installs `uncaughtException` and `unhandledRejection` handlers that call
// `process.exit(1)` — the right thing for a corrupt state, and a loaded gun pointed at every
// setInterval in the codebase. A bare `setInterval(tick, ...)` whose tick does a synchronous
// sqlite read is one lock collision away from killing the queue, the monitor, the courier and
// the HTTP API. scheduler.ts had no try/catch anywhere in the file; monitor.ts had one, but its
// settings read sat one line ABOVE the try, and `setInterval(() => void tick(), ...)` discards
// the rejection that read produces. Neither is exotic: both were written by someone who knew
// the tick could fail, which is why the guard is a static check and not a code review note.
//
// THE RULE: a setInterval callback must not be able to throw out of itself. It satisfies this by
//   (a) being an inline function whose body opens with `try {`,
//   (b) being an inline expression that ends in `.catch(...)`, or
//   (c) naming a function declared in the same file whose body opens with `try {`.
// A tick that fails must be a tick SKIPPED. The next one is a poll interval away.
//
// DELIBERATELY NOT FLAGGED:
//   · setTimeout. A one-shot is usually inside a function that already has a caller to catch it,
//     and flagging every one would bury the signal. The daemon-killing shape measured here is the
//     REPEATING timer that runs unattended for months.
//   · Anything in tests, scripts, or the web app — a test process is meant to die on a throw.
//   · Anything inside a comment or a string literal (this repo's sources discuss their own timers
//     in prose, and spawn-console-window.mjs once read a SENTENCE as a spawn).
//
// Self-contained by design, like its siblings here: node stdlib only, plain finding objects.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'timer-callback-can-kill-the-daemon'

// The three literal forms blankNonCode has to step over. Each takes the source and the index of
// the construct's FIRST character and returns the blanked text plus the index to resume at, so
// the scanner loop below stays a flat three-way choice instead of three nested while loops.

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

/** Blank a block comment through its closing delimiter, keeping newlines so line numbers hold.
 *  An unterminated one runs to the end, exactly as before. */
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
    // Mutually exclusive by construction, as the three sequential ifs here always were.
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

/** The source text from `from` to its balanced closing paren. */
function argsOf(src, from) {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(from, i + 1)
    }
  }
  return src.slice(from)
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** Does this function body open with a try block (ignoring `let`/`const` declarations, which
 *  cannot throw when they are plain initialisers)? */
function opensWithTry(body) {
  const stripped = body
    .replace(/^\s*\{/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of stripped) {
    if (/^(let|const|var)\s+\w+(\s*=\s*(null|false|true|0|''|""|\[\]|\{\}))?\s*;?$/.test(line))
      continue
    return line.startsWith('try')
  }
  return false
}

/** The body text of `function NAME(...)` declared in this source, or null. */
function namedFunctionBody(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const openBrace = src.indexOf('{', m.index + m[0].length)
  if (openBrace < 0) return null
  let depth = 0
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(openBrace, i + 1)
    }
  }
  return null
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'tests') continue
      walk(p, out)
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** Every unguarded repeating timer in ONE source text. Exported so tests/guardrails.test.ts can
 *  fire it at the two real bugs this was written from, rather than trusting a clean tree. */
export function findViolations(text) {
  const code = blankNonCode(text)
  const out = []
  const re = /setInterval\s*\(/g
  let m
  while ((m = re.exec(code)) !== null) {
    const args = argsOf(code, m.index + m[0].length - 1)
    let guarded = false
    // (c) a bare named callback: setInterval(tick, ms)
    const named = /^\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(args)
    if (named) {
      const body = namedFunctionBody(code, named[1])
      guarded = body ? opensWithTry(body) : false
    } else {
      // (a) inline function whose body opens with try, or (b) an expression ending .catch(...)
      guarded = /\.catch\s*\(/.test(args)
      if (!guarded) {
        const arrow = args.indexOf('=>')
        const fnBody = arrow >= 0 ? args.slice(arrow + 2) : args
        guarded = opensWithTry(fnBody)
      }
    }
    if (guarded) continue
    out.push({
      id: ID,
      line: lineAt(code, m.index),
      severity: 'error',
      message:
        'This setInterval callback can throw out of itself. The daemon installs ' +
        'uncaughtException and unhandledRejection handlers that call process.exit(1), so one ' +
        'failed tick - a locked sqlite read is enough - takes down the queue, the monitor, ' +
        'the courier and the HTTP API together. Measured twice on 2026-08-30: scheduler.ts ' +
        'had no try/catch at all, and monitor.ts had one that its first statement sat above.',
      fix:
        'Wrap the tick body in try/catch and log the error (a failed tick is a tick SKIPPED; ' +
        'the next is one interval away), or attach .catch() to the promise the callback ' +
        'returns. Put EVERY statement inside the try, including the enabled/settings read - ' +
        'that read is a synchronous database call and is exactly the one that failed.',
    })
  }
  return out
}

export const audit = {
  id: ID,
  title: 'A repeating timer must not be able to kill the daemon',
  gating: true,
  async run({ root }) {
    const srcDir = join(root, 'server', 'src')
    let files = []
    try {
      if (statSync(srcDir).isDirectory()) files = walk(srcDir)
    } catch {
      return { failed: false, findings: [], report: 'no server/src to scan. ✓' }
    }

    const findings = []
    let checked = 0
    for (const file of files) {
      const raw = readFileSync(file, 'utf8')
      checked += (blankNonCode(raw).match(/setInterval\s*\(/g) ?? []).length
      const rel = relative(root, file).split(sep).join('/')
      for (const v of findViolations(raw)) findings.push({ ...v, file: rel })
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} unguarded repeating timer(s):\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join('\n')}`
      : `All ${checked} repeating timer(s) in server/src are guarded against a throw. ✓`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
