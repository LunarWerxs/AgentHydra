<script setup lang="ts">
import type { DevWebAddResult, DevWebFoundItem, DevWebPreview, DevWebProposal } from '@shared/devwebui'
import { FileCode, Folder } from '@lucide/vue'
import { ref, watch } from 'vue'
import { Tip } from '@/components/ui/tooltip'
import { ignoreFolder, loadProject, previewFound, scaffoldProject, unignoreFolder } from '../api'
import { useDevServers } from '../store'
import Card from './kit/Card.vue'
import Notice from './kit/Notice.vue'
import { BTN, BTN_GHOST, BTN_PRIMARY, CARD, CHIP, MONO } from './kit/kit'
import ProposalEditor from './ProposalEditor.vue'

// A scan's find that is not added yet: a .devwebui file (add it as it is) or a project folder with dev scripts and no
// file (review the proposed file, then write it and add). Either can be ignored so scans stop offering it.
const props = defineProps<{ item: DevWebFoundItem }>()
const servers = useDevServers()

const preview = ref<DevWebPreview | null>(null)
const proposal = ref<DevWebProposal | null>(null)
const ignored = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

// Read what adding it would add, without writing; a reply for a find no longer selected is dropped.
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

// Added: refresh the list and select the new project.
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
  <div class="flex min-h-full flex-col gap-4 p-4">
    <section :class="[CARD, 'flex items-start gap-3 p-4']">
      <span class="flex size-10 shrink-0 items-center justify-center rounded-(--radius-10) bg-fill-5 text-text-2">
        <component :is="item.kind === 'file' ? FileCode : Folder" class="size-5" aria-hidden="true" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 class="truncate text-[16px] font-semibold leading-6 text-text">{{ item.name }}</h2>
        <div class="flex flex-wrap gap-1.5">
          <span :class="CHIP">{{ item.kind === 'file' ? '.devwebui file' : 'Project folder' }}</span>
          <span v-if="item.framework" :class="CHIP">{{ item.framework }}</span>
        </div>
        <p :class="[MONO, 'break-all leading-4 text-text-muted']">{{ item.path }}</p>
      </div>
    </section>

    <Notice v-if="ignored" tone="neutral" title="Ignored: scans will not offer it again.">
      <template #actions><button type="button" :class="BTN" :disabled="busy" @click="unignore">Unignore</button></template>
    </Notice>
    <Notice v-if="error" tone="danger" title="Something went wrong">{{ error }}</Notice>

    <div v-if="!preview && !error" role="status" class="flex flex-col gap-2" aria-busy="true">
      <span class="sr-only">Reading it…</span>
      <div class="h-11 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
      <div class="h-11 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
      <div class="h-11 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
    </div>

    <template v-else-if="preview?.kind === 'file'">
      <Notice v-if="preview.error" tone="danger" title="This file cannot be read">{{ preview.error }}</Notice>
      <Card v-else flush :title="`${preview.processes.length} ${preview.processes.length === 1 ? 'server' : 'servers'} in this file`">
        <ul class="divide-y divide-border border-t border-border">
          <li v-for="p in preview.processes" :key="p.id" class="flex min-h-11 items-center gap-2 px-4 py-2">
            <span class="shrink-0 text-[13px] text-text">{{ p.name }}</span>
            <span v-if="p.port" :class="[CHIP, 'tnum']">:{{ p.port }}</span>
            <Tip :label="p.command"><span :class="[MONO, 'min-w-0 flex-1 truncate text-end text-text-muted']">{{ p.command }}</span></Tip>
          </li>
        </ul>
      </Card>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" :class="BTN_PRIMARY" :disabled="busy || !!preview.error || ignored" @click="add">Add project</button>
        <button v-if="!ignored" type="button" :class="BTN" :disabled="busy" @click="ignore">Ignore</button>
      </div>
    </template>

    <template v-else-if="preview?.kind === 'detected' && proposal">
      <p class="text-[13px] leading-5 text-text-2">No .devwebui file yet: review what goes into it.</p>
      <ProposalEditor v-model="proposal" />
      <div class="sticky bottom-0 -mx-4 -mb-4 mt-auto flex items-center justify-end gap-2 border-t border-border bg-bg-page/95 px-4 py-3 backdrop-blur">
        <button v-if="!ignored" type="button" :class="BTN_GHOST" :disabled="busy" @click="ignore">Ignore</button>
        <button type="button" :class="BTN_PRIMARY" :disabled="busy || ignored || !proposal.processes.length" @click="create">Create .devwebui and add</button>
      </div>
    </template>

    <template v-else-if="preview?.kind === 'none'">
      <Notice tone="danger" title="Nothing to add here">{{ preview.error }}</Notice>
      <div v-if="!ignored"><button type="button" :class="BTN" :disabled="busy" @click="ignore">Ignore</button></div>
    </template>

    <div v-else-if="error && !ignored"><button type="button" :class="BTN" :disabled="busy" @click="ignore">Ignore</button></div>
  </div>
</template>
