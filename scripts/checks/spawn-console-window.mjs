// Guardrail against a phantom console window flashing on an ordinary click.
//
// A spawned console-subsystem program (powershell, cmd, taskkill, bun, node, claude, npm, wmic,
// reg) allocates its OWN console UNLESS the spawn explicitly says not to. Today nothing visibly
// breaks: misc/Tray-Host.ps1 launches the daemon with ProcessStartInfo.CreateNoWindow=true, so the
// daemon itself has NO console, and a console CHILD spawned from a console-less parent quietly gets
// none either. That is INHERITANCE, not intent; it only holds for exactly this one launch path.
// Start the same daemon from a terminal, from Explorer, or as the compiled portable exe (all real
// launch paths for this app) and the daemon HAS a console, so the very same spawn call allocates a
// real, visible one, and it flashes on screen for whatever ordinary action triggered it (opening a
// file, copying to clipboard, killing a stray process). This repo already shipped exactly this class
// of bug once: see the long comment at server/src/dispatch.ts (~line 312) on Win32_Process.Create
// applying a default STARTUPINFO and handing the WMI-launched runner a real, visible console,
// "Verified 2026-07-15". The fix there, and the rule this check enforces everywhere else, is to
// state the intent (`windowsHide: true`) at every spawn of a console program, so the outcome no
// longer depends on how the daemon happened to be started.
//
// WHAT COUNTS AS SATISFIED, two legitimate shapes:
//   · `windowsHide: true` in the Bun.spawn/nodeSpawn/spawn options object (the normal case).
//   · A WMI `Win32_ProcessStartup` `ShowWindow = [uint16]0` (the ONLY other way to hide a
//     Win32_Process.Create-launched window, needed because Win32_ProcessStartup rejects
//     CreateFlags=CREATE_NO_WINDOW outright with ReturnValue 21, "invalid parameter"). See
//     server/src/dispatch.ts's WMI runner launch and server/src/detached-spawn.mjs's header.
//
// DELIBERATELY NOT FLAGGED:
//   · server/src/core/cli-instances.ts: every spawn there (`cmd /k`, x-terminal-emulator) is an
//     INTENTIONAL user-facing terminal window; hiding it would defeat the feature.
//   · server/src/core/crypto/keys.mac.ts, keys.linux.ts: non-Windows; console-window allocation is
//     a win32-only concept.
//   · Any spawn whose argv is NOT a literal array containing a known console-program name (e.g. a
//     variable built elsewhere, or a spec read from disk); a text scan cannot safely resolve those,
//     and a wrong guess here is worse than a miss. Narrow and low-false-positive beats clever.
//     The ONE exception is CONSOLE_RESOLVERS below: a helper whose whole job is to return a console
//     program's path is as good as a literal, and treating it as one is what catches usage.ts. That
//     site (a periodic `claude -p /usage`) is the worst case in the repo precisely because it hid
//     behind a function call: resolveClaudeExe() falls back to `claude.cmd`, a BATCH file, which
//     runs through cmd.exe, so on a machine without the packaged claude.exe an unhidden spawn is a
//     CMD window flashing on a timer with no user action to blame. The literal-argv rule alone had
//     a blind spot exactly the shape of the bug this check exists to prevent.
//   · Anything inside a `//` or `/* */` comment: a comment cannot allocate a console window, and
//     these files discuss their own spawns by name in prose (see blankComments below).
//
// Self-contained by design: imports nothing from the arkitect core (a bare
// `import "connections-arkitect"` doesn't resolve from a check that lives in the repo rather than
// the runner's node_modules), and returns plain finding objects, which the runner accepts as-is.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'spawn-console-without-windows-hide'

// Program names that allocate a console window on win32 when spawned without windowsHide.
const CONSOLE_PROGRAMS = ['powershell', 'cmd', 'taskkill', 'bun', 'node', 'claude', 'npm', 'wmic', 'reg']
// Matches a quoted argv element whose ENTIRE content (between the quotes) is one of those names,
// with an optional .exe/.cmd suffix, e.g. 'powershell', "cmd.exe", 'taskkill'. Bounded by the quote
// characters so it can't match a substring of an unrelated identifier or path.
const PROGRAM_LITERAL = new RegExp(
  `['"](?:${CONSOLE_PROGRAMS.join('|')})(?:\\.exe|\\.cmd)?['"]`,
  'i',
)
// Helpers that RESOLVE to a console program's path. argv[0] being a call to one of these is as
// certain as a string literal, so they count as naming a console program.
const CONSOLE_RESOLVERS = ['resolveClaudeExe']
const PROGRAM_RESOLVER = new RegExp(`\\b(?:${CONSOLE_RESOLVERS.join('|')})\\s*\\(`)

