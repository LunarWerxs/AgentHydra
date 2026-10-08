<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DevWebAlertMetric, DevWebAlertRule } from '@shared/devwebui'
import { addAlert, updateAlert } from '@/components/servers/api'
import { duration, fromMb, toMb } from '@/components/servers/info/format'
import { BTN_GHOST, BTN_GHOST_SM, BTN_PRIMARY, CARD, INPUT, SELECT } from './kit/kit'
import Field from './kit/Field.vue'
import Segmented from './kit/Segmented.vue'

// One alert rule as a small form, for New and Edit alike: which server (only when the view is not one server's), CPU or
// memory, the limit and how long it must stay over it. Memory is typed in MB and stored in bytes; CPU in percent of one
// core. A new rule is added with addAlert; an edit saves only metric, threshold and duration with updateAlert.
const props = defineProps<{
  rule?: DevWebAlertRule | null
  processId?: string
  servers: { id: string; name: string; projectName: string }[]
}>()
const emit = defineEmits<{ saved: [rule: DevWebAlertRule]; cancel: [] }>()

const server = ref(props.rule?.processId ?? props.processId ?? '')
const metric = ref<DevWebAlertMetric>(props.rule?.metric ?? 'cpu')
// v-model on a type="number" input hands back a number once typed in (Vue casts it), a string before: read both.
const threshold = ref<string | number>(props.rule ? String(props.rule.metric === 'cpu' ? props.rule.threshold : toMb(props.rule.threshold)) : '80')
const seconds = ref<string | number>(props.rule ? String(Math.round(props.rule.forMs / 1000)) : '30')
const busy = ref(false)
const error = ref<string | null>(null)
const tried = ref(false)

const fixed = computed(() => !!props.processId || !!props.rule)
const unit = computed(() => (metric.value === 'cpu' ? '%' : 'MB'))
const QUICK = [
  { s: 10, label: '10 s' },
  { s: 30, label: '30 s' },
  { s: 60, label: '1 min' },
  { s: 300, label: '5 min' }
]

function setMetric(m: DevWebAlertMetric) {
  // A fresh default for the new unit, unless the user already typed one for it.
  if (m !== metric.value && !props.rule) threshold.value = m === 'cpu' ? '80' : '500'
  metric.value = m
}

const thresholdError = computed(() => {
  const n = Number(threshold.value)
  if (!String(threshold.value).trim() || !Number.isFinite(n) || n <= 0) return 'Enter a limit above 0.'
  // The service keeps a CPU limit in whole percent, so 0.4 would be saved as 0 and always fire.
  if (metric.value === 'cpu' && Math.round(n) < 1) return 'Enter a limit of at least 1%.'
  if (metric.value === 'cpu' && n > 1000) return 'CPU is at most 1000% (ten cores).'
  return null
})
const durationError = computed(() => {
  const n = Number(seconds.value)
  return !String(seconds.value).trim() || !Number.isFinite(n) || n < 1 ? 'At least 1 second.' : null
})
const serverError = computed(() => (!fixed.value && !server.value ? 'Pick a server.' : null))

const preview = computed(() => ({
  metric: metric.value === 'cpu' ? 'CPU' : 'memory',
  limit: thresholdError.value ? '…' : `${Number(threshold.value)}${metric.value === 'cpu' ? '%' : ' MB'}`,
  time: durationError.value ? '…' : duration(Number(seconds.value) * 1000)
}))

async function submit() {
  tried.value = true
  if (thresholdError.value || durationError.value || serverError.value) return
  const n = Number(threshold.value)
  const value = metric.value === 'cpu' ? Math.round(n) : fromMb(n)
  const forMs = Math.round(Number(seconds.value) * 1000)
  busy.value = true
  try {
    const saved = props.rule
      ? await updateAlert(props.rule.id, { metric: metric.value, threshold: value, forMs })
      : await addAlert({ processId: server.value, metric: metric.value, threshold: value, forMs })
    error.value = null
    emit('saved', saved)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form :class="CARD" class="flex flex-col gap-4 p-4" @submit.prevent="submit">
    <Field v-if="!fixed" label="Server" :error="tried ? serverError : null">
      <template #default="{ id, describedBy, invalid }">
        <select :id="id" v-model="server" :class="SELECT" class="max-w-90" :aria-describedby="describedBy" :aria-invalid="invalid">
          <option value="">Select a server</option>
          <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.projectName }} · {{ s.name }}</option>
        </select>
      </template>
    </Field>

    <div class="flex flex-col gap-1.5">
      <span class="text-[12px] font-medium leading-4 text-text-2">Metric</span>
      <Segmented
        :model-value="metric"
        label="Metric"
        :options="[
          { value: 'cpu', label: 'CPU' },
          { value: 'memory', label: 'Memory' }
        ]"
        @update:model-value="setMetric"
      />
    </div>

    <Field label="Threshold" :error="tried ? thresholdError : null" :help="metric === 'cpu' ? 'Percent of one core.' : 'Resident memory of the server and its children.'">
      <template #default="{ id, describedBy, invalid }">
        <div class="relative max-w-40">
          <input :id="id" v-model="threshold" type="number" min="0" step="any" :class="INPUT" class="pe-9 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" :aria-describedby="describedBy" :aria-invalid="invalid" />
          <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[12px] text-text-muted">{{ unit }}</span>
        </div>
      </template>
    </Field>

    <Field label="Duration" :error="tried ? durationError : null" help="How long it must stay over the limit.">
      <template #default="{ id, describedBy, invalid }">
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative w-full max-w-40">
            <input :id="id" v-model="seconds" type="number" min="1" step="1" :class="INPUT" class="pe-9 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" :aria-describedby="describedBy" :aria-invalid="invalid" />
            <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[12px] text-text-muted">s</span>
          </div>
          <button
            v-for="q in QUICK"
            :key="q.s"
            type="button"
            :class="BTN_GHOST_SM"
            class="shadow-[inset_0_0_0_1px_var(--border)] aria-pressed:bg-fill-selected aria-pressed:text-text"
            :aria-pressed="Number(seconds) === q.s"
            @click="seconds = String(q.s)"
          >{{ q.label }}</button>
        </div>
      </template>
    </Field>

    <p class="rounded-(--radius-6) bg-fill-5 px-3 py-2 text-[13px] leading-5 text-text-2">
      Alert if <span class="font-medium text-text">{{ preview.metric }}</span> stays over
      <span class="font-medium text-text tnum">{{ preview.limit }}</span> for <span class="font-medium text-text tnum">{{ preview.time }}</span>
    </p>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <p v-if="error" role="alert" class="me-auto text-[12px] leading-4 text-danger-text">{{ error }}</p>
      <button type="button" :class="BTN_GHOST" @click="emit('cancel')">Cancel</button>
      <button type="submit" :class="BTN_PRIMARY" :disabled="busy">{{ rule ? 'Save rule' : 'Add rule' }}</button>
    </div>
  </form>
</template>
