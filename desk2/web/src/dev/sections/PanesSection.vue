<script setup lang="ts">
import { provide } from 'vue'
import type { GitStatus } from '@shared/protocol'
import { FREE_SETTINGS_DEFAULTS } from '@shared/free-instances'
import DiffPane from '@/components/panes/DiffPane.vue'
import SettingsView from '@/components/panes/SettingsView.vue'
import AccountsList from '@/components/accounts/AccountsList.vue'
import AccountsPopover from '@/components/accounts/AccountsPopover.vue'
import { PANE_API, type PaneApi } from '@/components/panes/api'
import { accountFixtures, settingsFixtures } from '../fixtures'

// Fixture answers for every call the panes make, so the gallery needs no server.
const REPO = 'C:/Users/me/Desktop/Project/Agent Hydra/desk'
const CLEAN = 'C:/Users/me/clean-repo'
const NOT_REPO = 'C:/Users/me/Downloads'

const status: GitStatus = {
  isRepo: true,
  branch: 'main',
  ahead: 2,
  behind: 0,
  added: 61,
  removed: 9,
  files: [
    { path: 'web/src/components/panes/DiffPane.vue', status: 'M', added: 42, removed: 7 },
    { path: 'web/src/components/panes/diff.ts', status: '??', added: 15, removed: 0 },
    { path: 'server/src/git/legacy.ts', status: 'D', added: 0, removed: 2 },
    { path: 'README.md', status: 'M', added: 4, removed: 0 }
  ]
}

const diffText = `diff --git a/web/src/components/panes/DiffPane.vue b/web/src/components/panes/DiffPane.vue
index 3b1c2d4..9f8e7a6 100644
--- a/web/src/components/panes/DiffPane.vue
+++ b/web/src/components/panes/DiffPane.vue
@@ -1,9 +1,12 @@ <script setup lang="ts">
-
-defineProps<{ cwd: string }>()
+import { computed, onMounted, ref, watch } from 'vue'
+import type { GitStatus } from '@shared/protocol'
+import { usePaneApi } from './api'
+
+const props = defineProps<{ cwd: string }>()
 <\/script>

 <template>
   <div class="flex flex-col h-full w-full">
-    <div class="flex-1 flex items-center justify-center">
+    <div class="flex h-10 items-center border-b">
+      <span>Changes</span>
     </div>
   </div>
 </template>
@@ -40,4 +43,5 @@ function open(path: string) {
   selectedPath.value = path
   diff.value = null
+  loadDiff(path)
 }
\\ No newline at end of file
`

const fixtureApi: PaneApi = {
  gitStatus: async (cwd) =>
    cwd === REPO
      ? status
      : cwd === CLEAN
        ? { isRepo: true, branch: 'main', ahead: 0, behind: 0, added: 0, removed: 0, files: [] }
        : { isRepo: false, branch: null, ahead: 0, behind: 0, added: 0, removed: 0, files: [] },
  gitDiff: async () => diffText,
  models: async () => [
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' }
  ],
  health: async () => ({ ok: true, version: '0.1.0' }),
  bridgeStatus: async () => ({ up: true, url: 'http://127.0.0.1:7787' }),
  babysitter: async () => ({ enabled: true, everyMs: 300_000, checkedAt: null, nextCheckAt: null, stopped: [], accounts: [], acts: [], error: null }),
  getSettings: async () => ({ ...settingsFixtures, defaultModel: 'claude-opus-5-5' }),
  putSettings: async (patch) => ({ ...settingsFixtures, ...patch }),
  accounts: async () => [
    ...accountFixtures,
    {
      id: '71',
      label: '#71 work@example.com (Max 5x)',
      configDir: '/path/to/71',
      number: 71,
      email: 'work@example.com',
      plan: 'Max 5x',
      signedIn: true,
      fiveHourPct: 91,
      weeklyPct: 64,
      fiveHourResetsAt: Date.now() + 47 * 60 * 1000,
      weeklyResetsAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
      inUse: false
    }
  ],
  pickAccount: async () => accountFixtures[1],
  externalItems: async () => [],
  diagnostics: async () => ({ rows: [], total: 0, byCause: {}, byAccount: {}, byDay: {} }) as never,
  agentHydra: async () => {
    throw new Error('AgentHydra is not running')
  },
  freeSettings: async () => ({ ...FREE_SETTINGS_DEFAULTS }),
  patchFreeSettings: async (p) => ({ ...FREE_SETTINGS_DEFAULTS, ...p })
}

provide(PANE_API, fixtureApi)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h3 class="mb-2 text-sm text-(--text-muted)">Diff pane (click a file for its diff) · clean tree · not a repo</h3>
      <div class="flex gap-4">
        <div class="h-140 w-95 overflow-hidden rounded border border-(--border)">
          <DiffPane :cwd="REPO" initial-path="web/src/components/panes/DiffPane.vue" />
        </div>
        <div class="h-50 w-75 overflow-hidden rounded border border-(--border)">
          <DiffPane :cwd="CLEAN" />
        </div>
        <div class="h-50 w-75 overflow-hidden rounded border border-(--border)">
          <DiffPane :cwd="NOT_REPO" />
        </div>
      </div>
    </div>

    <div class="flex gap-4">
      <div>
        <h3 class="mb-2 text-sm text-(--text-muted)">Settings dialog body (the dialog itself: #/gallery/shell/settings)</h3>
        <div class="h-170 w-230 overflow-hidden rounded-(--radius-12) border border-(--border)">
          <SettingsView />
        </div>
      </div>
      <div>
        <h3 class="mb-2 text-sm text-(--text-muted)">Accounts popover (body, and the trigger the sidebar footer wraps)</h3>
        <div class="rounded-lg border border-(--border) bg-(--bg-popover)">
          <AccountsList />
        </div>
        <div class="mt-3">
          <AccountsPopover>
            <button type="button" class="rounded px-2 py-1 text-[13px] text-(--text-muted) hover:bg-(--fill-hover)">Auto account</button>
          </AccountsPopover>
        </div>
      </div>
    </div>
  </div>
</template>
