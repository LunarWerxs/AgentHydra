// ChatManager's side of the send queue (SPEC "Send queue"), on SDK chats: a dispatch never joins a running
// turn, a send carries the queue's uuid into the SDK and the transcript, and a named account that is signed
// out is refused.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import type { AccountInfo } from '@shared/protocol'
import { NOW } from '../../bridge/fake-hydra'
import { fakeBridge, fakeQueries } from '../manager/fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SID = 'queue-manager-session-0001'
let n = 0
const uuid = () => `60000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const init = (): SDKMessage => ({ type: 'system', subtype: 'init', session_id: SID, uuid: uuid(), cwd: '/', tools: [], mcp_servers: [], model: 'm', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', skills: [], plugins: [], claude_code_version: '2' }) as unknown as SDKMessage
const state = (s: 'running' | 'idle'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SID }) as unknown as SDKMessage

/** A Pro account (one chat at a time); a lower 5-hour % means more room. */
const acct = (num: number, fiveHourPct: number, over: Partial<AccountInfo> = {}): AccountInfo => ({
  id: `pro${num}`,
  label: `#${num} user${num}@example.com (Pro)`,
  configDir: `C:\\cfg\\pro${num}`,
  number: num,
  email: null,
  plan: 'Pro',
  signedIn: true,
  fiveHourPct,
  weeklyPct: 50,
  fiveHourResetsAt: NOW + 5 * 3_600_000,
  weeklyResetsAt: NOW + 3.5 * 86_400_000,
  inUse: false,
  ...over,
})

/** A manager running SDK chats, with these accounts listed. */
function setup(accounts: AccountInfo[]) {
  const home = mkdtempSync(join(tmpdir(), 'desk-queue-manager-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  let clock = NOW
  const bridge: ManagerBridge = {
    ...fakeBridge().bridge,
    listAccounts: async () => accounts,
  }
  const q = fakeQueries()
  const m = new ChatManager({ home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, now: () => ++clock, newChats: 'sdk' })
  managers.push(m)
  return { m, home, ...q }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('onlyIfReady refuses a chat whose turn runs (a plain send still joins it); a ready chat takes it under the given uuid', async () => {
  const t = setup([acct(1, 0)])
  const chat = await t.m.create({ cwd: t.home, prompt: 'first' })
  const fake = t.last()
  fake.push(init(), state('running'))
  await waitFor(() => t.m.get(chat.id).status === 'working')

  await expect(t.m.send(chat.id, 'queued', undefined, { onlyIfReady: true })).rejects.toMatchObject({ status: 409 })
  await waitFor(() => fake.sent.length === 1)
  expect(await t.m.send(chat.id, 'plain')).toEqual({ queued: true })

  fake.push(state('idle'))
  await waitFor(() => t.m.get(chat.id).status === 'idle')
  const id = '60000000-0000-4000-8000-0000000000aa'
  expect(await t.m.send(chat.id, 'queued', undefined, { onlyIfReady: true, messageId: id })).toEqual({ queued: false })
  await waitFor(() => fake.sent.length === 3)
  expect(fake.sent[2]!.uuid).toBe(id)
  expect(t.m.listItems(chat.id).find((i) => i.kind === 'user' && i.id === id)).toMatchObject({ text: 'queued' })
})

test('a queued chat is in chats.json once createFromQueue answers, not after the save debounce', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-queue-manager-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const q = fakeQueries()
  const m = new ChatManager({ home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 60_000, newChats: 'sdk' })
  managers.push(m)
  const made = await m.createFromQueue({ cwd: home, prompt: 'once' }, { waitForRoom: false })
  if (!('chat' in made)) throw new Error('the chat was not created')
  // a crash now: the queue's restart must find the chat it recorded
  expect(JSON.parse(readFileSync(join(home, 'chats.json'), 'utf8')).map((c: { id: string }) => c.id)).toEqual([made.chat.id])
})

test('a named account that is signed out is refused with 409; the default login and auto are not', async () => {
  const t = setup([acct(1, 0), acct(2, 0, { signedIn: false })])
  await expect(t.m.create({ cwd: t.home, prompt: 'x', accountId: 'pro2' })).rejects.toMatchObject({ status: 409, message: '#2 user2@example.com (Pro) is signed out' })
  await expect(t.m.createFromQueue({ cwd: t.home, prompt: 'x', accountId: 'pro2' }, { waitForRoom: true })).rejects.toMatchObject({ status: 409 })
  const chat = await t.m.create({ cwd: t.home, accountId: 'pro1' })
  await expect(t.m.patch(chat.id, { accountId: 'pro2' })).rejects.toMatchObject({ status: 409 })
  expect((await t.m.create({ cwd: t.home, accountId: 'default' })).account.id).toBe('default')
  expect((await t.m.create({ cwd: t.home, accountId: 'auto' })).account.id).toBe('default')
})
