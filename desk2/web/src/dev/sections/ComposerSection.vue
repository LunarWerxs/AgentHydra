<script setup lang="ts">
import { provide } from 'vue'
import type { ChatSummary, GitStatus } from '@shared/protocol'
import Composer from '@/components/composer/Composer.vue'
import { COMPOSER_API, type ComposerApi } from '@/components/composer/api'
import { accountFixtures, chatFixtures, cliMayteWorkerFixtures } from '../fixtures'

// The composer reads its lists through COMPOSER_API; here they come from fixtures, so no server is needed.
const git: GitStatus = {
  isRepo: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  added: 13658,
  removed: 4852,
  files: [
    { path: 'web/src/components/composer/Composer.vue', status: 'M', added: 420, removed: 300 },
    { path: 'web/src/App.vue', status: 'M', added: 3, removed: 1 },
    { path: 'docs/fidelity/composer.md', status: '??', added: 80, removed: 0 }
  ]
}
// The folder menu's list, kept here so choosing, removing and Add new folder show in the gallery.
let recentFolders = ['D:/NEWProjects/connections', 'C:/Users/jacob/Desktop/Project/Agent Hydra/desk', 'D:/NEWProjects/web', 'C:/Users/jacob/Desktop/Project/Agent Hydra/desk/web']
const fixtureApi: ComposerApi = {
  // The real model menu's order.
  models: async () => [
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' }
  ],
  commands: async () => [
    { name: 'review', description: 'Review the current diff' },
    { name: 'resume', description: 'Resume an earlier session' },
    { name: 'release-notes', description: 'Show the release notes' },
    { name: 'compact', description: 'Summarize the conversation to free context', argumentHint: '[instructions]' },
    { name: 'clear', description: 'Start over with an empty context' },
    { name: 'cost', description: 'Show what this session has cost' }
  ],
  git: async () => git,
  recentFolders: async () => recentFolders,
  rememberFolder: async (path) => (recentFolders = [path, ...recentFolders.filter((p) => p !== path)]),
  forgetFolder: async (path) => (recentFolders = recentFolders.filter((p) => p !== path)),
  pickFolder: async () => {
    recentFolders = ['D:/NEWProjects/IronWerx', ...recentFolders.filter((p) => p !== 'D:/NEWProjects/IronWerx')]
    return 'D:/NEWProjects/IronWerx'
  },
  browse: async (path) => ({ path: path ?? 'D:/NEWProjects/connections', parent: 'D:/NEWProjects', dirs: ['web', 'server', 'docs'] }),
  accounts: async () => accountFixtures,
  pickAccount: async () => accountFixtures[1],
  mcpServers: async () => [
    { name: 'codegraph', scope: 'user', transport: 'stdio' },
    { name: 'connections', scope: 'user', transport: 'http' },
    { name: 'docs', scope: 'project', transport: 'sse' },
    { name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' }
  ],
  mcpStatus: async () => ({
    live: true,
    servers: [
      { name: 'codegraph', status: 'connected' },
      { name: 'connections', status: 'failed' },
      { name: 'docs', status: 'pending' },
      { name: 'agenthydra', status: 'disabled' }
    ]
  }),
  toggleMcp: async () => {}
}
provide(COMPOSER_API, fixtureApi)

const base: ChatSummary = {
  ...chatFixtures[0],
  cwd: 'D:/NEWProjects/connections',
  status: 'idle',
  activity: null,
  turnStartedAt: null,
  model: 'claude-sonnet-5-5',
  effort: 'max',
  permissionMode: 'bypassPermissions',
  contextPct: 72,
  pendingCount: 0,
  queuedCount: 0,
  climayteActive: 0
}
const idle: ChatSummary = { ...base, id: 'composer-idle' }
const working: ChatSummary = { ...base, id: 'composer-working', status: 'working', contextPct: 82, permissionMode: 'acceptEdits' }
const extras: ChatSummary = { ...base, id: 'composer-extras', status: 'needs_you', pendingCount: 1, queuedCount: 2, climayteActive: 3 }
const slash: ChatSummary = { ...idle, id: 'composer-slash', permissionMode: 'default' }
const attach: ChatSummary = { ...idle, id: 'composer-attach', permissionMode: 'plan', effort: 'high' }
const long: ChatSummary = { ...working, id: 'composer-long' }

function swatch(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="32" r="14" fill="#fff" opacity=".5"/></svg>`
  return 'data:image/svg+xml;base64,' + btoa(svg)
}
const pics = [
  { name: 'sidebar-before.png', mediaType: 'image/png', url: swatch('#d97757') },
  { name: 'error-dialog.png', mediaType: 'image/png', url: swatch('#3b82f6') }
]
const longText = Array.from({ length: 30 }, (_, i) =>
  i === 0 ? 'A long draft, to show the box growing to 384px and then scrolling:' : `${i}. Step ${i} of the plan, with enough words to fill part of a line.`
).join('\n')
const workers = cliMayteWorkerFixtures.map((w, i) => ({ ...w, active: true, status: i ? 'queued' : 'running', startedAt: Date.now() - (i + 1) * 7 * 60_000 }))
// The workers dock: two running, then one finished, then all finished.
const t = Date.now()
const running = [
  { ...cliMayteWorkerFixtures[0], id: 'dock-a', title: 'Composer fidelity: workers dock', status: 'running', active: true, account: '#68', startedAt: t - 12 * 60_000, lastActivity: 'Edit web/src/components/climayte/WorkerDock.vue' },
  { ...cliMayteWorkerFixtures[1], id: 'dock-b', title: 'Transcript fidelity: status rows', status: 'running', active: true, account: '#41', startedAt: t - 4 * 60_000, lastActivity: 'bun test ./web/test' }
]
const finished = { ...running[1], id: 'dock-c', title: 'Sidebar: chat row menu', status: 'done', active: false, verdict: 'ok', startedAt: t - 31 * 60_000, lastActivityAt: t - 2 * 60_000, lastActivity: 'Committed 3f2a91c: chat row menu' }
const dockMixed = [running[0], finished]
const dockDone = [
  { ...running[0], status: 'done', active: false, verdict: 'ok', lastActivityAt: t - 60_000, lastActivity: 'Committed ed7a18c' },
  finished,
  { ...running[1], id: 'dock-d', status: 'failed', active: false, error: 'bun run build exited 1', lastActivityAt: t - 5 * 60_000 }
]

type Case = { id: string; label: string; chat: ChatSummary | null; demo: InstanceType<typeof Composer>['$props']['demo'] }
const cases: Case[] = [
  { id: 'idle', label: 'Idle chat with a draft (real: composer-dock.png)', chat: idle, demo: { text: 'how we looking' } },
  { id: 'empty', label: 'Idle chat, empty box: placeholder', chat: idle, demo: { text: '' } },
  { id: 'new', label: 'New session (chat null): folder and account pickers in the strip', chat: null, demo: { cwd: 'D:/NEWProjects/connections' } },
  { id: 'working', label: 'Working chat, empty box: Stop (Esc)', chat: working, demo: { text: '' } },
  { id: 'extras', label: 'Hydra Desk row: waiting for you, queued, CliMayte workers', chat: extras, demo: { text: '', workers } },
  { id: 'attach', label: 'Attachments', chat: attach, demo: { text: 'What is wrong in these two?', images: pics } },
  { id: 'long', label: 'Long draft while working: Queue', chat: long, demo: { text: longText } }
]
// One open menu per screenshot (?shot=<id>#/gallery): open menus steal focus from each other.
const menuCases: Case[] = [
  { id: 'menu-mode', label: 'Permission mode menu', chat: idle, demo: { text: 'how we looking', openMenu: 'mode' } },
  { id: 'menu-model', label: 'Model menu', chat: idle, demo: { text: 'how we looking', openMenu: 'model' } },
  { id: 'menu-effort', label: 'Effort popover', chat: idle, demo: { text: 'how we looking', openMenu: 'effort' } },
  { id: 'menu-plus', label: 'Plus menu', chat: idle, demo: { text: 'how we looking', openMenu: 'plus' } },
  { id: 'slash', label: 'Slash menu (typed /re)', chat: slash, demo: { text: '/re', slashOpen: true } },
  { id: 'mention', label: '@-mention menu', chat: idle, demo: { text: 'look at @', mentionOpen: true } },
  { id: 'dock', label: 'Workers dock, collapsed: 2 agents running', chat: idle, demo: { text: '', workers: running } },
  { id: 'dock-done', label: 'Workers dock: 1 running, 1 done', chat: idle, demo: { text: '', workers: dockMixed } },
  { id: 'dock-all-done', label: 'Workers dock: all finished (green)', chat: idle, demo: { text: '', workers: dockDone } }
]

const shot = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('shot')
const shotCases = shot === 'composer' ? cases : menuCases.filter((c) => c.id === shot)
</script>

<template>
  <!-- Screenshot mode: the cases alone, over everything, on the pane background. -->
  <div v-if="shotCases.length" class="fixed inset-0 z-40 flex flex-col justify-end gap-4 overflow-hidden bg-[var(--bg-page)] pb-4">
    <div v-for="c in shotCases" :key="c.id" class="w-[800px]" :data-case="c.id">
      <Composer :chat="c.chat" :demo="c.demo" />
    </div>
  </div>

  <div v-else class="flex flex-col gap-6">
    <p class="text-[12px] text-[var(--text-muted)]">
      Open one menu at a time:
      <a v-for="c in menuCases" :key="c.id" class="mr-3 text-[var(--accent-text)] hover:underline" :href="`?shot=${c.id}#/gallery`">{{ c.label }}</a>
      <a class="text-[var(--accent-text)] hover:underline" href="?shot=composer#/gallery">All states alone</a>
    </p>
    <div v-for="c in cases" :key="c.id" class="flex w-[800px] flex-col gap-1">
      <p class="text-xs text-[var(--text-muted)]">{{ c.label }}</p>
      <Composer :chat="c.chat" :demo="c.demo" />
    </div>
  </div>
</template>
