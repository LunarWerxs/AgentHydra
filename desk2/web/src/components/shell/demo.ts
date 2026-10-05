// Gallery-only data for the shell: rows laid out like the real screenshots
// (docs/reference/real/sidebar.png) with invented titles and folders, plus one row for each Hydra Desk status cue.
import { ref } from 'vue'
import type { AccountInfo, ChatStatus, ChatSummary, DeskSettings, ExternalSession, HomeStats, HomeStatsRange, SearchHit, TranscriptItem } from '@shared/protocol'
import { cliMayteWorkerFixtures, settingsFixtures, transcriptFixtures } from '@/dev/fixtures'
import type { ShellSource } from './source'
import type { View } from './logic'
import type { ComposerApi } from '@/components/composer/api'

const MIN = 60_000

function chat(
  id: string,
  title: string,
  cwd: string,
  status: ChatStatus,
  agoMin: number,
  extra: Partial<ChatSummary> = {}
): ChatSummary {
  const now = Date.now()
  return {
    id,
    sessionId: `s-${id}`,
    title,
    cwd,
    account: { id: '68', label: '#68 eek (Max 20x)', configDir: null, number: 68 },
    accountAuto: true,
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: true,
    status,
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - agoMin * MIN - 40 * 60 * MIN,
    updatedAt: now - agoMin * MIN,
    costUsd: 0.4,
    contextPct: 30,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
    ...extra
  }
}

const C = 'C:/Users/me/Desktop/Project/connections'
const N = 'C:/Users/me/Desktop/nexuscode-2d'
const P = 'C:/Users/me/Desktop/audio-lab'

export function demoChats(): ChatSummary[] {
  const now = Date.now()
  return [
    chat('pc', 'Slow build investigation', C, 'working', 1, {
      activity: 'Bash: bun test',
      turnStartedAt: now - 3 * MIN - 12_000,
      climayteActive: 2
    }),
    chat('ccd', 'Desktop client rewrite plan', C, 'idle', 2),
    chat('usb', 'Unified settings and billing consolidation plan', C, 'needs_you', 3, { unread: true, pendingCount: 1 }),
    chat('nvw', 'Native vs web design trade-offs', C, 'idle', 4),
    chat('mkt', 'Plugin marketplace onboarding UX review', C, 'limited', 5, {
      limitResetsAt: now + 2 * 60 * MIN,
      model: 'claude-sonnet-5-5'
    }),
    chat('game', 'Game store resubmission readiness', N, 'idle', 6, { unread: true }),
    chat('err', 'Shader cache rebuild', N, 'error', 7, { lastError: 'API Error: 500 Internal server error' }),
    chat('stem', 'Audio stem isolation model', P, 'closed', 60),
    chat('pin', 'Hydra Desk release checklist', C, 'idle', 9, { pinned: true }),
    chat('sue', 'Kit sync for the composer', C, 'idle', 12, { account: { id: '35', label: '#35 sue (Max 5x)', configDir: null, number: 35 } }),
    chat('old', 'Old notes', P, 'closed', 900, { archived: true })
  ]
}

function account(id: string, name: string, plan: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    label: `#${id} ${name} (${plan})`,
    configDir: null,
    number: Number(id),
    email: null,
    plan,
    signedIn: true,
    fiveHourPct: 22,
    weeklyPct: 41,
    fiveHourResetsAt: Date.now() + 3 * 60 * MIN,
    weeklyResetsAt: Date.now() + 4 * 24 * 60 * MIN,
    inUse: false,
    ...over
  }
}

export function demoAccounts(): AccountInfo[] {
  const now = Date.now()
  return [
    account('68', 'eek', 'Max 20x'),
    account('35', 'sue', 'Max 5x', { fiveHourPct: 71, weeklyPct: 58, fiveHourResetsAt: now + 47 * MIN, inUse: true }),
    account('12', 'kai', 'Pro', { fiveHourPct: 93, weeklyPct: 88, fiveHourResetsAt: now + 2 * 60 * MIN + 14 * MIN }),
    account('7', 'old', 'Pro', { signedIn: false, fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null })
  ]
}

