<script setup lang="ts">
// The micro summary above the one Instances table. It keeps only what answers "can work start now, and
// who is about to stop?". Collapsed (the default, remembered): one line with the accounts usable now and
// the pooled 5-hour and week gauges over every Claude account. Expanded: that line per kind (Desktop,
// CLI, Free), then the accounts nearest their limit, the top few and the rest behind "+N more".
// Every number comes from a composable the table already reads; nothing is fetched here.
import { ChevronRight, Monitor, Terminal, MessagesSquare } from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PooledUsageGauges from '@/components/PooledUsageGauges.vue'
import { useCliInstances } from '@/composables/useCliInstances'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { useInstances } from '@/composables/useInstances'
import { pii } from '@/composables/usePrivacy'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import { freeUsageSnapshot } from '@/lib/free-instances'
import { type HeadroomRow, sortHeadroom, usableNow } from '@/lib/instance-headroom'
import { usageBadgeVariant, windowUsedPct } from '@/lib/usage'
import { pooledRemaining } from '@/lib/usage-pool'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
/** How many rows the nearest-their-limit list shows before "+N more". */
const TOP = 5

const open = useStorage('agenthydra.instances.summaryOpen', false)

const { instances: desktopInstances } = useInstances()
const { cliInstances } = useCliInstances()
const { instances: freeInstances } = useFreeInstances()
const { snapshotFor } = useUsage()
const { now } = useUsageMode(true)

interface PoolInput {
  signedIn: boolean
  planLabel?: string | null
  usage: ReturnType<typeof snapshotFor>
}

/** One line's figures: usable now (usableNow), the breakdown, the two pooled windows. */
function accountLine(rows: PoolInput[]) {
  const { signedIn, spent, usable } = usableNow(
    rows.map((r) => ({ signedIn: r.signedIn, session: r.usage?.session, week: r.usage?.weekAll })),
    now.value.getTime(),
  )
  const pool = (w: 'session' | 'weekAll') =>
    pooledRemaining(
      rows.map((r) => ({ signedIn: r.signedIn, planLabel: r.planLabel, limit: r.usage?.[w] })),
      now.value,
    )
  return {
    total: rows.length,
    usable,
    detail: t('instances.home.usableDetail', { signedIn, spent, signedOut: rows.length - signedIn }),
    session: pool('session'),
    week: pool('weekAll'),
  }
}

const desktopByDir = computed(() => new Map(desktopInstances.value.map((d) => [d.dir, d])))
const desktopRows = computed<PoolInput[]>(() =>
  desktopInstances.value.map((i) => ({
    signedIn: !!i.account,
    planLabel: i.account?.planLabel,
    usage: snapshotFor(`desktop:${i.dir}`),
  })),
)
// A CLI login's plan falls back to its linked desktop row's, so the two read the same pool.
const cliRows = computed<PoolInput[]>(() =>
  cliInstances.value.map((i) => ({
    signedIn: i.loggedIn,
    planLabel:
      i.planLabel ??
      (i.associatedDesktopDir
        ? desktopByDir.value.get(i.associatedDesktopDir)?.account?.planLabel
        : null),
    usage: snapshotFor(`cli:${i.id}`),
  })),
)
const freeRows = computed<PoolInput[]>(() =>
  freeInstances.value.map((i) => ({ signedIn: i.loggedIn, usage: freeUsageSnapshot(i.usage) })),
)

/** The collapsed line: every Claude account, desktop and CLI, pooled together. */
const allLine = computed(() => accountLine([...desktopRows.value, ...cliRows.value]))

