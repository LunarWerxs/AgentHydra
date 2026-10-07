<script setup lang="ts">
import type { DevWebProposal } from '@shared/devwebui'
import { ref, watch } from 'vue'
import { INPUT } from '../styles'

type Row = DevWebProposal['processes'][number] & { include: boolean }

const props = defineProps<{ modelValue: DevWebProposal }>()
const emit = defineEmits<{ 'update:modelValue': [value: DevWebProposal] }>()

// Unticked servers stay on screen (so they can be ticked again) but leave the emitted proposal, which is what gets written.
const name = ref('')
const rows = ref<Row[]>([])
// What each row's port field holds as typed; `port` changes only when it is valid or emptied.
const portText = ref<string[]>([])
let emitted: DevWebProposal | null = null

const validPort = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

watch(
  () => props.modelValue,
  (v) => {
    if (v === emitted) return
    name.value = v.name
    rows.value = v.processes.map((p) => ({ ...p, include: true }))
    portText.value = v.processes.map((p) => (p.port ? String(p.port) : ''))
  },
  { immediate: true }
)

function push(): void {
  emitted = {
    ...props.modelValue,
    name: name.value,
    processes: rows.value.filter((r) => r.include).map(({ include: _, ...p }) => p)
  }
  emit('update:modelValue', emitted)
}

function setPort(r: Row, i: number, v: string): void {
  portText.value[i] = v
  if (!v.trim()) r.port = undefined
  else {
    const n = validPort(v)
    if (n === undefined) return
    r.port = n
  }
  push()
}
</script>

<template>
  <div class="flex flex-col gap-2 text-[12px]">
    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-[var(--text-2)]">Name</span>
      <input v-model="name" :class="INPUT" aria-label="Project name" @input="push" />
    </label>
    <p v-if="modelValue.framework" class="text-[var(--text-muted)]">Looks like {{ modelValue.framework }}.</p>
    <p v-if="!rows.length" class="text-[var(--text-muted)]">No dev scripts were found. Add servers after the file is written.</p>
    <div v-for="(r, i) in rows" :key="i" class="flex flex-col gap-1 rounded-[var(--radius-6)] p-2 shadow-[inset_0_0_0_1px_var(--border)]" :class="r.include ? '' : 'opacity-50'">
      <label class="flex items-center gap-2">
        <input v-model="r.include" type="checkbox" :aria-label="`Include ${r.name}`" @change="push" />
        <input v-model="r.name" :class="INPUT" aria-label="Server name" :disabled="!r.include" @input="push" />
      </label>
      <template v-if="r.include">
        <label class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-[var(--text-2)]">Id</span>
          <input v-model="r.id" :class="INPUT" aria-label="Server id" @input="push" />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-[var(--text-2)]">Command</span>
          <input v-model="r.command" :class="[INPUT, 'font-mono']" aria-label="Command" @input="push" />
        </label>
        <label class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-[var(--text-2)]">Port</span>
          <input :value="portText[i] ?? ''" :class="INPUT" inputmode="numeric" aria-label="Port" placeholder="None" @input="setPort(r, i, ($event.target as HTMLInputElement).value)" />
        </label>
        <p v-if="(portText[i] ?? '').trim() && validPort(portText[i]) === undefined" class="pl-18 text-[var(--danger-text)]">Port must be 1 to 65535</p>
        <label class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-[var(--text-2)]">Folder</span>
          <input
            :value="r.cwd ?? ''"
            :class="[INPUT, 'font-mono']"
            aria-label="Folder, relative to the project"
            placeholder="The project folder"
            @input="r.cwd = ($event.target as HTMLInputElement).value || undefined; push()"
          />
        </label>
        <label class="flex items-center gap-2 text-[var(--text-2)]">
          <input :checked="!!r.autostart" type="checkbox" @change="r.autostart = ($event.target as HTMLInputElement).checked; push()" />
          Start it automatically
        </label>
      </template>
    </div>
    <p v-if="modelValue.truncated" class="text-[var(--text-muted)]">{{ modelValue.truncated }} more dev scripts were left out to keep the list short.</p>
  </div>
</template>
