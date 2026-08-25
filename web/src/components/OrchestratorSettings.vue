<script setup lang="ts">
// The orchestrator's settings group (docs/ORCHESTRATOR.md): the watcher's master switch, the
// owner-policy knobs the /orchestrate reviewer obeys (new-chat defaults, handoff surface,
// open-instances policy, reviewer reserve), and the tuning numbers behind a disclosure —
// mirroring the auto-resume monitor group one card up.
//
// Self-contained on purpose: SettingsView.vue mounts it with one line. Every save round-trips
// through POST /api/orchestrator and re-adopts the server's answer, so a clamped or refused
// value shows as what actually stuck, never as what was typed.
import { Bot, ChevronDown, PauseCircle, Play, SlidersHorizontal } from '@lucide/vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { OrchestratorView } from '@/lib/api'
import * as api from '@/lib/api'
import { baseName, shortId, timeAgo } from '@/lib/format'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'

const view = ref<OrchestratorView | null>(null)
const advancedOpen = ref(false)
const holdsOpen = ref(false)
/** The session id currently being unparked, so its own button disables without freezing the rest. */
const unparking = ref<string | null>(null)
const holds = computed(() => view.value?.holds ?? [])

async function unpark(sessionId: string) {
  unparking.value = sessionId
  try {
    // Adopt the server's list rather than splicing locally: a hold could have been lifted from
    // inside the chat (/resumeo) since this view was fetched, and the server is the truth.
    const r = await api.setOrchestratorHold(sessionId, false)
    if (view.value) view.value = { ...view.value, holds: r.holds }
  } finally {
    unparking.value = null
  }
}

// Local copies for the free-typed fields, adopted from the server on every round trip.
const form = reactive({
  newChatModel: '',
  openMinPlan: '',
  reviewerReservePct: 0,
  tickSecs: 0,
  idleQuietSecs: 0,
  ctxHandoffTokens: 0,
  softPct: 0,
  warnPct: 0,
  hardPct: 0,
  sessionHighPct: 0,
  resetSoonMins: 0,
  spikePct: 0,
  dirtyMins: 0,
  staleTaskMins: 0,
  nudgeCooldownMins: 0,
})

function adopt(v: OrchestratorView) {
  view.value = v
  form.newChatModel = v.settings.newChatModel
  form.openMinPlan = v.settings.openMinPlan
  form.reviewerReservePct = v.settings.reviewerReservePct
  form.tickSecs = v.settings.tickSecs
  form.idleQuietSecs = v.settings.idleQuietSecs
  form.ctxHandoffTokens = v.settings.ctxHandoffTokens
  form.softPct = v.settings.softPct
  form.warnPct = v.settings.warnPct
  form.hardPct = v.settings.hardPct
  form.sessionHighPct = v.settings.sessionHighPct
  form.resetSoonMins = v.settings.resetSoonMins
  form.spikePct = v.settings.spikePct
  form.dirtyMins = v.settings.dirtyMins
  form.staleTaskMins = v.settings.staleTaskMins
  form.nudgeCooldownMins = v.settings.nudgeCooldownMins
}

async function save(patch: Parameters<typeof api.updateOrchestrator>[0]) {
  try {
    adopt(await api.updateOrchestrator(patch))
  } catch {
    // The daemon answers on localhost; a failed save leaves the last adopted state visible.
  }
}

function saveNumbers() {
  save({
    reviewerReservePct: Number(form.reviewerReservePct),
    tickSecs: Number(form.tickSecs),
    idleQuietSecs: Number(form.idleQuietSecs),
    ctxHandoffTokens: Number(form.ctxHandoffTokens),
    softPct: Number(form.softPct),
    warnPct: Number(form.warnPct),
    hardPct: Number(form.hardPct),
    sessionHighPct: Number(form.sessionHighPct),
    resetSoonMins: Number(form.resetSoonMins),
    spikePct: Number(form.spikePct),
    dirtyMins: Number(form.dirtyMins),
    staleTaskMins: Number(form.staleTaskMins),
    nudgeCooldownMins: Number(form.nudgeCooldownMins),
  })
}

