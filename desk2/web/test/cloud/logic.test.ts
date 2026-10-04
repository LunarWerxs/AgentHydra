import { describe, expect, test } from 'bun:test'
import type { CloudSession } from '@shared/protocol'
import { DEFAULT_SCOPES, type CloudScopes, cloudQuery, effectiveScopes, groupCloud } from '../../src/components/cloud/logic'

// The cloud list asks AgentHydra's GET /api/sessions (through Desk's /api/cloud/sessions) in AgentHydra's
// own scope spelling. A wrong spelling does not fail loudly there: an unknown value falls back to a
// default, and a Claude-only scope sent without othersPass empties every other source.
const params = (s: CloudScopes, search = '') => Object.fromEntries(new URLSearchParams(cloudQuery(effectiveScopes(s, search), search)))

describe('cloudQuery', () => {
  test('the defaults ask for every source but HSwarm, live sessions, the last 24 hours', () => {
    expect(params(DEFAULT_SCOPES)).toEqual({ period: '24h', archived: 'active', source: '-zswarm', othersPass: '1' })
  })

  test('nothing ticked is AgentHydra\'s none, not "no narrowing"', () => {
    expect(params({ ...DEFAULT_SCOPES, source: [], archived: [] })).toMatchObject({ source: 'none', archived: 'none' })
  })

  test('instance, queued work and usage limits go only with Claude ticked', () => {
    const narrowed: CloudScopes = { ...DEFAULT_SCOPES, instance: ['default'], dispatched: ['queued'], rateLimit: ['pending'] }
    expect(params(narrowed)).toMatchObject({ source: '-zswarm', instance: 'default', dispatched: 'queued', ratelimited: 'pending' })
    const noClaude = params({ ...narrowed, source: ['codex'] })
    expect(noClaude).toEqual({ period: '24h', archived: 'active', source: 'codex', othersPass: '1' })
  })

  test('a search looks at everything, unless Only this view keeps the filters', () => {
    const narrowed: CloudScopes = { ...DEFAULT_SCOPES, source: ['claude'], period: '7d' }
    expect(params(narrowed, ' kit ')).toEqual({ period: 'all', archived: 'active,archived', othersPass: '1', title: 'kit' })
    expect(params({ ...narrowed, onlyThisView: true }, 'kit')).toEqual({ period: '7d', archived: 'active', source: 'claude', othersPass: '1', title: 'kit' })
  })
})

describe('groupCloud', () => {
  const row = (id: string, cwd: string, lastActivityAt: number): CloudSession => ({
    id,
    title: id,
    cwd,
    source: 'claude',
    instance: null,
    lastActivityAt,
    createdAt: null,
    messageCount: 3,
    dispatched: false,
    archived: false,
    fromPc: null,
    model: null
  })
  const rows = [row('old-match', 'D:/a', 1), row('new-match', 'D:/b', 3), row('mid-match', 'D:/a', 2)]
  const all = { shape: DEFAULT_SCOPES.shape, pcs: null }

  test('the plain list is grouped by folder, newest first', () => {
    expect(groupCloud(rows, all, 'PC').map((g) => g.rows.map((r) => r.id))).toEqual([['new-match'], ['mid-match', 'old-match']])
  })

  test("a search's answer keeps AgentHydra's best-match order", () => {
    expect(groupCloud(rows, all, 'PC', true).map((g) => g.rows.map((r) => r.id))).toEqual([['old-match', 'new-match', 'mid-match']])
  })
})
