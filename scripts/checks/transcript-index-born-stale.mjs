// Guardrail against the transcript index rebuilding forever and blocking the event loop with it.
//
// THE BUG THIS EXISTS TO PREVENT, measured on a real machine on 2026-08-14. server/src/transcript.ts
// keeps a cached index of every transcript file on the box (~23,000 of them here). Building it took
// ~9.5 s. It was stamped like this:
//
//     function buildTranscriptIndex() {
//       const started = performance.now()      // <- captured BEFORE ~9.5 s of work
//       ...
//       return finishIndex(files, started)     // -> cache = { at, files }
//     }
//
// with a two-second TTL. So the snapshot was already ~9.5 s old at the instant it was stored, the
// freshness test was therefore ALWAYS false, and every caller that checked asked for another sweep.
// The daemon rebuilt the index continuously for as long as it ran.
//
// That alone would only waste CPU. What made it a user-facing outage is that the revalidation ran
// the SYNCHRONOUS builder inside a setTimeout, and a sync sweep holds Bun's event loop for its whole
// duration. Measured consequences: `/api/health` — a route that reads nothing at all — answered in
// 6.6 SECONDS, and opening any chat took 16-23 s REGARDLESS of its size (a 672 KB conversation was
// as slow as a 12.6 MB one, because the wait was the queue, not the file). Three chats were reported
// as "very slow to load, or broke". After the fix: warm sweep ~1.05 s, worst event-loop stall 64 ms.
//
// THE THREE RULES, each the direct negation of one part of that bug:
//   A. The snapshot lifetime must be >= 10 s. A TTL shorter than a sweep is unsatisfiable by
//      construction: the snapshot can never be young enough, so the "cache" only ever schedules more
//      work. 2000 is the exact value that shipped the outage.
//   B. The cache assignment must stamp `performance.now()` INLINE. The age of a snapshot is how long
//      ago it became true, which is when the sweep FINISHED — never a timestamp threaded in from
//      before it started. The shorthand `{ at, files }` is the shape that shipped, and is exactly
//      what "decided somewhere else" looks like, so it is a violation on sight.
//   C. No synchronous builder inside a `setTimeout`. That is the shape of the old "background"
//      refresh that was not in the background at all. Deferring a blocking call to a later turn of
//      the loop does not stop it blocking. Revalidation goes through startIndexBuild(), which is
//      async and coalesces concurrent callers onto one sweep.
//
// Self-contained by design: imports nothing from the arkitect core (a bare
// `import "connections-arkitect"` doesn't resolve from a check that lives in the repo rather than
// the runner's node_modules), and returns plain finding objects, which the runner accepts as-is.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'transcript-index-born-stale'
const TARGET = 'server/src/transcript.ts'
const MIN_TTL_MS = 10_000

/** Consume a `//` line comment starting at `i`, blanking it to spaces (the newline that ends it is
 *  left for the main loop). Returns the blanked chunk and the index just past it. */
function skipLineComment(text, i, n) {
  let out = ''
  while (i < n && text[i] !== '\n') {
    out += ' '
    i++
  }
  return { chunk: out, i }
}

/** Consume a `/* ... *\/` block comment starting at `i`, blanking it to spaces while keeping any
 *  newlines inside it. Returns the blanked chunk and the index just past the closing `*\/`. */
function skipBlockComment(text, i, n) {
  let out = ''
  while (i < n && text.slice(i, i + 2) !== '*/') {
    out += text[i] === '\n' ? '\n' : ' '
    i++
  }
  out += '  '
  return { chunk: out, i: i + 2 }
}

/** Consume a quoted string/template literal opened by `quote` at `i`, blanking its interior
 *  (escape pairs included, newlines kept) while preserving the delimiter quotes so call spans
 *  still balance. Returns the blanked chunk and the index just past the closing quote. */
function skipString(text, i, n, quote) {
  let out = quote
  i++
  while (i < n && text[i] !== quote) {
    if (text[i] === '\\') {
      out += ' '
      i++
    }
    if (i < n) {
      out += text[i] === '\n' ? '\n' : ' '
      i++
    }
  }
  if (i < n) {
    out += quote
    i++
  }
  return { chunk: out, i }
}

/** Blank out comments and string bodies, keeping offsets and newlines so line numbers stay honest.
 *  This check's own header DISCUSSES every pattern below in prose, and prose cannot rebuild an
 *  index; spawn-console-window.mjs shipped once reading a sentence as a call. */