/** Sessions running elsewhere, in the same folders, so the list shows them beside our chats. */
export function demoExternal(): ExternalSession[] {
  const now = Date.now()
  const ext = (id: string, title: string, cwd: string | null, source: ExternalSession['source'], status: ExternalSession['status'], agoMin: number): ExternalSession => ({
    id,
    title,
    cwd,
    source,
    instance: source === 'desktop' ? '#68' : null,
    status,
    activity: status === 'working' ? 'Edit: src/main.ts' : null,
    lastActivityAt: now - agoMin * MIN,
    model: 'claude-opus-5-5',
    accountId: null,
    canResume: false,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null
  })
  return [
    ext('x-run', 'Level editor export bug', N, 'desktop', 'working', 2.5),
    ext('x-stale', 'Audio model tuning sweep', P, 'cli', 'stale', 3000),
    ext('x-cm', 'CliMayte worker (hidden)', C, 'climayte', 'working', 1)
  ]
}

/** What AgentHydra's transcript search finds in the Gallery: one of our chats, a listed outside session, two unlisted. */
export function demoSearchHits(): SearchHit[] {
  const now = Date.now()
  const hit = (sessionId: string, title: string, cwd: string, snippet: string, agoMin: number, source: SearchHit['source'] = 'cli'): SearchHit => ({
    sessionId,
    title,
    cwd,
    snippet,
    source,
    lastActivityAt: now - agoMin * MIN,
    score: 1
  })
  return [
    hit('s-ccd', 'Desktop client rewrite plan', C, '…the sidebar search should use the websocket bridge to AgentHydra…', 2),
    hit('x-stale', 'Audio model tuning sweep', P, 'The websocket reconnect loop backs off to 30 s, then the sweep resumes…', 3000),
    hit('h-old1', 'Flaky websocket test in CI', N, '…bun test passes locally but the websocket test times out on the runner…', 60 * 24 * 3, 'desktop'),
    hit('h-old2', 'Export pipeline notes', N, 'Search found the shader cache rebuild in an old Codex session…', 60 * 24 * 40, 'codex')
  ]
}

/**
 * Made-up consolidated figures for the stats card, scaled by range (the real ones are AgentHydra's). 7d leaves
 * HSwarm out to show a missing part; All is still being read, to show that footer line.
 */
export function demoHomeStats(range: HomeStatsRange): HomeStats {
  const f = range === 'all' ? 1 : range === '30d' ? 0.4 : 0.1
  const n = (x: number) => Math.round(x * f)
  const sources = [
    { key: 'desktop', label: 'Claude desktop', sessions: n(1800), messages: n(410_000), tokens: n(120e9), costUsd: n(42_000) },
    { key: 'climayte', label: 'CliMayte', sessions: n(2600), messages: n(96_000), tokens: n(18e9), costUsd: n(9_400) },
    { key: 'cli', label: 'Claude Code CLI', sessions: n(240), messages: n(30_000), tokens: n(9e9), costUsd: n(3_700) },
    { key: 'hswarm', label: 'HSwarm', sessions: n(1100), messages: n(61_000), tokens: n(6e9), costUsd: n(5_100) },
    { key: 'opencode', label: 'OpenCode', sessions: n(12), messages: n(40), tokens: n(1.1e9), costUsd: n(20) },
    { key: 'codex', label: 'Codex', sessions: n(60), messages: n(4_000), tokens: n(0.9e9), costUsd: n(700) }
  ]
  const sum = (pick: (s: (typeof sources)[number]) => number) => sources.reduce((t, s) => t + pick(s), 0)
  const total = sum((s) => s.tokens)
  const parts = { input: Math.round(total * 0.03), cacheRead: Math.round(total * 0.94), cacheWrite: Math.round(total * 0.02) }
  const days = range === 'all' ? 189 : range === '30d' ? 30 : 7
  const now = new Date()
  const heat = Array.from({ length: 189 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (188 - i))
    const level = i < 189 - days ? 0 : [0, 1, 2, 1, 3, 4, 2][i % 7]!
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { day, count: level * n(120), level }
  })
  return {
    range,
    sessions: sum((s) => s.sessions),
    messages: sum((s) => s.messages),
    tokens: { ...parts, output: total - parts.input - parts.cacheRead - parts.cacheWrite, total },
    costUsd: sum((s) => s.costUsd),
    pricesAsOf: '2026-10-01',
    activeDays: heat.filter((c) => c.level > 0).length,
    peakHour: '2 PM',
    favoriteModel: 'claude-opus-5-5',
    agentMinutes: n(90_000),
    heat,
    sources,
    models: [
      { key: 'claude-opus-5-5', sessions: n(3100) },
      { key: 'claude-sonnet-5-5', sessions: n(2200) },
      { key: 'claude-opus-5-5-20260901', sessions: n(300) },
      { key: 'gpt-6-astra', sessions: n(60) }
    ],
    climayte: { tasks: n(1700), sessions: n(3200), costUsd: n(9_400), limitHits: n(40) },
    hswarm: range === '7d' ? null : { tasks: n(5200), savedUsd: n(2_300) },
    coverage: { sessions: range === 'all' ? 5200 : 5800, total: 5800, refreshing: range === 'all' },
    missing: range === '7d' ? [{ part: 'hswarm', reason: 'HSwarm did not answer (the Gallery leaves it out on 7d)' }] : []
  }
}