onMounted(async () => {
  try {
    adopt(await api.getOrchestrator())
  } catch {
    // Daemon unreachable — the group renders with the switch off and no status line.
  }
})
</script>

<template>
  <SettingsGroup :label="$t('orchestrator.title')" :description="$t('orchestrator.hint')">
    <SettingsRow :icon="Bot" :label="$t('orchestrator.enabledLabel')">
      <template #info>
        <InfoHint :text="$t('orchestrator.enabledHint')" />
      </template>
      <template #control>
        <span v-if="view?.meta.lastTickAt" class="text-xs text-muted-foreground">
          {{
            $t('orchestrator.statusLine', {
              live: view.meta.liveSessions,
              items: view.attention.length,
              holds: view.holds.length,
            })
          }}
        </span>
        <Switch
          :model-value="view?.settings.enabled ?? false"
          @update:model-value="(v: boolean) => save({ enabled: v })"
        />
      </template>
    </SettingsRow>

    <ExpandTransition :open="view?.settings.enabled ?? false">
      <div class="divide-y divide-border/60">
        <SettingsRow :icon="Bot" :label="$t('orchestrator.newChatModelLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.newChatModelHint')" />
          </template>
          <template #control>
            <Input
              v-model="form.newChatModel"
              class="w-28"
              @change="save({ newChatModel: form.newChatModel })"
            />
            <Select
              :model-value="view?.settings.newChatEffort"
              @update:model-value="(v) => save({ newChatEffort: v as never })"
            >
              <SelectTrigger class="w-28">
                <SelectValue />
              </SelectTrigger>
              <!-- the CLI's literal --effort values, not prose -->
              <!-- i18n-ignore -->
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="xhigh">xhigh</SelectItem>
                <SelectItem value="max">max</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>

        <SettingsRow :icon="Bot" :label="$t('orchestrator.newChatUltracodeLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.newChatUltracodeHint')" />
          </template>
          <template #control>
            <Switch
              :model-value="view?.settings.newChatUltracode ?? true"
              @update:model-value="(v: boolean) => save({ newChatUltracode: v })"
            />
          </template>
        </SettingsRow>

        <SettingsRow :icon="Bot" :label="$t('orchestrator.migrateOnLimitLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.migrateOnLimitHint')" />
          </template>
          <template #control>
            <Switch
              :model-value="view?.settings.migrateOnLimit ?? false"
              @update:model-value="(v: boolean) => save({ migrateOnLimit: v })"
            />
          </template>
        </SettingsRow>

        <SettingsRow :icon="Bot" :label="$t('orchestrator.handoffSurfaceLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.handoffSurfaceHint')" />
          </template>
          <template #control>
            <Select
              :model-value="view?.settings.handoffSurface"
              @update:model-value="(v) => save({ handoffSurface: v as never })"
            >
              <SelectTrigger class="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop">{{ $t('orchestrator.surfaceDesktop') }}</SelectItem>
                <SelectItem value="terminal">{{ $t('orchestrator.surfaceTerminal') }}</SelectItem>
                <SelectItem value="queue">{{ $t('orchestrator.surfaceQueue') }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>

        <SettingsRow :icon="Bot" :label="$t('orchestrator.openInstancesLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.openInstancesHint')" />
          </template>
          <template #control>
            <Select
              :model-value="view?.settings.openInstances"
              @update:model-value="(v) => save({ openInstances: v as never })"
            >
              <SelectTrigger class="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">{{ $t('orchestrator.openNever') }}</SelectItem>
                <SelectItem value="when-exhausted">
                  {{ $t('orchestrator.openWhenExhausted') }}
                </SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>

        <SettingsRow :icon="Bot" :label="$t('orchestrator.openMinPlanLabel')">
          <template #info>
            <InfoHint :text="$t('orchestrator.openMinPlanHint')" />
          </template>
          <template #control>
            <Select
              :model-value="view?.settings.openMinPlan"
              :disabled="view?.settings.openInstances !== 'when-exhausted'"
              @update:model-value="(v) => save({ openMinPlan: v as string })"
            >
              <SelectTrigger class="w-28">
                <SelectValue />
              </SelectTrigger>
              <!-- Anthropic's literal plan-tier names (substring-matched against the account
                   label), not prose -->
              <!-- i18n-ignore -->
              <SelectContent>
                <SelectItem value="Max 20">Max 20×</SelectItem>
                <SelectItem value="Max 5">Max 5×</SelectItem>
                <SelectItem value="Pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </SettingsRow>

        <!-- Parked threads, listed only when there ARE any. A hold has no expiry and the count in
             the status line above cannot tell you WHICH thread you parked, so a /delayo typed days
             ago was effectively unfindable from the app: the only way back was to remember the chat
             and type /resumeo inside it. This is that memory, plus the way out. -->
        <template v-if="holds.length">
          <SettingsRow
            :icon="PauseCircle"
            :label="$t('orchestrator.holdsLabel', { n: holds.length })"
            clickable
            @click="holdsOpen = !holdsOpen"
          >
            <template #info>
              <InfoHint :text="$t('orchestrator.holdsHint')" />
            </template>
            <template #control>
              <ChevronDown
                class="size-4 transition-transform duration-200"
                :class="holdsOpen ? 'rotate-180' : ''"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="holdsOpen">
            <div class="space-y-1.5 px-3.5 pb-3.5 pt-2.5">
              <div
                v-for="h in holds"
                :key="h.sessionId"
                class="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5"
              >
                <div class="min-w-0 flex-1">
                  <!-- peerName is the live-session name; a thread parked and since closed has
                       none, so the session id is the honest fallback rather than a blank row. -->
                  <div class="truncate text-xs font-medium">
                    {{ h.peerName || shortId(h.sessionId) }}
                  </div>
                  <div class="truncate text-[0.625rem] text-muted-foreground">
                    <span v-if="h.cwd">{{ baseName(h.cwd) }} · </span>{{ timeAgo(h.heldAt) }}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  :disabled="unparking === h.sessionId"
                  @click="unpark(h.sessionId)"
                >
                  <Play /> {{ $t('orchestrator.holdsUnpark') }}
                </Button>
              </div>
            </div>
          </ExpandTransition>
        </template>

        <SettingsRow
          :icon="SlidersHorizontal"
          :label="$t('settings.advanced')"
          clickable
          @click="advancedOpen = !advancedOpen"
        >
          <template #control>
            <ChevronDown
              class="size-4 transition-transform duration-200"
              :class="advancedOpen ? 'rotate-180' : ''"
            />
          </template>
        </SettingsRow>
        <ExpandTransition :open="advancedOpen">
          <div class="grid grid-cols-3 gap-3 px-3.5 pb-3.5 pt-2.5">
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.reserveLabel') }}</label>
              <Input v-model="form.reviewerReservePct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.tickLabel') }}</label>
              <Input v-model="form.tickSecs" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.idleQuietLabel') }}</label>
              <Input v-model="form.idleQuietSecs" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.ctxLabel') }}</label>
              <Input v-model="form.ctxHandoffTokens" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.softLabel') }}</label>
              <Input v-model="form.softPct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.warnLabel') }}</label>
              <Input v-model="form.warnPct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.hardLabel') }}</label>
              <Input v-model="form.hardPct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.sessionHighLabel') }}</label>
              <Input v-model="form.sessionHighPct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.resetSoonLabel') }}</label>
              <Input v-model="form.resetSoonMins" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.spikeLabel') }}</label>
              <Input v-model="form.spikePct" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.dirtyLabel') }}</label>
              <Input v-model="form.dirtyMins" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.staleTaskLabel') }}</label>
              <Input v-model="form.staleTaskMins" type="number" @change="saveNumbers" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('orchestrator.cooldownLabel') }}</label>
              <Input v-model="form.nudgeCooldownMins" type="number" @change="saveNumbers" />
            </div>
          </div>
        </ExpandTransition>
      </div>
    </ExpandTransition>
  </SettingsGroup>
</template>
