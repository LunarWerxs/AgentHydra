<script setup lang="ts">
import { computed, ref } from 'vue'
import { Pencil, Play, Plus, Square } from '@lucide/vue'
import type { DevWebProject } from '@shared/devwebui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { allKey, groupActions, serverPort, statusDot, statusWord } from '../logic'
import { removeProject, setProjectEnabled, updateProject } from '../api'
import { useDevServers } from '../store'
import { DOT, INPUT, TEXT_BTN } from '../styles'
import ProcessForm from './ProcessForm.vue'
import TakeoverCard from './TakeoverCard.vue'

// One project: its .devwebui file, Start all / Stop all, a new server, a rename and recolor, the master autostart switch,
// removal (the file is kept), the take-over card and its servers as rows that select the server.
const props = defineProps<{ project: DevWebProject }>()
const servers = useDevServers()
const pr = computed(() => props.project)
const acts = computed(() => groupActions(pr.value.processes))
const busy = computed(() => servers.busy.value.has(allKey(pr.value)))
const error = ref<string | null>(null)

const adding = ref(false)
const renaming = ref(false)
const name = ref('')
const color = ref('')
function startRename() {
  name.value = pr.value.name
  color.value = pr.value.color ?? ''
  renaming.value = true
}
async function attempt(fn: () => Promise<unknown>) {
  error.value = null
  try {
    await fn()
    await servers.refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
const saveRename = () =>
  attempt(async () => {
    await updateProject(pr.value.id, { name: name.value.trim() || pr.value.name, color: color.value || null })
    renaming.value = false
  })

const removing = ref(false)
function remove() {
  removing.value = false
  void attempt(async () => {
    await removeProject(pr.value.id)
    servers.select(null)
  })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span v-if="pr.color" class="size-3 shrink-0 rounded-full" :style="{ background: pr.color }" aria-hidden="true" />
        <span class="min-w-0 truncate font-medium">{{ pr.name }}</span>
      </div>
      <p class="mt-1 break-all font-mono text-[12px] text-text-muted">{{ pr.path }}</p>
    </div>

    <div class="flex flex-wrap items-center gap-1.5">
      <button v-if="acts.start || pr.processes.length === 1" type="button" :class="TEXT_BTN" :disabled="busy" @click="servers.actAll(pr, 'start')"><Play class="size-3.5" />Start all</button>
      <button v-if="acts.stop || pr.processes.some((x) => x.status === 'running')" type="button" :class="TEXT_BTN" :disabled="busy" @click="servers.actAll(pr, 'stop')"><Square class="size-3.5" />Stop all</button>
      <button type="button" :class="TEXT_BTN" @click="adding = true"><Plus class="size-3.5" />Add server</button>
      <button type="button" :class="TEXT_BTN" @click="startRename"><Pencil class="size-3.5" />Rename and recolor</button>
    </div>
    <p v-if="error || servers.actionError.value" role="alert" class="text-danger-text">{{ error || servers.actionError.value }}</p>

    <ProcessForm v-if="adding" :project-id="pr.id" :process-id="null" :siblings="pr.processes" @saved="adding = false; servers.refresh()" @cancel="adding = false" @deleted="adding = false" />

    <form v-if="renaming" class="flex flex-col gap-2 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] p-2.5" @submit.prevent="saveRename">
      <label class="flex flex-col gap-1">Name<input v-model="name" :class="[INPUT, 'h-7 flex-none']" aria-label="Project name" /></label>
      <label class="flex items-center gap-2">
        Color
        <input v-model="color" type="color" class="h-6 w-8 rounded" aria-label="Project color" />
        <button type="button" class="rounded-[4px] px-1 text-[12px] text-text-2 hover:bg-fill-hover" @click="color = ''">No color</button>
      </label>
      <div class="flex gap-1.5">
        <button type="submit" :class="TEXT_BTN">Save</button>
        <button type="button" :class="TEXT_BTN" @click="renaming = false">Cancel</button>
      </div>
    </form>

    <label class="flex items-center gap-1.5">
      <input type="checkbox" :checked="pr.enabled" @change="attempt(() => setProjectEnabled(pr.id, ($event.target as HTMLInputElement).checked))" />
      Autostart is on for this project
    </label>

    <TakeoverCard :project-id="pr.id" />

    <div>
      <h3 class="mb-1 text-[12px] font-medium text-text-2">Servers</h3>
      <p v-if="!pr.processes.length" class="text-text-muted">No servers yet. Add one above.</p>
      <ul class="flex flex-col gap-0.5">
        <li v-for="x in pr.processes" :key="x.id">
          <button type="button" class="flex h-7 w-full items-center gap-2 rounded-[var(--radius-6)] px-1.5 text-left hover:bg-fill-hover" :aria-label="`${x.name} details`" @click="servers.select({ kind: 'server', id: x.id })">
            <span class="size-1.5 shrink-0 rounded-full" :class="DOT[statusDot(x.status)]" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ x.name }}</span>
            <span class="shrink-0 text-[12px] text-text-muted">{{ statusWord(x) }}{{ x.port ? ` · ${serverPort(x)}` : '' }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div>
      <button type="button" class="rounded-[4px] text-danger-text hover:underline" @click="removing = true">Remove project…</button>
    </div>

    <Dialog :open="removing" @update:open="(o: boolean) => !o && (removing = false)">
      <DialogContent :aria-describedby="undefined">
        <DialogTitle>Remove {{ pr.name }}?</DialogTitle>
        <DialogDescription>This stops the servers AgentHydra started for it and takes it off the list. Its .devwebui file is kept.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" @click="removing = false">Cancel</Button>
          <Button variant="destructive" @click="remove">Remove project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
