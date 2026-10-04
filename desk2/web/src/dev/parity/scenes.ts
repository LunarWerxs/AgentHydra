// The parity page's scenes: which fixture state each '#/parity/<scene>' renders. The scene list with the
// reference images, crops and viewports is docs/reference/real/scenes.json; its routes point here.
import { ref } from 'vue'
import type { AccountInfo, ChatSummary, CliMayteWorker, DeskSettings, ExternalSession, GitStatus, TranscriptItem } from '@shared/protocol'
import { cliMayteWorkerFixtures, settingsFixtures } from '@/dev/fixtures'
import type { ShellSource } from '@/components/shell/source'
import type { View } from '@/components/shell/logic'
import type { ComposerApi } from '@/components/composer/api'
import type { PaneApi } from '@/components/panes/api'
import { PARITY_NOW } from './clock'
import { backgroundTaskWorkers } from './tasks'
import { markdownSceneItems } from './markdown'
import {
  CWD,
  HARVEST_DRAFT,
  HARVEST_GIT,
  WINDOW_DRAFT,
  WINDOW_GIT,
  harvestChats,
  harvestItems,
  parityAccounts,
  popoverAccounts,
  sidebarUserChats,
  windowChats,
  windowItems
} from './fixtures'

export type MenuName = 'plus' | 'mode' | 'model' | 'effort'

export interface ParityScene {
  /** 'frame' = the whole DeskFrame; 'dock' = the composer alone in the transcript column. */
  layout: 'frame' | 'dock'
  chats: () => ChatSummary[]
  items: () => TranscriptItem[]
  view: View
  git: { branch: string; added: number; removed: number }
  /** The grey suggested next prompt the real captures show in the empty box (not a typed draft). */
  suggestion?: string
  external?: ExternalSession[]
  accountsOpen?: boolean
  /** The account list (default: the two of the composer captures) and the saved default account. */
  accounts?: () => AccountInfo[]
  defaultAccountId?: string
  /** The account Auto would pick now. */
  pickId?: string
  openDiff?: boolean
  /** The CliMayte workers the store lists (default: the gallery's three). */
  workers?: () => CliMayteWorker[]
  /** Opens the Background tasks panel. */
  openTasks?: boolean
  /** Views visited before `view` (the window capture has Back enabled). */
  history?: View[]
}

const whole: ParityScene = {
  layout: 'frame',
  chats: harvestChats,
  items: harvestItems,
  view: { kind: 'chat', id: 'ccd' },
  git: HARVEST_GIT,
  suggestion: HARVEST_DRAFT,
  history: [{ kind: 'chat', id: 'pc' }]
}

export const PARITY_SCENES: Record<string, ParityScene> = {
  window: { layout: 'frame', chats: windowChats, items: windowItems, view: { kind: 'chat', id: 'ccd' }, git: WINDOW_GIT, suggestion: WINDOW_DRAFT, history: [{ kind: 'chat', id: 'avg' }] },
  'sidebar-user': { layout: 'frame', chats: sidebarUserChats, items: windowItems, view: { kind: 'chat', id: 'ccd' }, git: WINDOW_GIT, suggestion: WINDOW_DRAFT },
  'whole-window': whole,
  'new-session': { ...whole, view: { kind: 'new', cwd: CWD }, suggestion: undefined },
  'diff-pane': { ...whole, openDiff: true },
  'background-tasks': { ...whole, workers: backgroundTaskWorkers, openTasks: true },
  // The Settings dialog over the chat it was opened from.
  settings: { ...whole, view: { kind: 'settings' }, history: [{ kind: 'chat', id: 'pc' }, { kind: 'chat', id: 'ccd' }] },
  'external-session': {
    ...whole,
    view: { kind: 'external', id: 'x-run' },
    suggestion: undefined,
    external: [
      {
        id: 'x-run',
        title: 'Level editor export bug',
        cwd: 'C:/Users/jacob/Desktop/nexuscode-2d',
        source: 'desktop',
        instance: '#68',
        status: 'working',
        activity: 'Edit: src/main.ts',
        lastActivityAt: PARITY_NOW - 150_000,
        model: 'claude-opus-5-5',
        accountId: 'cli-68',
        canResume: false,
        pinned: false,
        archived: false,
        unread: false,
        group: null
      }
    ]
  },
  'transcript-markdown': { ...whole, items: markdownSceneItems, workers: () => [], suggestion: undefined },
  'accounts-popover': { ...whole, accountsOpen: true, accounts: popoverAccounts, defaultAccountId: 'auto', pickId: '128' },
  'agents-bar-expanded': { ...whole, layout: 'dock' },
  // A chat waiting on AskUserQuestion with three questions: the card shows one at a time.
  'question-steps': {
    ...whole,
    chats: () => harvestChats().map((c): ChatSummary => (c.id === 'ccd' ? { ...c, status: 'needs_you', pendingCount: 1 } : c)),
    suggestion: undefined,
    items: () => [
      ...harvestItems(),
      {
        id: 'ask-open',
        ts: PARITY_NOW - 5_000,
        kind: 'question',
        state: 'pending',
        questions: [
          { question: 'Where should drafts be kept?', header: 'Storage', multiSelect: false, options: [{ label: 'localStorage', description: 'Simple and built in' }, { label: 'Server', description: 'Survives a browser reset' }] },
          { question: 'Which pieces should the new card show?', header: 'Pieces', multiSelect: true, options: [{ label: 'Step header', description: 'Question 1 of 3' }, { label: 'Thumbnails', description: 'Pictures in Other' }] },
          { question: 'Anything else to keep in mind?', header: 'Notes', multiSelect: false, options: [{ label: 'No', description: 'Go ahead' }] }
        ]
      }
    ]
  },
  // A chat waiting on a permission, with the SDK's own wording and the rule "Always allow" would save.
  'request-dock': {
    ...whole,
    chats: () => harvestChats().map((c): ChatSummary => (c.id === 'ccd' ? { ...c, status: 'needs_you', pendingCount: 1 } : c)),
    suggestion: undefined,
    items: () => [
      ...harvestItems(),
      {
        id: 'perm-open',
        ts: PARITY_NOW - 5_000,
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        canAlwaysAllow: true,
        title: 'Claude wants to run git push origin main',
        alwaysRules: ['Bash(git push:*) in this project'],
        state: 'pending'
      }
    ]
  }
}

