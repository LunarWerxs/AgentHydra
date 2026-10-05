<script setup lang="ts">
// The run queue's automation: the scheduler that dispatches queued runs, and the monitor that
// resumes a session stopped on a rate limit once its window resets. Opened from the queue drawer's
// scheduler button and the header's scheduler chip (usePanels.openAutomation); they were the
// Settings panel's Automation tab (owner, 2026-10-01: a setting lives on the page it belongs to).
// Every field saves as it changes: the numbers save when they lose focus, where the Settings panel
// used to wait for its footer Save button.
import { CalendarClock, ChevronDown, Power, RefreshCw, SlidersHorizontal } from '@lucide/vue'
import { onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useData } from '@/composables/useData'
import { useMonitor } from '@/composables/useMonitor'
import type { MonitorStateName } from '@/lib/api'
import * as api from '@/lib/api'
import type { BadgeVariant } from '@/lib/format'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const { t } = useI18n()
// `accounts` lists the monitor's per-account switches; useData's polling fills both.
const { accounts, scheduler, refreshScheduler } = useData()

// --- scheduler ---
const sched = reactive({
  spacing_seconds: 60,
  poll_seconds: 5,
  max_concurrent: 3,
  tomorrow_time: '09:00',
})
watch(
  scheduler,
  (s) => {
    if (s) {
      sched.spacing_seconds = s.spacing_seconds
      sched.poll_seconds = s.poll_seconds
      sched.max_concurrent = s.max_concurrent
      sched.tomorrow_time = s.tomorrow_time
    }
  },
  { immediate: true },
)

// Both writes apply locally first (the switch and the numbers reflect the change instantly), roll
// back if the server refuses, and still reload afterwards so counts the server owns reconcile.
async function toggleScheduler(enabled: boolean) {
  const prev = scheduler.value
  if (prev) scheduler.value = { ...prev, enabled }
  try {
    await api.updateScheduler({ enabled })
  } catch {
    scheduler.value = prev
    toast.error(t('settings.toastSchedulerFailed'))
  }
  await refreshScheduler()
}
async function saveScheduler() {
  const patch = {
    spacing_seconds: Number(sched.spacing_seconds),
    poll_seconds: Number(sched.poll_seconds),
    max_concurrent: Number(sched.max_concurrent),
    tomorrow_time: sched.tomorrow_time,
  }
  const prev = scheduler.value
  if (prev) scheduler.value = { ...prev, ...patch }
  try {
    await api.updateScheduler(patch)
  } catch {
    scheduler.value = prev
    toast.error(t('settings.toastSchedulerFailed'))
  }
  await refreshScheduler()
}

// progressive disclosure state
const schedAdvancedOpen = ref(false)
const monitorAdvancedOpen = ref(false)

// --- auto-resume monitor ---
const {
  settings: monitorSettings,
  status: monitorStatus,
  accounts: monitorAccountOverrides,
  refreshMonitor,
  updateMonitor,
  setMonitorAccount,
} = useMonitor()
onMounted(refreshMonitor)

const monitorMaxAttempts = ref(3)
const monitorResumeBufferMin = ref(10)
watch(
  monitorSettings,
  (s) => {
    if (s) {
      monitorMaxAttempts.value = s.maxAttempts
      monitorResumeBufferMin.value = s.resumeBufferMin
    }
  },
  { immediate: true },
)

async function toggleMonitorEnabled(enabled: boolean) {
  const ok = await updateMonitor({ enabled })
  if (ok) {
    toast.success(enabled ? t('settings.monitorToastEnabled') : t('settings.monitorToastDisabled'))
  } else {
    toast.error(t('settings.monitorToastFailed'))
  }
}
async function saveMonitorSettings() {
  const ok = await updateMonitor({
    maxAttempts: Number(monitorMaxAttempts.value),
    resumeBufferMin: Number(monitorResumeBufferMin.value),
  })
  if (!ok) toast.error(t('settings.monitorToastFailed'))
}
async function toggleMonitorAccount(accountId: string, enabled: boolean) {
  const ok = await setMonitorAccount(accountId, enabled)
  if (!ok) toast.error(t('settings.monitorToastFailed'))
}
function monitorAccountEnabled(accountId: string): boolean {
  return monitorAccountOverrides.value[accountId] ?? true
}

