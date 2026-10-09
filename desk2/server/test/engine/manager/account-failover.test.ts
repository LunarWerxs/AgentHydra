// An SDK chat (an import, a fork) never ends on an account-level failure: a dead login or a usage limit
// moves the session to another healthy account and sends the message again, once, with a muted line;
// any other error stays an error on the account it happened on.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo, TranscriptItem } from '@shared/protocol'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatManager, pickHealthy, type ManagerBridge } from '../../../src/engine/chat-manager'
import { CONTINUE_TEXT, MAX_HANDOFF_CHARS } from '../../../src/engine/handoff'
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

const account = (num: number, over: Partial<AccountInfo> = {}): AccountInfo => ({
  id: `acct-${num}`,
  label: `#${num} user${num} (Pro)`,
  configDir: temp(`desk-fo-${num}-`),
  number: num,
  email: null,
  plan: 'Pro',
  signedIn: true,
  fiveHourPct: 10,
  weeklyPct: 10,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  inUse: false,
  ...over,
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let n = 0
const uuid = () => `50000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const failed = (error: string): SDKMessage =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: uuid(), session_id: 's' }) as unknown as SDKMessage

const SID = '8a8a8a8a-1111-4222-8333-444455556666'
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed'
const rejected = (): SDKMessage =>
  ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_791_086_400 }, uuid: uuid(), session_id: 's' }) as unknown as SDKMessage
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const said = (text: string, error?: string): SDKMessage =>
  ({ type: 'assistant', message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, ...(error ? { error } : {}), uuid: uuid(), session_id: SID }) as unknown as SDKMessage
const finished = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: uuid(), session_id: SID }) as unknown as SDKMessage
const LIMIT = "You've hit your session limit · resets 9:10pm"
/** The CLI's own words when a 5-hour window runs out mid-turn: a rate_limit assistant line, then the failed result. */
const limitHit = (): SDKMessage[] => [said(LIMIT, 'rate_limit'), failed(LIMIT)]

/** A session on #126 (signed in as far as AgentHydra's list says), with #61 healthy and #70 signed out. */
async function setup(o: { sessionLine?: string; handoffTokens?: number } = {}) {
  const home = temp('desk-fo-home-')
  const cwd = temp('desk-fo-cwd-')
  process.env.HYDRA_DESK_HOME = home
  const a = account(126)
  const b = account(61, { fiveHourPct: 30 })
  const c = account(70, { signedIn: false })
  const file = join(a.configDir!, 'projects', encodeProjectDir(cwd), `${SID}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `{"type":"user"}\n${o.sessionLine ?? ''}`)
  const q = fakeQueries()
  // A move reads the accounts first: holdMoves keeps it there.
  const hold = { gate: Promise.resolve() }
  const listAccounts = async () => {
    await hold.gate
    return [a, c, b]
  }
  const bridge: ManagerBridge = { ...fakeBridge({ roots: [join(a.configDir!, 'projects'), join(b.configDir!, 'projects')] }).bridge, listAccounts }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk', handoffTokens: o.handoffTokens, deskUrl: () => 'http://127.0.0.1:7798' })
  managers.push(m)
  const chat = await m.importSession({ sessionId: SID, cwd, title: 'Outside', configDir: a.configDir })
  return { m, q, a, b, chat, hold }
}

/** Holds the next move at its first step until the answer is called. */
function holdMoves(hold: { gate: Promise<void> }): () => void {
  let open!: () => void
  hold.gate = new Promise<void>((r) => (open = r))
  return open
}
const systemTexts = (items: TranscriptItem[]) => items.flatMap((i) => (i.kind === 'system' ? [i.text] : []))
const userTexts = (f: { sent: { message: { content: unknown } }[] }) => f.sent.map((s) => JSON.stringify(s.message.content))

