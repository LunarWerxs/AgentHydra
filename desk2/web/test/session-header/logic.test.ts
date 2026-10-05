import { describe, expect, test } from 'bun:test'
import type { TranscriptItem } from '@shared/protocol'
import {
  DEFAULT_DISPLAY,
  displayItems,
  findHits,
  instanceFor,
  usageSummary,
  wrapIndex,
  type AhInstance,
  type AhUsage
} from '../../src/components/session-header/logic'

// The session header over an outside session says and filters what AgentHydra's Sessions tab did.
const items = [
  { id: 'u1', ts: 1, kind: 'user', text: 'Fix the kit, then the KIT tests' },
  { id: 't1', ts: 2, kind: 'thinking', text: 'the kit is in web/' },
  { id: 'b1', ts: 3, kind: 'tool_use', name: 'Bash', input: { command: 'bun test kit' } },
  { id: 's1', ts: 4, kind: 'user', text: 'kit, in the sub-agent', parentToolUseId: 'agent-1' },
  { id: 'a1', ts: 5, kind: 'assistant_text', text: 'The kit is fixed.' }
] as unknown as TranscriptItem[]

describe('Find', () => {
  test('every match in what the transcript says, in order, whatever the case; not tool input or a sub-agent', () => {
    expect(findHits(items, ' Kit ')).toEqual([
      { itemId: 'u1', nth: 0 },
      { itemId: 'u1', nth: 1 },
      { itemId: 't1', nth: 0 },
      { itemId: 'a1', nth: 0 }
    ])
    expect(findHits(items, '  ')).toEqual([])
  })

  test('next past the last goes to the first, previous before the first to the last', () => {
    expect(wrapIndex(4, 4)).toBe(0)
    expect(wrapIndex(-1, 4)).toBe(3)
    expect(wrapIndex(-1, 0)).toBe(0)
  })
})

describe('Display', () => {
  const ids = (p: Partial<typeof DEFAULT_DISPLAY>) => displayItems(items, { ...DEFAULT_DISPLAY, ...p }).map((i) => i.id)

  test('Only what I typed keeps the prompts a person sent, and nothing else', () => {
    expect(ids({ humanOnly: true })).toEqual(['u1'])
  })

  test('tool activity and reasoning hide on their own', () => {
    expect(ids({})).toEqual(['u1', 't1', 'b1', 's1', 'a1'])
    expect(ids({ showTools: false })).toEqual(['u1', 't1', 's1', 'a1'])
    expect(ids({ showThinking: false })).toEqual(['u1', 'b1', 's1', 'a1'])
  })
})

test('a cost with a model that has no published price is marked as a floor', () => {
  const u: AhUsage = {
    status: 'ok',
    tokens: { input: 1000, output: 200_000, cacheRead: 1_000_000, cacheCreation: 50_000, total: 1_251_000, turns: 12 },
    costUsd: 3.4,
    unpricedModels: [],
    pricesAsOf: '2026-10-01'
  }
  expect(usageSummary(u)).toBe('1.3M tokens · $3.40')
  expect(usageSummary({ ...u, unpricedModels: ['some-model'] })).toBe('1.3M tokens · $3.40+')
  expect(usageSummary({ ...u, costUsd: null })).toBe('1.3M tokens')
  expect(usageSummary({ ...u, tokens: { ...u.tokens, turns: 0 } })).toBeNull()
})

test("the account is the one instance the session's label names, or none when two could be it", () => {
  const inst = (name: string, isDefault = false): AhInstance => ({ num: 1, name, dir: `C:/i/${name}`, isRunning: false, isDefault, account: null })
  const list = [inst('Claude', true), inst('4claude'), inst('default')]
  expect(instanceFor(list, { source: 'claude', instance: '4claude' })?.name).toBe('4claude')
  // 'default' is the regular install's label, but a folder named "default" could be it too.
  expect(instanceFor(list, { source: 'claude', instance: 'default' })).toBeNull()
  expect(instanceFor(list.slice(0, 2), { source: 'claude', instance: 'default' })?.name).toBe('Claude')
  // A Codex session names its own instance, never a Claude Desktop one.
  expect(instanceFor(list, { source: 'codex', instance: '4claude' })).toBeNull()
})
