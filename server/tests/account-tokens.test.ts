// Tokens per ACCOUNT (core/account-tokens.ts): a message is credited to the account signed in to
// its instance when it was written, one usage per reply, and a window counts only what is inside it.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountTokens, refreshAccountTokens } from '../src/core/account-tokens'
import { createCliInstance, deleteCliInstance } from '../src/core/cli-instances'
import type { TokenParts } from '../src/types'

const created: { id: string; name: string }[] = []
afterAll(() => {
  for (const { id, name } of created) deleteCliInstance(id, name)
})

const HOUR = 3_600_000
const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const reply = (id: string, at: number, output: number, input = 1, read = 0, write = 0) =>
  line({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
      },
    },
  })

/** A signed-in CLI instance (credentials present, empty) holding `uuid`, with `transcript` written. */
function instanceHolding(uuid: string, transcript: string) {
  const name = `acct-tokens-${crypto.randomUUID().slice(0, 8)}`
  const made = createCliInstance(name)
  expect(made.ok).toBe(true)
  created.push({ id: made.data?.id as string, name })
  const dir = made.dir as string
  writeFileSync(join(dir, '.credentials.json'), '{}')
  signInAs(dir, uuid)
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
  writeFileSync(join(dir, 'projects', 'p', 's1.jsonl'), transcript)
  return dir
}
const signInAs = (dir: string, uuid: string) =>
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }))

describe('accountTokens', () => {
  test('an instance that changes account credits each message to the account signed in then', async () => {
    const now = Date.now()
    // A streamed reply (three lines, last usage wins) written under account A, one more under A, and
    // a reply timestamped after the switch below that must go to B.
    const dir = instanceHolding(
      ACCOUNT_A,
      reply('m1', now - 2 * HOUR, 1, 3, 100, 10) +
        reply('m1', now - 2 * HOUR, 1, 3, 100, 10) +
        reply('m1', now - 2 * HOUR, 40, 3, 100, 10) +
        reply('m2', now - HOUR, 5, 2, 200, 0),
    )
    await refreshAccountTokens()
    expect(accountTokens(ACCOUNT_A)?.total).toEqual({
      input: 5,
      output: 45,
      cacheRead: 300,
      cacheWrite: 10,
      total: 360,
    })

    // The instance is signed in to B; a later message is B's, and A keeps what it ran before.
    signInAs(dir, ACCOUNT_B)
    writeFileSync(join(dir, 'projects', 'p', 's2.jsonl'), reply('m3', now + HOUR, 7, 1, 0, 0))
    await refreshAccountTokens()
    expect(accountTokens(ACCOUNT_B)?.total.total).toBe(8)
    expect(accountTokens(ACCOUNT_A)?.total.total).toBe(360)
  })

  test('a transcript that grows gives the totals of reading it whole, a reply split by the append included', async () => {
    const now = Date.now()
    const first = Array.from({ length: 12 }, (_, i) =>
      reply(`g${i}`, now - (i < 3 ? 20 * 24 : 1) * HOUR + i, 10 + i, 1, 5, 2),
    ).join('')
    // The last reply of `first` streams on after the append boundary with a larger usage; a new
    // reply follows, and an unfinished line (no newline yet) is completed by the second append.
    const unfinished = reply('g20', now, 3, 1, 0, 0)
    const cut = unfinished.length - 9
    const second =
      reply('g11', now, 99, 1, 5, 2) + reply('g12', now, 4, 1, 0, 0) + unfinished.slice(0, cut)
    const third = unfinished.slice(cut) + reply('g20', now, 6, 1, 0, 0)

    const grown = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const whole = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const dir = instanceHolding(grown, first)
    const file = join(dir, 'projects', 'p', 's1.jsonl')
    await refreshAccountTokens()
    appendFileSync(file, second)
    await refreshAccountTokens()
    appendFileSync(file, third)
    instanceHolding(whole, first + second + third)
    await refreshAccountTokens()

    const expected = accountTokens(whole)?.total
    expect(expected?.output).toBe(10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 99 + 4 + 6)
    expect(accountTokens(grown)?.total).toEqual(expected as TokenParts)
    expect(accountTokens(grown)?.week).toEqual(accountTokens(whole)?.week as TokenParts)
  })

  test('the 5-hour window counts only messages since it began', async () => {
    const now = Date.now()
    const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    instanceHolding(
      account,
      reply('w1', now - 6 * HOUR, 100) + // before the window, inside the week
        reply('w2', now - 4 * HOUR, 10) + // before the window that ends in 2 h (it began 3 h ago)
        reply('w3', now - HOUR, 1),
    )
    await refreshAccountTokens()
    const resets = {
      sessionResetsAt: new Date(now + 2 * HOUR).toISOString(),
      weekResetsAt: new Date(now + 24 * HOUR).toISOString(),
    }
    const t = accountTokens(account, resets)
    expect(t?.fiveHour.output).toBe(1)
    expect(t?.week.output).toBe(111)
    expect(t?.total.output).toBe(111)
    // No reset time known: the last five hours.
    expect(accountTokens(account)?.fiveHour.output).toBe(11)
  })
})
