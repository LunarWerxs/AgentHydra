// A new chat is named from its first message by a generator that runs off the send (SPEC "Titles"):
// the generated title replaces the first words, never one the owner set meanwhile, and a failure keeps them.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { cleanTitle, sdkTitleGenerator, type TitleGenerator } from '../../../src/engine/chat-title'
import type { QueryImpl } from '../../../src/engine/chat-runtime'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(gen: TitleGenerator) {
  const home = mkdtempSync(join(tmpdir(), 'desk-title-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const events: unknown[] = []
  const m = new ChatManager({ home, emit: (e) => events.push(e), settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, titleGenerator: gen })
  managers.push(m)
  return { home, m, events }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

test('a new chat gets the generated title, a user rename wins, a failure keeps the first words', async () => {
  let release!: (t: string) => void
  const seen: string[] = []
  const gen: TitleGenerator = (req) => {
    seen.push(req.prompt)
    return new Promise((r) => (release = r))
  }
  const { home, m, events } = setup(gen)

  const a = await m.create({ cwd: home, prompt: 'Yo, I found a problem with this. You see the images are lost' })
  expect(m.get(a.id).title).toBe('Yo, I found a problem with this. You see the images are lost')
  release('Copy images with messages')
  await tick()
  expect(m.get(a.id).title).toBe('Copy images with messages')
  expect(events).toContainEqual(expect.objectContaining({ type: 'chat.upsert', chat: expect.objectContaining({ title: 'Copy images with messages' }) }))

  const b = await m.create({ cwd: home, prompt: 'second chat prompt' })
  await m.patch(b.id, { title: 'My own name' })
  release('Generated name')
  await tick()
  expect(m.get(b.id).title).toBe('My own name')

  const failing = setup(async () => null)
  const c = await failing.m.create({ cwd: failing.home, prompt: 'third chat prompt' })
  await tick()
  expect(failing.m.get(c.id).title).toBe('third chat prompt')
  expect(seen.length).toBe(2)
})

test('cleanTitle keeps 6 words at most, drops quotes and the trailing period', () => {
  expect(cleanTitle('"crazy games resubmission readiness check for the portal."\nmore')).toBe('Crazy games resubmission readiness check for')
  expect(cleanTitle('   ')).toBeNull()
})

test('an error the model returns as its result (a signed-out account) is no title', async () => {
  const result = (is_error: boolean, text: string) =>
    (() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', is_error, result: text }
      })()) as unknown as QueryImpl
  const signedOut = sdkTitleGenerator(result(true, 'Failed to authenticate: OAuth session expired and could not be refreshed'), {})
  expect(await signedOut({ prompt: 'hi', cwd: '.', configDir: null })).toBeNull()
  const ok = sdkTitleGenerator(result(false, 'Copy images with messages'), {})
  expect(await ok({ prompt: 'hi', cwd: '.', configDir: null })).toBe('Copy images with messages')
})
