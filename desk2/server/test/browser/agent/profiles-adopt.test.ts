// browser_profile_adopt over a fake Chrome User Data root and a temp saved-browser store, with invented names. Nothing
// reads a real browser profile: LOCALAPPDATA and APPDATA point into a temp home. A live Chrome is a local HTTP stub.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callTool } from '../../../src/browser/agent/tools'
import { tempDir } from '../../git/helpers'

setDefaultTimeout(30_000)

const KEYS = ['HYDRA_DESK_BROWSER_STORE', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
let root: string
let cwd: string
let userData: string
let stub: ReturnType<typeof Bun.serve> | null = null

const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data))
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
const managed = (name: string) => join(root, 'ws', 'shop-ws', name)

function fakeChrome(appBound: boolean) {
  const osCrypt: Record<string, string> = { encrypted_key: 'ZmFrZQ==' }
  if (appBound) osCrypt.app_bound_encrypted_key = 'ZmFrZQ=='
  write(join(userData, 'Local State'), {
    os_crypt: osCrypt,
    profile: { info_cache: { 'Profile 11': { name: 'Sample Friend' } } },
  })
  const src = join(userData, 'Profile 11')
  mkdirSync(join(src, 'Network'), { recursive: true })
  writeFileSync(join(src, 'Network', 'Cookies'), 'cookie-store')
  write(join(src, 'Preferences'), { v: 1 })
  mkdirSync(join(src, 'Local Storage', 'leveldb'), { recursive: true })
  writeFileSync(join(src, 'Local Storage', 'leveldb', '000001.ldb'), 'storage')
}

beforeEach(() => {
  root = tempDir('agent-store-')
  cwd = tempDir('agent-cwd-')
  const home = tempDir('agent-home-')
  userData = join(home, 'local', 'Google', 'Chrome', 'User Data')
  process.env.HYDRA_DESK_BROWSER_STORE = root
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.LOCALAPPDATA = join(home, 'local')
  process.env.APPDATA = join(home, 'roaming')
  write(join(root, 'workspaces.json'), { 'shop-ws': { workspace: cwd } })
  mkdirSync(join(root, 'ws', 'shop-ws'), { recursive: true })
})

afterEach(() => {
  stub?.stop(true)
  stub = null
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('browser_profile_adopt', () => {
  test('refuses an app-bound profile and copies nothing', async () => {
    fakeChrome(true)
    const res = await callTool('browser_profile_adopt', { from: 'Sample Friend' }, { cwd })
    expect(res).toMatchObject({ ok: false, status: 400 })
    if (!res.ok) expect(res.error).toContain('app-bound cookie encryption')
    expect(existsSync(managed('sample-friend'))).toBe(false)
  })

  test('with force, copies the non-session files and skips the cookie store', async () => {
    fakeChrome(true)
    const res = await callTool('browser_profile_adopt', { from: 'Sample Friend', force: true }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out.status).toBe('adopted')
    expect(out.copied).not.toContain('Network/Cookies')
    expect(read(join(managed('sample-friend'), 'Default', 'Preferences'))).toEqual({ v: 1 })
    expect(existsSync(join(managed('sample-friend'), 'Default', 'Local Storage', 'leveldb', '000001.ldb'))).toBe(true)
    expect(existsSync(join(managed('sample-friend'), 'Default', 'Network', 'Cookies'))).toBe(false)
  })

  test('a store without an app-bound key copies, and the profile is listed by browser_profiles', async () => {
    fakeChrome(false)
    const res = await callTool('browser_profile_adopt', { from: 'Sample Friend' }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out).toMatchObject({ status: 'adopted', profile: 'sample-friend', scope: 'workspace', osCryptKeyCarried: true })
    expect(existsSync(join(managed('sample-friend'), 'Default', 'Network', 'Cookies'))).toBe(true)
    expect(read(join(managed('sample-friend'), 'Local State')).os_crypt.encrypted_key).toBe('ZmFrZQ==')
    const listed = await callTool('browser_profiles', {}, { cwd })
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.text).toContain('sample-friend')
    const reg = read(join(root, 'registry.json')).profiles
    expect(reg['shop-ws/sample-friend']).toMatchObject({ osCryptKeyCarried: true })
  })

  test('a second adopt without refresh refuses to copy; refresh re-copies the live session', async () => {
    fakeChrome(false)
    await callTool('browser_profile_adopt', { from: 'Sample Friend' }, { cwd })
    write(join(userData, 'Profile 11', 'Preferences'), { v: 2 })

    const again = await callTool('browser_profile_adopt', { from: 'Sample Friend' }, { cwd })
    expect(again.ok).toBe(true)
    if (again.ok) expect(JSON.parse(again.text).status).toBe('already-adopted')
    expect(read(join(managed('sample-friend'), 'Default', 'Preferences'))).toEqual({ v: 1 })

    const refreshed = await callTool('browser_profile_adopt', { from: 'Sample Friend', refresh: true }, { cwd })
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) expect(JSON.parse(refreshed.text).status).toBe('refreshed')
    expect(read(join(managed('sample-friend'), 'Default', 'Preferences'))).toEqual({ v: 2 })
  })

  test('refresh refuses a managed profile whose Chrome is live, and changes nothing', async () => {
    fakeChrome(false)
    await callTool('browser_profile_adopt', { from: 'Sample Friend' }, { cwd })
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/invented' }),
    })
    writeFileSync(join(managed('sample-friend'), 'DevToolsActivePort'), `${stub.port}\n/devtools/browser/invented\n`)
    write(join(userData, 'Profile 11', 'Preferences'), { v: 3 })
    const res = await callTool('browser_profile_adopt', { from: 'Sample Friend', refresh: true }, { cwd })
    expect(res).toMatchObject({ ok: false, status: 400 })
    if (!res.ok) expect(res.error).toContain('live Chrome')
    expect(read(join(managed('sample-friend'), 'Default', 'Preferences'))).toEqual({ v: 1 })
  })

  test('from matches the friendly name, the dir, or chrome:<either>; an unknown name is refused', async () => {
    fakeChrome(false)
    for (const [from, as] of [
      ['Sample Friend', 'by-name'],
      ['Profile 11', 'by-dir'],
      ['chrome:Profile 11', 'by-prefix'],
    ] as const) {
      const res = await callTool('browser_profile_adopt', { from, as }, { cwd })
      expect(res.ok).toBe(true)
      if (res.ok) expect(JSON.parse(res.text)).toMatchObject({ status: 'adopted', profile: as })
    }
    const unknown = await callTool('browser_profile_adopt', { from: 'Nobody Here' }, { cwd })
    expect(unknown).toMatchObject({ ok: false, status: 400 })
    if (!unknown.ok) expect(unknown.error).toContain('no Chrome profile on this machine matches "Nobody Here". Known:')
  })
})
