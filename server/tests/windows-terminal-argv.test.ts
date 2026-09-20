// server/tests/windows-terminal-argv.test.ts - the launch that opened a console only to refuse.
//
// Hit on 2026-09-19 clicking "add cli login": a console window opened at C:\Windows\System32 and
// printed
//
//   '"C:\Users\...\@anthropic-ai\claude-code\bin\claude.exe"' is not recognized as an internal or
//   external command, operable program or batch file.
//
// The exe was present and runnable the whole time. Both launchers built their `cmd /k` payload as
// ONE pre-quoted string, `[`"${exe}"`, ...args].join(' ')`. The spawn layer then applies MSVCRT
// quoting to that string, so the real command line carried `"\"C:\...\claude.exe\""`; cmd.exe has
// no backslash escape, stripped the outer pair, and tried to run a program whose name starts with
// a literal quote. Measured the same day, launching a probe under `C:\...\sp ace\`:
//
//   ["exe" args] joined   -> fails      (this bug)
//   [exe args]   joined   -> fails      (cmd strips the spawn layer's quotes, space splits it)
//   [exe, ...args] split  -> WORKS      (the only form that also survives a spaced install path)
//
// This is a failure the API cannot see - Bun.spawn succeeds, a window really opens, and the
// endpoint returns ok - so nothing but the shape of this argv keeps it honest.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cmdLauncherScript,
  needsCmdLauncher,
  windowsTerminalArgv,
  writeCmdLauncher,
} from '../src/core/launch-options'

const WINDOWS_EXE = String.raw`C:\Program Files\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`

test('the exe is its own argv entry, never quoted or joined with its args', () => {
  const argv = windowsTerminalArgv(WINDOWS_EXE, ['--model', 'opus'])

  // The regression: the exe must appear verbatim as one entry. A quoted or joined entry is the
  // exact shape cmd.exe reported as "not recognized".
  expect(argv).toContain(WINDOWS_EXE)
  expect(argv).toEqual(['cmd', '/c', 'start', '', 'cmd', '/k', WINDOWS_EXE, '--model', 'opus'])

  for (const entry of argv) {
    expect(entry).not.toInclude('"')
    expect(entry).not.toInclude('\\"')
  }
})

test('each arg stays a separate entry, so none is ever pre-quoted or glued to another', () => {
  const argv = windowsTerminalArgv(WINDOWS_EXE, ['--model', 'claude-opus-5', '--effort', 'high'])
  const tail = argv.slice(argv.indexOf(WINDOWS_EXE) + 1)

  expect(tail).toEqual(['--model', 'claude-opus-5', '--effort', 'high'])
  // A joined payload would collapse these four into one entry containing spaces.
  expect(tail.some((entry) => entry.includes(' '))).toBe(false)
})

test('start keeps its mandatory empty title slot ahead of the inner shell', () => {
  // Drop the "" and `start` reads the next quoted token as the window title instead of the
  // command, so nothing launches at all.
  const argv = windowsTerminalArgv(WINDOWS_EXE)
  expect(argv.slice(0, 7)).toEqual(['cmd', '/c', 'start', '', 'cmd', '/k', WINDOWS_EXE])
})

test('no args is a bare launch, not a trailing empty entry', () => {
  // An empty string tail would reach claude as an empty argument.
  expect(windowsTerminalArgv(WINDOWS_EXE)).toEqual([
    'cmd',
    '/c',
    'start',
    '',
    'cmd',
    '/k',
    WINDOWS_EXE,
  ])
})

// ── the quoted-arg case: codex's reasoning-effort override ──────────────────────────────────────
//
// `model_reasoning_effort="high"` carries quotes as part of its VALUE. argv cannot deliver those
// through cmd.exe at all, so these args take a launcher script instead.

const CODEX_EFFORT_ARG = 'model_reasoning_effort="high"'

test("claude's args never need a launcher; codex's quoted override always does", () => {
  // Claude's model/effort are validated to a quote-free charset, so it keeps the simple path.
  expect(needsCmdLauncher(['--model', 'claude-opus-5', '--effort', 'high'])).toBe(false)
  expect(needsCmdLauncher([])).toBe(false)

  expect(needsCmdLauncher(['-c', CODEX_EFFORT_ARG])).toBe(true)
  // cmd's own metacharacters would be interpreted rather than passed through.
  for (const hostile of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'a!b']) {
    expect(needsCmdLauncher([hostile])).toBe(true)
  }
})

test('the launcher script writes each arg verbatim and quotes only the exe', () => {
  const script = cmdLauncherScript(WINDOWS_EXE, ['-c', CODEX_EFFORT_ARG])

  // Verbatim is the whole point: re-escaping here is what corrupted the value before.
  expect(script).toInclude(`-c ${CODEX_EFFORT_ARG}`)
  expect(script).toInclude(`"${WINDOWS_EXE}"`)
  expect(script).not.toInclude('""') // doubling mangles it - measured, see the header
  expect(script).toStartWith('@echo off\r\n')
  expect(script).toEndWith('\r\n') // cmd.exe requires CRLF
})

// A launcher is only worth anything if the program really receives the bytes. Run one for real.
//
// The end-to-end case below spawns `cmd /c start /wait`, so its runtime is set by the machine and
// not by its assertions - bun's 5s default is a coin flip on a loaded CI runner (see
// scripts/checks/spawn-test-without-timeout.mjs, and the 2026-08-08 run that failed 84ms over).
// Measured locally at ~120ms; 30s is a generous allowance, not a guess at the real cost.
const SPAWN_TIMEOUT_MS = 30_000
const ROOT = mkdtempSync(join(tmpdir(), 'ah-winargv-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

test.skipIf(process.platform !== 'win32')(
  'end to end: the program receives the quoted override exactly as macOS delivers it',
  () => {
    // A probe under a SPACED directory, so this covers the install-path-with-spaces case too.
    const dir = join(ROOT, 'sp ace')
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, 'probe.cmd')
    const marker = join(dir, 'marker.txt')
    writeFileSync(probe, `@echo off\r\necho %*> "${marker}"\r\n`)

    const launcher = writeCmdLauncher(probe, ['-c', CODEX_EFFORT_ARG])
    // `/b` runs it without opening a console; `/wait` so the marker exists when we read it.
    Bun.spawnSync(['cmd', '/c', 'start', '/b', '', '/wait', 'cmd', '/c', launcher], {
      stdout: 'ignore',
      stderr: 'ignore',
    })

    expect(readFileSync(marker, 'utf8').trim()).toBe(`-c ${CODEX_EFFORT_ARG}`)
    rmSync(launcher, { force: true })
  },
  SPAWN_TIMEOUT_MS,
)