// The INVERSE rule. Bun's windowsHide is libuv's hide flag, which sets STARTUPINFO SW_HIDE as well
// as CREATE_NO_WINDOW. A console app ignores SW_HIDE; a GUI app OBEYS it. So windowsHide on a GUI
// program hides the very window the spawn exists to open, and the call still succeeds, which is why
// it survives review: the route returns ok and nothing appears. This is not hypothetical. A
// well-meant "hide every spawn" pass put windowsHide on `explorer` here and silently broke reveal
// instance folder (measured 2026-07-16: plain opened 1 Explorer window, windowsHide opened 0).
// Only LITERAL GUI names are listed; a launcher whose argv is a variable (portable-window.mjs's
// browser, which hands off via WMI so its windowsHide only hides the transient powershell) is
// correctly invisible to this rule.
const GUI_PROGRAMS = ['explorer', 'code', 'cursor', 'notepad', 'notepad++', 'subl', 'msedge', 'chrome']
const GUI_LITERAL = new RegExp(
  `['"](?:${GUI_PROGRAMS.map((p) => p.replace(/\+/g, '\\+')).join('|')})(?:\\.exe)?['"]`,
  'i',
)

// Either legitimate way to hide the window: a plain windowsHide option, or the WMI
// Win32_ProcessStartup ShowWindow=0 shape used to hide a Win32_Process.Create-launched grandchild.
const WINDOWS_HIDE_TRUE = /windowsHide\s*:\s*true/
const WMI_SHOW_WINDOW_HIDDEN = /ShowWindow\s*=\s*\[uint16\]0/
const isHidden = (callText) => WINDOWS_HIDE_TRUE.test(callText) || WMI_SHOW_WINDOW_HIDDEN.test(callText)

