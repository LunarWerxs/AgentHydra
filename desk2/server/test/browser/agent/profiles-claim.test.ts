// browser_profile_claim over a fixture saved-browser store with invented names: a move, and its three refusals.
// A live Chrome is simulated by a local HTTP stub answering /json/version, named by DevToolsActivePort.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callTool } from '../../../src/browser/agent/tools'
import { tempDir } from '../../git/helpers'

setDefaultTimeout(30_000)

const KEYS = ['HYDRA_DESK_BROWSER_STORE', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const OTHER = 'C:/example/other-project'
let root: string
let cwd: string
let stub: ReturnType<typeof Bun.serve> | null = null

const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data))
}
const readRegistry = () =>
  JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as Record<string, any>

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
      'loose-profile': { sessionHosts: ['example.test'], note: 'Loose note' },
      'other-ws/away-profile': { sessionHosts: ['example.org'], note: 'Away note' },
    },
  })
  write(join(root, 'workspaces.json'), {
    'shop-ws': { workspace: cwd },
    'other-ws': { workspace: OTHER },
  })
  mkdirSync(join(root, 'ws', 'shop-ws'), { recursive: true })
  mkdirSync(join(root, 'loose-profile'), { recursive: true })
  mkdirSync(join(root, 'ws', 'other-ws', 'away-profile'), { recursive: true })
})

afterEach(() => {
  stub?.stop(true)
  stub = null
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('browser_profile_claim', () => {
  test('moves a pre-partition profile into this workspace and carries its registry entry', async () => {
    const res = await callTool('browser_profile_claim', { profile: 'loose-profile' }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.text)).toMatchObject({
      status: 'claimed',
      profile: 'loose-profile',
      from: '(unowned, pre-partition)',
      nowOwnedBy: 'shop-ws',
    })
    expect(existsSync(join(root, 'ws', 'shop-ws', 'loose-profile'))).toBe(true)
    expect(existsSync(join(root, 'loose-profile'))).toBe(false)
    const reg = readRegistry()
    expect(reg.profiles['loose-profile']).toBeUndefined()
    expect(reg.profiles['shop-ws/loose-profile']).toMatchObject({
      note: 'Loose note',
      claimedFrom: '(unowned, pre-partition)',
    })
    expect(typeof reg.profiles['shop-ws/loose-profile'].claimedAt).toBe('string')
  })

  test("moves another workspace's profile only when from names it", async () => {
    const bare = await callTool('browser_profile_claim', { profile: 'away-profile' }, { cwd })
    expect(bare).toMatchObject({ ok: false, status: 400 })
    if (bare.ok) return
    expect(bare.error).toContain('belongs to another workspace')
    expect(existsSync(join(root, 'ws', 'other-ws', 'away-profile'))).toBe(true)

    const wrong = await callTool(
      'browser_profile_claim',
      { profile: 'away-profile', from: 'other-ws' },
      { cwd },
    )
    expect(wrong.ok).toBe(true)
    expect(existsSync(join(root, 'ws', 'shop-ws', 'away-profile'))).toBe(true)
    expect(existsSync(join(root, 'ws', 'other-ws', 'away-profile'))).toBe(false)
    expect(readRegistry().profiles['shop-ws/away-profile']).toMatchObject({
      note: 'Away note',
      claimedFrom: OTHER,
    })
  })

  test('refuses a name this workspace already owns', async () => {
    mkdirSync(join(root, 'ws', 'shop-ws', 'loose-profile'), { recursive: true })
    const res = await callTool('browser_profile_claim', { profile: 'loose-profile' }, { cwd })
    expect(res).toMatchObject({ ok: false, status: 400 })
    if (!res.ok) expect(res.error).toContain('already owns')
    expect(existsSync(join(root, 'loose-profile'))).toBe(true)
  })

  test('refuses a profile whose Chrome is live, and moves nothing', async () => {
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/invented' }),
    })
    writeFileSync(
      join(root, 'loose-profile', 'DevToolsActivePort'),
      `${stub.port}\n/devtools/browser/invented\n`,
    )
    const res = await callTool('browser_profile_claim', { profile: 'loose-profile' }, { cwd })
    expect(res).toMatchObject({ ok: false, status: 400 })
    if (!res.ok) expect(res.error).toContain('live Chrome')
    expect(existsSync(join(root, 'loose-profile'))).toBe(true)
    expect(existsSync(join(root, 'ws', 'shop-ws', 'loose-profile'))).toBe(false)
  })
})
