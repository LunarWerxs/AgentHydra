// Guardrail for the agent catalog's PROVENANCE: a row whose paths nobody has ever checked against
// the tool's own source is a claim, and this repo should be able to say how many of those it makes.
//
// THE BUG THIS EXISTS TO PREVENT, measured on 2026-09-04. `server/src/agent-catalog.ts` lists 58
// coding agents and where each keeps its conversations. Its own header says a wrong path is
// harmless, because it "costs one `stat` and produces nothing". Both halves of that are true, and
// together they are the problem:
//
//   A row pointing at a directory that does not exist produces exactly what a row pointing at a
//   correct directory produces on a machine where the tool is not installed: nothing.
//
// So a wrong row cannot be told from an absent tool by looking at the output, no matter how many
// machines run it, and it lives forever. Three rows were checked against upstream source that day,
// and all three were wrong in that undetectable way:
//
//   * Hermes Agent (241k stars) pointed at `.hermes/sessions` under `HERMES_SESSIONS_DIR`. Neither
//     exists: `hermes_constants.py` puts one SQLite file, `state.db`, at the root of `HERMES_HOME`.
//   * OpenClaw (389k stars) pointed at `.openclaw/agents` under `OPENCLAW_DIR`. `src/config/paths.ts`
//     has no `agents` directory; the state dir is `~/.openclaw` itself and the variable is
//     `OPENCLAW_STATE_DIR`.
//   * aider carried `dirs: []`, which `rootsFor` turns into zero candidates - unmatched by
//     construction on every machine that did not set `AIDER_DIR`.
//
// WHAT THIS CHECK CAN AND CANNOT DO. It cannot know upstream truth; only a person or an agent
// reading the tool's source can, and pretending otherwise would build a gate that lies. What it can
// do is make the unchecked set VISIBLE and STOP IT GROWING BACK, which is precisely what was
// missing. Hence a ratchet, not a threshold: the number of rows carrying `verified:` may rise and
// may never fall, so verifying a row is permanent and a new unverified row is free. Deliberately
// NOT an error, because 55 unverified rows failing every build is a gate nobody would keep.
//
// THE THREE RULES:
//   A. RATCHET. `verified` count must be >= VERIFIED_FLOOR. Removing a marker fails the build.
//      When you verify more rows, raise the floor in the same commit - the check tells you to.
//   B. A `verified` marker must NAME ITS SOURCE. The value has to mention a real-looking upstream
//      file (an extension) and a date, so the field cannot be set to "yes" or "trust me". A claim
//      that cannot be re-checked is worse than no claim, because it stops anyone re-checking.
//   C. A ROW MUST BE ABLE TO MATCH. `dirs: []` with no `envVar` can never produce a candidate, so
//      the row is dead code pretending to be coverage. (An empty `dirs` WITH an `envVar` is legal
//      and deliberate: opt-in, reachable only when the user points the variable at a store.)

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'catalog-row-provenance'
const REL = 'server/src/agent-catalog.ts'

/**
 * Rows verified against upstream source, as of the last time anyone did the work.
 *
 * RAISE THIS when you verify a row; never lower it. It is the ratchet's whole mechanism: a floor
 * that only moves up is a promise that verification is not silently undone by a later refactor.
 */
const VERIFIED_FLOOR = 3

/**
 * Parse the catalog's row literals without importing it (this file must run under plain node).
 *
 * Anchored on each `id:` and scanning forward to the row's closing `  },` rather than on the
 * opening `{`. The first cut anchored on `{\s*\n\s*id:` and silently dropped the ONE row that
 * carries a comment between its brace and its id (`cowork`) - 57 of 58, reported as a clean pass.
 * A guardrail written against silent under-reporting must not itself under-report, so the caller
 * also cross-checks this count against a plain count of `id:` lines and fails on any disagreement.
 */
function parseRows(code) {
  const start = code.indexOf('export const AGENT_TOOLS')
  if (start === -1) return null
  const body = code.slice(start)
  const rows = []
  for (const m of body.matchAll(/^ {4}id: '([^']+)',$/gm)) {
    const id = m[1]
    const end = body.indexOf('\n  },', m.index)
    const block = end === -1 ? body.slice(m.index) : body.slice(m.index, end)
    rows.push({
      id,
      block,
      envVar: /\n\s*envVar: '([^']*)'/.exec(block)?.[1] ?? null,
      dirsRaw: /\n\s*dirs: (\[[\s\S]*?\])/.exec(block)?.[1] ?? null,
      verified: /\n\s*verified: '([^']*)'/.exec(block)?.[1] ?? null,
    })
  }
  return rows
}

/**
 * The blob-local rules (0, B and C) over the catalog's source text.
 *
 * Rule A, the ratchet, is deliberately NOT here: it is a statement about the repo as a whole
 * ("verification may not be undone"), not about any one piece of text, and putting a global floor
 * inside a per-blob predicate would make every small fixture fail for being small. It lives in
 * audit.run below, where the whole catalog is in view.
 *
 * Returns `[{ id, line, message, fix }]`, empty when the text is clean. Exported because
 * tests/guardrails.test.ts drives every check through this signature with a broken and a fixed
 * fixture, so the check is proven to still FIRE rather than merely to be passing today.
 */
