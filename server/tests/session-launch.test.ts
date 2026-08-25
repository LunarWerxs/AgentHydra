// server/tests/session-launch.test.ts — the visible-terminal launch plan, pinned per platform.
//
// The prompt rides in a FILE, never on the command line: handoff prompts are long, multiline
// and quote-riddled, and the first design (inline quoting through `cmd /c start`) is exactly
// how arguments get silently mangled. These tests pin that the plan reads the file, keeps the
// window open on failure, and never interpolates the prompt text itself into argv.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTerminalLaunchPlan, bundledClaudeExe } from '../src/session-launch'

test('windows: powershell reads the prompt file raw, window survives exit', () => {
  const plan = buildTerminalLaunchPlan(
    'win32',
    'C:\\Tools\\claude.exe',
    'C:\\tmp\\prompt-1.txt',
    'sonnet',
  )
  expect(plan.argv.slice(0, 5)).toEqual(['cmd', '/c', 'start', '', 'powershell'])
  expect(plan.argv).toContain('-NoExit')
  const ps = plan.argv[plan.argv.length - 1]
  expect(ps).toContain("Get-Content -Raw 'C:\\tmp\\prompt-1.txt'")
  expect(ps).toContain('--model sonnet')
})

test('windows: single quotes in paths are doubled for powershell, not left to break it', () => {
  const plan = buildTerminalLaunchPlan('win32', "C:\\o'brien\\claude.exe", 'C:\\tmp\\p.txt', null)
  expect(plan.argv[plan.argv.length - 1]).toContain("C:\\o''brien\\claude.exe")
  expect(plan.argv[plan.argv.length - 1]).not.toContain('--model')
})

test('bundledClaudeExe picks the numerically newest version, not the lexicographic one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-bundled-'))
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  // 2.1.9 vs 2.1.237: lexicographic sort would pick 2.1.9. The real store hit exactly this shape.
  for (const v of ['2.1.9', '2.1.237']) {
    mkdirSync(join(dir, 'claude-code', v), { recursive: true })
    writeFileSync(join(dir, 'claude-code', v, exeName), '')
  }
  expect(bundledClaudeExe(dir)).toContain('2.1.237')
  expect(bundledClaudeExe(join(dir, 'no-such'))).toBe(null)
})

test('darwin and linux read the file via cat; unknown platforms still return the command text', () => {
  const mac = buildTerminalLaunchPlan('darwin', '/usr/local/bin/claude', '/tmp/p.txt', null)
  expect(mac.argv[0]).toBe('osascript')
  expect(mac.command).toContain("$(cat '/tmp/p.txt')")
  const linux = buildTerminalLaunchPlan('linux', '/usr/bin/claude', '/tmp/p.txt', 'haiku')
  expect(linux.argv[0]).toBe('x-terminal-emulator')
  expect(linux.command).toContain('--model haiku')
  const other = buildTerminalLaunchPlan('freebsd' as NodeJS.Platform, 'claude', '/tmp/p.txt', null)
  expect(other.argv).toHaveLength(0)
  expect(other.command).toContain('claude')
})
