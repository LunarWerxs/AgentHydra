<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { X } from '@lucide/vue'
import { Tip } from '@/components/ui/tooltip'
import { findServer } from '../logic'
import { useDevServers } from '../store'
import { ICON_BTN } from '../styles'
import AddProject from './AddProject.vue'
import FoundInfo from './FoundInfo.vue'
import OtherInfo from './OtherInfo.vue'
import ProjectInfo from './ProjectInfo.vue'
import ServerInfo from './ServerInfo.vue'

// The right-hand pane for what the Dev servers list selected (DeskFrame's 'devinfo'): a 41px strip with the title and a
// close button, then the body, which scrolls. It reads the one client (store.ts) and keeps polling on while it shows, so
// a server's status and numbers stay live. A selection whose thing is gone (a project removed, a server deleted) says so.
const emit = defineEmits<{ close: [] }>()
const servers = useDevServers()
const release = servers.use()
onBeforeUnmount(release)

const sel = servers.selection
const projects = servers.projects
const hit = computed(() => (sel.value?.kind === 'server' ? findServer(projects.value, sel.value.id) : null))
const project = computed(() => (sel.value?.kind === 'project' ? ((projects.value ?? []).find((p) => p.id === (sel.value as { id: string }).id) ?? null) : null))
const foundItem = computed(() => (sel.value?.kind === 'found' ? (servers.found.value?.items.find((i) => i.path === (sel.value as { path: string }).path) ?? null) : null))

// With the service down the list is empty, so a server or project cannot be shown: say why rather than show nothing.
const state = computed(() => servers.status.value?.state ?? null)
const down = computed(() => !projects.value && state.value !== null && state.value !== 'running')

const title = computed(() => {
  const s = sel.value
  if (!s) return 'Details'
  if (s.kind === 'server') return hit.value?.proc.name ?? 'Server'
  if (s.kind === 'project') return project.value?.name ?? 'Project'
  if (s.kind === 'found') return foundItem.value?.name ?? 'Found project'
  if (s.kind === 'other') return `Port ${s.port}`
  return 'Add a project'
})
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-page" aria-label="Server details">
    <header class="flex h-[41px] shrink-0 items-center gap-2 border-b border-border px-3 text-[13px]">
      <h2 class="min-w-0 flex-1 truncate font-medium text-text">{{ title }}</h2>
      <Tip label="Close details">
        <button type="button" :class="ICON_BTN" aria-label="Close details" @click="emit('close')"><X class="size-4" /></button>
      </Tip>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto p-3 text-[13px] leading-5 text-text">
      <p v-if="!sel" class="text-text-muted">Pick a server, project or folder in the list to see its details.</p>
      <p v-else-if="down && (sel.kind === 'server' || sel.kind === 'project')" role="status" class="text-text-muted">
        <template v-if="state === 'starting'">Starting…</template>
        <template v-else>
          The dev-servers service is not running.
          <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="servers.tryAgain()">Start it now</button>
        </template>
      </p>
      <template v-else-if="sel.kind === 'server'">
        <ServerInfo v-if="hit" :key="hit.proc.id" :project="hit.project" :proc="hit.proc" />
        <p v-else-if="projects" class="text-text-muted">This server is not in the list any more.</p>
      </template>
      <template v-else-if="sel.kind === 'project'">
        <ProjectInfo v-if="project" :key="project.id" :project="project" />
        <p v-else-if="projects" class="text-text-muted">This project is not in the list any more.</p>
      </template>
      <template v-else-if="sel.kind === 'found'">
        <FoundInfo v-if="foundItem" :key="foundItem.path" :item="foundItem" />
        <p v-else-if="servers.found.value" class="text-text-muted">This folder is not on the found list any more. It may have been added or ignored.</p>
      </template>
      <OtherInfo v-else-if="sel.kind === 'other'" :key="sel.port" :port="sel.port" />
      <AddProject v-else />
    </div>
  </section>
</template>