const sceneAccounts = (scene: ParityScene) => (scene.accounts ?? parityAccounts)()
const scenePick = (scene: ParityScene) => sceneAccounts(scene).find((a) => a.id === scene.pickId) ?? parityAccounts()[0]!

/** A ShellSource over local refs, like the Gallery's demo source but holding exactly the scene's data. */
export function sceneSource(scene: ParityScene): ShellSource {
  const chats = ref(scene.chats())
  const items = ref(new Map<string, TranscriptItem[]>([['ccd', scene.items()]]))
  const selected = ref<View>(scene.view)
  const settings = ref<DeskSettings>({ ...settingsFixtures, defaultAccountId: scene.defaultAccountId ?? '68' })
  const patch = (id: string, p: Partial<ChatSummary>) => {
    chats.value = chats.value.map((c) => (c.id === id ? { ...c, ...p } : c))
  }
  return {
    chats,
    itemsByChat: items,
    workers: ref(scene.workers?.() ?? cliMayteWorkerFixtures),
    external: ref(scene.external ?? []),
    accounts: ref(sceneAccounts(scene)),
    settings,
    selected,
    select: (v) => (selected.value = v),
    openSettings: () => (selected.value = { kind: 'settings' }),
    updateChat: async (id, p) => patch(id, p as Partial<ChatSummary>),
    removeChat: async (id) => (chats.value = chats.value.filter((c) => c.id !== id)),
    interrupt: async () => {},
    loadItems: async () => {},
    updateSettings: async (p) => (settings.value = { ...settings.value, ...p }),
    forkChat: async () => chats.value[0]!,
    forkExternal: async () => chats.value[0]!,
    updateSessionMeta: async () => {},
    revealFolder: async () => {},
    search: async () => []
  }
}

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

function gitStatus(scene: ParityScene): GitStatus {
  return {
    isRepo: true,
    branch: scene.git.branch,
    ahead: 0,
    behind: 0,
    added: scene.git.added,
    removed: scene.git.removed,
    files: [
      { path: 'web/src/components/composer/Composer.vue', status: 'M', added: 412, removed: 96 },
      { path: 'web/src/components/sidebar/Sidebar.vue', status: 'M', added: 88, removed: 41 },
      { path: 'web/src/dev/parity/ParityPage.vue', status: '??', added: 140, removed: 0 }
    ]
  }
}

export function sceneComposerApi(scene: ParityScene): ComposerApi {
  return {
    models: async () => MODELS,
    commands: async () => [],
    git: async () => gitStatus(scene),
    recentFolders: async () => [CWD],
    rememberFolder: async () => [CWD],
    forgetFolder: async () => [],
    pickFolder: async () => null,
    browse: async (path) => ({ path: path ?? CWD, parent: 'C:/Users/jacob/Desktop/Project', dirs: [] }),
    accounts: async () => parityAccounts(),
    pickAccount: async () => parityAccounts()[0]!,
    mcpServers: async () => [{ name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' }],
    mcpStatus: async () => ({ live: false, servers: [] }),
    toggleMcp: async () => {},
    suggestion: () => scene.suggestion ?? null
  }
}

export function scenePaneApi(scene: ParityScene): PaneApi {
  return {
    gitStatus: async () => gitStatus(scene),
    gitDiff: async (_cwd, path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n import { ref } from 'vue'\n-const open = ref(false)\n+const open = ref(true)\n+const width = ref(288)\n`,
    models: async () => MODELS,
    health: async () => ({ ok: true, version: '0.1.0' }),
    bridgeStatus: async () => ({ up: true, url: 'http://127.0.0.1:7787' }),
    getSettings: async () => ({ ...settingsFixtures, defaultAccountId: '68' }),
    putSettings: async (p) => ({ ...settingsFixtures, ...p }),
    accounts: async () => sceneAccounts(scene),
    pickAccount: async () => scenePick(scene),
    externalItems: async () => scene.items(),
    diagnostics: async () => ({ rows: [], total: 0, byCause: {}, byAccount: {}, byDay: {} }) as never
  }
}
