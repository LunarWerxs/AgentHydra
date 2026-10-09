// The read-only browser tools over a fixture saved-browser store with invented names; no Chrome is launched.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callTool } from '../../../src/browser/agent/tools'
import { tempDir } from '../../git/helpers'

setDefaultTimeout(30_000)

const saved = process.env.HYDRA_DESK_BROWSER_STORE
let root: string
let cwd: string

const write = (file: string, data: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data))
}

beforeEach(() => {
  root = tempDir('agent-store-')
  cwd = tempDir('agent-cwd-')
  process.env.HYDRA_DESK_BROWSER_STORE = root
  write(join(root, 'registry.json'), {
    profiles: {
      'shop-ws/example-shop': { sessionHosts: ['example.test'], note: 'Example shop login', title: 'Example shop' },
    },
  })
  write(join(root, 'workspaces.json'), { 'shop-ws': { workspace: cwd } })
  mkdirSync(join(root, 'ws', 'shop-ws', 'example-shop'), { recursive: true })
})

afterEach(() => {
  if (saved === undefined) delete process.env.HYDRA_DESK_BROWSER_STORE
  else process.env.HYDRA_DESK_BROWSER_STORE = saved
})

describe('browser_profiles', () => {
  test('lists the workspace profiles with their signed-in hosts and note', async () => {
    const res = await callTool('browser_profiles', {}, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out.workspace).toBe('shop-ws')
    expect(out.managed).toHaveLength(1)
    expect(out.managed[0]).toMatchObject({
      profile: 'example-shop',
      scope: 'workspace',
      key: 'shop-ws/example-shop',
      open: false,
      signedInHosts: ['example.test'],
      note: 'Example shop login',
      title: 'Example shop',
    })
    expect(out.unowned).toEqual([])
  })

  test('needs the chat folder to pick a workspace', async () => {
    const res = await callTool('browser_profiles', {}, {})
    expect(res).toMatchObject({ ok: false, status: 400 })
  })
})

describe('browser_profile_find', () => {
  test('scores a saved browser by the host it is signed into', async () => {
    const res = await callTool('browser_profile_find', { for: 'https://shop.example.test/cart' }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const out = JSON.parse(res.text)
    expect(out.query).toBe('https://shop.example.test/cart')
    expect(out.drivableNow).toMatchObject({ profile: 'example-shop', matchedHosts: ['shop.example.test'] })
    expect(out.managed[0]).toMatchObject({ profile: 'example-shop', matchedHosts: ['shop.example.test'] })
  })

  test('names a profile by its note words', async () => {
    const res = await callTool('browser_profile_find', { for: 'example' }, { cwd })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const top = JSON.parse(res.text).managed[0]
    expect(top).toMatchObject({ profile: 'example-shop' })
    expect(top.points).toBeGreaterThan(0)
  })

  test('refuses a call without a query', async () => {
    const res = await callTool('browser_profile_find', {}, { cwd })
    expect(res).toMatchObject({ ok: false, status: 400 })
  })
})

describe('browser_status and the live tools', () => {
  test('reports no open browser when no saved profile is running', async () => {
    const res = await callTool('browser_status', {}, { cwd })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.text).toContain('(0)')
  })

  test('targets and frames refuse to guess a browser', async () => {
    expect(await callTool('browser_targets', {}, { cwd })).toMatchObject({ ok: false, status: 400 })
    expect(await callTool('browser_frames', { profile: 'example-shop' }, { cwd })).toMatchObject({ ok: false, status: 400 })
  })

  test('an unknown tool is a 404', async () => {
    expect(await callTool('browser_launch', {}, { cwd })).toMatchObject({ ok: false, status: 404 })
  })
})
