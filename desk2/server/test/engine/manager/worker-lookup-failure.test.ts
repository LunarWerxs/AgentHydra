// A failed worker lookup costs one round: every worker chat's transcript still syncs from the last rows known.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('a worker lookup that throws costs that round only: each worker chat still gets its new transcript items', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-worker-lookup-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)

  const first = await m.create({ cwd: home, prompt: 'first worker' })
  const second = await m.create({ cwd: home, prompt: 'second worker' })
  while (!m.get(first.id).workerId || !m.get(second.id).workerId) await new Promise((r) => setTimeout(r, 5))
  for (const row of b.state.rows) Object.assign(row, { status: 'running' })
  const firstSession = m.get(first.id).sessionId as string
  const secondSession = m.get(second.id).sessionId as string

  const lookup = b.bridge.workersByIds
  let down = false
  b.bridge.workersByIds = async (ids) => {
    if (down) throw new Error('the daemon did not answer in time')
    return lookup(ids)
  }

  b.state.workerItems[firstSession] = [{ kind: 'assistant_text', id: 'a-1', ts: 10, text: 'first answer' }]
  b.state.workerItems[secondSession] = [{ kind: 'assistant_text', id: 'b-1', ts: 11, text: 'second answer' }]
  await m.syncWorkers()
  expect(m.listItems(first.id).find((i) => i.id === 'a-1')).toMatchObject({ text: 'first answer' })
  expect(m.listItems(second.id).find((i) => i.id === 'b-1')).toMatchObject({ text: 'second answer' })

  down = true
  b.state.workerItems[firstSession] = [...b.state.workerItems[firstSession]!, { kind: 'assistant_text', id: 'a-2', ts: 12, text: 'more from first' }]
  b.state.workerItems[secondSession] = [...b.state.workerItems[secondSession]!, { kind: 'assistant_text', id: 'b-2', ts: 13, text: 'more from second' }]
  await m.syncWorkers()
  expect(m.listItems(first.id).find((i) => i.id === 'a-2')).toMatchObject({ text: 'more from first' })
  expect(m.listItems(second.id).find((i) => i.id === 'b-2')).toMatchObject({ text: 'more from second' })
})
