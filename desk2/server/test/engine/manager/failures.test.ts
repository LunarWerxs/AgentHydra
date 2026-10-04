// Every failure path appends one row to <home>/failures.jsonl (SPEC "Failure ledger"): a failed SDK turn
// and a refused first message here; the recovery of a moved chat is folded into the failure's row.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AccountInfo } from '@shared/protocol'
import { encodeProjectDir } from '../../../src/bridge/session-jsonl'
import { ChatManager, type ManagerBridge } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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
const account = (num: number): AccountInfo => ({
  id: `acct-${num}`, label: `#${num} user${num} (Pro)`, configDir: temp(`desk-fl-${num}-`), number: num, email: null, plan: 'Pro',
  signedIn: true, fiveHourPct: 10, weeklyPct: 10, fiveHourResetsAt: null, weeklyResetsAt: null, inUse: false,
})
const failed = (error: string): SDKMessage =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: 'f0000000-0000-4000-8000-000000000001', session_id: 's' }) as unknown as SDKMessage

test('a failed SDK turn appends one row, and the move to another account marks it recovered', async () => {
  const home = temp('desk-fl-home-')
  const cwd = temp('desk-fl-cwd-')
  const a = account(126)
  const b = account(61)
  const sid = '8a8a8a8a-1111-4222-8333-444455556666'
  const file = join(a.configDir!, 'projects', encodeProjectDir(cwd), `${sid}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{"type":"user"}\n')
  const q = fakeQueries()
  const bridge: ManagerBridge = { ...fakeBridge({ roots: [join(a.configDir!, 'projects'), join(b.configDir!, 'projects')] }).bridge, listAccounts: async () => [a, b] }
  const m = new ChatManager({ home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  const chat = await m.importSession({ sessionId: sid, cwd, title: 'Outside', configDir: a.configDir })
  await m.send(chat.id, 'carry on')
  await waitFor(() => q.all.length === 1)
  q.last().push(failed('Failed to authenticate: OAuth session expired for someone@example.com'))
  await waitFor(() => m.failures.read().rows.some((r) => r.recovered))

  const { rows, byCause, byAccount } = m.failures.read()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ chatId: chat.id, kind: 'sdk', cause: 'auth_expired', accountId: a.id, accountNumber: 126, recovered: true, movedToAccountId: b.id })
  expect(rows[0]!.message).toContain('<email>')
  expect(rows[0]!.message).not.toContain('someone@')
  expect(byCause).toEqual({ auth_expired: 1 })
  expect(byAccount).toEqual({ '#126': 1 })
})

test('a refused first message appends one row', async () => {
  const home = temp('desk-fl-home-')
  const failing = fakeBridge()
  failing.bridge.startWorker = async () => {
    throw new Error('pictures cannot be sent')
  }
  const m = new ChatManager({ home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: failing.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)
  const chat = await m.create({ cwd: temp('desk-fl-cwd-'), prompt: 'keep these words' })
  await waitFor(() => m.get(chat.id).status === 'error')
  const { rows } = m.failures.read()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ chatId: chat.id, kind: 'worker', cause: 'refused_send' })
  expect(rows[0]!.message).toContain('pictures cannot be sent')
})
