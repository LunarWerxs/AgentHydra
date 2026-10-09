<script lang="ts">
import type { DevWebAlerts } from '@shared/devwebui'
// Module level, so a remount (another tab and back) shows the last answer at once while it asks again.
let last: DevWebAlerts | null = null
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Bell, Pencil, Plus, Trash2 } from '@lucide/vue'
import type { DevWebAlertEvent, DevWebAlertRule } from '@shared/devwebui'
import { ago, bytes, clockTime, cpu, duration, toMb } from '@/components/servers/info/format'
import { alertList, updateAlert, removeAlert, clearAlertEvents } from '@/components/servers/api'
import { Tip } from '@/components/ui/tooltip'
import PaneSwitch from '@/components/panes/PaneSwitch.vue'
import { useDevServers } from '@/components/servers/store'
import { BTN, BTN_DANGER_SM, BTN_GHOST, BTN_GHOST_SM, ICON_BTN_SM, ICON_BTN_SM_DANGER, SECTION_TITLE, chip } from './kit/kit'
import Card from './kit/Card.vue'
import CountBadge from './kit/CountBadge.vue'
import EmptyState from './kit/EmptyState.vue'
import RuleForm from './RuleForm.vue'

// Alert rules: "alert if this server's CPU or memory stays over a limit for a while", each a sentence with a switch, and
// the history of when they fired. Used as a server's Alerts tab (processId: only that server's rules and events, and the
// form's server is fixed) and in Settings -> Dev servers (no processId: every server's).
const props = defineProps<{ processId?: string }>()

const dev = useDevServers()
const alerts = ref<{ rules: DevWebAlertRule[]; events: DevWebAlertEvent[] } | null>(last)
const error = ref<string | null>(null)
let releaseStore: (() => void) | null = null

/** null: no form; 'new': the New rule form; a rule id: that row is being edited. */
const editing = ref<string | null>(null)
const confirmRemove = ref<string | null>(null)
/** Clear history asks first: the service keeps one history for every server, so a server's tab clears them all. */
const confirmClear = ref(false)
const showAll = ref(false)
const SHOWN = 8

const rules = computed(() => (alerts.value?.rules ?? []).filter((r) => !props.processId || r.processId === props.processId))
const events = computed(() =>
  [...(alerts.value?.events ?? [])].filter((e) => !props.processId || e.processId === props.processId).sort((a, b) => b.firedAt - a.firedAt)
)
const shownEvents = computed(() => (showAll.value ? events.value : events.value.slice(0, SHOWN)))

const liveProcess = (id: string) => (dev.projects.value ?? []).flatMap((p) => p.processes).find((p) => p.id === id)
const liveValue = (id: string, metric: 'cpu' | 'memory') => liveProcess(id)?.[metric === 'cpu' ? 'cpu' : 'memory'] ?? null
const serverName = (ev: DevWebAlertEvent) => liveProcess(ev.processId)?.name ?? ev.processName
const amount = (metric: 'cpu' | 'memory', n: number) => (metric === 'cpu' ? cpu(n) : bytes(n))
const limit = (r: DevWebAlertRule) => (r.metric === 'cpu' ? `${r.threshold}%` : `${toMb(r.threshold)} MB`)

// The service keeps no resolved marker, so an event reads as firing while it is the rule's latest and the server's live
// sample is still over the threshold.
const stillFiring = (ev: DevWebAlertEvent) => {
  if (events.value.find((e) => e.ruleId === ev.ruleId)?.id !== ev.id) return false
  const now = liveValue(ev.processId, ev.metric)
  return now != null && now > ev.threshold
}
const ruleFiring = (r: DevWebAlertRule) => {
  const latest = events.value.find((e) => e.ruleId === r.id)
  return !!latest && stillFiring(latest)
}

const servers = computed(() => {
  const list: { id: string; name: string; projectName: string }[] = []
  for (const proj of dev.projects.value ?? []) for (const proc of proj.processes) list.push({ id: proc.id, name: proc.name, projectName: proj.name })
  return list.sort((a, b) => a.name.localeCompare(b.name))
})
const serverOf = (id: string) => servers.value.find((s) => s.id === id)