const MONITOR_STATE_VARIANT: Record<MonitorStateName, BadgeVariant> = {
  scheduled: 'info',
  blocked_weekly: 'warning',
  needs_human: 'destructive',
  done: 'secondary',
}
const MONITOR_STATE_LABEL_KEY: Record<MonitorStateName, string> = {
  scheduled: 'settings.monitorStateScheduled',
  blocked_weekly: 'settings.monitorStateBlockedWeekly',
  needs_human: 'settings.monitorStateNeedsHuman',
  done: 'settings.monitorStateDone',
}
function monitorStateVariant(state: MonitorStateName): BadgeVariant {
  return MONITOR_STATE_VARIANT[state] ?? 'secondary'
}
function monitorStateLabelKey(state: MonitorStateName): string {
  return MONITOR_STATE_LABEL_KEY[state] ?? 'settings.monitorStateScheduled'
}
</script>

<template>
  <!-- scheduler: opened from the queue drawer's indicator and the header chip. -->
  <SettingsGroup
    :label="$t('settings.scheduler')"
    :description="$t('settings.schedulerHint')"
    class="scroll-mt-4"
  >
    <!-- AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — the scheduler
         exists solely to spawn those runs automatically, so it can never dispatch anything in
         this build. Say so up front and disable the controls below with that reason, rather than
         offer a toggle that would only fail moments after being flipped on. Mirrors QueueView /
         QueueBuilder's AH-12 fix, both reading the same HEADLESS_QUEUEING_ENABLED flag. -->
    <div
      v-if="!HEADLESS_QUEUEING_ENABLED"
      class="flex items-center gap-1.5 px-3.5 py-2.5 text-2xs text-warning"
    >
      {{ $t('settings.schedulerUnavailable') }}
      <InfoHint :text="$t('settings.schedulerUnavailableHint')" />
    </div>
    <SettingsRow :icon="Power" :label="$t('settings.schedulerEnabledLabel')">
      <template #control>
        <span>
          {{ scheduler?.running_count ?? 0 }} {{ $t('settings.running') }} ·
          {{ scheduler?.queued_count ?? 0 }} {{ $t('settings.queued') }}
        </span>
        <Switch
          :model-value="scheduler?.enabled ?? false"
          :disabled="!HEADLESS_QUEUEING_ENABLED"
          :title="!HEADLESS_QUEUEING_ENABLED ? $t('settings.schedulerUnavailableHint') : undefined"
          @update:model-value="toggleScheduler"
        />
      </template>
    </SettingsRow>
    <!-- the composer's "Tomorrow …" quick option reads this time (its tiny gear lands here) -->
    <SettingsRow :icon="CalendarClock" :label="$t('settings.tomorrowTimeLabel')">
      <template #info>
        <InfoHint :text="$t('settings.tomorrowTimeHint')" />
      </template>
      <template #control>
        <Input
          v-model="sched.tomorrow_time"
          type="time"
          class="w-28"
          :disabled="!HEADLESS_QUEUEING_ENABLED"
          :title="!HEADLESS_QUEUEING_ENABLED ? $t('settings.schedulerUnavailableHint') : undefined"
          @change="saveScheduler"
        />
      </template>
    </SettingsRow>
    <SettingsRow
      :icon="SlidersHorizontal"
      :label="$t('settings.advanced')"
      clickable
      :aria-expanded="schedAdvancedOpen"
      @click="schedAdvancedOpen = !schedAdvancedOpen"
    >
      <template #control>
        <ChevronDown
          class="size-4 transition-transform duration-200"
          :class="schedAdvancedOpen ? 'rotate-180' : ''"
        />
      </template>
    </SettingsRow>
    <ExpandTransition :open="schedAdvancedOpen">
      <div class="grid grid-cols-3 gap-3 px-3.5 pb-3.5 pt-2.5">
        <div class="space-y-1.5">
          <label for="sched-spacing" class="text-xs font-medium text-muted-foreground">{{ $t('settings.spacingLabel') }}</label>
          <Input id="sched-spacing" v-model="sched.spacing_seconds" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" @change="saveScheduler" />
        </div>
        <div class="space-y-1.5">
          <label for="sched-poll" class="text-xs font-medium text-muted-foreground">{{ $t('settings.pollLabel') }}</label>
          <Input id="sched-poll" v-model="sched.poll_seconds" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" @change="saveScheduler" />
        </div>
        <div class="space-y-1.5">
          <label for="sched-max-concurrent" class="text-xs font-medium text-muted-foreground">{{ $t('settings.maxConcurrentLabel') }}</label>
          <Input id="sched-max-concurrent" v-model="sched.max_concurrent" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" @change="saveScheduler" />
        </div>
      </div>
    </ExpandTransition>
  </SettingsGroup>

  <!-- auto-resume monitor -->
  <SettingsGroup :label="$t('settings.monitorTitle')" :description="$t('settings.monitorHint')">
    <SettingsRow :icon="RefreshCw" :label="$t('settings.monitorEnabledLabel')">
      <template #control>
        <Switch
          :model-value="monitorSettings?.enabled ?? false"
          @update:model-value="toggleMonitorEnabled"
        />
      </template>
    </SettingsRow>

    <!-- everything below only applies while the monitor is on: collapse it away when
         it's off instead of leaving dead knobs on screen (owner request) -->
    <ExpandTransition :open="monitorSettings?.enabled ?? false">
      <!-- divide-y is restated here for the same reason the scheduler deep link avoids a wrapper
           div: SettingsGroup draws its hairlines with divide-y on the one div that directly wraps
           its slot, and ExpandTransition inserts two divs of its own. Everything in this
           disclosure is therefore a single child to that container, so the per-account rows below
           rendered back-to-back with no separator while structurally identical rows got one. -->
      <div class="divide-y divide-border/60">
        <!-- the tuning numbers are advanced, mirroring the Scheduler group's disclosure -->
        <SettingsRow
          :icon="SlidersHorizontal"
          :label="$t('settings.advanced')"
          clickable
          :aria-expanded="monitorAdvancedOpen"
          @click="monitorAdvancedOpen = !monitorAdvancedOpen"
        >
          <template #control>
            <ChevronDown
              class="size-4 transition-transform duration-200"
              :class="monitorAdvancedOpen ? 'rotate-180' : ''"
            />
          </template>
        </SettingsRow>
        <ExpandTransition :open="monitorAdvancedOpen">
          <div class="grid grid-cols-2 gap-3 px-3.5 pb-3.5 pt-2.5">
            <div class="space-y-1.5">
              <label for="monitor-max-attempts" class="text-xs font-medium text-muted-foreground">{{ $t('settings.monitorMaxAttemptsLabel') }}</label>
              <Input id="monitor-max-attempts" v-model="monitorMaxAttempts" type="number" min="1" @change="saveMonitorSettings" />
            </div>
            <div class="space-y-1.5">
              <label for="monitor-buffer-min" class="text-xs font-medium text-muted-foreground">{{ $t('settings.monitorBufferLabel') }}</label>
              <Input id="monitor-buffer-min" v-model="monitorResumeBufferMin" type="number" min="0" @change="saveMonitorSettings" />
            </div>
          </div>
        </ExpandTransition>

        <div
          v-if="monitorStatus.length === 0"
          class="flex items-center gap-1.5 px-3.5 py-2.5 text-xs italic text-muted-foreground"
        >
          {{ $t('settings.monitorEmpty') }}
          <InfoHint :text="$t('settings.monitorEmptyHint')" />
        </div>
        <div v-else class="flex flex-col gap-2 px-3.5 py-2.5">
          <div v-for="row in monitorStatus" :key="row.itemId" class="flex items-center gap-2 text-xs">
            <Badge :variant="monitorStateVariant(row.state)">{{ $t(monitorStateLabelKey(row.state)) }}</Badge>
            <!-- a stop we went and found on disk, vs one of our own runs we watched stop -->
            <Badge v-if="row.discovered" variant="outline" :title="$t('settings.monitorDiscoveredHint')">
              {{ $t('settings.monitorDiscovered') }}
            </Badge>
            <span class="min-w-0 flex-1 truncate text-foreground">{{ row.title ?? row.sessionId }}</span>
            <span v-if="row.message" class="max-w-56 truncate text-muted-foreground">{{ row.message }}</span>
            <span class="shrink-0 text-muted-foreground">
              {{ $t('settings.monitorAttempts', { n: row.resumeAttempts }) }}
            </span>
          </div>
        </div>

        <template v-if="accounts.length > 0">
          <p class="px-3.5 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t('settings.monitorAccountOverridesLabel') }}
          </p>
          <SettingsRow v-for="a in accounts" :key="a.id" :label="a.label">
            <template #control>
              <Switch
                :model-value="monitorAccountEnabled(a.id)"
                @update:model-value="(v: boolean) => toggleMonitorAccount(a.id, v)"
              />
            </template>
          </SettingsRow>
        </template>
      </div>
    </ExpandTransition>
  </SettingsGroup>
</template>
