import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInstanceModeShortcut,
  instanceModeShortcutSpec,
} from '../src/core/instance-mode-shortcut'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('instanceModeShortcutSpec', () => {
  test('source checkout launches the VBS through wscript', () => {
    const spec = instanceModeShortcutSpec({
      appRoot: 'D:\\Apps\\AgentHydra',
      compiled: false,
      systemRoot: 'C:\\Windows',
    })

    expect(spec.target).toBe('C:\\Windows\\System32\\wscript.exe')
    expect(spec.args).toBe('"D:\\Apps\\AgentHydra\\misc\\Instance-Launch.vbs"')
    expect(spec.workingDir).toBe('D:\\Apps\\AgentHydra')
  })

  test('packaged release launches its own executable with --instances', () => {
    const spec = instanceModeShortcutSpec({
      appRoot: 'D:\\Portable\\AgentHydra',
      compiled: true,
      execPath: 'D:\\Portable\\AgentHydra\\agenthydra.exe',
    })

    expect(spec.target).toBe('D:\\Portable\\AgentHydra\\agenthydra.exe')
    expect(spec.args).toBe('--instances')
    expect(spec.workingDir).toBe('D:\\Portable\\AgentHydra')
  })
})

test('creates a Windows .lnk in an explicitly selected Desktop folder', async () => {
  if (process.platform !== 'win32') return

  const root = mkdtempSync(join(tmpdir(), 'agenthydra-instance-shortcut-'))
  cleanup.push(root)
  const desktopDir = join(root, 'Desktop')
  const fakeExe = join(root, 'agenthydra.exe')
  writeFileSync(fakeExe, '')

  const result = await createInstanceModeShortcut({
    appRoot: root,
    compiled: true,
    desktopDir,
    execPath: fakeExe,
    platform: 'win32',
  })

  expect(result.ok).toBe(true)
  expect(result.data?.path).toBe(join(desktopDir, 'AgentHydra Instances.lnk'))
  expect(existsSync(join(desktopDir, 'AgentHydra Instances.lnk'))).toBe(true)
})
