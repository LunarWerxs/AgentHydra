// devservers/settings.ts: the defaults, the one-time import from DevWebUI's old settings.json (only the settings keys,
// the old folder never written), and the PATCH validator.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DevServerError } from '../../src/devservers/contract'
import { cleanSettingsPatch, defaultSettings, readSettings, settingsPath, writeSettings } from '../../src/devservers/settings'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'devs-settings-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('the defaults skip the system folders of the running OS only', () => {
  const cases: [NodeJS.Platform, boolean, boolean, boolean][] = [
    ['win32', true, false, false],
    ['darwin', false, true, false],
    ['linux', false, false, true],
  ]
  for (const [platform, skipWindows, skipMac, skipLinux] of cases) {
    expect(defaultSettings(platform)).toMatchObject({ skipWindows, skipMac, skipLinux, runtime: 'auto', freePortOnStart: false, autoStartOnLaunch: false, monitorResources: true, linkHost: '', autoScan: false, scanExclude: [] })
  }
})

test("the first run takes only the settings keys from DevWebUI's file, never writes there, and later runs read ours", () => {
  const home = tmp()
  const old = tmp()
  const oldFile = path.join(old, 'settings.json')
  const oldText = JSON.stringify({ runtime: 'bun', linkHost: 'my-pc', autoScan: true, installId: 'install-1234', sync: { token: 'example' } })
  writeFileSync(oldFile, oldText)

  const first = readSettings(home, old)
  expect(first.settings).toMatchObject({ runtime: 'bun', linkHost: 'my-pc', autoScan: true })
  expect(first.firstScanDone).toBe(false)
  const ours = JSON.parse(readFileSync(settingsPath(home), 'utf8')) as Record<string, unknown>
  expect(ours.runtime).toBe('bun')
  expect('installId' in ours).toBe(false)
  expect('sync' in ours).toBe(false)
  expect(readFileSync(oldFile, 'utf8')).toBe(oldText)
  expect(readdirSync(old)).toEqual(['settings.json'])

  // DevWebUI's file changes afterwards: ours is the one read now.
  writeFileSync(oldFile, JSON.stringify({ runtime: 'node' }))
  writeSettings(home, first.settings, true)
  const second = readSettings(home, old)
  expect(second.settings.runtime).toBe('bun')
  expect(second.firstScanDone).toBe(true)
})

test('a settings change with a wrong type is a 400, and unknown keys are left out', () => {
  const bad: unknown[] = [null, [], { runtime: 'deno' }, { autoScan: 'yes' }, { monitorResources: 1 }, { linkHost: 5 }, { linkHost: 'my pc' }, { scanExclude: 'node_modules' }, { scanExclude: [1] }, { osSkip: { windows: [2] } }]
  for (const patch of bad) {
    let err: unknown = null
    try {
      cleanSettingsPatch(patch)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DevServerError)
    expect((err as DevServerError).status).toBe(400)
  }
  expect(cleanSettingsPatch({ autoScan: true, installId: 'install-1234', firstScanDone: true })).toEqual({ autoScan: true })
})
