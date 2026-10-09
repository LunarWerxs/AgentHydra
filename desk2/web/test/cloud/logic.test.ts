import { describe, expect, test } from 'bun:test'
import type { CloudSession, ExternalSession } from '@shared/protocol'
import { DEFAULT_SCOPES, type CloudScopes, cloudOnlyKeys, cloudQuery, deskOnPcs, deskPlaces, effectiveScopes, groupCloud, localOnly, parseScopes, pcKept, pickApp, type RowLead, rowLead, ahSource, appShown } from '../../src/components/cloud/logic'
import { dropHidden, groupChats, groupOrderKey, recordCloudOrder, recordDeskOrder, type SidebarOrder } from '../../src/components/sidebar/logic'

// The cloud list asks AgentHydra's GET /api/sessions (through Desk's /api/cloud/sessions) in AgentHydra's
// own scope spelling. A wrong spelling does not fail loudly there: an unknown value falls back to a
// default, and a Claude-only scope sent without othersPass empties every other source.
const params = (s: CloudScopes, search = '') => Object.fromEntries(new URLSearchParams(cloudQuery(effectiveScopes(s, search), search)))

describe('cloudQuery', () => {
  test('the defaults ask for Claude alone, live sessions, the last 24 hours', () => {
    expect(params(DEFAULT_SCOPES)).toEqual({ period: '24h', archived: 'active', source: 'claude', othersPass: '1' })
  })

  test('every app but HSwarm is the -zswarm shorthand', () => {
    expect(params({ ...DEFAULT_SCOPES, apps: ['claude', 'codex', 'opencode', 'hermes', 'dsh'] })).toMatchObject({ source: '-zswarm' })
  })

  test('nothing ticked is AgentHydra\'s none, not "no narrowing"', () => {
    expect(params({ ...DEFAULT_SCOPES, apps: [], archived: [] })).toMatchObject({ source: 'none', archived: 'none' })
  })

  test('instance, queued work and usage limits go only with Claude ticked', () => {
    const narrowed: CloudScopes = { ...DEFAULT_SCOPES, instance: ['default'], dispatched: ['queued'], rateLimit: ['pending'] }
    expect(params(narrowed)).toMatchObject({ source: 'claude', instance: 'default', dispatched: 'queued', ratelimited: 'pending' })
    const noClaude = params({ ...narrowed, apps: ['codex'] })
    expect(noClaude).toEqual({ period: '24h', archived: 'active', source: 'codex', othersPass: '1' })
  })

  test('a search looks at everything, unless Only this view keeps the filters', () => {
    const narrowed: CloudScopes = { ...DEFAULT_SCOPES, apps: ['claude'], period: '7d' }
    expect(params(narrowed, ' kit ')).toEqual({ period: 'all', archived: 'active,archived', othersPass: '1', title: 'kit' })
    expect(params({ ...narrowed, onlyThisView: true }, 'kit')).toEqual({ period: '7d', archived: 'active', source: 'claude', othersPass: '1', title: 'kit' })
  })
})

// Owner, 2026-10-05: the saved filters had `source` with every app ticked; Apps comes back at Claude alone, the rest stays.
describe('pickApp', () => {
  const apps = ['claude', 'codex', 'opencode'] as const
  test.each<[string, string[], string, string[]]>([
    ['from All, a click keeps that app alone', [...apps], 'codex', ['codex']],
    ['otherwise a click ticks an app', ['claude'], 'codex', ['claude', 'codex']],
    ['and unticks a ticked one', ['claude', 'codex'], 'claude', ['codex']],
  ])('%s', (_, selected, click, want) => {
    expect(pickApp(selected, apps, click)).toEqual(want)
  })
})

describe('parseScopes', () => {
  test('an old stored `source` list is dropped for the Apps default, the period kept', () => {
    const stored = JSON.stringify({ source: ['claude', 'codex', 'opencode', 'hermes', 'dsh'], period: '7d' })
    expect(parseScopes(stored)).toMatchObject({ apps: ['claude'], period: '7d' })
  })
})