function blankNonCode(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      const step = skipLineComment(text, i, n)
      out += step.chunk
      i = step.i
      continue
    }
    if (two === '/*') {
      const step = skipBlockComment(text, i, n)
      out += step.chunk
      i = step.i
      continue
    }
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const step = skipString(text, i, n, ch)
      out += step.chunk
      i = step.i
      continue
    }
    out += ch
    i++
  }
  return out
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** The source span of a call's argument list, from the index of its opening `(`. Brace aware,
 *  because the argument that matters here is an arrow function whose body is full of both. */
function callSpan(code, openParen) {
  let depth = 0
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return code.slice(openParen, i + 1)
    }
  }
  return code.slice(openParen)
}

/**
 * Every violation present in one blob of source.
 *
 * Reports only what is present AND wrong; it never complains that an anchor is missing, because a
 * fixture is a fragment rather than the whole module. audit.run adds the missing-anchor rule, which
 * only makes sense against the real file.
 */
export function findViolations(text) {
  const code = blankNonCode(text)
  const out = []

  // --- A. the TTL must be longer than a sweep ----------------------------------------------------
  for (const m of code.matchAll(/\bconst\s+TTL_MS\s*=\s*([0-9_]+)/g)) {
    const value = Number(m[1].replace(/_/g, ''))
    if (value >= MIN_TTL_MS) continue
    out.push({
      id: ID,
      line: lineAt(code, m.index),
      severity: 'error',
      message:
        `TTL_MS is ${value} ms, under the ${MIN_TTL_MS} ms floor. A whole-store sweep measured ` +
        '~1.05 s warm and ~9.5 s cold on a real machine, so a TTL near that is unsatisfiable: the ' +
        'snapshot is never young enough, every freshness check schedules another sweep, and the ' +
        'daemon rebuilds the index for as long as it runs. TTL_MS was 2000 when /api/health took ' +
        '6.6 s and opening a chat took 16-23 s.',
      fix: `Keep TTL_MS at or above ${MIN_TTL_MS}. It has to exceed how long a sweep TAKES, not how fresh you would like the data to be; a caller that cannot tolerate a stale answer forces its own sweep.`,
    })
  }

  // --- B. the snapshot is stamped on completion --------------------------------------------------
  // Both spellings are read, and the SHORTHAND is the one that shipped the bug: the original wrote
  // `cache = { at, files: result }`, where `at` was a parameter threaded in from before the sweep.
  // A colon-only pattern would sail straight past the exact defect this check exists for.
  for (const m of code.matchAll(/\bcache\s*=\s*\{([^}]*)\}/g)) {
    const prop = /\bat\s*(?::\s*([^,}]+))?/.exec(m[1])
    if (!prop) continue
    const stamp = prop[1]?.trim()
    if (stamp === 'performance.now()') continue
    out.push({
      id: ID,
      line: lineAt(code, m.index),
      severity: 'error',
      message:
        (stamp === undefined
          ? 'The index snapshot is stamped from a variable (`cache = { at, ... }`) rather than'
          : `The index snapshot is stamped with \`${stamp}\` rather than`) +
        ' `performance.now()` read at the moment it is stored. If that value was captured before ' +
        'the sweep — which is exactly what threading a timestamp into the finishing helper does — ' +
        'the snapshot is born older than the TTL and can never be fresh, whatever the TTL says. ' +
        'That is the precise shape of the 2026-08-14 outage.',
      fix: 'Stamp `performance.now()` inline at the assignment. A snapshot’s age is how long ago it became TRUE, which is when the sweep finished — not when it started.',
    })
  }

  // --- C. revalidation is never the synchronous builder ------------------------------------------
  for (const m of code.matchAll(/\bsetTimeout\s*\(/g)) {
    const span = callSpan(code, m.index + m[0].length - 1)
    if (!/\bbuildTranscriptIndex\s*\(/.test(span)) continue
    out.push({
      id: ID,
      line: lineAt(code, m.index),
      severity: 'error',
      message:
        'The synchronous index builder is called from inside a setTimeout. A sync sweep holds the ' +
        'event loop for its whole duration, so this "background" refresh is a full stop for every ' +
        'request in flight — measured at 6.6 s on /api/health, a route that reads nothing.',
      fix: 'Revalidate through startIndexBuild(), which runs the async builder and coalesces concurrent callers onto one sweep. Deferring a blocking call to a later turn of the loop does not stop it blocking.',
    })
  }

  return out
}

const POLL_SOURCE = 'web/src/composables/useData.ts'

/**
 * The interval the web app re-asks for the session list, or null if it cannot be read.
 *
 * Null means "no opinion", never "violation": this rule compares the index's snapshot lifetime
 * against its only real consumer, and a consumer that has moved or been rewritten is a reason to
 * stay quiet rather than to fail a build over a number nobody can see.
 */
function readSessionsPollMs(root) {
  try {
    const text = readFileSync(join(root, POLL_SOURCE), 'utf8')
    const m = /setInterval\(\s*refreshSessions\s*,\s*([0-9_]+)\s*\)/.exec(text)
    return m ? Number(m[1].replace(/_/g, '')) : null
  } catch {
    return null
  }
}

export const audit = {
  id: ID,
  title:
    'the transcript index must be stamped when its sweep FINISHES, kept longer than the sweep takes, and never revalidated synchronously',
  gating: true,
  async run({ root }) {
    const rel = TARGET
    let raw
    try {
      raw = readFileSync(join(root, TARGET), 'utf8')
    } catch {
      // The file moved or was renamed. A check that cannot find its subject must say so rather than
      // pass silently — a green tick for a rule nobody is enforcing is worse than no rule at all,
      // which is the whole lesson of tests/guardrails.test.ts.
      return {
        failed: true,
        findings: [
          {
            id: ID,
            file: rel,
            line: 1,
            severity: 'error',
            message: `${TARGET} not found, so this guardrail checked nothing.`,
            fix: 'Point TARGET at the transcript index module’s new path, or delete this check if the cache is gone.',
          },
        ],
        report: `${TARGET} not found — guardrail could not run.`,
      }
    }

    const findings = findViolations(raw).map((f) => ({ ...f, file: rel }))

    const code = blankNonCode(raw)

    // --- D. the lifetime must also stay AT OR UNDER the client's session-list poll ---------------
    // A cross-file rule, because the two numbers are one decision. Set the TTL above the poll and
    // the tick that notices the snapshot is stale lands only every OTHER time, so a new or renamed
    // session waits two full cycles to show up instead of one. Raising TTL_MS to 15 s against a
    // 12 s poll did exactly that, and review caught it before it shipped. Skipped rather than
    // failed when the poll cannot be read: an unreadable neighbour is not evidence of a bug.
    const ttl = /\bconst\s+TTL_MS\s*=\s*([0-9_]+)/.exec(code)
    const pollMs = readSessionsPollMs(root)
    if (ttl && pollMs !== null) {
      const value = Number(ttl[1].replace(/_/g, ''))
      if (value > pollMs)
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(code, ttl.index),
          severity: 'error',
          message:
            `TTL_MS is ${value} ms but the web app polls the session list every ${pollMs} ms ` +
            `(${POLL_SOURCE}). A snapshot that outlives the poll asking for it means only every ` +
            'other tick can trigger a sweep, so a new, renamed or deleted session takes two poll ' +
            'cycles to appear rather than one.',
          fix: `Keep TTL_MS at or under the ${pollMs} ms poll (and comfortably above a warm sweep, ~1 s). If the poll interval itself changed, move this pair together — they are one decision, not two.`,
        })
    }

    // The anchors, checked only against the real module: if neither the lifetime constant nor the
    // cache assignment is there any more, the rules above matched nothing and this check has
    // quietly stopped enforcing anything.
    if (!/\bconst\s+TTL_MS\s*=\s*[0-9_]+/.test(code))
      findings.push({
        id: ID,
        file: rel,
        line: 1,
        severity: 'error',
        message: 'No `const TTL_MS = <number>` in the transcript index module; rule A checked nothing.',
        fix: 'Keep the snapshot lifetime as a named numeric constant so this guardrail can read it, or update TARGET/this rule to match the new shape.',
      })
    if (!/\bcache\s*=\s*\{[^}]*\bat\b/.test(code))
      findings.push({
        id: ID,
        file: rel,
        line: 1,
        severity: 'error',
        message: 'No `cache = { at… }` assignment in the transcript index module; rule B checked nothing.',
        fix: 'Keep the snapshot assignment in that shape, or update this rule to match the new one.',
      })

    const failed = findings.length > 0
    const report = failed
      ? `The transcript index can rebuild forever and block the loop (${findings.length} problem(s)):\n${findings
          .map((f) => `- ${f.file}:${f.line} — ${f.message.split('. ')[0]}.`)
          .join('\n')}`
      : 'Transcript index: stamped on completion, TTL longer than a sweep, no sync revalidate. ✓'

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
