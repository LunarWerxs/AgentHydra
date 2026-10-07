<script setup lang="ts">
import type { DevWebAddResult, DevWebFoundItem, DevWebPreview, DevWebProposal } from '@shared/devwebui'
import { FileCode, Folder } from '@lucide/vue'
import { ref, watch } from 'vue'
import { ignoreFolder, loadProject, previewFound, scaffoldProject, unignoreFolder } from '../api'
import { useDevServers } from '../store'
import { TEXT_BTN } from '../styles'
import ProposalEditor from './ProposalEditor.vue'

const props = defineProps<{ item: DevWebFoundItem }>()
const servers = useDevServers()

const preview = ref<DevWebPreview | null>(null)
const proposal = ref<DevWebProposal | null>(null)
const ignored = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.item.path,
  async (path) => {
    preview.value = null
    proposal.value = null
    ignored.value = false
    error.value = null
    try {
      const p = await previewFound(path)
      if (path !== props.item.path) return
      preview.value = p
      if (p.kind === 'detected') proposal.value = p.proposal
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  },
  { immediate: true }
)

async function act(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function added(res: DevWebAddResult): Promise<void> {
  if (res.error || !res.project) throw new Error(res.error || 'It could not be added.')
  await servers.refresh()
  servers.select({ kind: 'project', id: res.project.id })
}

const add = () => act(async () => added(await loadProject(props.item.path)))
const create = () =>
  act(async () => {
    if (preview.value?.kind !== 'detected' || !proposal.value) return
    await added(await scaffoldProject(preview.value.dir, proposal.value))
  })
const ignore = () => act(async () => { await ignoreFolder(props.item.path); ignored.value = true; void servers.refresh() })
const unignore = () => act(async () => { await unignoreFolder(props.item.path); ignored.value = false; void servers.refresh() })
</script>

<template>
  <div class="flex flex-col gap-3 p-3 text-[12px]">
    <div class="flex items-center gap-2">
      <component :is="item.kind === 'file' ? FileCode : Folder" class="size-4 shrink-0 text-[var(--text-2)]" aria-hidden="true" />
      <h2 class="truncate text-[13px] font-medium text-[var(--text)]">{{ item.name }}</h2>
    </div>
    <p class="break-all font-mono text-[11px] text-[var(--text-muted)]">{{ item.path }}</p>
    <p class="text-[var(--text-2)]">
      {{ item.kind === 'file' ? 'A .devwebui file that is not added yet.' : 'A project folder with dev scripts and no .devwebui file yet.' }}
      <template v-if="item.framework"> Looks like {{ item.framework }}.</template>
    </p>

    <p v-if="!preview && !error" class="text-[var(--text-muted)]">Reading it...</p>
    <template v-else-if="preview?.kind === 'file'">
      <p v-if="preview.error" class="text-[var(--danger-text)]">{{ preview.error }}</p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="p in preview.processes" :key="p.id" class="flex items-baseline gap-2">
          <span class="text-[var(--text)]">{{ p.name }}</span>
          <span v-if="p.port" class="text-[var(--text-muted)]">port {{ p.port }}</span>
          <span class="min-w-0 truncate font-mono text-[11px] text-[var(--text-muted)]" :title="p.command">{{ p.command }}</span>
        </li>
      </ul>
      <div><button type="button" :class="TEXT_BTN" :disabled="busy || !!preview.error || ignored" @click="add">Add</button></div>
    </template>
    <template v-else-if="preview?.kind === 'detected' && proposal">
      <p class="text-[var(--text-2)]">Review what goes into its .devwebui file.</p>
      <ProposalEditor v-model="proposal" />
      <div><button type="button" :class="TEXT_BTN" :disabled="busy || ignored || !proposal.processes.length" @click="create">Create .devwebui and add</button></div>
    </template>
    <p v-else-if="preview?.kind === 'none'" class="text-[var(--danger-text)]">{{ preview.error }}</p>

    <p v-if="error" class="text-[var(--danger-text)]">{{ error }}</p>
    <div class="flex items-center gap-2">
      <template v-if="ignored">
        <span class="text-[var(--text-2)]">Ignored: scans will not offer it again.</span>
        <button type="button" :class="TEXT_BTN" :disabled="busy" @click="unignore">Unignore</button>
      </template>
      <button v-else type="button" :class="TEXT_BTN" :disabled="busy" @click="ignore">Ignore</button>
    </div>
  </div>
</template>
