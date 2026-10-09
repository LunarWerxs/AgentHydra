// The engine script ships with the server and is copied under HYDRA_DESK_HOME, where its compiled-type cache lives.
// These pins read the script's source; nothing here starts PowerShell or touches the desktop.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserLiveEnginePath, browserLiveEngineStats } from '../../../src/browser/live/engine'
import { tempDir } from '../../git/helpers'

const SOURCE = fileURLToPath(new URL('../../../src/browser/live/browser-live.ps1', import.meta.url))
const KEY = 'HYDRA_DESK_HOME'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  process.env[KEY] = tempDir('live-home-')
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe('browser_live engine script', () => {
  test('the engine is copied under HYDRA_DESK_HOME, not beside the source', () => {
    const path = browserLiveEnginePath()
    expect(path.startsWith(join(process.env[KEY] as string, 'browser-live'))).toBe(true)
    expect(path).toMatch(/browser-live-[0-9a-f]{12}\.ps1$/)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path)).toEqual(readFileSync(SOURCE))
  })

  test('no engine runs before the first call', () => {
    expect(browserLiveEngineStats()).toEqual({ starts: 0, pid: null, alive: false })
  })

  test('the compiled-type cache sits beside the script', () => {
    expect(readFileSync(SOURCE, 'utf8')).toContain("$dll = Join-Path $PSScriptRoot ('browser-live-types-' + $key + '.dll')")
  })

  test('key input is aimed at the focused element inside the page', () => {
    expect(readFileSync(SOURCE, 'utf8')).toContain('In-Subtree ([System.Windows.Automation.AutomationElement]::FocusedElement)')
  })
})
