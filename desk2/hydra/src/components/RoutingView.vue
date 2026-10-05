<script setup lang="ts">
// The Routing page of the HSwarm tab: where a task runs, on an API key (HSwarm) or on a Claude
// subscription (CliMayte). The preference split, the close band, the on/off switch and the bulk-rate
// discounts are saved on change (lib/routing-cost.ts, debounced); the plan and model tables are the
// daemon's cost model. Its data is the warm kind 'routing' (lib/warm-data.ts).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useDeskSidebar } from '@/lib/desk-embed'
import { formatUsd } from '@/lib/kit'
import {
  DISCOUNT_KEYS,
  type DiscountKey,
  type RoutingModelRow,
  saveRouting,
  useRoutingCost,
} from '@/lib/routing-cost'

const { t } = useI18n()
const { model, settings, error, loading, saving, saveError } = useRoutingCost()

// Desk draws the sidebar: this page has no rows of its own, only its entry in the tab's list.
useDeskSidebar(
  'routing',
  () => ({
    view: 'routing',
    title: t('routingCost.title'),
    icon: 'route',
    info: t('routingCost.subtitle'),
    sections: [],
  }),
  () => {},
)

const apiPct = computed(() => Math.round(settings.value?.apiPreferencePct ?? 0))

function num(e: Event): number {
  return Number((e.target as HTMLInputElement).value)
}
function onSplit(e: Event) {
  saveRouting({ apiPreferencePct: num(e) })
}
function onRatio(e: Event) {
  const n = num(e)
  if (Number.isFinite(n) && n >= 1) saveRouting({ closeRatio: n })
}
function onDiscount(key: DiscountKey, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const n = Number(raw)
  if (raw !== '' && Number.isFinite(n)) saveRouting({ discounts: { [key]: Math.min(100, Math.max(0, n)) } })
}

const pct = (f: number) => `${(f * 100).toFixed(1)}%`
const pair = (a: number, b: number) => `${formatUsd(a)} / ${formatUsd(b)}`

