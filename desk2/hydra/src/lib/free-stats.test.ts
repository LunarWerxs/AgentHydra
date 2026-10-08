import { expect, test } from 'bun:test'
import type { FreeInstance, FreeStatRow, FreeTokens } from '@desk/shared/free-instances'
import { summarizeFree } from './free-stats'

const account = (id: string, num: number, provider: FreeInstance['provider']): FreeInstance =>
  ({ id, num, provider, name: `Example ${num}`, autoName: false, loggedIn: true, checkedAt: null, lastSignedInAt: null, lastActiveAt: null, usage: null })
const parts = (total: number) => ({ input: total, output: 0, total })
const tokens = (fiveHour: number, total: number): FreeTokens => ({ fiveHour: parts(fiveHour), week: parts(total), total: parts(total) })

test('Free numbers: tokens by provider in the table window, success by model, older tokens by day only', () => {
  const now = new Date(2026, 9, 8, 12).getTime()
  const instances = [account('b', 2, 'chatgpt'), account('a', 1, 'claude'), account('c', 3, 'chatgpt')]
  const row = (day: string, instanceId: string, model: string, sent: number, failed: number, input: number): FreeStatRow =>
    ({ day, instanceId, model, sent, failed, input, output: 0 })
  const rows = [
    row('2026-10-07', 'a', '', 0, 0, 500),
    row('2026-10-08', 'a', 'claude-haiku', 4, 1, 40),
    row('2026-10-08', 'b', 'gpt-6', 3, 0, 30),
    row('2026-10-08', 'c', 'gpt-6', 2, 2, 0),
    row('2026-10-08', 'c', 'unknown', 1, 1, 0),
    // An account removed since: on no total, line or day.
    row('2026-10-08', 'gone', 'gpt-6', 9, 0, 900),
  ]
  const all = { a: tokens(5, 1000), b: tokens(7, 2000) }
  const s = summarizeFree(rows, instances, all, '5h', 3, now)

  expect(s.totals).toEqual({ all: { tokens: 12, sent: 10, failed: 4 }, claude: { tokens: 5, sent: 4, failed: 1 }, chatgpt: { tokens: 7, sent: 6, failed: 3 } })
  expect(summarizeFree(rows, instances, all, 'total', 3, now).totals.all.tokens).toBe(3000)
  expect(s.models.map(m => [m.provider, m.model, m.sent, m.failed, m.tokens])).toEqual([
    ['chatgpt', 'gpt-6', 5, 2, 30], ['claude', 'claude-haiku', 4, 1, 40], ['chatgpt', 'unknown', 1, 1, 0]])
  expect(s.days).toEqual([{ key: '2026-10-06', claude: 0, chatgpt: 0 }, { key: '2026-10-07', claude: 500, chatgpt: 0 }, { key: '2026-10-08', claude: 40, chatgpt: 30 }])
})