const kindLines = computed(() =>
  [
    {
      key: 'desktop' as const,
      icon: Monitor,
      title: t('instances.home.desktopTitle'),
      text: t('instances.home.desktopUsable', { total: desktopRows.value.length }),
      line: accountLine(desktopRows.value),
    },
    {
      key: 'cli' as const,
      icon: Terminal,
      title: t('instances.home.cliTitle'),
      text: t('instances.home.cliUsable', { total: cliRows.value.length }),
      line: accountLine(cliRows.value),
    },
    {
      key: 'free' as const,
      icon: MessagesSquare,
      title: t('instances.summary.freeTitle'),
      text: t('instances.summary.freeUsable', { total: freeRows.value.length }),
      line: accountLine(freeRows.value),
    },
  ].filter((k) => k.line.total > 0),
)

// --- nearest their limit ---

const headroom = computed(() => {
  const at = now.value.getTime()
  const row = (key: string, label: string, snap: ReturnType<typeof snapshotFor>): HeadroomRow => ({
    key,
    label,
    session: windowUsedPct(snap?.session, at),
    week: windowUsedPct(snap?.weekAll, at),
  })
  // An instance is usually named by its account's address: masked in privacy mode.
  return sortHeadroom([
    ...cliInstances.value
      .filter((i) => i.loggedIn)
      .map((i) => row(`cli:${i.id}`, `#${i.num} ${pii(i.name)}`, snapshotFor(`cli:${i.id}`))),
    ...desktopInstances.value
      .filter((i) => i.account)
      .map((i) => row(`desktop:${i.dir}`, `#${i.num} ${pii(i.name)}`, snapshotFor(`desktop:${i.dir}`))),
    ...freeInstances.value
      .filter((i) => i.loggedIn)
      .map((i) => row(`free:${i.id}`, `#${i.num} ${pii(i.name)}`, freeUsageSnapshot(i.usage))),
  ])
})
const limitsOpen = ref(false)
const limitRows = computed(() => (limitsOpen.value ? headroom.value : headroom.value.slice(0, TOP)))
const limitMore = computed(() => Math.max(0, headroom.value.length - TOP))
const iconOf = (key: string) =>
  key.startsWith('cli:') ? Terminal : key.startsWith('free:') ? MessagesSquare : Monitor
/** The same rule as the pooled week gauge (usageBadgeVariant on the used share: amber from 70%, red
 *  over 90%), so a row and a gauge never disagree about what is a warning. Grey below it. */
const toneOf = (pct: number | null) => {
  const tone = pct === null ? 'success' : usageBadgeVariant(pct)
  return tone === 'success' ? null : tone
}
const BAR_TONE = { warning: 'bg-warning', destructive: 'bg-destructive' } as const
const TEXT_TONE = { warning: 'text-warning', destructive: 'text-destructive' } as const
const worstOf = (r: HeadroomRow) => Math.max(r.session ?? 0, r.week ?? 0)
const pctText = (pct: number | null) => (pct === null ? '–' : `${Math.round(pct)}%`)
</script>