let loadedAt = 0
async function load() {
  loadedAt = Date.now()
  try {
    alerts.value = last = await alertList({ start: false })
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function saved(rule: DevWebAlertRule) {
  if (alerts.value) {
    const idx = alerts.value.rules.findIndex((r) => r.id === rule.id)
    if (idx >= 0) alerts.value.rules[idx] = rule
    else alerts.value.rules.push(rule)
  }
  editing.value = null
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
  confirmRemove.value = null
  try {
    await removeAlert(rule.id)
    if (alerts.value) alerts.value.rules = alerts.value.rules.filter((r) => r.id !== rule.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// The service clears the whole history at once (there is no per-server clear).
async function clearEvents() {
  confirmClear.value = false
  try {
    await clearAlertEvents()
    if (alerts.value) alerts.value.events = []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// Asked again with the list's poll (at most every 3 s), so a rule that fires while this is open shows it, and its history.
watch(dev.answered, () => {
  if (Date.now() - loadedAt >= 3000) void load()
})
onMounted(() => {
  releaseStore = dev.use({ quiet: true })
  void load()
})
onBeforeUnmount(() => {
  releaseStore?.()
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <p v-if="error" role="alert" class="text-[13px] leading-4.75 text-danger-text">{{ error }}</p>
    <div v-if="!alerts" role="status" class="flex flex-col gap-3" aria-busy="true">
      <span class="sr-only">Reading the alert rules…</span>
      <div class="h-8 w-40 animate-pulse rounded-(--radius-6) bg-fill-5 motion-reduce:animate-none" />
      <div class="h-26 animate-pulse rounded-(--radius-10) bg-fill-5 motion-reduce:animate-none" />
    </div>
    <template v-else>
      <div class="flex min-h-8 items-center gap-2">
        <h3 :class="SECTION_TITLE">Alert rules</h3>
        <CountBadge :count="rules.length" tone="neutral" />
        <span class="flex-1" />
        <button v-if="editing !== 'new' && rules.length" type="button" :class="BTN" @click="editing = 'new'">
          <Plus class="size-3.5" aria-hidden="true" />New rule
        </button>
      </div>

      <RuleForm v-if="editing === 'new'" :process-id="processId" :servers="servers" @saved="saved" @cancel="editing = null" />

      <Card v-if="!rules.length && editing !== 'new'">
        <EmptyState :icon="Bell" title="No alert rules" text="Get a notice when this server's CPU or memory stays high.">
          <button type="button" :class="BTN" @click="editing = 'new'"><Plus class="size-3.5" aria-hidden="true" />New rule</button>
        </EmptyState>
      </Card>

      <Card v-else-if="rules.length" flush>
        <ul class="divide-y divide-border">
          <li v-for="rule in rules" :key="rule.id">
            <div v-if="editing === rule.id" class="p-2">
              <RuleForm :rule="rule" :process-id="processId" :servers="servers" @saved="saved" @cancel="editing = null" />
            </div>
            <div v-else class="flex min-h-13 items-center gap-3 px-4 py-3">
              <PaneSwitch :model-value="rule.enabled" label="Turn alert rule on/off" @update:model-value="toggleRule(rule)" />
              <div class="min-w-0 flex-1" :class="!rule.enabled && 'opacity-60'">
                <p class="text-[13px] leading-5 text-text-2">
                  Alert if <span class="font-medium text-text">{{ rule.metric === 'cpu' ? 'CPU' : 'memory' }}</span> stays over
                  <span class="font-medium text-text tnum">{{ limit(rule) }}</span> for
                  <span class="font-medium text-text tnum">{{ duration(rule.forMs) }}</span>
                </p>
                <p class="flex flex-wrap items-center gap-x-2 text-[12px] leading-4.5 text-text-muted">
                  <span v-if="!processId" class="truncate">
                    {{ liveProcess(rule.processId)?.name ?? serverOf(rule.processId)?.name ?? rule.processId }}<template v-if="serverOf(rule.processId)"> · {{ serverOf(rule.processId)?.projectName }}</template>
                  </span>
                  <span v-if="liveValue(rule.processId, rule.metric) != null" class="tnum">now {{ amount(rule.metric, liveValue(rule.processId, rule.metric)!) }}</span>
                </p>
              </div>
              <span v-if="ruleFiring(rule)" :class="chip('warning')">
                <span class="size-1.5 animate-pulse rounded-full bg-warning motion-reduce:animate-none" aria-hidden="true" />Firing
              </span>
              <template v-if="confirmRemove === rule.id">
                <button type="button" :class="BTN_DANGER_SM" @click="deleteRule(rule)">Remove</button>
                <button type="button" :class="BTN_GHOST_SM" @click="confirmRemove = null">Keep</button>
              </template>
              <template v-else>
                <Tip label="Edit rule">
                  <button type="button" :class="ICON_BTN_SM" aria-label="Edit rule" @click="editing = rule.id"><Pencil class="size-3.5" /></button>
                </Tip>
                <Tip label="Remove rule">
                  <button type="button" :class="ICON_BTN_SM_DANGER" aria-label="Remove rule" @click="confirmRemove = rule.id"><Trash2 class="size-3.5" /></button>
                </Tip>
              </template>
            </div>
          </li>
        </ul>
      </Card>

      <Card v-if="events.length" title="History">
        <template #actions>
          <template v-if="confirmClear">
            <span class="text-[12px] leading-4 text-text-2">{{ processId ? "Clear every server's alert history?" : 'Clear all alert history?' }}</span>
            <button type="button" :class="BTN_DANGER_SM" @click="clearEvents">Clear</button>
            <button type="button" :class="BTN_GHOST_SM" @click="confirmClear = false">Keep</button>
          </template>
          <button v-else type="button" :class="BTN_GHOST" @click="confirmClear = true">Clear history</button>
        </template>
        <ol class="relative ms-1 flex flex-col gap-3 border-s border-border ps-4">
          <li v-for="ev in shownEvents" :key="ev.id" class="relative flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              class="absolute top-1.75 -left-5.25 size-2 rounded-full ring-2 ring-bg-panel"
              :class="stillFiring(ev) ? 'bg-warning' : 'bg-text-muted'"
              aria-hidden="true"
            />
            <p class="min-w-0 flex-1 text-[13px] leading-5 text-text-2">
              {{ ev.metric === 'cpu' ? 'CPU' : 'Memory' }} reached <span class="font-medium text-text tnum">{{ amount(ev.metric, ev.value) }}</span>
              (over {{ amount(ev.metric, ev.threshold) }})
              <span class="block text-[12px] leading-4.5 text-text-muted">
                <template v-if="!processId">{{ serverName(ev) }} · </template><Tip :label="clockTime(ev.firedAt)"><span>{{ ago(ev.firedAt) }}</span></Tip>
              </span>
            </p>
            <span :class="chip(stillFiring(ev) ? 'warning' : 'neutral')">{{ stillFiring(ev) ? 'Firing' : 'Resolved' }}</span>
          </li>
        </ol>
        <button v-if="events.length > SHOWN" type="button" :class="BTN_GHOST" class="mt-3" @click="showAll = !showAll">
          {{ showAll ? 'Show fewer' : `Show all ${events.length}` }}
        </button>
      </Card>
    </template>
  </div>
</template>
