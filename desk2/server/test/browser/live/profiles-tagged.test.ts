// browser_profile_find names a tagged browser window when the query asks for the person's own browser.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callTool } from '../../../src/browser/agent/tools'
import { tempDir } from '../../git/helpers'

setDefaultTimeout(30_000)

const KEYS = ['HYDRA_DESK_BROWSER_STORE', 'CONNECTIONS_BROWSER_TAGS', 'HYDRA_DESK_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
let cwd: string

beforeEach(() => {
  const store = tempDir('live-find-store-')
  const home = tempDir('live-find-home-')
  cwd = tempDir('live-find-cwd-')
  const userData = join(home, 'chrome-user-data')
  mkdirSync(join(userData, 'Default'), { recursive: true })
  const tags = join(home, 'browser-tags.json')
  writeFileSync(
    tags,
    JSON.stringify({ version: 1, tags: [{ tag: 'work', browser: 'Chrome', userDataDir: userData, profileDir: 'Default', profileName: 'Example Owner' }] }),
  )
  process.env.HYDRA_DESK_BROWSER_STORE = store
  process.env.CONNECTIONS_BROWSER_TAGS = tags
  process.env.HYDRA_DESK_HOME = home
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.LOCALAPPDATA = join(home, 'local')
  process.env.APPDATA = join(home, 'roaming')
  writeFileSync(join(store, 'registry.json'), JSON.stringify({ profiles: {} }))
  writeFileSync(join(store, 'workspaces.json'), JSON.stringify({}))
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('browser_profile_find and tagged browser windows', () => {
  test('a request for my own browser names the tagged window and never drives it as a managed profile', async () => {
    const res = await callTool('browser_profile_find', { for: 'my browser' }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.error)
    const out = JSON.parse(res.text)
    expect(out.drivableNow).toBeNull()
    expect(out.taggedBrowsers).toEqual([
      expect.objectContaining({ tag: 'work', browser: 'Chrome', profileDir: 'Default', profile: 'Example Owner' }),
    ])
    expect(out.note).toContain("browser_live { window: 'work' }")
  })
})