// The cloud means another PC, nothing else; this PC's other apps get their own mark, an extra beside the row's dot (never in its place, whether or not the desk list shows the row).
describe('rowLead', () => {
  const lead = (source: string, fromPc: string | null, added = false) => rowLead({ source, fromPc }, 'HERE', { added })
  test.each<[string, RowLead, RowLead]>([
    ["another PC's Claude chat", lead('claude', 'THERE'), { kind: 'cloud', label: 'From THERE, through the chat sync' }],
    ["another PC's OpenCode chat", lead('opencode', 'THERE'), { kind: 'cloud', label: 'OpenCode chat from THERE, through the chat sync' }],
    ["this PC's OpenCode chat", lead('opencode', null), { kind: 'app', app: 'opencode', label: 'OpenCode chat on this PC' }],
    ["this PC's Claude chat", lead('claude', null), null],
    ["a row added for this PC's work", lead('claude', null, true), null],
    ["a row added for the other PC's work", lead('claude', 'THERE', true), { kind: 'cloud', label: 'On THERE' }]
  ])('%s', (_name, got, want) => {
    expect(got).toEqual(want)
  })
})

// Owner, 2026-10-05: Open Code and ChatGPT are not in the sidebar by default; the Apps ticks decide, desk list included.
describe("the desk list's Apps scope", () => {
  const session = (id: string, source: ExternalSession['source']): ExternalSession => ({
    id, title: id, cwd: 'D:/work/app', source, instance: null, status: 'idle', activity: null, lastActivityAt: 1, model: null,
    accountId: null, canResume: false, fromPc: null, pinned: false, archived: false, unread: false, group: null
  })
  const external = [session('claude-cli', 'cli'), session('claude-desktop', 'desktop'), session('codex-1', 'codex'), session('unnamed', 'other')]
  const listed = (apps: string[]) => groupChats([], { external, showApp: (s) => appShown(ahSource(s.source), apps) }).folders.flatMap((f) => f.entries.map((e) => e.id)).sort()
  test("Claude alone hides this PC's Codex chats, and the one it cannot name", () => {
    expect(listed(['claude'])).toEqual(['claude-cli', 'claude-desktop'])
  })
  test('ticking Codex shows them', () => {
    expect(listed(['claude', 'codex'])).toEqual(['claude-cli', 'claude-desktop', 'codex-1'])
  })
  test('the unnamed one needs every app but HSwarm', () => {
    expect(listed(['claude', 'codex', 'opencode', 'hermes', 'dsh'])).toContain('unnamed')
  })
  test("Desk's own chats are never filtered", () => {
    const chat = { id: 'c1', sessionId: null, title: 'mine', cwd: 'D:/work/app', group: null, archived: false, pinned: false, updatedAt: 5, createdAt: 5 } as unknown as Parameters<typeof groupChats>[0][number]
    const out = groupChats([chat], { external, showApp: () => false })
    expect(out.folders.flatMap((f) => f.entries.map((e) => e.id))).toEqual(['c1'])
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

  test('the plain list is grouped by folder, folders A-Z, rows newest first', () => {
    expect(groupCloud(rows, all, 'PC').map((g) => g.rows.map((r) => r.id))).toEqual([['mid-match', 'old-match'], ['new-match']])
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
    let order: SidebarOrder = { rows: ['chat-split', 'vector', 'rust', 'pub'] }
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
      ['new', ['split', 'vector', 'rust', 'cloud-a', 'cloud-c']],
      ['other', ['cloud-b']],
      ['pub', ['pub']]
    ])
    const added = cloudOnlyKeys(first, desk)
    expect(added).toEqual(['cloud-a', 'cloud-c', 'cloud-b'])
    order = recordCloudOrder(order, added)

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
      ['new', ['split', 'vector', 'rust', 'cloud-a', 'cloud-c', 'cloud-d']],
      ['other', ['cloud-b']],
      ['pub', ['pub']],
      ['zeta', ['cloud-e']]
    ])
    order = recordCloudOrder(order, cloudOnlyKeys(groupCloud(later, all, 'PC', { desk, order }), desk))

    // A Desk chat goes on in the folder only the cloud list had. New to the desk list, which shows it last
    // (the order knows it), its row goes to the top of the saved order, and its folder sorts A-Z as ever.
    const withOther = deskPlaces(
      [deskChat('chat-split', 'split', { cwd: 'D:/new' }), deskChat('chat-other', 'cloud-b', { cwd: 'D:/other' })],
      [outside('vector', { cwd: 'D:/new' }), outside('rust', { cwd: 'D:/new' }), outside('pub', { cwd: 'D:/pub' })]
    )
    order = recordDeskOrder(order, ['chat-other', 'chat-split', 'vector', 'rust', 'pub'])
    expect(order.rows[0]).toBe('chat-other')
    expect(recordDeskOrder(order, ['chat-other', 'chat-split', 'vector', 'rust', 'pub'])).toEqual(order)
    expect(listed(groupCloud(later, all, 'PC', { desk: withOther, order })).map(([label]) => label)).toEqual(['new', 'other', 'pub', 'zeta'])
  })

  // Two folders share a name: a session moved to a group of that name joins the same one of them in both
  // lists, never one only the cloud list has, so turning the cloud on moves nothing.
  test('a moved-to group joins the same namesake folder in the desk list and the cloud list', () => {
    const ext = (id: string, cwd: string, lastActivityAt: number, group: string | null = null): ExternalSession => ({
      id,
      title: id,
      cwd,
      source: 'desktop',
      instance: null,
      status: 'idle',
      activity: null,
      lastActivityAt,
      model: null,
      accountId: null,
      canResume: false,
      fromPc: null,
      pinned: false,
      archived: false,
      unread: false,
      group
    })
    const external = [ext('in-b', 'D:/b/app', 1), ext('in-a', 'D:/a/app', 2), ext('moved', 'D:/work/zeta', 3, 'App')]
    const deskFolder = groupChats([], { external }).folders.find((f) => f.entries.some((e) => e.id === 'moved'))
    const answer = [row('in-b', 'D:/b/app', 1), row('in-a', 'D:/a/app', 2), row('moved', 'D:/work/zeta', 3), row('cloud-only', 'D:/c/app', 9)]
    const cloudFolder = groupCloud(answer, all, 'PC', { desk: deskPlaces([], external) }).find((g) => g.rows.some((r) => r.id === 'moved'))
    expect(deskFolder?.cwd).toBe('D:/a/app')
    expect(cloudFolder?.cwd).toBe('D:/a/app')
  })

  // Owner, 2026-10-05: a group hidden with its right-click's Hide stays hidden with the cloud button on.
  test('a group hidden on the desk list is the one the cloud list hides', () => {
    const external = [outside('plain', { cwd: 'D:\\Work\\Alpha', lastActivityAt: 3 }), outside('moved', { cwd: 'D:/work/beta', group: 'Reading', lastActivityAt: 2 }), outside('kept', { cwd: 'D:/work/gamma', lastActivityAt: 1 })]
    const session = (o: DeskOutside): ExternalSession => ({ ...o, status: 'idle', activity: null, accountId: null, canResume: false, pinned: false, unread: false })
    const deskGroups = groupChats([], { external: external.map(session) }).folders
    const hidden = new Set(deskGroups.filter((g) => g.label !== 'gamma').map(groupOrderKey))
    const answer = [row('plain', 'D:/work/alpha', 3), row('moved', 'D:/work/beta', 2), row('kept', 'D:/work/gamma', 1), row('cloud-only', 'd:/work/Alpha/', 9)]
    const cloud = groupCloud(answer, all, 'PC', { desk: deskPlaces([], external) })
    expect(listed(dropHidden(cloud, (g) => g.orderKey, hidden, false).shown)).toEqual([['gamma', ['kept']]])
    expect(dropHidden(cloud, (g) => g.orderKey, hidden, true).shown.map((g) => [g.label, g.hidden])).toEqual([
      ['Alpha', true],
      ['gamma', undefined],
      ['Reading', true]
    ])
  })

  // Owner, 2026-10-05: "we should have one that says show only local".
  test('Show only local keeps this PC\'s sessions and leaves the other PC\'s out', () => {
    const answer = [row('here', 'D:/work/alpha', 2), { ...row('synced', 'D:/work/alpha', 3), fromPc: 'OTHER-PC' }]
    const ids = (s: CloudScopes) => groupCloud(answer, s, 'PC').flatMap((g) => g.rows.map((r) => r.id))
    expect(localOnly(all, 'PC')).toBe(false)
    expect(ids(all)).toEqual(['synced', 'here'])
    const local: CloudScopes = { ...all, pcs: ['PC'] }
    expect(localOnly(local, 'PC')).toBe(true)
    expect(ids(local)).toEqual(['here'])
    // Ticking the other PC too, in Computer, is both PCs again, not local.
    expect(localOnly({ ...all, pcs: ['PC', 'OTHER-PC'] }, 'PC')).toBe(false)
  })

  // Owner, 2026-10-05: "show only local, which should mean this PC" did nothing to the desk list.
  test('Show only local narrows the desk list too: Desk chats are this PC\'s, a synced outside session its PC\'s', () => {
    const chats = [deskChat('chat-1', 'chat-session')]
    const external = [outside('here'), outside('synced', { fromPc: 'OTHER-PC' })]
    const ids = (pcs: string[] | null) => {
      const kept = deskOnPcs(chats, external, pcs, 'PC')
      return [...kept.chats.map((c) => c.id), ...kept.external.map((s) => s.id)]
    }
    expect(ids(null)).toEqual(['chat-1', 'here', 'synced'])
    expect(ids(['PC'])).toEqual(['chat-1', 'here'])
    expect(ids(['OTHER-PC'])).toEqual(['synced'])
    expect(ids(['PC', 'OTHER-PC'])).toEqual(['chat-1', 'here', 'synced'])
    expect(pcKept(external[1], ['PC'], 'PC')).toBe(false)
  })

  // Owner, 2026-10-04: an outside Desktop chat the desk list shows was missing from the cloud list, older
  // than its 24 hours.
  test('a session the desk list shows is listed when AgentHydra leaves it out; only the period cannot drop it', () => {
    const desk = deskPlaces([deskChat('chat-1', 'chat-session', { cwd: 'D:/conn', updatedAt: 2 })], [outside('old-desktop', { cwd: 'D:/conn', lastActivityAt: 1 })])
    const answer = [row('recent', 'D:/conn', 50)]
    const ids = (s: CloudScopes, ranked = false) => groupCloud(answer, s, 'PC', { desk, ranked }).flatMap((g) => g.rows.map((r) => r.id))
    expect(listed(groupCloud(answer, all, 'PC', { desk }))).toEqual([['conn', ['recent', 'chat-session', 'old-desktop']]])
    // App, archived and PC are read off the desk's facts.
    expect(ids({ ...all, apps: ['codex'] })).toEqual(['recent'])
    expect(ids({ ...all, archived: ['archived'] })).toEqual(['recent'])
    expect(ids({ ...all, pcs: ['PC'] })).toEqual(['recent', 'chat-session', 'old-desktop'])
    // Shape and instance are AgentHydra's facts: narrowed, they keep the desk's rows out.
    expect(ids({ ...all, shape: ['quick'] })).toEqual(['recent'])
    expect(ids({ ...all, instance: ['default'] })).toEqual(['recent'])
    // A search's answer is AgentHydra's alone.
    expect(ids(all, true)).toEqual(['recent'])
  })
})
