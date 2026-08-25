// server/tests/session-launch.test.ts — the visible-terminal launch plan, pinned per platform.
//
// The prompt rides in a FILE, never on the command line: handoff prompts are long, multiline
// and quote-riddled, and the first design (inline quoting through `cmd /c start`) is exactly
// how arguments get silently mangled. These tests pin that the plan reads the file, keeps the
// window open on failure, and never interpolates the prompt text itself into argv.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveDesktopChat,
  buildImportPlan,
  buildTerminalLaunchPlan,
  bundledClaudeExe,
  importSessionToDesktop,
} from '../src/session-launch'

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

test('the desktop import plan targets one instance via its profile dir', () => {
  const win = buildImportPlan(
    'win32',
    'C:\\LA\\AnthropicClaude\\claude.exe',
    'c:\\users\\x\\.claude-instances\\work',
    'abc-123',
  )
  expect(win).toEqual([
    'C:\\LA\\AnthropicClaude\\claude.exe',
    '--user-data-dir=c:\\users\\x\\.claude-instances\\work',
    'claude://resume?session=abc-123',
  ])
  // darwin: resolveLaunchBinary returns the 'Claude' marker, which must go through `open -na`.
  const mac = buildImportPlan('darwin', 'Claude', '/Users/x/instances/work', 'abc-123')
  expect(mac.slice(0, 4)).toEqual(['open', '-na', 'Claude', '--args'])
})

test('import refuses a non-running instance instead of booting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-import-guard-'))
  const r = await importSessionToDesktop({
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => false,
    isInstanceRunning: async () => false,
  })
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('instance-not-running')
  const live = await importSessionToDesktop({
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => true,
    isInstanceRunning: async () => true,
  })
  expect(live.reason).toContain('session-live')
})

test('archiveDesktopChat flips the metadata flag by filename across profiles', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-archive-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-arch-1.json')
  writeFileSync(metaPath, JSON.stringify({ cliSessionId: 'sess-arch-1', isArchived: false }))
  const notRunning = async () => false
  const r = await archiveDesktopChat('sess-arch-1', true, [profile], notRunning)
  expect(r.ok).toBe(true)
  expect(r.hits).toHaveLength(1)
  expect(r.hits[0].wasRunning).toBe(false)
  expect(JSON.parse(readFileSync(metaPath, 'utf8')).isArchived).toBe(true)
  const back = await archiveDesktopChat('sess-arch-1', false, [profile], notRunning)
  expect(back.ok).toBe(true)
  expect(JSON.parse(readFileSync(metaPath, 'utf8')).isArchived).toBe(false)
  const miss = await archiveDesktopChat('sess-nope', true, [profile], notRunning)
  expect(miss.ok).toBe(false)
  expect(miss.reason).toBe('no-desktop-chat-found')
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
