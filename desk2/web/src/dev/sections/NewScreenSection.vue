<script setup lang="ts">
import { provide, ref } from 'vue'
import type { ProjectChoices, ProjectEntry } from '@shared/protocol'
import NewSessionScreen from '@/components/shell/NewSessionScreen.vue'
import ProjectFoldersDialog from '@/components/shell/ProjectFoldersDialog.vue'
import { demoSource } from '@/components/shell/demo'
import { SHELL_SOURCE } from '@/components/shell/source'

// The New screen's project grid with the View options menu, and Manage folders open over it, on invented project names.
provide(SHELL_SOURCE, demoSource())

const row = (path: string, name: string, sources: ProjectEntry['sources'], hidden = false): ProjectEntry => ({
  path,
  name,
  group: null,
  icon: null,
  sources,
  hidden,
  git: null,
  lastCommitAt: null,
  lastChatAt: null,
  openChats: 0,
})
const projects: ProjectEntry[] = [
  row('C:/Projects/lantern-notes', 'lantern-notes', ['projecthydra', 'chats']),
  row('C:/Projects/river-tools', 'river-tools', ['projecthydra']),
  row('C:/Projects/copper-kettle', 'copper-kettle', ['chats']),
  row('C:/Projects/old-garden', 'old-garden', ['projecthydra'], true),
]
const choices: ProjectChoices = { folders: [], roots: [], hidden: ['C:/Projects/old-garden'] }
const managing = ref(false)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h3 class="mb-2 text-sm text-(--text-muted)">New screen (View options in the filter row)</h3>
      <div class="w-[720px]">
        <NewSessionScreen name="Sam" :chats="[]" />
      </div>
    </div>
    <div>
      <h3 class="mb-2 text-sm text-(--text-muted)">Manage folders (sources with counts, and a hidden project)</h3>
      <button type="button" class="h-7 rounded-(--radius-6) bg-fill-5 px-3 text-[12px] text-text hover:bg-fill-hover" @click="managing = true">Manage folders…</button>
      <ProjectFoldersDialog :open="managing" :choices="choices" :projects="projects" @update:open="(o: boolean) => (managing = o)" @changed="() => {}" @failed="() => {}" />
    </div>
  </div>
</template>
