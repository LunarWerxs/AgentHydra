import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSummary, HomeStats } from '@shared/protocol'
import { accountLabel, accountTitle } from '../../src/components/accounts/format'
import { rowTooltip } from '../../src/components/sidebar/logic'
import { TIPS, TIPS_KEY, dismissTip, modelTriggerLabel, nextTip, resolvedEffort, type DraftStorage } from '../../src/components/composer/logic'
import { computeStats } from '../../src/components/shell/logic'
import { homeFooter, homeModels, homeSources, homeTiles, statsFooter, statsTiles } from '../../src/components/shell/stats'

const EMAIL = /[^\s<>()@]+@[^\s<>()@]+\.[a-z]{2,}/i

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

describe('account labels', () => {
  it('names an account by number and plan once, never by email', () => {
    expect(accountTitle({ id: '128', label: '#128 jacob@example.com (Pro) (Pro)', plan: 'Pro' })).toBe('#128 · Pro')
    expect(accountTitle({ id: '128', label: '#128 <jacob@example.com> (Pro) (Pro)', plan: 'Pro' })).toBe('#128 · Pro')
    expect(accountTitle({ id: '68', label: '#68 eek (Max 20x)', plan: 'Max 20x' })).toBe('#68 eek · Max 20x')
    expect(accountTitle({ id: 'default', label: 'jacob@example.com', plan: null })).toBe('Default login')
  })

  it('reads the plan from the label of a bare AccountRef (a chat account)', () => {
    expect(accountTitle({ id: '128', label: '#128 jacob@example.com (Pro) (Pro)' })).toBe('#128 · Pro')
    expect(accountTitle({ id: '7', label: '#7' })).toBe('#7')
  })

  it('drops a doubled trailing plan from the short label', () => {
    expect(accountLabel('#128 jacob@example.com (Pro) (Pro)', 'Pro', '128')).toBe('#128')
  })

  it('keeps emails out of the chat row tooltip', () => {
    const chat = { title: 'T', status: 'idle', activity: null, climayteActive: 0, account: { id: '128', label: '#128 jacob@example.com (Pro) (Pro)', configDir: null } } as unknown as ChatSummary
    const tip = rowTooltip(chat)
    expect(tip).not.toMatch(EMAIL)
    expect(tip.endsWith('#128 · Pro')).toBe(true)
  })

  it('no component renders an account label raw', () => {
    const root = join(import.meta.dir, '../../src/components')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.vue')) files.push(p)
      }
    }
    walk(root)
    const raw = /account\.label\b|autoPick(\.value)?\??\.label|\{\{\s*a\.label\s*\}\}/
    expect(files.filter((f) => raw.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))).toEqual([])
  })
})

describe('model and effort triggers', () => {
  it('always names a model', () => {
    expect(modelTriggerLabel('claude-opus-5-5', MODELS)).toBe('Opus 5.5')
    expect(modelTriggerLabel(null, MODELS)).toBe('Sonnet 5.5')
    expect(modelTriggerLabel(null, [{ value: 'default', label: 'Default (Opus 5.5)' }, ...MODELS])).toBe('Opus 5.5')
    expect(modelTriggerLabel(null, [])).toBe('Sonnet')
    expect(modelTriggerLabel(null, MODELS)).not.toMatch(/default/i)
  })

  it('names an effort from the chat, else settings, else the recommended stop', () => {
    expect(resolvedEffort('high', 'xhigh')).toBe('high')
    expect(resolvedEffort(null, 'xhigh')).toBe('xhigh')
    expect(resolvedEffort(null, null)).toBe('medium')
  })
})

describe('tips', () => {
  it('shows the first tip and remembers dismissals', () => {
    const s = memory()
    expect(nextTip(s)?.id).toBe(TIPS[0]!.id)
    dismissTip(s, TIPS[0]!.id)
    expect(nextTip(s)?.id).toBe(TIPS[1]!.id)
    dismissTip(s, TIPS[0]!.id)
    expect(JSON.parse(s.data.get(TIPS_KEY)!)).toEqual([TIPS[0]!.id])
    for (const t of TIPS) dismissTip(s, t.id)
    expect(nextTip(s)).toBeNull()
  })

  it('survives broken storage', () => {
    const s = memory()
    s.setItem(TIPS_KEY, '{nope')
    expect(nextTip(s)?.id).toBe(TIPS[0]!.id)
    expect(nextTip(null)?.id).toBe(TIPS[0]!.id)
  })
})

