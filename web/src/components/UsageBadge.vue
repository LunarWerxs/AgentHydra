<script setup lang="ts">
// Color-coded usage Badge + hover/click Popover breakdown, shared by the desktop Instances
// table and the CLI Instances table (both key into useUsage by a different string, so this
// component just takes the already-resolved snapshot rather than a key).
import { Loader2, RefreshCw } from '@lucide/vue'
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { UsageSnapshot } from '@/lib/api'
import {
  formatMoney,
  isNoDataSnap,
  isStaleSnap,
  shortDate,
  type UsageScope,
  usageBadgeVariant,
  usageCellLabel,
  usageCheckedAgo,
  usagePctFor,
  usageReasonMessageKey,
} from '@/lib/usage'
import { resetLabel } from '@/lib/usage-reset'

const props = defineProps<{
  snapshot: UsageSnapshot | null | undefined
  checking?: boolean
  /** This row's cache key (`desktop:<dir>` / `cli:<id>` / `acct:<id>`) — used to look up WHY
   *  a no-data snapshot is empty via useUsage's reason map. Optional so a caller that never
   *  passes it just falls back to the generic "not checked yet" message. */
  usageKey?: string
  /** Which window this chip reports. Defaults to the binding weekly cap; usage mode puts a second
   *  chip beside it for the rolling 5-hour window. The popover is the same either way — it already
   *  breaks out every window, so duplicating it per scope would be duplicating the answer. */
  scope?: UsageScope
}>()

defineEmits<{ check: [] }>()

const { t } = useI18n()
const { reasonFor } = useUsage()
// Shared clock, so the "resets in" lines here tick with the table's countdown columns rather than
// freezing at whatever the value was when this popover first rendered.
const { now } = useUsageMode(true)

const noData = computed(() => !props.snapshot || isNoDataSnap(props.snapshot))
// `now` is threaded through so a chip whose window resets while the table is open drops to "—" on
// the next tick, instead of asserting a superseded percentage until someone clicks refresh.
const label = computed(() => usageCellLabel(props.snapshot, props.scope, false, now.value))
// COLOUR IS SPENT ON THE WEEKLY CHIP ONLY.
//
// A usage-mode row carries four quota cells, and colouring all four leaves the row with no
// emphasis to give: the eye has to read each hue to find the one that matters. The 5-hour window
// is the one that gives its colour up, because it refills the same afternoon — a spent session
// says "not right now", a spent WEEK says "not at all", and only the second is worth an alarm.
// The session chip keeps its number and its popover; it just stops shouting. Same rule, same
// reason, as UsageBar's `neutral` variant on the Session column beside it.
const variant = computed(() => {
  if (props.scope === 'session') return 'outline'
  const pct = usagePctFor(props.snapshot, props.scope, now.value)
  return pct == null ? 'outline' : usageBadgeVariant(pct)
})
const stale = computed(() => isStaleSnap(props.snapshot))
const checkedAgo = computed(() =>
  props.snapshot ? usageCheckedAgo(props.snapshot.capturedAt) : '',
)
// Explains a "—" cell instead of showing it silently (see the usage-check `reason` DTO field).
const reasonMessage = computed(() => {
  const key = usageReasonMessageKey(props.usageKey ? reasonFor(props.usageKey) : undefined)
  return t(key ?? 'instances.usageNotChecked')
})

const sessionResets = computed(() => resetLabel(props.snapshot?.session, now.value))
const weekAllResets = computed(() => resetLabel(props.snapshot?.weekAll, now.value))

