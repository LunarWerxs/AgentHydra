// The `orchestratorModel` setting: the judge asks the model it names, so a value that is not an alias or a full model id
// must be refused at save, and a fresh Desk asks for the newest Opus.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, validateSettingsPatch } from '../src/settings'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('the aliases and a full model id are accepted', () => {
  for (const orchestratorModel of ['opus', 'sonnet', 'haiku', 'claude-opus-5-5']) expect(validateSettingsPatch({ orchestratorModel })).toBeNull()
})

test('anything else is refused, with the choices named', () => {
  for (const orchestratorModel of ['Opus', '', 'gpt-4', '5', ' opus', 'claude opus']) {
    expect(validateSettingsPatch({ orchestratorModel })).toContain("'opus', 'sonnet', 'haiku'")
  }
})

test('a fresh Desk asks for the newest Opus', () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-settings-'))
  temps.push(home)
  expect(loadSettings(home).orchestratorModel).toBe('opus')
})