test('an expired login moves the chat to the next healthy account and sends the message again, once', async () => {
  const { m, q, b, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(failed(EXPIRED))

  await waitFor(() => q.all.length === 2)
  expect(q.last().options).toMatchObject({ resume: SID, env: { CLAUDE_CONFIG_DIR: b.configDir } })
  await waitFor(() => userTexts(q.last()).length === 1)
  expect(userTexts(q.last())[0]).toContain('carry on')
  expect(systemTexts(m.listItems(chat.id))).toContain('Moved from #126 (signed out) to #61.')
  expect(m.get(chat.id).account.id).toBe(b.id)
})

test('an identity verification refusal moves the chat like an expired login', async () => {
  const { m, q, b, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(failed('API Error: 400 Identity verification is required to continue.'))
  await waitFor(() => q.all.length === 2)
  expect(q.last().options).toMatchObject({ resume: SID, env: { CLAUDE_CONFIG_DIR: b.configDir } })
  expect(m.get(chat.id).account.id).toBe(b.id)
})

test('the sign-in line says the chat is moving and the message goes again by itself, as a warning', async () => {
  const { m, q, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(failed(EXPIRED))
  await waitFor(() => q.all.length === 2)
  const line = m.listItems(chat.id).find((i) => i.kind === 'system' && i.text.startsWith('Sign-in failed'))
  expect(line).toMatchObject({ level: 'warn', text: 'Sign-in failed on #126 user126 (Pro): moving this chat to another account and sending your message again.' })
})

test("a usage limit's line says the same in place of its reset time", async () => {
  const { m, q, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(rejected())
  await waitFor(() => q.all.length === 2)
  const lines = m.listItems(chat.id).filter((i) => i.kind === 'system' && i.text.startsWith('Usage limit reached'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ level: 'warn', text: 'Usage limit reached (5-hour) on #126 user126 (Pro): moving this chat to another account and sending your message again.' })
})

test('the same message sent again by hand during a move waits for it and goes once', async () => {
  const { m, q, chat, hold } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  const open = holdMoves(hold)
  q.last().push(failed(EXPIRED))
  await waitFor(() => systemTexts(m.listItems(chat.id)).some((s) => s.startsWith('Sign-in failed')))
  const again = m.send(chat.id, 'carry on')
  await pause()
  open()
  expect(await again).toEqual({ queued: false })
  await waitFor(() => q.all.length === 2 && userTexts(q.last()).length > 0)
  await pause()
  expect(userTexts(q.all[0]!)).toHaveLength(1)
  expect(userTexts(q.last())).toHaveLength(1)
  expect(systemTexts(m.listItems(chat.id))).toContain('That message is already being sent again on #61 after the move, so it was not sent twice.')
})

test('another message sent during a move waits for it and goes to the new account after the one sent again', async () => {
  const { m, q, chat, hold } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  const open = holdMoves(hold)
  q.last().push(failed(EXPIRED))
  await waitFor(() => systemTexts(m.listItems(chat.id)).some((s) => s.startsWith('Sign-in failed')))
  const next = m.send(chat.id, 'and then this')
  await pause()
  open()
  await next
  await waitFor(() => q.all.length === 2 && userTexts(q.last()).length === 2)
  await pause()
  expect(userTexts(q.all[0]!)).toHaveLength(1)
  expect(userTexts(q.last())[0]).toContain('carry on')
  expect(userTexts(q.last())[1]).toContain('and then this')
})

test('an error that is not the account is shown where it happened: no move, no resend', async () => {
  const { m, q, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(failed('Tool use concurrency issues: invalid request body'))
  await waitFor(() => m.get(chat.id).status === 'error')
  expect(q.all).toHaveLength(1)
  expect(m.get(chat.id).account.number).toBe(126)
  expect(systemTexts(m.listItems(chat.id)).some((s) => s.startsWith('Moved'))).toBe(false)
})

test('a limit in a turn the CLI started itself (a background task ended) moves and continues the work, not nothing', async () => {
  const { m, q, b, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(said('Started the playtest in the background.'), finished())
  await waitFor(() => m.get(chat.id).status === 'idle')
  // The background task's end starts a turn with no message of ours; the 5-hour window runs out in it.
  q.last().push(said('The playtest finished; reading its log.'), ...limitHit())

  await waitFor(() => q.all.length === 2)
  expect(q.last().options).toMatchObject({ resume: SID, env: { CLAUDE_CONFIG_DIR: b.configDir } })
  await waitFor(() => userTexts(q.last()).length === 1)
  expect(userTexts(q.last())[0]).toContain(CONTINUE_TEXT)
  expect(userTexts(q.last())[0]).not.toContain('carry on')
  expect(systemTexts(m.listItems(chat.id))).toContain('Moved from #126 (limit reached) to #61.')
})

test('a limit after the turn had replied continues it too, instead of asking the message again', async () => {
  const { m, q, chat } = await setup()
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(said('Reading the files now.'), ...limitHit())
  await waitFor(() => q.all.length === 2)
  await waitFor(() => userTexts(q.last()).length === 1)
  expect(userTexts(q.last())[0]).toContain(CONTINUE_TEXT)
  expect(userTexts(q.last())[0]).not.toContain('carry on')
})

test('a session over the size cap moves as a fresh session whose first message is the condensed handoff', async () => {
  const usage = { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200_000, output_tokens: 300 }
  const { m, q, b, chat } = await setup({ sessionLine: `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage } })}\n` })
  const goal = `Build the planet game: one tap sends ships. ${'Every detail of the brief. '.repeat(2000)}`
  await m.send(chat.id, goal)
  await waitFor(() => q.all.length === 1)
  q.last().push(said('Wrote the map and the ship routes; 40 tests pass.'), finished())
  await waitFor(() => m.get(chat.id).status === 'idle')
  await m.send(chat.id, 'now add the win bar')
  q.last().push(said('Adding the win bar now.'), ...limitHit())

  await waitFor(() => q.all.length === 2)
  expect(q.last().options.resume).toBeUndefined()
  expect(q.last().options.env).toMatchObject({ CLAUDE_CONFIG_DIR: b.configDir })
  await waitFor(() => userTexts(q.last()).length === 1)
  const first = q.last().sent[0]!.message.content
  const text = typeof first === 'string' ? first : JSON.stringify(first)
  expect(text.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS + 200)
  for (const want of ['about 201k tokens', `/api/chats/${chat.id}/transcript`, `session_id ${SID}`, 'Build the planet game', 'now add the win bar', 'Wrote the map and the ship routes', 'Adding the win bar now.', 'do not redo finished steps']) expect(text).toContain(want)
  expect(m.get(chat.id).sessionId).toBeNull()
  // The old session is still this chat's, never listed as an outside one.
  expect(m.sessionIds()).toContain(SID)
  expect(systemTexts(m.listItems(chat.id)).some((s) => s.startsWith('The session had grown to about 201k tokens'))).toBe(true)
})

test('a session under the size cap is still copied and resumed', async () => {
  const usage = { input_tokens: 5, cache_read_input_tokens: 20_000, output_tokens: 300 }
  const { m, q, chat } = await setup({ sessionLine: `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage } })}\n` })
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(...limitHit())
  await waitFor(() => q.all.length === 2)
  expect(q.last().options.resume).toBe(SID)
  await waitFor(() => userTexts(q.last()).length === 1)
  expect(userTexts(q.last())[0]).toContain('carry on')
})

test('pickHealthy skips signed-out, tried, unread and at-the-85%-line accounts and prefers the least used', () => {
  const list = [
    account(1, { signedIn: false }),
    account(2, { fiveHourPct: 100 }),
    account(3, { fiveHourPct: 60 }),
    account(4, { fiveHourPct: 20 }),
    account(5),
    account(6, { weeklyPct: 85 }),
    account(7, { fiveHourPct: null })
  ]
  expect(pickHealthy(list, [])?.number).toBe(5)
  expect(pickHealthy(list, ['acct-5'])?.number).toBe(4)
  expect(pickHealthy(list, ['acct-5', 'acct-4', 'acct-3'])).toBeNull()
})