// Facts only the running Claude app serves (server/src/claude-app-usage.ts): banked resets, the
// Code & Cowork credit, usage credits and the weekly split. Claude Desktop rows only.
const app = computed(() => props.snapshot?.claudeApp ?? null)
const appResets = computed(() => {
  const count = props.snapshot?.resetCredits
  if (!app.value || count == null) return null
  if (count === 0) return '0'
  const expires = shortDate(props.snapshot?.resetCreditsExpiresAt)
  return t('instances.usageAppResetsValue', { count, expires })
})
const appCodeCredit = computed(() => {
  const credit = app.value?.codeCredit
  if (!credit) return null
  if (credit.state === 'unclaimed') return t('instances.usageAppCodeCreditUnclaimed')
  if (credit.state === 'locked') return t('instances.usageAppCodeCreditLocked')
  return t('instances.usageAppCodeCreditValue', {
    remaining: formatMoney(credit.remainingUsd),
    limit: formatMoney(credit.limitUsd),
    expires: shortDate(credit.expiresAt),
  })
})
const appUsageCredits = computed(() => {
  const credits = app.value?.usageCredits
  if (!credits) return null
  if (!credits.enabled) return t('instances.usageAppUsageCreditsOff')
  const used = formatMoney(credits.used, credits.currency)
  return credits.limit == null
    ? t('instances.usageAppUsageCreditsOnUncapped', { used })
    : t('instances.usageAppUsageCreditsOn', {
        used,
        limit: formatMoney(credits.limit, credits.currency),
      })
})
const appSplit = computed(
  () =>
    app.value?.weeklySplit
      ?.filter((row) => row.pct > 0)
      .map((row) => `${row.label} ${Math.round(row.pct)}%`)
      .join(' · ') || null,
)
const appCheckedAgo = computed(() => (app.value ? usageCheckedAgo(app.value.checkedAt) : ''))

// --- open on HOVER as well as on click ----------------------------------------------------------
// The breakdown (both reset times, the per-model sub-limit, how stale the reading is) is the whole
// reason the badge is interactive, and requiring a click to see it made the badge look like a plain
// label. Hover reveals it; click still works and PINS it open, so the "Check now" button inside is
// reachable without racing the pointer out of the trigger.
//
// The delays are what make this usable rather than twitchy: a short open delay so sweeping the
// pointer across a table column doesn't strobe popovers, and a longer close delay so travelling
// from the badge INTO the popover doesn't dismiss it mid-move.
const OPEN_DELAY_MS = 130
const CLOSE_DELAY_MS = 220

const open = ref(false)
/** Set by an explicit click; a pinned popover ignores mouseleave until dismissed. */
const pinned = ref(false)
let openTimer: number | null = null
let closeTimer: number | null = null

function clearTimers(): void {
  if (openTimer !== null) window.clearTimeout(openTimer)
  if (closeTimer !== null) window.clearTimeout(closeTimer)
  openTimer = null
  closeTimer = null
}
onUnmounted(clearTimers)

function onEnter(): void {
  clearTimers()
  if (open.value) return
  openTimer = window.setTimeout(() => {
    open.value = true
  }, OPEN_DELAY_MS)
}

function onLeave(): void {
  clearTimers()
  if (pinned.value) return
  closeTimer = window.setTimeout(() => {
    open.value = false
  }, CLOSE_DELAY_MS)
}

/** Root open changes come from the trigger's own click, Escape, and outside-click. A click is the
 *  only one that arrives with `v` true here (hover sets `open` directly), so pinning tracks it. */
function onRootOpenChange(v: boolean): void {
  clearTimers()
  open.value = v
  pinned.value = v
}
</script>