/** A ShellSource over local refs: select, rename, pin, archive and delete all work in the Gallery. */
export function demoSource(start: View = { kind: 'chat', id: 'ccd' }): ShellSource {
  const chats = ref<ChatSummary[]>(demoChats())
  const items = ref(new Map<string, TranscriptItem[]>(chats.value.map((c) => [c.id, transcriptFixtures])))
  const selected = ref<View>(start)
  const settings = ref<DeskSettings>({ ...settingsFixtures, defaultAccountId: '68' })
  const external = ref<ExternalSession[]>(demoExternal())
  const patch = (id: string, p: Partial<ChatSummary>) => {
    chats.value = chats.value.map((c) => (c.id === id ? { ...c, ...p } : c))
  }
  const fork = (title: string, cwd: string, from: string) => {
    const made = chat(`fork-${chats.value.length}`, `${title} (fork)`, cwd, 'closed', 0, { sessionId: null, forkedFrom: from })
    chats.value = [made, ...chats.value]
    selected.value = { kind: 'chat', id: made.id }
    return made
  }
  return {
    chats,
    itemsByChat: items,
    workers: ref(cliMayteWorkerFixtures),
    external,
    accounts: ref(demoAccounts()),
    settings,
    selected,
    select: (v) => {
      selected.value = v
      if (v.kind === 'chat') patch(v.id, { unread: false })
    },
    openSettings: () => (selected.value = { kind: 'settings' }),
    updateChat: async (id, p) => patch(id, p as Partial<ChatSummary>),
    removeChat: async (id) => {
      chats.value = chats.value.filter((c) => c.id !== id)
    },
    interrupt: async (id) => patch(id, { status: 'stopped', activity: null, turnStartedAt: null }),
    loadItems: async () => {},
    updateSettings: async (p) => {
      settings.value = { ...settings.value, ...p }
    },
    forkChat: async (id) => {
      const src = chats.value.find((c) => c.id === id)!
      return fork(src.title, src.cwd, src.sessionId ?? src.forkedFrom!)
    },
    forkExternal: async (sessionId) => {
      const s = external.value.find((x) => x.id === sessionId)!
      return fork(s.title, s.cwd ?? C, s.id)
    },
    updateSessionMeta: async (sessionId, p) => {
      external.value = external.value.map((s) => (s.id === sessionId ? { ...s, ...p, title: p.title ?? s.title } : s))
    },
    revealFolder: async () => {},
    // The Gallery lists every outside session it has; an older search hit stays the read-only fallback.
    ensureExternal: async () => {},
    search: async (query) => {
      await new Promise((r) => setTimeout(r, 300))
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      return demoSearchHits().filter((h) => words.every((w) => `${h.title} ${h.snippet}`.toLowerCase().includes(w)))
    },
    // The Gallery keeps nothing in the browser: its figures must never land in the live app's cache.
    homeStats: async (range) => {
      await new Promise((r) => setTimeout(r, 300))
      return demoHomeStats(range)
    }
  }
}

/** Fixture answers for the composer's reads, so the Gallery shell renders without a server. */
export const demoComposerApi: ComposerApi = {
  models: async () => [
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],
  commands: async () => [],
  git: async () => ({ isRepo: true, branch: 'main', ahead: 0, behind: 0, added: 13658, removed: 4852, files: [] }),
  recentFolders: async () => [C, N, P],
  rememberFolder: async () => [C, N, P],
  forgetFolder: async () => [C, N, P],
  pickFolder: async () => null,
  browse: async (path) => ({ path: path ?? C, parent: 'C:/Users/me/Desktop/Project', dirs: [] }),
  accounts: async () => demoAccounts(),
  pickAccount: async () => demoAccounts()[0]!,
  mcpServers: async () => [
    { name: 'codegraph', scope: 'user', transport: 'stdio' },
    { name: 'zswarm', scope: 'user', transport: 'stdio' },
    { name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' }
  ],
  mcpStatus: async () => ({ live: false, servers: [] }),
  toggleMcp: async () => {}
}
