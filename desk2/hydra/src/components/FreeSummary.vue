<script setup lang="ts">
// The Free accounts' part of the Usage history card (owner, 2026-10-08: "total tokens ... Claude and ChatGPT ... per
// each ... also the success rate across which models ... were used on each"): the token totals in the table's window,
// each account with the models it was sent to, the success rate by model, and Free tokens per day.
import type { FreeProvider } from '@desk/shared/free-instances'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import HourBars from '@/components/charts/HourBars.vue'
import ProviderLogo from '@/components/ProviderLogo.vue'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { FREE_STAT_DAYS, useFreeStats } from '@/composables/useFreeStats'
import { useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { seriesColor } from '@/lib/chart'
import { freeLogo } from '@/lib/free-instances'
import { answeredShare, type FreeTally, summarizeFree } from '@/lib/free-stats'
import { formatTokens } from '@/lib/kit'
import { dayLabel } from '@/lib/usage-history'

const { t } = useI18n()
const { instances, tokens } = useFreeInstances()
const { rows, failed } = useFreeStats()
const tokenWindow = useDesktopTokenWindow()

const summary = computed(() => summarizeFree(rows.value ?? [], instances.value, tokens.value, tokenWindow.value, FREE_STAT_DAYS, Date.now()))
const windowLabel = computed(() => ({ '5h': t('freeInstances.stats.window5h'), week: t('freeInstances.stats.windowWeek'), total: t('freeInstances.stats.windowTotal') })[tokenWindow.value])
const providerLabel = (p: FreeProvider) => (p === 'claude' ? 'Claude' : 'ChatGPT')
const pct = (x: Pick<FreeTally, 'sent' | 'failed'>) => {
  const share = answeredShare(x)
  return share === null ? '–' : `${Math.round(share * 100)}%`
}
/** A rate under nine in ten reads as a warning, as the row's own mark does at the far end (health.ts). */
const rateClass = (x: Pick<FreeTally, 'sent' | 'failed'>) => {
  const share = answeredShare(x)
  return share === null ? 'text-muted-foreground' : share < 0.5 ? 'text-destructive' : share < 0.9 ? 'text-warning' : ''
}
const tiles = computed(() => (['all', 'claude', 'chatgpt'] as const).map(key => ({
  key, label: key === 'all' ? t('freeInstances.stats.allFree') : providerLabel(key), ...summary.value.totals[key],
})))
const SERIES = ['claude', 'chatgpt'] as const
const series = SERIES.map(s => ({ key: s, label: providerLabel(s), color: seriesColor(s, SERIES) }))
const dayBars = computed(() => summary.value.days.map(d => ({ label: dayLabel(d.key), values: [d.claude, d.chatgpt] })))
const daysEmpty = computed(() => summary.value.days.every(d => d.claude + d.chatgpt === 0))
const messagesTip = (x: FreeTally) => t('freeInstances.stats.messagesTip', { sent: x.sent, failed: x.failed, days: FREE_STAT_DAYS })
</script>

<template>
  <div class="space-y-3">
    <h3 class="text-xs font-semibold">{{ $t('freeInstances.stats.title') }}</h3>
    <div class="grid grid-cols-3 gap-2">
      <div v-for="tile in tiles" :key="tile.key" class="rounded-md border px-2.5 py-2">
        <p class="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <ProviderLogo v-if="tile.key !== 'all'" :provider="freeLogo(tile.key)" class="size-3" />
          {{ tile.label }}
        </p>
        <p class="text-base font-semibold tabular-nums">
          {{ formatTokens(tile.tokens) }}
          <span class="text-2xs font-normal text-muted-foreground">{{ $t('freeInstances.stats.tokensIn', { window: windowLabel }) }}</span>
        </p>
        <p class="text-2xs tabular-nums text-muted-foreground" :title="messagesTip(tile)">
          <span :class="rateClass(tile)">{{ pct(tile) }}</span>
          {{ $t('freeInstances.stats.answeredOf', { sent: tile.sent, days: FREE_STAT_DAYS }) }}
        </p>
      </div>
    </div>

    <p v-if="failed" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('freeInstances.stats.unavailable') }}</p>
    <template v-else>
      <div>
        <h4 class="mb-1 text-2xs font-semibold text-muted-foreground">{{ $t('freeInstances.stats.perAccount') }}</h4>
        <ul class="divide-y rounded-md border text-xs">
          <li v-for="a in summary.accounts" :key="a.instance.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5">
            <span class="flex min-w-40 items-center gap-1.5">
              <ProviderLogo :provider="freeLogo(a.instance.provider)" class="size-3.5 shrink-0" />
              <span class="text-muted-foreground tabular-nums">#{{ a.instance.num }}</span>
              <span class="truncate">{{ a.instance.name }}</span>
            </span>
            <span class="w-24 tabular-nums">{{ formatTokens(a.tokens) }} <span class="text-2xs text-muted-foreground">{{ $t('freeInstances.stats.tokens') }}</span></span>
            <span class="w-28 tabular-nums" :title="messagesTip(a)">
              <span :class="rateClass(a)">{{ pct(a) }}</span>
              <span class="text-2xs text-muted-foreground"> {{ $t('freeInstances.stats.ofSent', { sent: a.sent }) }}</span>
            </span>
            <span class="flex flex-wrap gap-1">
              <span
                v-for="m in a.models"
                :key="m.model"
                class="rounded-sm bg-muted px-1.5 py-0.5 text-2xs tabular-nums"
                :title="$t('freeInstances.stats.modelTip', { model: m.model, sent: m.sent, failed: m.failed, tokens: formatTokens(m.tokens), days: FREE_STAT_DAYS })"
              >
                {{ m.model }} <span :class="rateClass(m)">{{ pct(m) }}</span>
              </span>
              <span v-if="!a.models.length" class="text-2xs text-muted-foreground">{{ $t('freeInstances.stats.noMessages', { days: FREE_STAT_DAYS }) }}</span>
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h4 class="mb-1 text-2xs font-semibold text-muted-foreground">{{ $t('freeInstances.stats.byModel', { days: FREE_STAT_DAYS }) }}</h4>
        <p v-if="!summary.models.length" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('freeInstances.stats.noModels') }}</p>
        <ul v-else class="divide-y rounded-md border text-xs">
          <li v-for="m in summary.models" :key="`${m.provider}/${m.model}`" class="flex items-center gap-3 px-2.5 py-1.5">
            <span class="flex min-w-40 items-center gap-1.5">
              <ProviderLogo :provider="freeLogo(m.provider)" class="size-3.5 shrink-0" />
              <span class="truncate">{{ m.model }}</span>
            </span>
            <span class="w-28 tabular-nums" :title="messagesTip(m)">
              <span :class="rateClass(m)">{{ pct(m) }}</span>
              <span class="text-2xs text-muted-foreground"> {{ $t('freeInstances.stats.ofSent', { sent: m.sent }) }}</span>
            </span>
            <span class="tabular-nums">{{ formatTokens(m.tokens) }} <span class="text-2xs text-muted-foreground">{{ $t('freeInstances.stats.tokens') }}</span></span>
          </li>
        </ul>
      </div>

      <div>
        <h4 class="mb-1 text-2xs font-semibold text-muted-foreground">{{ $t('freeInstances.stats.perDay', { days: FREE_STAT_DAYS }) }}</h4>
        <p v-if="daysEmpty" class="py-2 text-center text-2xs text-muted-foreground">{{ $t('freeInstances.stats.noTokens') }}</p>
        <template v-else>
          <HourBars :hours="dayBars" :series="series" :format-value="formatTokens" height-class="h-20" />
          <div class="mt-1 flex justify-between text-3xs text-muted-foreground">
            <span>{{ dayBars[0]?.label }}</span>
            <span class="flex gap-3">
              <span v-for="s in series" :key="s.key" class="flex items-center gap-1">
                <span class="inline-block size-2 rounded-sm bg-(--dot-c)" :style="{ '--dot-c': s.color }"></span>{{ s.label }}
              </span>
            </span>
            <span>{{ dayBars[dayBars.length - 1]?.label }}</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
