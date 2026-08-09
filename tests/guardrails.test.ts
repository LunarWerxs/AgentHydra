// tests/guardrails.test.ts: proves the repo's custom checks themselves work, not just that the
// repo currently passes them. Two real failures motivate this file:
//   · reka-trigger-tooltip-button.mjs (2026-07-16) encoded a wrong diagnosis AND crashed on import
//     (`Cannot find package 'connections-arkitect'`), so it never ran at all. A check that throws
//     and a check that passes look the same from a distance.
//   · spawn-console-window.mjs's first cut had a blind spot shaped exactly like the bug it exists to
//     catch: it only saw literal argv, so a resolveClaudeExe() spawn slipped through unnoticed.
// "The check passes" is not evidence the check works; it might not even be running. So for every
// check under scripts/checks, discovered by reading the directory (never hardcoded, so
// a new check cannot silently dodge this file), we: import it for real, assert it exports a
// well-formed gating audit, run it against the live repo root, and, for every check that exposes
// findViolations, prove it actually fires on the broken shape it claims to catch and stays quiet on
// the fixed one. A guardrail that cannot fail is not a guardrail.

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = join(import.meta.dir, '..')
// The checks used to live under .arkitect/your-checks/code. That directory was deleted wholesale
// on 2026-07-27 while both this file and ci.yml still pointed at it, which is exactly the
// can-a-guardrail-silently-stop-running failure this file exists to catch. They now live in
// scripts/checks and depend on nothing but bun.
const CHECKS_DIR = join(REPO_ROOT, 'scripts', 'checks')

