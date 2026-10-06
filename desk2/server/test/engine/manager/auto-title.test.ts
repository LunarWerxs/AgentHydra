// A new chat is named from its first message by a generator that runs off the send (SPEC "Titles"):
// the generated title replaces the first words, never one the owner set meanwhile, and a failure keeps them.

import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { cleanTitle, sdkTitleGenerator, type TitleGenerator } from '../../../src/engine/chat-title'
import type { QueryImpl } from '../../../src/engine/chat-runtime'
import type { TranscriptItem } from '@shared/protocol'
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
  const m = new ChatManager({ home, claudeHome: home, emit: (e) => events.push(e), settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, titleGenerator: gen })
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
  await waitFor(() => seen.length === 1)
  release('Copy images with messages')
  await tick()
  expect(m.get(a.id).title).toBe('Copy images with messages')
  expect(events).toContainEqual(expect.objectContaining({ type: 'chat.upsert', chat: expect.objectContaining({ title: 'Copy images with messages' }) }))

  const b = await m.create({ cwd: home, prompt: 'second chat prompt' })
  await m.patch(b.id, { title: 'My own name' })
  await waitFor(() => seen.length === 2)
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
  expect(cleanTitle('"indie games resubmission readiness check for the portal."\nmore')).toBe('Indie games resubmission readiness check for')
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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('a CliMayte chat not placed yet is titled on a signed-in account, never the default login', async () => {
  const asked: (string | null)[] = []
  const { home, m } = setup(async (req) => {
    asked.push(req.configDir)
    return 'Named on a real login'
  })
  const a = await m.create({ cwd: home, prompt: 'ello Google Developer, check this' })
  await waitFor(() => m.get(a.id).title === 'Named on a real login')
  // fakeBridge lists #68 signed in; the stand-in account's null folder is the (signed-out) default login.
  expect(asked).toEqual(['C:/fake/instances/68'])
})

test('a failed title is said in the server log and asked once more; two failures keep the first words', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    let n = 0
    const { home, m } = setup(async (_req, failed) => {
      n++
      if (n === 1) {
        failed?.('Failed to authenticate: OAuth session expired')
        return null
      }
      return 'Second try worked'
    })
    const a = await m.create({ cwd: home, prompt: 'first words of the chat' })
    await waitFor(() => m.get(a.id).title === 'Second try worked')
    expect(n).toBe(2)
    const logged = warn.mock.calls.map((c) => String(c[0]))
    expect(logged.some((l) => l.includes(a.id) && l.includes('try 1 of 2') && l.includes('OAuth session expired'))).toBe(true)

    const never = setup(async (_req, failed) => {
      failed?.('no answer within 20s')
      return null
    })
    const b = await never.m.create({ cwd: never.home, prompt: 'never named' })
    await waitFor(() => warn.mock.calls.some((c) => String(c[0]).includes(b.id) && String(c[0]).includes('try 2 of 2')))
    expect(never.m.get(b.id).title).toBe('never named')
  } finally {
    warn.mockRestore()
  }
})

test('a chat opened empty is named by its first message', async () => {
  const { home, m } = setup(async () => 'Named from the first send')
  const a = await m.create({ cwd: home })
  expect(m.get(a.id).title).toBe('New session')
  await m.send(a.id, 'what the chat is about')
  await waitFor(() => m.get(a.id).title === 'Named from the first send')

  // One the owner named when opening it keeps that name.
  const b = await m.create({ cwd: home, title: 'Mine' })
  await m.send(b.id, 'something else')
  await tick()
  expect(m.get(b.id).title).toBe('Mine')
})

test('an imported session nobody named is named from its first message; a named one, a fork and a fresh session keep theirs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-title-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const SID = '7b7b7b7b-1111-4222-8333-444455556666'
  const items = { [SID]: [{ kind: 'user', id: 'u-1', ts: 1, text: 'please fix the flaky login test' }, { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'ok' }] as TranscriptItem[] }
  const b = fakeBridge({ items })
  const asked: string[] = []
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, titleGenerator: async (req) => (asked.push(req.prompt), 'Fix the flaky login test') })
  managers.push(m)

  const imported = await m.importSession({ sessionId: SID, cwd: home, configDir: 'C:/fake/instances/68' })
  await waitFor(() => m.get(imported.id).title === 'Fix the flaky login test')
  expect(asked).toEqual(['please fix the flaky login test'])

  const named = await m.importSession({ sessionId: SID, cwd: home, configDir: 'C:/fake/instances/68', title: 'Login work', fork: true })
  const forked = m.fork(imported.id)
  await tick()
  expect(m.get(named.id).title).not.toBe('Fix the flaky login test')
  expect(m.get(forked.id).title).toContain('Fix the flaky login test')
  expect(asked.length).toBe(1)

  // A CliMayte chat the owner renamed, continued in a fresh session after a move: the name stays.
  const w = await m.create({ cwd: home, prompt: 'a worker chat' })
  await waitFor(() => !!m.get(w.id).workerId)
  await m.patch(w.id, { title: 'Owner name' })
  Object.assign(b.state.rows[0]!, { status: 'running', accountId: 'cli-168', sessions: ['worker-session-1'], sessionId: 'worker-session-2' })
  await m.syncWorkers(w.id)
  expect(m.get(w.id).title).toBe('Owner name')
})
