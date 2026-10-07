<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Trash2 } from '@lucide/vue'
import type { DevWebAlertEvent, DevWebAlertRule, DevWebProcess, DevWebProject } from '@shared/devwebui'
import { ago, bytes, cpu } from '@/components/servers/info/format'
import { alertList, addAlert, updateAlert, removeAlert, clearAlertEvents, listProjects } from '@/components/servers/api'
import { Tip } from '@/components/ui/tooltip'
import { BUTTON } from '@/components/panes/settings-styles'
import { useDevServers } from '@/components/servers/store'

const props = defineProps<{ processId?: string }>()

const dev = useDevServers()
const alerts = ref<{ rules: DevWebAlertRule[]; events: DevWebAlertEvent[] } | null>(null)
const projects = ref<DevWebProject[]>([])
const error = ref<string | null>(null)
let releaseStore: (() => void) | null = null

const events = computed(() => [...(alerts.value?.events ?? [])].sort((a, b) => b.firedAt - a.firedAt))
const liveProcess = (id: string) => (dev.projects.value ?? []).flatMap((p) => p.processes).find((p) => p.id === id)
const serverName = (ev: DevWebAlertEvent) => liveProcess(ev.processId)?.name ?? ev.processName
const amount = (ev: DevWebAlertEvent, n: number) => (ev.metric === 'cpu' ? cpu(n) : bytes(n))
// The service keeps no resolved marker, so an event reads as firing while it is the rule's latest and the server's live sample is still over the threshold.
const stillFiring = (ev: DevWebAlertEvent) => {
  if (events.value.find((e) => e.ruleId === ev.ruleId)?.id !== ev.id) return false
  const now = liveProcess(ev.processId)?.[ev.metric === 'cpu' ? 'cpu' : 'memory']
  return now != null && now > ev.threshold
}

const selectedProcess = ref(props.processId || '')
const selectedMetric = ref<'cpu' | 'memory'>('cpu')
const selectedThreshold = ref('80')
const selectedDuration = ref('30')