// Discovered, not hardcoded: a check dropped into this directory is automatically subject to every
// assertion below, including the fire / stay-quiet fixtures wired through FIXTURES_BY_FILE.
const CHECK_FILES = readdirSync(CHECKS_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()

// Assembled at runtime, never written as a contiguous literal in this file's source: see the
// wmi-commandline-query-self-match fixtures below for why.
const CMD_LINE = 'Command' + 'Line'

// Bespoke broken / fixed text for each check that exports findViolations, written from the real bug
// each check's own header comment documents, not a synthetic near-miss. A check that exports
// findViolations but has no entry here fails loudly below rather than being silently skipped.
const FIXTURES_BY_FILE: Record<string, { broken: string[]; fixed: string[] }> = {
  'reka-popper-root-inside-tooltip.mjs': {
    broken: [
      // DropdownMenu wraps AROUND the IconTooltip, so DropdownMenuTrigger's nearest PopperRoot is
      // the tooltip's own and the menu's popper never gets anchored (the real SessionsView.vue bug,
      // fixed 2026-07-16: menu opened off-screen and, being modal, froze the whole app's pointer
      // events).
      `
      <DropdownMenu>
        <IconTooltip :label="$t('sessions.listOptions')">
          <span class="inline-flex">
            <DropdownMenuTrigger as-child>
              <button type="button"><MoreHorizontal /></button>
            </DropdownMenuTrigger>
          </span>
        </IconTooltip>
        <DropdownMenuContent align="end" class="w-56" />
      </DropdownMenu>
      `,
    ],
    fixed: [
      // The actual shape web/src/components/SessionsView.vue ships today: IconTooltip contains a
      // <span> anchor, which contains the whole DropdownMenu including its own trigger and content.
      `
      <IconTooltip :label="$t('sessions.listOptions')">
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button type="button"><MoreHorizontal /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56" />
          </DropdownMenu>
        </span>
      </IconTooltip>
      `,
    ],
  },
  'spawn-console-window.mjs': {
    broken: [
      // Direction A: a console-subsystem program (powershell) spawned with no windowsHide at all.
      // invisible only by accident of how the daemon happens to be launched today; a terminal,
      // Explorer, or the compiled exe all get a real, visible console flash from this same call.
      `Bun.spawn(['powershell', '-Command', script])`,
      // Direction B: a GUI program (explorer) spawned WITH windowsHide. Bun's windowsHide sets
      // STARTUPINFO SW_HIDE, which a GUI app obeys, so this hides the very window the spawn exists
      // to open (measured 2026-07-16: plain opened 1 Explorer window, windowsHide opened 0).
      `Bun.spawn(['explorer', dir], { windowsHide: true })`,
    ],
    fixed: [
      `
      Bun.spawn(['powershell', '-Command', script], { windowsHide: true })
      Bun.spawn(['explorer', dir], { stdin: 'ignore' })
      `,
      // A spawn named only in PROSE. The scan is textual, so before comments were blanked this was
      // a finding: the shared kit's detached-spawn.mjs header explains which shell
      // spawn("powershell") resolves to, and syncing that comment in turned the whole suite red
      // against a file that contains no spawn call at all (2026-08-09).
      `
      // Windows PowerShell (powershell.exe, which spawn("powershell") resolves to) space-joins
      // -ArgumentList without quoting, so pre-quote each element.
      /* Bun.spawn(['powershell', '-Command', script]) */
      export function buildDetachedSpawn(platform, argv) { return { argv, detached: true } }
      `,
      // The inverse direction must survive the same treatment: a commented-out GUI spawn is not a
      // gui-hidden finding either.
      `// Bun.spawn(['explorer', dir], { windowsHide: true })`,
    ],
  },
  'wmi-commandline-query-self-match.mjs': {
    broken: [
      // The needle lives inside the LIKE pattern of the querying powershell's OWN command line, so
      // the query always matches itself; this is the actual dispatch.ts isRunnerAlive() bug that
      // made reattach think every runner was alive forever, on every machine, silently.
      // (Built via CMD_LINE, never written as one contiguous word+keyword pair in this file's own
      // source: this check scans tests/**/*.ts too, and a literal occurrence here would flag this
      // very test file.)
      `
      function isRunnerAlive(id) {
        const filter = "${CMD_LINE} LIKE '%" + id + ".spec.json%'"
        return runPowershell(filter)
      }
      `,
    ],
    fixed: [
      `
      function isRunnerAlive(id) {
        const filter = "${CMD_LINE} LIKE '%" + id + ".spec.json%' AND ProcessId <> $PID"
        return runPowershell(filter)
      }
      `,
    ],
  },
}

// Checks that deliberately do NOT export findViolations, and why, asserted explicitly below rather
// than silently skipped, so dropping findViolations from a future check without updating this file
// fails loudly instead of quietly losing its regression net.
const EXEMPT_FROM_FIXTURES: Record<string, string> = {
  'kit-lib-type-drift.mjs':
    'diffs export sets across a WHOLE .mjs / .d.mts file PAIR, not a single text blob a ' +
    'findViolations(text) signature could take; its regression coverage is the run({ root }) ' +
    'assertion against the real repo tree, exercised for every check below.',
}

for (const file of CHECK_FILES) {
  describe(file, () => {
    // Set by the import test and read by every test after it in this describe block. bun:test runs
    // a describe block's tests sequentially by default, so this is never read before it is set.
    let mod: any

    test('imports cleanly, the exact failure mode a crashed check hides behind', async () => {
      // pathToFileURL, not a bare path: a raw Windows path is not a valid ESM specifier.
      mod = await import(pathToFileURL(join(CHECKS_DIR, file)).href)
      expect(mod).toBeTruthy()
    })

    test('exports a well-formed, gating audit', () => {
      expect(mod.audit).toBeTruthy()
      expect(typeof mod.audit.id).toBe('string')
      expect(mod.audit.id.length).toBeGreaterThan(0)
      expect(typeof mod.audit.title).toBe('string')
      expect(mod.audit.title.length).toBeGreaterThan(0)
      expect(mod.audit.gating).toBe(true)
    })

    test('audit.run resolves clean against the real repo root (the regression net)', async () => {
      const result = await mod.audit.run({ root: REPO_ROOT })
      expect(result.failed).toBe(false)
      expect(typeof result.report).toBe('string')
      expect(result.report.length).toBeGreaterThan(0)
    })

    if (file in EXEMPT_FROM_FIXTURES) {
      test(`does not export findViolations, exempt: ${EXEMPT_FROM_FIXTURES[file]}`, () => {
        expect(mod.findViolations).toBeUndefined()
      })
    } else {
      test('exports findViolations and has registered fixtures', () => {
        // A failure here means a new check landed with findViolations but nobody taught this file
        // its broken/fixed shape, exactly the silent-skip this file exists to prevent. Fix: add an
        // entry to FIXTURES_BY_FILE (or, if it truly has no single-text-blob shape, an entry to
        // EXEMPT_FROM_FIXTURES explaining why, same as kit-lib-type-drift.mjs above).
        expect(typeof mod.findViolations).toBe('function')
        expect(FIXTURES_BY_FILE[file]).toBeTruthy()
      })

      const fixtures = FIXTURES_BY_FILE[file]
      if (fixtures) {
        fixtures.broken.forEach((text, i) => {
          test(`findViolations fires on the broken fixture #${i}`, () => {
            expect(mod.findViolations(text).length).toBeGreaterThan(0)
          })
        })
        fixtures.fixed.forEach((text, i) => {
          test(`findViolations stays quiet on the fixed fixture #${i}`, () => {
            expect(mod.findViolations(text).length).toBe(0)
          })
        })
      }
    }
  })
}

test('at least one check was actually discovered and exercised above', () => {
  // Guards against the whole file above passing vacuously if CHECKS_DIR were ever empty or
  // misnamed: an empty for-loop registers zero tests and bun reports that as success, not failure.
  // A guardrail that cannot fail is not a guardrail, and neither is a suite with nothing in it.
  expect(CHECK_FILES.length).toBeGreaterThan(0)
})