export function findViolations(code) {
  const hits = []
  const table = code.indexOf('export const AGENT_TOOLS')
  if (table === -1) return hits
  const rows = parseRows(code) ?? []
  const lineOf = (needle) => code.slice(0, code.indexOf(needle)).split('\n').length

  // Rule 0, aimed at this guardrail itself: every `id:` line in the table must have become a row.
  // A parser that quietly matches 57 of 58 reports a clean bill of health over a row it never read,
  // which is the same silence the whole check exists to break. Cross-check, then fail loud.
  //
  // The counting pattern is deliberately LOOSER than parseRows' - any indent, any spacing - and
  // that is the whole point. The first cut reused the parser's own strict pattern, so a malformed
  // `id:  'zed',` broke both identically, the two counts agreed at 57, and the check passed over a
  // row nothing had read. A cross-check that shares the parser's assumptions cannot see the
  // parser's blind spots; it has to be able to find rows the parser cannot.
  const declared = (code.slice(table).match(/^\s*id:\s*'[^']+',\s*$/gm) ?? []).length
  if (declared !== rows.length)
    hits.push({
      id: ID,
      line: 1,
      message: `This guardrail parsed ${rows.length} rows but the catalog declares ${declared}, so ${declared - rows.length} row(s) were checked by nothing.`,
      fix: 'The row literal shape changed; update parseRows() in this guardrail to match it.',
    })

  // Rule C: a row that can never produce a candidate. An empty `dirs` WITH an `envVar` is legal and
  // deliberate (opt-in: reachable only when the user points the variable at a store).
  for (const r of rows) {
    if (r.dirsRaw !== null && /^\[\s*\]$/.test(r.dirsRaw) && !r.envVar)
      hits.push({
        id: ID,
        line: lineOf(`id: '${r.id}'`),
        message: `Row '${r.id}' has an empty \`dirs\` and no \`envVar\`, so rootsFor() can never return a candidate for it on any machine.`,
        fix: "Give it a home-relative path from the tool's own source, or an envVar that makes it opt-in, or delete the row.",
      })
  }

  // Rule B: a verified marker has to name something re-checkable.
  for (const r of rows.filter((x) => x.verified !== null)) {
    const namesAFile = /\.[a-z]{2,5}\b/.test(r.verified)
    const namesADate = /\d{4}-\d{2}-\d{2}/.test(r.verified)
    if (!namesAFile || !namesADate)
      hits.push({
        id: ID,
        line: lineOf(`id: '${r.id}'`),
        message: `Row '${r.id}' claims \`verified: '${r.verified}'\` but does not name ${namesAFile ? 'a date' : 'an upstream file'}, so the claim cannot be re-checked.`,
        fix: "Use the form '<owner>/<repo> <path/to/file.ext> (YYYY-MM-DD)'.",
      })
  }

  return hits
}

export const audit = {
  id: ID,
  title: 'Agent catalog rows: provenance ratchet, and no row that cannot match',
  gating: true,
  async run({ root = process.cwd() } = {}) {
    const findings = []
    let code
    try {
      code = readFileSync(join(root, REL), 'utf8')
    } catch {
      return {
        failed: true,
        findings: [
          {
            id: ID,
            file: REL,
            line: 1,
            severity: 'error',
            message: 'The agent catalog could not be read, so none of its rules were checked.',
            fix: `Keep the catalog at ${REL}, or update this guardrail to its new home.`,
          },
        ],
        report: `Agent catalog: ${REL} is missing, so this guardrail checked NOTHING.`,
      }
    }

    const rows = parseRows(code)
    if (!rows || rows.length === 0) {
      // A parser that silently matches zero rows would report a clean bill of health over a file it
      // never understood - the exact false green this guardrail is about.
      return {
        failed: true,
        findings: [
          {
            id: ID,
            file: REL,
            line: 1,
            severity: 'error',
            message: 'No catalog rows could be parsed, so every rule below checked nothing.',
            fix: 'The row literal shape changed; update parseRows() in this guardrail to match it.',
          },
        ],
        report: 'Agent catalog: parsed 0 rows, so this guardrail checked NOTHING.',
      }
    }

    // The blob-local rules (0, C, B) live in findViolations so tests/guardrails.test.ts can prove
    // they still fire against a broken fixture. Only the ratchet is evaluated here.
    findings.push(...findViolations(code).map((h) => ({ ...h, file: REL, severity: 'error' })))

    // Rule A: the ratchet.
    const verified = rows.filter((r) => r.verified !== null)
    if (verified.length < VERIFIED_FLOOR)
      findings.push({
        id: ID,
        file: REL,
        line: 1,
        severity: 'error',
        message: `${verified.length} rows carry \`verified\`, below the floor of ${VERIFIED_FLOOR}. Verification was removed, not added.`,
        fix: 'Restore the marker, or - if the row itself is gone - lower VERIFIED_FLOOR in this guardrail and say why in the commit.',
      })

    const unverified = rows.length - verified.length
    const failed = findings.length > 0
    const raise =
      verified.length > VERIFIED_FLOOR
        ? `\n  Raise VERIFIED_FLOOR to ${verified.length} in this guardrail to lock the new ones in.`
        : ''
    const report = failed
      ? `Agent catalog provenance (${findings.length} problem(s)):\n${findings
          .map((f) => `- ${f.file}:${f.line} - ${f.message}`)
          .join('\n')}`
      : `Agent catalog: ${rows.length} rows, ${verified.length} verified against upstream source, ${unverified} still from the agentsview registry.${raise}\n` +
        `  Unverified rows are a known gap, not a failure - a wrong path there finds nothing and reads as "not installed".\n` +
        `  To close one: find the tool's own path constants, fix the row if they disagree, add \`verified: '<repo> <file> (<date>)'\`, raise the floor. ✓`

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
