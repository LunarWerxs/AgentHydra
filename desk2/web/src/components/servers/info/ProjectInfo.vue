<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Pencil, Play, Plus, Server, Square } from '@lucide/vue'
import type { DevWebProject } from '@shared/devwebui'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
import { allKey, groupActions } from '../logic'
import { setProjectEnabled, takeoverCheck } from '../api'
import { useDevServers } from '../store'
import { usePaneNav } from './nav'
import { BTN, BTN_PRIMARY, CHIP, chip, MONO, SECTION_TITLE } from './kit/kit'
import Card from './kit/Card.vue'
import EmptyState from './kit/EmptyState.vue'
import Notice from './kit/Notice.vue'
import StatTile from './kit/StatTile.vue'
import ServerRows from './ServerRows.vue'

// One project as cards: a hero with its .devwebui file and Start all / Stop all, tiles for its servers, running count,
// errors and the master autostart switch, a take-over offer when the folder also starts its server by itself, and its
// servers as rows that select the server. Adding a server, renaming, recoloring and removing (the file is kept) are
// sub-views (owner, 2026-10-07: "the edit menu in the sidebar. Holy fuck ... That is so horrible").
const props = defineProps<{ project: DevWebProject }>()
const servers = useDevServers()
const nav = usePaneNav()
const pr = computed(() => props.project)
const acts = computed(() => groupActions(pr.value.processes))
const busy = computed(() => servers.busy.value.has(allKey(pr.value)))
const error = ref<string | null>(null)

const running = computed(() => pr.value.processes.filter((x) => x.status === 'running').length)
const errors = computed(() => pr.value.processes.reduce((n, x) => n + (x.errorCount ?? 0), 0))
const allRun = computed(() => pr.value.processes.length > 0 && running.value === pr.value.processes.length)

async function attempt(fn: () => Promise<unknown>) {
  error.value = null
  try {
    await fn()
    await servers.refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
const setEnabled = (on: boolean) => attempt(() => setProjectEnabled(pr.value.id, on))

// The take-over offer: a warning while the folder has triggers of its own; with only backups from an earlier take-over
// left, a quiet note that they can be put back.
const outside = ref<{ triggers: number; backups: number }>({ triggers: 0, backups: 0 })
watch(
  () => pr.value.id,
  async (id) => {
    outside.value = { triggers: 0, backups: 0 }
    try {
      const t = await takeoverCheck(id)
      if (id === pr.value.id) outside.value = { triggers: t.triggers.length, backups: t.backups.length }
    } catch {
      // The offer is a hint; the take-over view itself shows a failure to read.
    }
  },
  { immediate: true }
)
const addServer = () => nav.open({ kind: 'add-server', projectId: pr.value.id })
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <section class="flex min-w-0 flex-col gap-3">
      <div class="flex min-w-0 flex-wrap items-center gap-2.5">
        <span class="size-3 shrink-0 rounded-full" :class="pr.color ? '' : 'bg-fill-selected'" :style="pr.color ? { background: pr.color } : undefined" aria-hidden="true" />
        <h2 class="min-w-0 truncate text-[18px] font-semibold leading-6 text-text">{{ pr.name }}</h2>
        <span :class="allRun ? chip('success') : CHIP" class="tnum">{{ running }} of {{ pr.processes.length }} running</span>
      </div>
      <p :class="MONO" class="break-all text-text-muted">{{ pr.path }}</p>
      <div class="flex flex-wrap items-center gap-1.5">
        <button v-if="acts.start || pr.processes.length === 1" type="button" :class="BTN_PRIMARY" :disabled="busy" @click="servers.actAll(pr, 'start')"><Play class="size-3.5" />Start all</button>
        <button v-if="acts.stop || pr.processes.some((x) => x.status === 'running')" type="button" :class="BTN" :disabled="busy" @click="servers.actAll(pr, 'stop')"><Square class="size-3.5" />Stop all</button>
        <button type="button" :class="BTN" @click="addServer"><Plus class="size-3.5" />Add server</button>
        <button type="button" :class="BTN" @click="nav.open({ kind: 'edit-project', id: pr.id })"><Pencil class="size-3.5" />Edit project</button>
      </div>
      <p v-if="error || servers.actionError.value" role="alert" class="text-[12px] leading-4 text-danger-text">{{ error || servers.actionError.value }}</p>
    </section>

    <div class="grid grid-cols-2 gap-2.5 @lg:grid-cols-4">
      <StatTile label="Servers" :value="String(pr.processes.length)" />
      <StatTile label="Running" :value="String(running)" :tone="running > 0 ? 'success' : undefined" />
      <StatTile label="Errors" :value="String(errors)" :tone="errors > 0 ? 'danger' : undefined" />
      <StatTile label="Autostart">
        <span class="flex-1">{{ pr.enabled ? 'On' : 'Off' }}</span>
        <PaneSwitch label="Autostart is on for this project" :model-value="pr.enabled" @update:model-value="setEnabled" />
      </StatTile>
    </div>

    <Notice v-if="outside.triggers" tone="warning" title="Started outside AgentHydra too">
      Something in this folder (VS Code, an editor extension) also starts its server when the folder opens.
      <template #actions>
        <button type="button" :class="BTN" @click="nav.open({ kind: 'takeover', projectId: pr.id })">Review</button>
      </template>
    </Notice>
    <Notice v-else-if="outside.backups" tone="neutral" title="Taken over by AgentHydra">
      The files it turned off are backed up and can be put back.
      <template #actions>
        <button type="button" :class="BTN" @click="nav.open({ kind: 'takeover', projectId: pr.id })">Review</button>
      </template>
    </Notice>

    <section class="flex flex-col gap-2.5">
      <h3 :class="SECTION_TITLE" class="px-0.5">Servers</h3>
      <Card v-if="pr.processes.length" flush>
        <ServerRows :processes="pr.processes" />
      </Card>
      <Card v-else>
        <EmptyState :icon="Server" title="No servers yet" text="Add the command that starts this project's dev server.">
          <button type="button" :class="BTN_PRIMARY" @click="addServer"><Plus class="size-3.5" />Add server</button>
        </EmptyState>
      </Card>
    </section>
  </div>
</template>
