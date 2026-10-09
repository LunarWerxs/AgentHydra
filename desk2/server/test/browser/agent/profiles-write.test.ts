// The registry write side and the workspace payloads over a fixture saved-browser store with invented names. No Chrome
// is launched; the cookie store is a small SQLite file written by the test, its values invented.

import { Database } from 'bun:sqlite'
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

const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data))
}

const readRegistry = () =>
  JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as Record<string, any>

function cookieStore(dir: string, rows: [string, string][]) {
  mkdirSync(join(dir, 'Network'), { recursive: true })
  const db = new Database(join(dir, 'Network', 'Cookies'))
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)')
  for (const [host, name] of rows)
    db.run('INSERT INTO cookies VALUES (?, ?, ?)', [host, name, 'invented-value'])
  db.close()
}

beforeEach(() => {
  root = tempDir('agent-store-')
  cwd = tempDir('agent-cwd-')
  const home = tempDir('agent-home-')
  process.env.HYDRA_DESK_BROWSER_STORE = root
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.LOCALAPPDATA = join(home, 'local')
  process.env.APPDATA = join(home, 'roaming')
  write(join(root, 'registry.json'), {
    profiles: {
      'shop-ws/example-shop': {
        sessionHosts: ['example.test'],
        note: 'Example shop login',
        title: 'Example shop',
        futureField: 'kept',
      },
    },
    fromAnotherWriter: { keep: true },
  })
  write(join(root, 'workspaces.json'), { 'shop-ws': { workspace: cwd } })
  mkdirSync(join(root, 'ws', 'shop-ws', 'example-shop'), { recursive: true })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('browser_profile_note', () => {
  test('writes the note and title, trimmed, and keeps the fields it did not touch', async () => {
    const res = await callTool(
      'browser_profile_note',
      { profile: 'example-shop', note: '  billing@example.test, refunds  ', title: 'Shop admin' },
      { cwd },
    )
    expect(res.ok).toBe(true)
    const reg = readRegistry()
    const entry = reg.profiles['shop-ws/example-shop']
    expect(entry.note).toBe('billing@example.test, refunds')
    expect(typeof entry.noteAt).toBe('string')
    expect(entry.title).toBe('Shop admin')
    expect(entry.sessionHosts).toEqual(['example.test'])
    expect(entry.futureField).toBe('kept')
    expect(reg.fromAnotherWriter).toEqual({ keep: true })
  })

  test('an empty note clears only the note; a title alone keeps it', async () => {
    await callTool('browser_profile_note', { profile: 'example-shop', title: 'Renamed' }, { cwd })
    let entry = readRegistry().profiles['shop-ws/example-shop']
    expect(entry.note).toBe('Example shop login')
    expect(entry.title).toBe('Renamed')

    await callTool('browser_profile_note', { profile: 'example-shop', note: '' }, { cwd })
    entry = readRegistry().profiles['shop-ws/example-shop']
    expect(entry.note).toBeUndefined()
    expect(entry.noteAt).toBeUndefined()
    expect(entry.title).toBe('Renamed')
    expect(entry.futureField).toBe('kept')
  })

  test('refuses a profile this workspace does not hold, and a call with nothing to write', async () => {
    const missing = await callTool(
      'browser_profile_note',
      { profile: 'no-such-browser', note: 'x' },
      { cwd },
    )
    expect(missing).toMatchObject({ ok: false, status: 400 })
    const nothing = await callTool('browser_profile_note', { profile: 'example-shop' }, { cwd })
    expect(nothing).toMatchObject({ ok: false, status: 400 })
  })

  test('leaves a registry that is not a JSON object exactly as it is', async () => {
    writeFileSync(join(root, 'registry.json'), '[1, 2]')
    const res = await callTool(
      'browser_profile_note',
      { profile: 'example-shop', note: 'x' },
      { cwd },
    )
    expect(res.ok).toBe(false)
    expect(readFileSync(join(root, 'registry.json'), 'utf8')).toBe('[1, 2]')
  })
})

describe('browser_profiles and browser_profile_find key shape', () => {
  beforeEach(() => {
    const dir = join(root, 'ws', 'shop-ws', 'cookie-shop')
    mkdirSync(dir, { recursive: true })
    cookieStore(dir, [
      ['.example.org', 'session'],
      ['.ads.example.org', '_ga'],
    ])
  })

  test('browser_profiles answers the Connections keys and reads hosts from the cookie names only', async () => {
    const res = await callTool('browser_profiles', {}, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out).toMatchObject({ workspace: 'shop-ws', external: [] })
    expect(Array.isArray(out.unowned)).toBe(true)
    const cookie = out.managed.find((p: { profile: string }) => p.profile === 'cookie-shop')
    expect(cookie).toMatchObject({
      scope: 'workspace',
      key: 'shop-ws/cookie-shop',
      open: false,
      driving: false,
      signedInHosts: ['example.org'],
    })
    expect(cookie.lastUsed).toEqual(expect.any(String))
    expect(JSON.stringify(out)).not.toContain('invented-value')
    const after = readRegistry().profiles['shop-ws/cookie-shop']
    expect(after.hosts).toEqual(['ads.example.org', 'example.org'])
    expect(after.hostsReadable).toBe(true)
  })

  test('browser_profile_find ranks by host and names the drivable profile', async () => {
    const res = await callTool(
      'browser_profile_find',
      { for: 'https://example.test/login' },
      { cwd },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out).toMatchObject({
      query: 'https://example.test/login',
      workspace: 'shop-ws',
      resolvedHosts: ['example.test'],
    })
    expect(out.drivableNow).toMatchObject({
      profile: 'example-shop',
      scope: 'workspace',
      matchedHosts: ['example.test'],
    })
    expect(out.managed[0]).toMatchObject({ profile: 'example-shop', points: 10 })
  })
})

describe('browser_profiles outside a workspace', () => {
  test('a chat folder no workspace records still gets the Connections keys', async () => {
    const res = await callTool('browser_profiles', {}, { cwd: tempDir('agent-stray-') })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out.workspace).toBeNull()
    expect(out.managed).toEqual([])
    expect(existsSync(join(root, 'registry.json'))).toBe(true)
  })
})
