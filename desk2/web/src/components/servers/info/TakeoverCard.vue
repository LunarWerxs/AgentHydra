<script setup lang="ts">
import type { DevWebTakeOverResult, DevWebTrigger } from '@shared/devwebui'
import { computed, ref, watch } from 'vue'
import { CheckCircle2, Code2, Zap } from '@lucide/vue'
import { restoreTakeover, takeOver, takeoverCheck } from '../api'
import { BTN, BTN_GHOST, BTN_PRIMARY, CARD, MONO } from './kit/kit'
import { Tip } from '@/components/ui/tooltip'
import Card from './kit/Card.vue'
import EmptyState from './kit/EmptyState.vue'
import Notice from './kit/Notice.vue'

// A folder that starts its own server (a VS Code task, the Vite extension) runs it twice beside AgentHydra. Take over
// turns those triggers off, backing the files up first; Restore puts the backups back. As the `takeover` sub-view it is
// a page; embedded (AddProject's done state) it is one compact card, and nothing at all when there is nothing to show.
const props = defineProps<{ projectId: string; triggers?: DevWebTrigger[]; embedded?: boolean }>()

const found = ref<DevWebTrigger[]>(props.triggers ?? [])
const backups = ref<string[]>([])
const confirming = ref(false)
const confirmingRestore = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const result = ref<DevWebTakeOverResult | null>(null)
const restored = ref<string[] | null>(null)
const loaded = ref(false)

const WHAT: Record<DevWebTrigger['kind'], string> = {
  'vscode-task': 'VS Code runs this task when the folder opens.',
  'vite-extension': 'The Vite extension starts the dev server when the folder opens.'
}
const ICON = { 'vscode-task': Code2, 'vite-extension': Zap } as const

async function load(): Promise<void> {
  try {
    const t = await takeoverCheck(props.projectId)
    found.value = t.triggers
    backups.value = t.backups
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loaded.value = true
  }
}
watch(() => props.projectId, () => {
  result.value = null
  restored.value = null
  void load()
}, { immediate: true })

async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await fn()
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    confirming.value = false
    confirmingRestore.value = false
  }
}
const doTakeOver = () => run(async () => { result.value = await takeOver(props.projectId) })
const doRestore = () => run(async () => { restored.value = (await restoreTakeover(props.projectId)).restored })

const any = computed(() => !!(found.value.length || backups.value.length || result.value || restored.value || error.value))
</script>

<template>
  <component :is="embedded ? Card : 'div'" v-if="!embedded || any" v-bind="embedded ? { title: 'Started outside AgentHydra' } : {}" :class="embedded ? '' : 'flex flex-col gap-4 p-4'">
    <div class="flex flex-col" :class="embedded ? 'gap-3' : 'gap-4'">
      <p v-if="found.length" class="text-[13px] leading-5 text-text-2">This folder also starts its server by itself, so it can run twice. Take over turns that off so only AgentHydra starts it. The files are backed up first and can be put back.</p>

      <div v-for="t in found" :key="t.file + t.label" :class="[CARD, 'flex min-w-0 gap-3', embedded ? 'p-3' : 'p-4']">
        <component :is="ICON[t.kind] ?? Code2" class="mt-0.5 size-4 shrink-0 text-text-2" aria-hidden="true" />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-[13px] font-medium leading-5 text-text">{{ t.label }}</span>
          <span class="text-[12px] leading-4 text-text-2">{{ WHAT[t.kind] }} {{ t.detail }}</span>
          <Tip :label="t.file"><span :class="MONO" class="truncate text-text-muted">{{ t.file }}</span></Tip>
        </div>
      </div>

      <Notice v-if="result && result.disabled.length" tone="success" :title="`Turned off ${result.disabled.length} ${result.disabled.length === 1 ? 'trigger' : 'triggers'}`">
        <Tip v-for="b in result.backups" :key="b" :label="b"><p :class="MONO" class="truncate">Backup: {{ b }}</p></Tip>
      </Notice>
      <Notice v-if="result && result.skipped.length" tone="danger" title="Some files were left alone">
        <p v-for="s in result.skipped" :key="s.file">Left <span :class="MONO">{{ s.file }}</span> alone: {{ s.reason }}</p>
      </Notice>
      <Notice v-if="restored" tone="success" :title="`Put back ${restored.length} ${restored.length === 1 ? 'file' : 'files'}`" />
      <Notice v-if="error" tone="danger" title="Could not finish">{{ error }}</Notice>

      <EmptyState v-if="!embedded && loaded && !found.length && !backups.length && !error" :icon="CheckCircle2" tone="success" title="Only AgentHydra starts this project" text="Nothing in this folder starts its server by itself." />

      <div v-if="found.length || backups.length" class="flex flex-col gap-2">
        <div v-if="found.length" class="flex flex-wrap items-center gap-2">
          <template v-if="confirming">
            <span class="text-[13px] text-text-2">Turn these off?</span>
            <button type="button" :class="BTN_PRIMARY" :disabled="busy" @click="doTakeOver">Take over</button>
            <button type="button" :class="BTN_GHOST" :disabled="busy" @click="confirming = false">Cancel</button>
          </template>
          <button v-else type="button" :class="BTN_PRIMARY" :disabled="busy" @click="confirming = true">Take over</button>
        </div>
        <div v-if="backups.length" class="flex flex-wrap items-center gap-2">
          <template v-if="confirmingRestore">
            <span class="text-[13px] text-text-2">Put the files back? Edits made to them since the take-over are lost.</span>
            <button type="button" :class="BTN" :disabled="busy" @click="doRestore">Restore</button>
            <button type="button" :class="BTN_GHOST" :disabled="busy" @click="confirmingRestore = false">Cancel</button>
          </template>
          <button v-else type="button" :class="BTN" :disabled="busy" @click="confirmingRestore = true">Restore the backups</button>
        </div>
      </div>
    </div>
  </component>
</template>
