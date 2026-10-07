<script setup lang="ts">
import type { DevWebTakeOverResult, DevWebTrigger } from '@shared/devwebui'
import { ref, watch } from 'vue'
import { restoreTakeover, takeOver, takeoverCheck } from '../api'
import { TEXT_BTN } from '../styles'

const props = defineProps<{ projectId: string; triggers?: DevWebTrigger[] }>()

const found = ref<DevWebTrigger[]>(props.triggers ?? [])
const backups = ref<string[]>([])
const confirming = ref(false)
const confirmingRestore = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const result = ref<DevWebTakeOverResult | null>(null)
const restored = ref<string[] | null>(null)

const WHAT: Record<DevWebTrigger['kind'], string> = {
  'vscode-task': 'VS Code runs this task when the folder opens.',
  'vite-extension': 'The Vite extension starts the dev server when the folder opens.'
}

async function load(): Promise<void> {
  try {
    const t = await takeoverCheck(props.projectId)
    found.value = t.triggers
    backups.value = t.backups
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
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
</script>

<template>
  <section v-if="found.length || backups.length || result || restored || error" class="flex flex-col gap-2 rounded-[var(--radius-6)] p-3 text-[12px] shadow-[inset_0_0_0_1px_var(--border)]">
    <h3 class="font-medium text-[var(--text)]">Started outside AgentHydra</h3>
    <template v-if="found.length">
      <p class="text-[var(--text-2)]">This folder also starts its server by itself. Take over to turn that off so only AgentHydra starts it. The files are backed up first.</p>
      <ul class="flex flex-col gap-1">
        <li v-for="t in found" :key="t.file + t.label">
          <div class="text-[var(--text)]">{{ t.label }}</div>
          <div class="text-[var(--text-muted)]">{{ WHAT[t.kind] }} {{ t.detail }}</div>
          <div class="truncate font-mono text-[11px] text-[var(--text-muted)]" :title="t.file">{{ t.file }}</div>
        </li>
      </ul>
    </template>
    <div v-if="result" class="text-[var(--text-2)]">
      <p v-if="result.disabled.length" class="text-[var(--success-text)]">Turned off {{ result.disabled.length }} {{ result.disabled.length === 1 ? 'trigger' : 'triggers' }}.</p>
      <p v-for="b in result.backups" :key="b" class="truncate font-mono text-[11px]" :title="b">Backup: {{ b }}</p>
      <p v-for="s in result.skipped" :key="s.file" class="text-[var(--danger-text)]">Left {{ s.file }} alone: {{ s.reason }}</p>
    </div>
    <p v-if="restored" class="text-[var(--success-text)]">Put back {{ restored.length }} {{ restored.length === 1 ? 'file' : 'files' }}.</p>
    <p v-if="error" class="text-[var(--danger-text)]">{{ error }}</p>
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="found.length">
        <template v-if="confirming">
          <span class="text-[var(--text-2)]">Turn these off?</span>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="doTakeOver">Take over</button>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="confirming = false">Cancel</button>
        </template>
        <button v-else type="button" :class="TEXT_BTN" :disabled="busy" @click="confirming = true">Take over</button>
      </template>
      <template v-if="backups.length">
        <template v-if="confirmingRestore">
          <span class="text-[var(--text-2)]">Put the files back? Edits made to them since the take-over are lost.</span>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="doRestore">Restore</button>
          <button type="button" :class="TEXT_BTN" :disabled="busy" @click="confirmingRestore = false">Cancel</button>
        </template>
        <button v-else type="button" :class="TEXT_BTN" :disabled="busy" @click="confirmingRestore = true">Restore the backups</button>
      </template>
    </div>
  </section>
</template>
