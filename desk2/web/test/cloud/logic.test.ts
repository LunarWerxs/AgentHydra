import { describe, expect, test } from 'bun:test'
import type { CloudSession } from '@shared/protocol'
import { DEFAULT_SCOPES, type CloudScopes, cloudOnlyKeys, cloudQuery, deskPlaces, effectiveScopes, groupCloud } from '../../src/components/cloud/logic'
import { recordOrder, type SidebarOrder } from '../../src/components/sidebar/logic'

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
    lastCwd: null,
    source: 'claude',
    instance: null,
    lastActivityAt,
    createdAt: null,
    messageCount: 3,
    dispatched: false,
    archived: false,
    fromPc: null,
    model: null,
    effort: null,
    instanceNum: null
  })
  const rows = [row('old-match', 'D:/a', 1), row('new-match', 'D:/b', 3), row('mid-match', 'D:/a', 2)]
  const all = DEFAULT_SCOPES
  // What the desk list lists, as the desk store has it.
  type DeskChat = Parameters<typeof deskPlaces>[0][number]
  type DeskOutside = Parameters<typeof deskPlaces>[1][number]
  const deskChat = (id: string, sessionId: string, over: Partial<DeskChat> = {}): DeskChat => ({
    id,
    sessionId,
    title: id,
    cwd: 'D:/work/alpha',
    group: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    model: null,
    effort: null,
    account: { id: '1', label: '#1', configDir: null, number: 1 },
    ...over
  })
  const outside = (id: string, over: Partial<DeskOutside> = {}): DeskOutside => ({
    id,
    title: id,
    cwd: 'D:/work/alpha',
    group: null,
    source: 'desktop',
    instance: null,
    archived: false,
    lastActivityAt: 0,
    model: null,
    fromPc: null,
    ...over
  })
  const listed = (groups: ReturnType<typeof groupCloud>) => groups.map((g) => [g.label, g.rows.map((r) => r.id)])

  test('the plain list is grouped by folder, newest first', () => {
    expect(groupCloud(rows, all, 'PC').map((g) => g.rows.map((r) => r.id))).toEqual([['new-match'], ['mid-match', 'old-match']])
  })

  test("a search's answer keeps AgentHydra's best-match order", () => {
    expect(groupCloud(rows, all, 'PC', { ranked: true }).map((g) => g.rows.map((r) => r.id))).toEqual([['old-match', 'new-match', 'mid-match']])
  })

  // Turning the cloud on must not move a chat to another group: a session the desk list shows sits where
  // it sits there, whatever folder AgentHydra says it works in now.
  test('a session the desk list shows keeps its desk group: its folder, or the group it was moved to', () => {
    const cloudRows = [
      row('went-deeper', 'D:/work/alpha/inner', 5),
      row('moved-away', 'D:/work/beta', 4),
      row('plain', 'D:/work/alpha', 3),
      row('moved-to-folder', 'D:/work/gamma', 2)
    ]
    const desk = deskPlaces(
      [deskChat('chat-deeper', 'went-deeper', { cwd: 'D:\\work\\alpha' })],
      [
        outside('moved-away', { cwd: 'D:/work/beta', group: 'Reading' }),
        // A moved-to group named like a folder group joins it, as on the desk list.
        outside('moved-to-folder', { cwd: 'D:/work/gamma', group: 'ALPHA', source: 'cli' })
      ]
    )
    expect(listed(groupCloud(cloudRows, all, 'PC', { desk }))).toEqual([
      ['alpha', ['went-deeper', 'plain', 'moved-to-folder']],
      ['Reading', ['moved-away']]
    ])
  })

  // Owner, 2026-10-04: turning the cloud on, off and on again changed the order, and each 30 s refresh
  // reshuffled it again. Both lists keep one saved order (sidebar/order.ts).
  test("with the saved order a row the desk list shows keeps its desk place; the cloud's own rows follow and keep theirs once recorded", () => {
    const desk = deskPlaces(
      [deskChat('chat-split', 'split', { cwd: 'D:/new' })],
      [outside('vector', { cwd: 'D:/new' }), outside('rust', { cwd: 'D:/new' }), outside('pub', { cwd: 'D:/pub' })]
    )
    // The desk list's order: a Desk chat is kept by its own id, not its session's.
    let order: SidebarOrder = { groups: ['d:/pub', 'd:/new'], rows: ['chat-split', 'vector', 'rust', 'pub'] }
    const answer = [
      row('rust', 'D:/new', 100),
      row('split', 'D:/new', 50),
      row('vector', 'D:/new', 10),
      row('pub', 'D:/pub', 5),
      row('cloud-a', 'D:/new', 200),
      row('cloud-b', 'D:/other', 300),
      row('cloud-c', 'D:/new', 150)
    ]
    const first = groupCloud(answer, all, 'PC', { desk, order })
    expect(listed(first)).toEqual([
      ['pub', ['pub']],
      ['new', ['split', 'vector', 'rust', 'cloud-a', 'cloud-c']],
      ['other', ['cloud-b']]
    ])
    const added = cloudOnlyKeys(first, desk)
    expect(added).toEqual({ groups: ['d:/other'], rows: ['cloud-a', 'cloud-c', 'cloud-b'] })
    order = { groups: recordOrder(order.groups, added.groups, 'end'), rows: recordOrder(order.rows, added.rows, 'end') }

    // The next refresh: new activity everywhere and two newcomers. Nothing recorded moves; they follow.
    const later = [
      row('rust', 'D:/new', 1000),
      row('split', 'D:/new', 50),
      row('vector', 'D:/new', 10),
      row('pub', 'D:/pub', 900),
      row('cloud-a', 'D:/new', 200),
      row('cloud-b', 'D:/other', 300),
      row('cloud-c', 'D:/new', 999),
      row('cloud-d', 'D:/new', 500),
      row('cloud-e', 'D:/zeta', 2000)
    ]
    expect(listed(groupCloud(later, all, 'PC', { desk, order }))).toEqual([
      ['pub', ['pub']],
      ['new', ['split', 'vector', 'rust', 'cloud-a', 'cloud-c', 'cloud-d']],
      ['other', ['cloud-b']],
      ['zeta', ['cloud-e']]
    ])
  })

  // Owner, 2026-10-04: an outside Desktop chat the desk list shows was missing from the cloud list, older
  // than its 24 hours.
  test('a session the desk list shows is listed when AgentHydra leaves it out; only the period cannot drop it', () => {
    const desk = deskPlaces([deskChat('chat-1', 'chat-session', { cwd: 'D:/conn', updatedAt: 2 })], [outside('old-desktop', { cwd: 'D:/conn', lastActivityAt: 1 })])
    const answer = [row('recent', 'D:/conn', 50)]
    const ids = (s: CloudScopes, ranked = false) => groupCloud(answer, s, 'PC', { desk, ranked }).flatMap((g) => g.rows.map((r) => r.id))
    expect(listed(groupCloud(answer, all, 'PC', { desk }))).toEqual([['conn', ['recent', 'chat-session', 'old-desktop']]])
    // Source, archived and PC are read off the desk's facts.
    expect(ids({ ...all, source: ['codex'] })).toEqual(['recent'])
    expect(ids({ ...all, archived: ['archived'] })).toEqual(['recent'])
    expect(ids({ ...all, pcs: ['PC'] })).toEqual(['recent', 'chat-session', 'old-desktop'])
    // Shape and instance are AgentHydra's facts: narrowed, they keep the desk's rows out.
    expect(ids({ ...all, shape: ['quick'] })).toEqual(['recent'])
    expect(ids({ ...all, instance: ['default'] })).toEqual(['recent'])
    // A search's answer is AgentHydra's alone.
    expect(ids(all, true)).toEqual(['recent'])
  })
})
