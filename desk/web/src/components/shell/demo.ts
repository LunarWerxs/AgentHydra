// Gallery-only data for the shell: rows laid out like the real screenshots
// (docs/reference/real/sidebar.png) with invented titles and folders, plus one row for each Hydra Desk status cue.
import { ref } from 'vue'
import type { AccountInfo, ChatStatus, ChatSummary, DeskSettings, ExternalSession, SearchHit, TranscriptItem } from '@shared/protocol'
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
