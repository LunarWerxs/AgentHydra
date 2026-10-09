// browser_profile_find over a fixture saved-browser store with invented names: service words resolve to hosts,
// URLs resolve to their host, and the points follow the Connections MCP's formula. No Chrome is launched.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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

const find = async (query: string) => {
  const res = await callTool('browser_profile_find', { for: query }, { cwd })
  expect(res.ok).toBe(true)
  if (!res.ok) throw new Error(res.error)
  return JSON.parse(res.text)
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
      'shop-ws/mail-profile': { sessionHosts: ['mail.google.com', 'accounts.google.com'], note: 'Work mail' },
      'shop-ws/example-shop': { sessionHosts: ['shop.example.test'], note: 'Example shop login' },
      'shop-ws/stripe-lab': { sessionHosts: [], note: 'Billing sandbox' },
    },
  })
  write(join(root, 'workspaces.json'), { 'shop-ws': { workspace: cwd } })
  for (const name of ['mail-profile', 'example-shop', 'stripe-lab'])
    mkdirSync(join(root, 'ws', 'shop-ws', name), { recursive: true })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('browser_profile_find', () => {
  test('a service word resolves to its hosts and picks the profile signed into them', async () => {
    const out = await find('gmail')
    expect(out.resolvedHosts).toEqual(['mail.google.com', 'accounts.google.com', 'google.com'])
    expect(out.drivableNow).toMatchObject({
      profile: 'mail-profile',
      scope: 'workspace',
      matchedHosts: ['mail.google.com', 'accounts.google.com', 'google.com'],
    })
  })

  test('a URL resolves to its host without www. and picks by that host', async () => {
    const out = await find('https://www.shop.example.test/cart')
    expect(out.resolvedHosts).toEqual(['shop.example.test'])
    expect(out.drivableNow).toMatchObject({ profile: 'example-shop', matchedHosts: ['shop.example.test'] })
  })

  test('a name-only hit is listed in managed but is never drivableNow', async () => {
    const out = await find('stripe')
    expect(out.resolvedHosts).toEqual(['dashboard.stripe.com', 'stripe.com'])
    expect(out.drivableNow).toBeNull()
    expect(out.managed).toEqual([
      expect.objectContaining({ profile: 'stripe-lab', hostHit: [], nameHit: true, noteHit: false, points: 3 }),
    ])
  })

  test('a note-only hit is listed in managed but is never drivableNow', async () => {
    const out = await find('billing')
    expect(out.resolvedHosts).toEqual([])
    expect(out.drivableNow).toBeNull()
    expect(out.managed).toEqual([
      expect.objectContaining({ profile: 'stripe-lab', hostHit: [], nameHit: false, noteHit: true, points: 3 }),
    ])
  })

  test('points are host hits times 10 plus 3 for a name and 3 for a note, with no word-in-host point', async () => {
    const out = await find('shop')
    expect(out.resolvedHosts).toEqual([])
    const row = out.managed.find((r: { profile: string }) => r.profile === 'example-shop')
    expect(row).toMatchObject({ hostHit: [], matchedHosts: [], nameHit: true, noteHit: true, points: 6 })

    const gmail = await find('gmail')
    expect(gmail.managed[0]).toMatchObject({
      profile: 'mail-profile',
      hostHit: ['mail.google.com', 'accounts.google.com', 'google.com'],
      matchedHosts: ['mail.google.com', 'accounts.google.com', 'google.com'],
      nameHit: false,
      noteHit: false,
      points: 30,
    })
  })

  test('a query with no host and no service word resolves nothing and drives nothing', async () => {
    const out = await find('LunarWerx')
    expect(out.resolvedHosts).toEqual([])
    expect(out.drivableNow).toBeNull()
  })
})