describe('stats card', () => {
  const NOW = new Date(2026, 9, 4, 15).getTime()
  const chat = (over: Partial<ChatSummary>): ChatSummary =>
    ({ cwd: 'C:/p/a', model: 'claude-opus-5-5', costUsd: 1.5, createdAt: NOW - 3600_000, updatedAt: NOW - 3600_000, ...over }) as ChatSummary

  it('uses the real labels and a dash for what Hydra Desk does not count', () => {
    const s = computeStats([chat({}), chat({ cwd: 'C:/p/b', updatedAt: NOW - 86_400_000 * 2, createdAt: NOW - 86_400_000 * 2 })], 'all', NOW)
    const tiles = statsTiles(s)
    expect(tiles.map((t) => t.label)).toEqual(['Sessions', 'Messages', 'Total tokens', 'Active days', 'Peak hour', 'Favorite model'])
    expect(tiles.map((t) => t.value)).toEqual(['2', '–', '–', '2', '2 PM', 'Opus 5.5'])
    expect(statsFooter(s)).toBe("You've run 2 sessions in 2 folders over 2 days, $3.00 in all.")
  })

  it('says nothing invented for an empty range', () => {
    expect(statsFooter(computeStats([], '7d', NOW))).toBe('No sessions in this range yet.')
    expect(statsFooter(computeStats([chat({ costUsd: 0 })], 'all', NOW))).toBe("You've run 1 session in 1 folder over 1 day.")
  })

  it("shows AgentHydra's consolidated figures, and a dash with the reason for a part that did not answer", () => {
    const home: HomeStats = {
      range: 'all',
      sessions: 6499,
      messages: 1_234_567,
      tokens: { input: 2_000_000_000, cacheRead: 480_000_000_000, cacheWrite: 5_000_000_000, output: 600_000_000, total: 487_600_000_000 },
      costUsd: 257_672.4,
      pricesAsOf: '2026-10-01',
      activeDays: 91,
      peakHour: '2 PM',
      favoriteModel: 'claude-opus-5-5',
      agentMinutes: 86_936,
      heat: [],
      sources: [
        { key: 'desktop', label: 'Claude desktop', sessions: 311, messages: 224_761, tokens: 61_746_567_890, costUsd: 21_376.3 },
        { key: 'opencode', label: 'OpenCode', sessions: 4, messages: 4, tokens: 999_950, costUsd: null }
      ],
      models: [
        { key: 'claude-opus-5-5', sessions: 40 },
        { key: 'claude-sonnet-5-5', sessions: 30 },
        { key: 'claude-opus-5-5-20260901', sessions: 5 }
      ],
      climayte: { tasks: 1668, sessions: 3164, costUsd: 3788.2, limitHits: 37 },
      hswarm: null,
      coverage: { sessions: 3248, total: 6499, refreshing: true },
      missing: [{ part: 'hswarm', reason: 'HSwarm did not answer (502)' }]
    }
    const tiles = homeTiles(home)
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Sessions', '6,499'],
      ['Messages', '1,234,567'],
      ['Total tokens', '487.6B'],
      ['Active days', '91'],
      ['Peak hour', '2 PM'],
      ['Favorite model', 'Opus 5.5'],
      ['CliMayte tasks', '1,668'],
      ['HSwarm tasks', '–'],
      ['Cost at API rates', '$257,672']
    ])
    expect(tiles[2]!.title).toBe('Input 2,000,000,000\nCache read 480,000,000,000\nCache write 5,000,000,000\nOutput 600,000,000')
    expect(tiles[3]!.title).toBe('1,449 hours of agent time')
    expect(tiles[6]!.title).toBe('37 runs stopped at a usage limit\n$3,788 at API rates')
    expect(tiles[7]!.title).toBe('HSwarm did not answer (502)')
    expect(tiles[8]!.title).toBe('Prices as of 2026-10-01')
    // 999,950 tokens round up to the next unit; a source AgentHydra could not price shows a dash.
    expect(homeSources(home).map((s) => [s.label, s.sessions, s.tokens, s.cost])).toEqual([
      ['Claude desktop', '311', '61.7B', '$21,376'],
      ['OpenCode', '4', '1.0M', '–']
    ])
    // A dated id joins its model's row.
    expect(homeModels(home)).toEqual([
      { label: 'Opus 5.5', sessions: 45 },
      { label: 'Sonnet 5.5', sessions: 30 }
    ])
    expect(homeFooter(home)).toEqual([
      '6,499 sessions from 2 sources over 91 days, $257,672 at API rates.',
      'AgentHydra is still reading sessions (3,248 of 6,499), so these figures will grow.'
    ])
  })
})