<template>
  <Popover :open="open" @update:open="onRootOpenChange">
    <PopoverTrigger as-child>
      <Badge
        :variant="variant"
        class="cursor-pointer"
        :class="stale ? 'opacity-60' : ''"
        :title="noData ? reasonMessage : undefined"
        @mouseenter="onEnter"
        @mouseleave="onLeave"
      >
        <Loader2 v-if="checking" class="animate-spin" />
        <span>{{ label }}</span>
      </Badge>
    </PopoverTrigger>
    <!-- trap-focus off + open-auto-focus prevented: this opens on HOVER now, and a popover that
         grabs the caret because the pointer drifted over a table cell would be hostile. The
         "Check now" action inside is duplicated in the row's kebab menu, which stays keyboard-
         reachable. -->
    <PopoverContent
      align="start"
      class="w-64 text-xs"
      :trap-focus="false"
      @open-auto-focus.prevent
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <div v-if="noData" class="text-muted-foreground">
        {{ reasonMessage }}
      </div>
      <div v-else class="space-y-1.5">
        <p v-if="snapshot?.sessionLimitUnavailable" class="text-muted-foreground">
          {{ $t('codexInstances.noSessionLimit') }}
        </p>
        <div v-if="snapshot?.session" class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground">{{ $t('instances.usageSession') }}</span>
          <span class="font-medium">{{ snapshot.session.pct }}% · {{ snapshot.session.resets }}</span>
        </div>
        <div v-if="snapshot?.weekAll" class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground">{{ $t('instances.usageWeekAll') }}</span>
          <span class="font-medium">{{ snapshot.weekAll.pct }}% · {{ snapshot.weekAll.resets }}</span>
        </div>
        <div v-if="snapshot?.weekModel" class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground">
            {{ $t('instances.usageWeekModel', { model: snapshot.weekModel.label }) }}
          </span>
          <span class="font-medium">{{ snapshot.weekModel.pct }}% · {{ snapshot.weekModel.resets }}</span>
        </div>
        <div v-for="limit in snapshot?.additionalLimits" :key="limit.label" class="border-t border-border/60 pt-1.5">
          <p class="font-medium">{{ limit.label }}</p>
          <div v-if="limit.session" class="flex justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageSession') }}</span>
            <span>{{ limit.session.pct }}% · {{ limit.session.resets }}</span>
          </div>
          <div v-if="limit.weekAll" class="flex justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageWeekAll') }}</span>
            <span>{{ limit.weekAll.pct }}% · {{ limit.weekAll.resets }}</span>
          </div>
        </div>
        <!-- Live countdowns, the thing the reset strings above can't tell you at a glance:
             "Aug 6, 4:59am" needs mental arithmetic, "in 9h 12m" does not. -->
        <div
          v-if="sessionResets"
          class="flex items-center justify-between gap-2 border-t border-border/60 pt-1.5"
        >
          <span class="text-muted-foreground">{{ $t('instances.usageSessionResetsIn') }}</span>
          <span class="font-medium">{{ sessionResets }}</span>
        </div>
        <div v-if="weekAllResets" class="flex items-center justify-between gap-2">
          <span class="text-muted-foreground">{{ $t('instances.usageWeekResetsIn') }}</span>
          <span class="font-medium">{{ weekAllResets }}</span>
        </div>
        <!-- A closed app keeps its last reading, so this section carries its own date. -->
        <div v-if="app" class="space-y-1.5 border-t border-border/60 pt-1.5">
          <div v-if="appResets" class="flex items-center justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageAppResets') }}</span>
            <span class="font-medium">{{ appResets }}</span>
          </div>
          <div v-if="appCodeCredit" class="flex items-center justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageAppCodeCredit') }}</span>
            <span class="text-end font-medium">{{ appCodeCredit }}</span>
          </div>
          <div v-if="appUsageCredits" class="flex items-center justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageAppUsageCredits') }}</span>
            <span class="font-medium">{{ appUsageCredits }}</span>
          </div>
          <div v-if="appSplit" class="flex items-center justify-between gap-2">
            <span class="text-muted-foreground">{{ $t('instances.usageAppWeeklySplit') }}</span>
            <span class="text-end font-medium">{{ appSplit }}</span>
          </div>
          <p class="text-muted-foreground">
            {{ $t('instances.usageAppCheckedAgo', { when: appCheckedAgo }) }}
          </p>
        </div>
        <p class="text-muted-foreground">
          {{ $t('instances.usageCheckedAgo', { when: checkedAgo }) }}
        </p>
      </div>
      <Button
        size="xs"
        variant="ghost"
        class="mt-2 w-full"
        :disabled="checking"
        @click="$emit('check')"
      >
        <RefreshCw :class="checking ? 'animate-spin' : ''" />
        {{ checking ? $t('instances.usageChecking') : $t('instances.usageCheckNow') }}
      </Button>
    </PopoverContent>
  </Popover>
</template>