/** The three prices of a row (in and out summed to rank them) and which are cheapest. */
function cells(m: RoutingModelRow) {
  const list = [
    { key: 'list', text: pair(m.listIn, m.listOut), cost: m.listIn + m.listOut },
    { key: 'yours', text: pair(m.afterDiscountIn, m.afterDiscountOut), cost: m.afterDiscountIn + m.afterDiscountOut },
    { key: 'sub', text: pair(m.subscriptionIn, m.subscriptionOut), cost: m.subscriptionIn + m.subscriptionOut },
  ]
  const min = Math.min(...list.map((c) => c.cost))
  return list.map((c) => ({ ...c, best: c.cost === min }))
}
const modelRows = computed(() => (model.value?.models ?? []).map((m) => ({ m, cells: cells(m) })))
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto">
    <div class="mx-auto flex max-w-4xl flex-col gap-3 p-4">
      <header class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">{{ $t('routingCost.title') }}</h2>
          <p class="text-xs text-muted-foreground">{{ $t('routingCost.subtitle') }}</p>
        </div>
        <span v-if="saving" class="text-xs text-muted-foreground">{{ $t('routingCost.saving') }}</span>
      </header>

      <p v-if="error && !model" class="text-xs text-destructive">{{ $t('routingCost.loadFailed') }}: {{ error }}</p>
      <p v-if="saveError" class="text-xs text-destructive">{{ $t('routingCost.saveFailed', { reason: saveError }) }}</p>
      <p v-if="loading && !model" class="text-xs text-muted-foreground">…</p>

      <template v-if="settings">
        <div class="rounded-lg border bg-card px-3 py-2">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs font-semibold">{{ $t('routingCost.enabled') }}</div>
              <div class="text-[11px] text-muted-foreground">{{ $t('routingCost.enabledNote') }}</div>
            </div>
            <Switch
              :model-value="settings.enabled"
              :aria-label="$t('routingCost.enabled')"
              @update:model-value="(v: boolean) => saveRouting({ enabled: v })"
            />
          </div>
        </div>

        <div class="rounded-lg border bg-card px-3 py-2">
          <div class="mb-1 text-xs font-semibold">{{ $t('routingCost.splitTitle') }}</div>
          <div class="flex items-center gap-3 text-xs">
            <span class="w-24 shrink-0 text-muted-foreground">{{ $t('routingCost.splitApi') }}</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              class="min-w-0 flex-1 accent-primary"
              :value="apiPct"
              :aria-label="$t('routingCost.splitAria')"
              @input="onSplit"
            />
            <span class="w-24 shrink-0 text-end text-muted-foreground">{{ $t('routingCost.splitSubscription') }}</span>
          </div>
          <div class="mt-1 text-center text-base font-semibold tabular-nums">{{ apiPct }} / {{ 100 - apiPct }}</div>
          <p class="mt-1 text-[11px] text-muted-foreground">
            {{ $t('routingCost.splitNote', { ratio: settings.closeRatio }) }}
          </p>
          <div class="mt-2 flex items-center gap-2 border-t border-border/50 pt-2 text-xs">
            <label class="font-semibold" for="routing-close-ratio">{{ $t('routingCost.closeRatio') }}</label>
            <Input
              id="routing-close-ratio"
              type="number"
              min="1"
              step="0.5"
              class="h-7 w-20 text-xs tabular-nums"
              :model-value="settings.closeRatio"
              @change="onRatio"
            />
            <span class="text-[11px] text-muted-foreground">{{ $t('routingCost.closeRatioNote') }}</span>
          </div>
        </div>

        <div class="rounded-lg border bg-card px-3 py-2">
          <div class="text-xs font-semibold">{{ $t('routingCost.discountsTitle') }}</div>
          <p class="mb-2 text-[11px] text-muted-foreground">{{ $t('routingCost.discountsNote') }}</p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            <label v-for="k in DISCOUNT_KEYS" :key="k" class="flex items-center gap-2 text-xs">
              <span class="w-24 shrink-0">{{ $t(`routingCost.discount${k[0].toUpperCase()}${k.slice(1)}`) }}</span>
              <Input
                type="number"
                min="0"
                max="100"
                step="1"
                class="h-7 w-16 text-xs tabular-nums"
                :model-value="settings.discounts[k]"
                @change="onDiscount(k, $event)"
              />
              <span class="text-muted-foreground">%</span>
            </label>
          </div>
        </div>
      </template>

      <div v-if="model" class="rounded-lg border bg-card px-3 py-1.5">
        <div class="mb-1 text-xs font-semibold">{{ $t('routingCost.plansTitle') }}</div>
        <table class="w-full text-xs tabular-nums">
          <thead class="text-start text-[11px] text-muted-foreground">
            <tr>
              <th class="py-0.5 text-start font-normal">{{ $t('routingCost.colPlan') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colPrice') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colWindows') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colWork') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colEffective') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in model.plans" :key="p.plan" class="border-t border-border/50">
              <td class="py-0.5">{{ p.plan }}</td>
              <td class="py-0.5 text-end">{{ formatUsd(p.price) }}</td>
              <td class="py-0.5 text-end">
                {{ p.windowsPerWeek.toFixed(1) }}
                <span class="text-muted-foreground">
                  ({{ p.windowsFellBack ? $t('routingCost.fellBack') : $t('routingCost.measured', { n: p.windowsMeasuredFrom }) }})
                </span>
              </td>
              <td class="py-0.5 text-end">{{ formatUsd(p.dollarsPerProWindow * p.sizeInProWindows) }}</td>
              <td class="py-0.5 text-end">{{ pct(p.effectiveFraction) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="model" class="rounded-lg border bg-card px-3 py-1.5">
        <div class="mb-1 text-xs font-semibold">{{ $t('routingCost.modelsTitle') }}</div>
        <table class="w-full text-xs tabular-nums">
          <thead class="text-start text-[11px] text-muted-foreground">
            <tr>
              <th class="py-0.5 text-start font-normal">{{ $t('routingCost.colModel') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colList') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colYours') }}</th>
              <th class="py-0.5 text-end font-normal">{{ $t('routingCost.colSubscription') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in modelRows" :key="r.m.model" class="border-t border-border/50">
              <td class="max-w-0 truncate py-0.5" :title="r.m.model">{{ r.m.model }}</td>
              <td
                v-for="c in r.cells"
                :key="c.key"
                class="py-0.5 text-end"
                :class="c.best ? 'font-semibold text-primary' : ''"
                :title="c.best ? $t('routingCost.cheapest') : undefined"
              >{{ c.text }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="model.pricesAsOf" class="mt-1 text-[11px] text-muted-foreground">
          {{ $t('routingCost.asOf', { date: model.pricesAsOf }) }}
        </p>
      </div>
    </div>
  </div>
</template>
