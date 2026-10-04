// A chat moves folders when its session's own transcript says its working directory is now outside the
// chat's folder (the model cd'd out): stored cwd, one muted line, a chat update for the sidebar, and the
// next turn resumes the same session in the new folder. A cd into a subfolder moves nothing.

import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, ServerEvent, TranscriptItem } from '@shared/protocol'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const SID = '7b7b7b7b-1111-4222-8333-444455556666'
const done = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: '60000000-0000-4000-8000-000000000001', session_id: SID }) as unknown as SDKMessage
const line = (cwd: string): string => `${JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, cwd, message: { role: 'user', content: 'x' } })}\n`

async function setup() {
  const home = temp('desk-cm-home-')
  const base = temp('desk-cm-base-')
  const cwd = join(base, 'A')
  const other = join(base, 'X')
  mkdirSync(join(cwd, 'web', 'src'), { recursive: true })
  mkdirSync(other, { recursive: true })
  process.env.HYDRA_DESK_HOME = home
  const configDir = temp('desk-cm-acct-')
  const account: AccountInfo = { id: 'acct-1', label: '#1 user (Pro)', configDir, number: 1, email: null, plan: 'Pro', signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false }
  const file = join(configDir, 'projects', encodeProjectDir(cwd), `${SID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, line(cwd))
  const roots = [join(configDir, 'projects')]
  const q = fakeQueries()
  const events: ServerEvent[] = []
  const bridge: ManagerBridge = { ...fakeBridge({ roots }).bridge, listAccounts: async () => [account] }
  const m = new ChatManager({ home, emit: (e) => events.push(e), settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  const chat = await m.importSession({ sessionId: SID, cwd, title: 'Outside', configDir })
  return { m, q, events, chat, cwd, other, file, configDir }
}
const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))

test('a cd out of the chat folder moves the chat and the next turn runs there; a cd into a subfolder does not', async () => {
  const { m, q, events, chat, cwd, other, file } = await setup()
  await m.send(chat.id, 'go')
  await waitFor(() => q.all.length === 1)

  // Into a subfolder of the chat's own folder: nothing moves.
  appendFileSync(file, line(join(cwd, 'web', 'src')))
  q.last().push(done())
  await waitFor(() => m.get(chat.id).status === 'idle')
  await new Promise((r) => setTimeout(r, 30))
  expect(m.get(chat.id).cwd).toBe(cwd)
  expect(systemTexts(m.listItems(chat.id)).some((s) => s.startsWith('Moved this chat'))).toBe(false)

  // Out of it: the chat moves, says so once, and the sidebar is told.
  appendFileSync(file, line(other))
  await m.send(chat.id, 'again')
  q.last().push(done())
  await waitFor(() => m.get(chat.id).cwd === other)
  expect(systemTexts(m.listItems(chat.id))).toContain(`Moved this chat to ${other}.`)
  expect(events.some((e) => e.type === 'chat.upsert' && e.chat.id === chat.id && e.chat.cwd === other)).toBe(true)
  await waitFor(() => q.last().calls.close === 1)
})

test('the next turn after a move resumes the same session in the new folder, with its transcript there and the original kept', async () => {
  const { m, q, chat, other, file, configDir } = await setup()
  await m.send(chat.id, 'go')
  await waitFor(() => q.all.length === 1)
  appendFileSync(file, line(other))
  q.last().push(done())
  await waitFor(() => q.last().calls.close === 1)

  await m.send(chat.id, 'now here')
  await waitFor(() => q.all.length === 2)
  expect(q.last().options).toMatchObject({ cwd: other, resume: SID })
  expect(existsSync(join(configDir, 'projects', encodeProjectDir(other), `${SID}.jsonl`))).toBe(true)
  expect(existsSync(file)).toBe(true)
})
