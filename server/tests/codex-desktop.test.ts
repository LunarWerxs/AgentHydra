import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  buildCodexDesktopLaunch,
  codexDesktopRuntimesFromRecords,
  codexDesktopUserDataDir,
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

test('Windows Codex Desktop launch carries both isolation variables through the detached handoff', () => {
  const launch = buildCodexDesktopLaunch(
    'win32',
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe',
    'C:\\profiles\\work',
    'C:\\profiles\\work\\desktop',
  )

  expect(launch.argv[0]).toBe('powershell')
  expect(launch.detached).toBe(false)
  expect(launch.argv.at(-2)).toBe('-EncodedCommand')
  const script = Buffer.from(launch.argv.at(-1)!, 'base64').toString('utf16le')
  expect(script).toContain('CODEX_HOME')
  expect(script).toContain('CODEX_ELECTRON_USER_DATA_PATH')
  expect(script).toContain('--user-data-dir=C:\\profiles\\work\\desktop')
  expect(script).toContain('Start-Process')
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