// Call heads this check looks at: `Bun.spawn(`, `nodeSpawn(`, or a bare `spawn(` (the
// node:child_process import used directly, e.g. github-updater.ts). The negative lookbehind keeps a
// bare `spawn(` from matching mid-identifier (nothing in this repo is named `*spawn`, but staying
// precise costs nothing).
const SPAWN_CALL_HEAD = /(?:Bun\.spawn|nodeSpawn|(?<![\w.])spawn)\s*\(/g

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.arkitect', 'coverage', 'build'])
const EXTS = ['.ts', '.mjs']
// Relative (posix-style) paths this check deliberately never scans; see header for WHY each one.
const SKIP_FILES = new Set([
  'server/src/core/cli-instances.ts',
  'server/src/core/crypto/keys.mac.ts',
  'server/src/core/crypto/keys.linux.ts',
])

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
 *  parens that appear inside string/template literals. Falls back to the rest of the file on an
 *  unterminated call (shouldn't happen in valid source, but never throw over it). */
function extractCall(text, openParenIndex) {
  let depth = 0
  let inString = null
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i++ // skip the escaped character, whatever it is
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

// A `/` opens a REGEX LITERAL only where an expression is expected; anywhere else it is division.
// The preceding non-whitespace character decides, and these are the ones that end such a position.
// Getting this right is not cosmetic: a regex is the one construct that can carry a bare quote, and
// a missed one desyncs the string tracking below for the whole REST OF THE FILE (see blankComments).
const REGEX_OPENS_AFTER = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'],
)
// The same position reached via a keyword rather than a punctuator, e.g. `return /x/.test(s)`.
const REGEX_OPENS_AFTER_KEYWORD = /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/

/** Consume the regex literal starting at `text[start]` (its opening `/`). Returns the index just
 *  past the closing `/`, or -1 if it never closes on that line, in which case the `/` was not a
 *  regex after all. `/` inside a `[...]` character class is literal, so classes are tracked. */
function endOfRegex(text, start) {
  let inClass = false
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') {
      j++ // an escaped character, `\/` included, is never a delimiter
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

/** Blank out `//` line and block comments, so a spawn call merely NAMED IN PROSE is not read as a
 *  real one. This scan is textual and these files document their own win32 spawn story in detail:
 *  server/src/detached-spawn.mjs's header explains which shell `spawn("powershell")` resolves to,
 *  and that sentence alone was a finding until this existed. A comment cannot allocate a console
 *  window, so scanning one can only ever produce a false positive.
 *
 *  Comment bodies become SPACES rather than being removed, and newlines are kept, so every byte
 *  keeps its original offset: `lineAt` reports against the untouched text, and it must still agree.
 *
 *  Strings AND regex literals are both tracked, and the regex half is not optional. The first cut
 *  skipped it and stayed red on the very file it was written for: quoteWinArg's
 *  `!/[ \t\n\v"]/.test(arg)` carries a `"` inside a character class, which opened a string that
 *  never closed, so every `//` for the next sixty lines looked like string content and the prose
 *  spawn survived. A desync here inverts code and string wholesale, so it produces FALSE POSITIVES,
 *  not misses — the expensive direction, and the reason this tracks more than the naive scanner in
 *  extractCall does. */
function blankComments(text) {
  const out = text.split('')
  let inString = null
  // Last non-whitespace character of CODE seen, the regex-vs-division discriminator above. A closing
  // quote counts (`"a" / 2` is division); characters inside strings and comments never do.
  let prev = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i += 2 // an escaped character, whatever it is, can never end the string
        continue
      }
      if (ch === inString) {
        inString = null
        prev = ch
      }
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
    if (ch === '/' && (prev === '' || REGEX_OPENS_AFTER.has(prev) || REGEX_OPENS_AFTER_KEYWORD.test(text.slice(0, i).trimEnd()))) {
      const end = endOfRegex(text, i)
      if (end !== -1) {
        i = end // skipped whole; any quote it carried never reaches the string tracker
        prev = '/'
        continue
      }
    }
    if (!/\s/.test(ch)) prev = ch
    i++
  }
  return out.join('')
}

/** Every spawn call in `text` whose argv names a console program (as a literal, or via a
 *  CONSOLE_RESOLVERS helper) and whose call (argv + options) sets neither windowsHide nor the WMI
 *  ShowWindow=0 hide. Exported so the rule can be unit-tested against fixture strings rather than
 *  only against the live tree. */
export function findViolations(text) {
  const hits = []
  // Comments are blanked index-for-index, so every hit index below still points at the same offset
  // in the caller's original `text`.
  const code = blankComments(text)
  SPAWN_CALL_HEAD.lastIndex = 0
  for (const head of code.matchAll(SPAWN_CALL_HEAD)) {
    const openParenIndex = head.index + head[0].length - 1
    const callText = extractCall(code, openParenIndex)
    const clean = (m) => m[0].replace(/['"(\s]/g, '')

    // Inverse rule first: a GUI program must NOT be hidden, and that mistake is the more damaging
    // one (it breaks a working feature rather than leaving a cosmetic flash).
    const guiMatch = callText.match(GUI_LITERAL)
    if (guiMatch && isHidden(callText)) {
      hits.push({ index: head.index, program: clean(guiMatch), kind: 'gui-hidden' })
      continue
    }

    const programMatch = callText.match(PROGRAM_LITERAL) ?? callText.match(PROGRAM_RESOLVER)
    if (!programMatch) continue // argv names nothing we can resolve to a console program; can't tell
    if (isHidden(callText)) continue
    hits.push({ index: head.index, program: clean(programMatch), kind: 'console-unhidden' })
  }
  return hits.sort((a, b) => a.index - b.index)
}

export const audit = {
  id: ID,
  title: 'console spawns (server/src) must be hidden; GUI spawns must NOT be',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: this doesn't crash or misbehave in the common case; the daemon's usual launch path
  // happens to have no console to inherit from, so it stays invisible. It only bites the moment
  // someone starts the daemon a different way, which is exactly when a user sees a console flash.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const start = join(root, 'server', 'src')
    const findings = []

    for (const file of sourceFiles(start)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      if (SKIP_FILES.has(rel)) continue
      let text
      try {
        if (statSync(file).size > 2_000_000) continue // no source file here is this big; skip pathological
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!text.includes('spawn(')) continue // cheap reject before the call-head scan
      for (const hit of findViolations(text)) {
        const guiHidden = hit.kind === 'gui-hidden'
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          kind: hit.kind,
          severity: 'error',
          message: guiHidden
            ? `Spawns '${hit.program}' (a GUI program) WITH a hide flag. Bun's windowsHide is libuv's ` +
              'hide flag, which sets STARTUPINFO SW_HIDE as well as CREATE_NO_WINDOW. A console app ' +
              'ignores SW_HIDE; a GUI app obeys it, so this hides the very window the spawn exists to ' +
              'open. The call still succeeds and the route still returns ok, so nothing looks wrong ' +
              'except that nothing appears.'
            : `Spawns '${hit.program}' (a console-subsystem program) without \`windowsHide: true\` ` +
              'and without a WMI ShowWindow=0 hide. It only stays invisible today because the daemon ' +
              'happens to be launched with a window-less console of its own (misc/Tray-Host.ps1 sets ' +
              'CreateNoWindow=true) and a console child inherits that. Launched any other way, a ' +
              'terminal, Explorer, the compiled portable exe, this same spawn allocates a real, ' +
              'visible console window that flashes on screen for an ordinary action.',
          fix: guiHidden
            ? 'Remove windowsHide from this spawn. To launch a GUI program without a console flash, hand it off instead (`cmd /c start "" <target>` hides only the transient cmd, because start ShellExecutes the target as a fresh process that inherits none of our STARTUPINFO).'
            : `Add \`windowsHide: true\` to the spawn's options object (or, for a WMI Win32_Process.Create launch, set Win32_ProcessStartup ShowWindow=0; CREATE_NO_WINDOW is rejected there with ReturnValue 21).`,
        })
      }
    }

    const failed = findings.length > 0
    // Name the two directions separately: "without windowsHide" on a GUI finding would send the
    // reader to add the very flag they need to remove.
    const report = failed
      ? `Found ${findings.length} mis-hidden spawn(s):\n` +
        findings
          .map(
            (f) =>
              `- ${f.file}:${f.line} ${f.kind === 'gui-hidden' ? 'GUI program hidden (remove windowsHide)' : 'console program not hidden (add windowsHide)'}`,
          )
          .join('\n')
      : 'Every console spawn under server/src is hidden, and no GUI spawn is. ✓'

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