async function load() {
  try {
    ;[alerts.value, projects.value] = await Promise.all([alertList({ start: false }), listProjects({ start: false }).catch(() => [])])
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const allProcesses = computed(() => {
  const procs: (DevWebProcess & { projectName: string })[] = []
  for (const proj of projects.value) {
    for (const proc of proj.processes) {
      procs.push({ ...proc, projectName: proj.name })
    }
  }
  return procs.sort((a, b) => a.name.localeCompare(b.name))
})

async function addNewAlert() {
  if (!selectedProcess.value) return
  const threshold = selectedMetric.value === 'cpu' ? Math.round(Number(selectedThreshold.value)) : Math.round(Number(selectedThreshold.value) * 1024 * 1024)
  const forMs = Math.round(Number(selectedDuration.value) * 1000)
  try {
    const rule = await addAlert({ processId: selectedProcess.value, metric: selectedMetric.value, threshold, forMs })
    if (alerts.value) alerts.value.rules.push(rule)
    selectedThreshold.value = selectedMetric.value === 'cpu' ? '80' : '500'
    selectedDuration.value = '30'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function toggleRule(rule: DevWebAlertRule) {
  try {
    const updated = await updateAlert(rule.id, { enabled: !rule.enabled })
    if (alerts.value) {
      const idx = alerts.value.rules.findIndex((r) => r.id === rule.id)
      if (idx >= 0) alerts.value.rules[idx] = updated
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function deleteRule(rule: DevWebAlertRule) {
  try {
    await removeAlert(rule.id)
    if (alerts.value) alerts.value.rules = alerts.value.rules.filter((r) => r.id !== rule.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function clearEvents() {
  try {
    await clearAlertEvents()
    if (alerts.value) alerts.value.events = []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  releaseStore = dev.use({ quiet: true })
  void load()
})
onBeforeUnmount(() => {
  releaseStore?.()
})
</script>

<template>
  <div class="min-w-[400px] space-y-4">
    <div v-if="error" class="text-[13px] leading-[19px] text-danger-text">{{ error }}</div>
    <div v-if="!alerts" class="text-[13px] leading-[19px] text-text-muted">Loading…</div>
    <template v-else>
      <div>
        <h4 class="mb-2 text-[12px] font-semibold leading-4 text-text-muted">Rules</h4>
        <div v-if="!alerts.rules.length" class="text-[12px] leading-[18px] text-text-muted">No rules yet.</div>
        <div v-else class="space-y-2">
          <div v-for="rule in alerts.rules" :key="rule.id" class="flex items-center gap-2 text-[12px] leading-[18px]">
            <input type="checkbox" :checked="rule.enabled" :aria-label="`Enable alert rule ${rule.id}`" @change="toggleRule(rule)" />
            <span class="flex-1 text-text-2">
              {{ allProcesses.find((p) => p.id === rule.processId)?.name || rule.processId }} · {{ rule.metric === 'cpu' ? 'CPU' : 'Memory' }} >
              {{ rule.metric === 'cpu' ? rule.threshold : Math.round(rule.threshold / 1024 / 1024) }}{{ rule.metric === 'cpu' ? '%' : ' MB' }} for
              {{ Math.round(rule.forMs / 1000) }}s
            </span>
            <Tip label="Delete rule">
              <button type="button" class="flex items-center justify-center rounded hover:text-danger-text" @click="deleteRule(rule)">
                <Trash2 class="size-3.5" />
              </button>
            </Tip>
          </div>
        </div>
      </div>

      <div>
        <h4 class="mb-2 text-[12px] font-semibold leading-4 text-text-muted">Add rule</h4>
        <div class="space-y-2">
          <select v-model="selectedProcess" class="w-full rounded bg-fill-5 px-2 py-1 text-[12px] text-text">
            <option value="">Select a server</option>
            <option v-for="proc in allProcesses" :key="proc.id" :value="proc.id">{{ proc.projectName }} · {{ proc.name }}</option>
          </select>
          <div class="flex gap-2">
            <label class="flex items-center gap-1 text-[12px]">
              <input v-model="selectedMetric" type="radio" value="cpu" />
              CPU %
            </label>
            <label class="flex items-center gap-1 text-[12px]">
              <input v-model="selectedMetric" type="radio" value="memory" />
              Memory MB
            </label>
          </div>
          <input v-model="selectedThreshold" type="number" :placeholder="selectedMetric === 'cpu' ? '80' : '500'" class="w-full rounded bg-fill-5 px-2 py-1 text-[12px]" />
          <div class="flex items-center gap-2 text-[12px]">
            <input v-model="selectedDuration" type="number" placeholder="30" class="w-16 rounded bg-fill-5 px-2 py-1" /> seconds
          </div>
          <button type="button" :class="BUTTON" :disabled="!selectedProcess" @click="addNewAlert">Add</button>
        </div>
      </div>

      <div v-if="alerts.events.length">
        <h4 class="mb-2 flex items-center justify-between text-[12px] font-semibold leading-4 text-text-muted">
          Events
          <button type="button" :class="BUTTON" @click="clearEvents">Clear</button>
        </h4>
        <div class="space-y-1 text-[12px] leading-[18px] text-text-muted">
          <div v-for="ev in events.slice(0, 10)" :key="ev.id">
            <span class="text-text-2">{{ serverName(ev) }}</span> · {{ ev.metric === 'cpu' ? 'CPU' : 'Memory' }} {{ amount(ev, ev.value) }} over {{ amount(ev, ev.threshold) }} ·
            {{ ago(ev.firedAt) }} · {{ stillFiring(ev) ? 'still firing' : 'resolved' }}
          </div>
          <div v-if="events.length > 10" class="text-[11px]">… and {{ events.length - 10 }} more</div>
        </div>
      </div>
    </template>
  </div>
</template>
