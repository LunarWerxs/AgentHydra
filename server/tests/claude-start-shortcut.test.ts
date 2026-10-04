// server/src/claude-start-shortcut.ts - Claude's Start-menu shortcut is moved off a managed copy
// and onto the install's stub, keeping its notification id, and nothing else is ever touched.
// Real .lnk files in a scratch folder, so it runs on Windows only.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnCaptured } from '../src/core/process'

const scratch = join(process.env.TEMP ?? '/tmp', `agenthydra-start-shortcut-${crypto.randomUUID()}`)
process.env.AGENTHYDRA_HOME = join(scratch, 'home')
const { repointClaudeStartShortcut } = await import('../src/claude-start-shortcut')

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const win = process.platform === 'win32'
// Each test starts three to six powershell.exe (one per link written or read, and the shortcut's own
// read): 2.4 and 3.3 s measured 2026-10-04 with 15% memory free, and over bun's 5 s default when the
// box was busier. The allowance is chosen, not inherited.
const POWERSHELL_TEST_MS = 30_000

async function ps(script: string, env: Record<string, string>): Promise<string> {
  const run = await spawnCaptured(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, ...env } },
  )
  return run.stdout.trim()
}

/** A real .lnk aimed at `target`. */
async function makeLink(lnk: string, target: string): Promise<void> {
  await ps(
    `$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:L); $l.TargetPath = $env:T; $l.Save()`,
    { L: lnk, T: target },
  )
}

async function readLink(lnk: string): Promise<string> {
  return ps(`(New-Object -ComObject WScript.Shell).CreateShortcut($env:L).TargetPath`, { L: lnk })
}

/** An existing file as the shell reads a shortcut target back: long form, lower case. The scratch
 *  folder sits under TEMP, which on a CI runner is an 8.3 short name (C:\Users\RUNNER~1). */
function longForm(path: string): string {
  return realpathSync.native(path).toLowerCase()
}

function fixture() {
  const root = join(scratch, crypto.randomUUID())
  const managedRoot = join(root, 'data', 'claude-native')
  const managed = join(managedRoot, '2.9939.2-003561859d16', 'claude.exe')
  const install = join(root, 'AnthropicClaude')
  mkdirSync(join(managedRoot, '2.9939.2-003561859d16'), { recursive: true })
  mkdirSync(install, { recursive: true })
  writeFileSync(managed, 'managed')
  writeFileSync(join(install, 'claude.exe'), 'stub')
  const paths = {
    lnk: join(root, 'Claude.lnk'),
    managedRoot,
    stub: join(install, 'claude.exe'),
    icon: join(install, 'app.ico'),
  }
  return { root, managed, paths }
}

test.skipIf(!win)(
  'a shortcut aimed at a managed copy is moved onto the install stub',
  async () => {
    const f = fixture()
    await makeLink(f.paths.lnk, f.managed)
    expect(await repointClaudeStartShortcut(f.paths)).toBe('repointed')
    expect((await readLink(f.paths.lnk)).toLowerCase()).toBe(longForm(f.paths.stub))
    // Already on the stub: a second pass leaves it alone.
    expect(await repointClaudeStartShortcut(f.paths)).toBe('unchanged')
  },
  POWERSHELL_TEST_MS,
)

test.skipIf(!win)(
  'a shortcut aimed anywhere else, or no shortcut at all, is never touched',
  async () => {
    const f = fixture()
    const elsewhere = join(f.root, 'Other', 'claude.exe')
    mkdirSync(join(f.root, 'Other'), { recursive: true })
    writeFileSync(elsewhere, 'other')
    await makeLink(f.paths.lnk, elsewhere)
    expect(await repointClaudeStartShortcut(f.paths)).toBe('unchanged')
    expect((await readLink(f.paths.lnk)).toLowerCase()).toBe(longForm(elsewhere))
    // A sibling folder that merely starts with the managed root's name is not inside it.
    const lookalike = `${f.paths.managedRoot}-old\\claude.exe`
    await makeLink(f.paths.lnk, lookalike)
    expect(await repointClaudeStartShortcut(f.paths)).toBe('unchanged')
    expect(await repointClaudeStartShortcut({ ...f.paths, lnk: join(f.root, 'missing.lnk') })).toBe(
      'unchanged',
    )
  },
  POWERSHELL_TEST_MS,
)
