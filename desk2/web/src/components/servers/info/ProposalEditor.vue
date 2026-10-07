<script setup lang="ts">
import type { DevWebProposal } from '@shared/devwebui'
import { ref, watch } from 'vue'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
import Field from './kit/Field.vue'
import Notice from './kit/Notice.vue'
import SwitchRow from './kit/SwitchRow.vue'
import { CARD, CHIP, INPUT, INPUT_MONO } from './kit/kit'

// The .devwebui a found folder would get, editable before it is written: the project's name, then one card per dev
// script it found. A server switched off stays on screen as a dimmed header (so it can be switched on again) but
// leaves the emitted proposal, which is what gets written.
type Row = DevWebProposal['processes'][number] & { include: boolean }

const props = defineProps<{ modelValue: DevWebProposal }>()
const emit = defineEmits<{ 'update:modelValue': [value: DevWebProposal] }>()

const name = ref('')
const rows = ref<Row[]>([])
// What each row's port field holds as typed; `port` changes only when it is valid or emptied.
const portText = ref<string[]>([])
let emitted: DevWebProposal | null = null

const validPort = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}
const portError = (i: number): string | null => {
  const t = portText.value[i] ?? ''
  return t.trim() && validPort(t) === undefined ? 'Port must be 1 to 65535' : null
}

// Our own emit comes back as the new modelValue: skip it so the rows (and unticked ones) are not reset.
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

function setInclude(r: Row, v: boolean): void {
  r.include = v
  push()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-2">
      <Field label="Project name" class="max-w-[360px]">
        <template #default="{ id, describedBy, invalid }">
          <input :id="id" v-model="name" :class="INPUT" :aria-describedby="describedBy" :aria-invalid="invalid" @input="push" />
        </template>
      </Field>
      <div v-if="modelValue.framework"><span :class="CHIP">Looks like {{ modelValue.framework }}</span></div>
    </div>

    <Notice v-if="!rows.length" tone="neutral" title="No dev scripts were found">Add servers after the file is written.</Notice>

    <section v-for="(r, i) in rows" :key="i" :class="[CARD, 'flex flex-col gap-4 p-4', r.include ? '' : 'opacity-60']">
      <div class="flex min-h-8 items-center gap-3">
        <PaneSwitch :label="`Include ${r.name}`" :model-value="r.include" @update:model-value="(v: boolean) => setInclude(r, v)" />
        <input
          v-model="r.name"
          :class="[INPUT, 'font-medium']"
          aria-label="Server name"
          :disabled="!r.include"
          @input="push"
        />
      </div>
      <template v-if="r.include">
        <div class="grid gap-3 @md:grid-cols-[1fr_160px]">
          <Field label="Id">
            <template #default="{ id, describedBy, invalid }">
              <input :id="id" v-model="r.id" :class="INPUT_MONO" :aria-describedby="describedBy" :aria-invalid="invalid" @input="push" />
            </template>
          </Field>
          <Field label="Port" :error="portError(i)">
            <template #default="{ id, describedBy, invalid }">
              <input
                :id="id"
                :value="portText[i] ?? ''"
                :class="[INPUT, 'tnum']"
                inputmode="numeric"
                placeholder="None"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                @input="setPort(r, i, ($event.target as HTMLInputElement).value)"
              />
            </template>
          </Field>
        </div>
        <Field label="Command">
          <template #default="{ id, describedBy, invalid }">
            <input :id="id" v-model="r.command" :class="INPUT_MONO" :aria-describedby="describedBy" :aria-invalid="invalid" @input="push" />
          </template>
        </Field>
        <Field label="Folder" help="Relative to the project; empty means the project folder." optional>
          <template #default="{ id, describedBy, invalid }">
            <input
              :id="id"
              :value="r.cwd ?? ''"
              :class="INPUT_MONO"
              placeholder="The project folder"
              :aria-describedby="describedBy"
              :aria-invalid="invalid"
              @input="r.cwd = ($event.target as HTMLInputElement).value || undefined; push()"
            />
          </template>
        </Field>
        <SwitchRow
          label="Start automatically"
          description="Start it when the project is loaded."
          :model-value="!!r.autostart"
          @update:model-value="(v: boolean) => { r.autostart = v; push() }"
        />
      </template>
    </section>

    <p v-if="modelValue.truncated" class="text-[12px] leading-4 text-text-muted">
      {{ modelValue.truncated }} more dev scripts were left out to keep the list short.
    </p>
  </div>
</template>