<template>
  <section class="m-4 rounded-lg border bg-card">
    <div class="flex items-center gap-2 px-3 py-1.5">
      <button
        type="button"
        class="flex min-w-0 items-center gap-1.5 rounded-sm text-start focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        :aria-expanded="open"
        :aria-label="open ? $t('instances.summary.collapse') : $t('instances.summary.expand')"
        @click="open = !open"
      >
        <ChevronRight
          class="size-4 shrink-0 text-muted-foreground transition-transform"
          :class="{ 'rotate-90': open }"
        />
        <span class="text-xs font-semibold whitespace-nowrap">{{ $t('instances.home.accounts') }}</span>
        <template v-if="allLine.total > 0">
          <span
            class="text-xl leading-none font-semibold tabular-nums"
            :class="{ 'text-warning': allLine.usable === 0 }"
          >{{ allLine.usable }}</span>
          <span class="truncate text-xs text-muted-foreground">{{
            $t('instances.summary.usableOf', { total: allLine.total })
          }}</span>
        </template>
        <span v-else class="truncate text-xs text-muted-foreground">{{ $t('instances.home.noAccounts') }}</span>
      </button>
      <PooledUsageGauges class="ml-auto shrink-0" gray :session="allLine.session" :week="allLine.week" />
    </div>

    <div v-if="open" class="space-y-2 border-t px-3 py-2">
      <ul v-if="kindLines.length" class="space-y-1.5">
        <li v-for="k in kindLines" :key="k.key" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <IconTooltip :label="k.title" :description="k.line.detail">
            <span class="flex min-w-0 items-baseline gap-1.5">
              <component :is="k.icon" class="size-3.5 shrink-0 self-center text-muted-foreground" />
              <span
                class="text-base leading-none font-semibold tabular-nums"
                :class="{ 'text-warning': k.line.usable === 0 }"
              >{{ k.line.usable }}</span>
              <span class="truncate text-xs text-muted-foreground">{{ k.text }}</span>
            </span>
          </IconTooltip>
          <PooledUsageGauges class="ml-auto" gray :session="k.line.session" :week="k.line.week" />
        </li>
      </ul>

      <div :class="{ 'border-t pt-1.5': kindLines.length }">
        <div
          class="grid grid-cols-[minmax(0,10rem)_minmax(2rem,1fr)_3.5rem_3.5rem] items-center gap-x-2 px-1 pb-0.5"
        >
          <h3 class="col-span-2 flex items-center gap-1.5 text-xs font-semibold">
            {{ $t('instances.home.nearest') }}
            <InfoHint :text="$t('instances.home.nearestHint')" />
          </h3>
          <span class="text-end text-3xs whitespace-nowrap text-muted-foreground">{{ $t('instances.home.chart5h') }}</span>
          <span class="text-end text-3xs whitespace-nowrap text-muted-foreground">{{ $t('instances.home.chartWeek') }}</span>
        </div>
        <ul v-if="headroom.length">
          <li
            v-for="r in limitRows"
            :key="r.key"
            class="grid grid-cols-[minmax(0,10rem)_minmax(2rem,1fr)_3.5rem_3.5rem] items-center gap-x-2 px-1 py-px text-2xs"
            :aria-label="
              $t('instances.summary.limitRow', {
                name: r.label,
                session: pctText(r.session),
                week: pctText(r.week),
              })
            "
          >
            <span class="flex min-w-0 items-center gap-1">
              <component :is="iconOf(r.key)" class="size-3 shrink-0 text-muted-foreground" />
              <span class="truncate">{{ r.label }}</span>
            </span>
            <span class="h-1 overflow-hidden rounded-full bg-muted-foreground/10 dark:bg-muted-foreground/15">
              <span
                class="block h-full rounded-full"
                :class="toneOf(worstOf(r)) ? BAR_TONE[toneOf(worstOf(r))!] : 'bg-muted-foreground/35'"
                :style="{ width: `${worstOf(r)}%` }"
              ></span>
            </span>
            <span
              class="text-end tabular-nums"
              :class="toneOf(r.session) ? ['font-semibold', TEXT_TONE[toneOf(r.session)!]] : 'text-muted-foreground'"
            >{{ pctText(r.session) }}</span>
            <span
              class="text-end tabular-nums"
              :class="toneOf(r.week) ? ['font-semibold', TEXT_TONE[toneOf(r.week)!]] : 'text-muted-foreground'"
            >{{ pctText(r.week) }}</span>
          </li>
        </ul>
        <p v-else class="py-2 text-center text-2xs text-muted-foreground">{{ $t('instances.home.chartHeadroomEmpty') }}</p>
        <button
          v-if="limitMore > 0"
          type="button"
          class="mt-0.5 rounded-sm px-1 text-2xs text-muted-foreground hover:text-foreground hover:underline"
          :aria-expanded="limitsOpen"
          @click="limitsOpen = !limitsOpen"
        >
          {{ limitsOpen ? $t('instances.home.fewer') : $t('instances.home.more', { n: limitMore }) }}
        </button>
      </div>
    </div>
  </section>
</template>
