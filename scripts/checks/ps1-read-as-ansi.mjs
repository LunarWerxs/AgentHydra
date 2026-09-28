// Guardrail: install.ps1 must survive being read in the ANSI code page.
//
// Windows PowerShell 5.1 (powershell.exe, the PowerShell every Windows box has) decodes a script
// file with no byte-order mark as the machine's ANSI code page, not UTF-8. An em dash is E2 80 94
// in UTF-8, and in code page 1252 byte 0x94 is a right curly double quote, which PowerShell treats
// as a real `"`. So every em dash inside a "..." string closed that string early, and
// `powershell -File install.ps1` failed to PARSE at all ("Missing closing '}' in statement block",
// reproduced 2026-09-28). The documented `irm | iex` path decodes the download as UTF-8 and hid it;
// the test suite ran only under pwsh 7, which defaults to UTF-8 and hid it too.
//
// The rule: a checked file is pure ASCII, or it starts with a UTF-8 BOM (which 5.1 honours). ASCII
// is the fix install.ps1 uses: a BOM would ride along into the `irm | iex` string as U+FEFF.
//
// WHY ONLY install.ps1: it is the one script a user runs standalone, before anything of ours is
// installed, from whatever PowerShell they have. The other tracked .ps1 files carry non-ASCII only
// in comments today and parse cleanly under 1252 (checked 2026-09-28 by parsing each one exactly as
// 5.1 reads it); add a file to TARGETS when that stops being true.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'ps1-non-ascii-without-bom'
const TARGETS = ['install.ps1']
const BOM = '﻿'

/** Every non-ASCII character in a BOM-less script, one finding per offending line. */
export function findViolations(text) {
  if (text.startsWith(BOM)) return []
  const out = []
  text.split('\n').forEach((line, i) => {
    const bad = [...line].filter((ch) => ch.codePointAt(0) > 0x7f)
    if (bad.length === 0) return
    const shown = [...new Set(bad)]
      .map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
      .join(', ')
    out.push({
      id: ID,
      line: i + 1,
      severity: 'error',
      message:
        `has non-ASCII (${shown}) and no UTF-8 BOM. Windows PowerShell 5.1 reads a BOM-less ` +
        'script in the ANSI code page, where these bytes can decode to a quote character and ' +
        'end a string early: `powershell -File` then fails to parse the whole script.',
      fix: 'Replace it with ASCII (an em dash becomes " - "). Do not add a BOM to install.ps1: `irm | iex` would carry it into the script text.',
    })
  })
  return out
}

export const audit = {
  id: ID,
  title: 'install.ps1 must be pure ASCII (or carry a UTF-8 BOM) so Windows PowerShell 5.1 can parse it',
  gating: true,
  async run({ root = process.cwd() } = {}) {
    const findings = []
    for (const rel of TARGETS) {
      const file = join(root, rel)
      // A missing target means this check has drifted from the repo, not that the repo is clean.
      if (!existsSync(file)) {
        findings.push({
          id: ID,
          file: rel,
          line: 1,
          message: `${rel} not found; fix this check's TARGETS rather than trusting its pass.`,
        })
        continue
      }
      for (const v of findViolations(readFileSync(file, 'utf8'))) {
        findings.push({ ...v, file: rel, message: `${rel} ${v.message}` })
      }
    }
    const failed = findings.length > 0
    const report = failed
      ? `PowerShell 5.1 encoding: ${findings.length} problem(s):\n` +
        findings.map((f) => `- ${f.file}:${f.line} ${f.message}`).join('\n')
      : `${TARGETS.join(', ')}: pure ASCII or BOM-marked, safe for Windows PowerShell 5.1.`
    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
