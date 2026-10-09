// The hidden service end to end: started detached by the client, answers a tool call over its token-guarded route,
// and stops on request. Uses a temp Desk home and a fixture store; no Chrome.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBrowserAgentClient } from '../../../src/browser/agent/client'
import { readServiceFile } from '../../../src/browser/agent/service'
import { tempDir } from '../../git/helpers'

setDefaultTimeout(60_000)

const home = tempDir('agent-home-')
const root = tempDir('agent-service-store-')
const cwd = tempDir('agent-service-cwd-')
const saved = process.env.HYDRA_DESK_BROWSER_STORE
const client = createBrowserAgentClient({ home, startWaitMs: 30_000 })

beforeAll(() => {
  process.env.HYDRA_DESK_BROWSER_STORE = root
  mkdirSync(join(root, 'ws', 'shop-ws', 'example-shop'), { recursive: true })
  writeFileSync(join(root, 'workspaces.json'), JSON.stringify({ 'shop-ws': { workspace: cwd } }))
})

afterAll(async () => {
  await client.stop()
  if (saved === undefined) delete process.env.HYDRA_DESK_BROWSER_STORE
  else process.env.HYDRA_DESK_BROWSER_STORE = saved
})

describe('browser tools service', () => {
  test('starts on demand and answers a read-only call', async () => {
    const res = await client.call('browser_profiles', {}, { cwd, chat: 'chat-fixture' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.text).managed.map((r: { profile: string }) => r.profile)).toEqual(['example-shop'])
    expect(readServiceFile(home)).not.toBeNull()
  })

  test('refuses a call without the service token', async () => {
    const file = await client.ensure()
    const res = await fetch(`http://127.0.0.1:${file.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ name: 'browser_profiles', params: {}, caller: { cwd } }),
    })
    expect(res.status).toBe(401)
  })

  test('stops when asked and leaves no service file behind', async () => {
    await client.stop()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (await client.probe())) await Bun.sleep(100)
    expect(await client.probe()).toBeNull()
  })
})
