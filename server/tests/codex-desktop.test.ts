import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexDesktopLaunch,
  codexDesktopRuntimesFromRecords,
  codexDesktopUserDataDir,
  openCodexDesktop,
} from '../src/core/codex-desktop'

test('Codex Desktop profile is kept inside its isolated CODEX_HOME', () => {
  expect(codexDesktopUserDataDir('C:\\profiles\\work')).toBe(join('C:\\profiles\\work', 'desktop'))
})

test('Codex Desktop runtime discovery maps a crashpad profile back to the main window pid', () => {
  const records = [
    {
      pid: 100,
      parentPid: 50,
      name: 'ChatGPT.exe',
      commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe"',
    },
    {
      pid: 101,
      parentPid: 100,
      name: 'ChatGPT.exe',
      commandLine:
        '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe" --type=crashpad-handler "--user-data-dir=C:\\profiles with space\\work\\desktop"',
    },
  ]

  expect(codexDesktopRuntimesFromRecords(records)).toEqual([
    {
      desktopUserDataDir: join('C:\\profiles with space\\work\\desktop'),
      pid: 100,
    },
  ])
})

test('Windows Codex Desktop launch starts inside its MSIX package and still carries both isolation variables', () => {
  const launch = buildCodexDesktopLaunch(
    'win32',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.917.8451.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
    'C:\\profiles\\work',
    'C:\\profiles\\work\\desktop',
  )

  expect(launch.argv[0]).toBe('powershell')
  expect(launch.detached).toBe(false)
  expect(launch.argv.at(-2)).toBe('-EncodedCommand')
  const script = Buffer.from(launch.argv.at(-1)!, 'base64').toString('utf16le')
  expect(script).toContain("-PackageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0'")
  // Invoke-CommandInDesktopPackage drops the caller's environment, so the variables must travel
  // inside the command it runs in the package.
  const inner = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)
  expect(inner).not.toBeNull()
  const innerScript = Buffer.from(inner![1]!, 'base64').toString('utf16le')
  expect(innerScript).toContain("$env:CODEX_HOME = 'C:\\profiles\\work'")
  expect(innerScript).toContain(
    "$env:CODEX_ELECTRON_USER_DATA_PATH = 'C:\\profiles\\work\\desktop'",
  )
  expect(innerScript).toContain('--user-data-dir=C:\\profiles\\work\\desktop')
})

test('a Codex Desktop launch the launcher refused is reported as a failure, not "launched"', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ah-codex-open-'))
  try {
    const refused = (() => ({
      pid: undefined,
      exitCode: 1,
      exited: Promise.resolve(1),
      stderr: new Response(
        'Start-Process : This command cannot be run due to the error: Access is denied.\r\nAt line:1 char:230\r\n',
      ).body,
      unref() {},
    })) as unknown as typeof Bun.spawn
    const result = await openCodexDesktop(
      { id: 'x', name: 'x', codexHome },
      {
        platform: 'win32',
        listProcesses: async () => [],
        resolveBinary: async () => 'C:\\Codex\\ChatGPT.exe',
        spawn: refused,
      },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Access is denied')
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('macOS Codex Desktop launch uses a detached process with isolated environment', () => {
  const binary = '/Applications/Codex.app/Contents/MacOS/Codex'
  const launch = buildCodexDesktopLaunch(
    'darwin',
    binary,
    '/Users/me/.codex-work',
    '/Users/me/.codex-work/desktop',
  )

  expect(launch.argv).toEqual([binary, '--user-data-dir=/Users/me/.codex-work/desktop'])
  expect(launch.detached).toBe(true)
  expect(launch.envOverrides).toEqual({
    CODEX_HOME: '/Users/me/.codex-work',
    CODEX_ELECTRON_USER_DATA_PATH: '/Users/me/.codex-work/desktop',
  })
})
