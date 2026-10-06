<script setup lang="ts">
// HSwarm's Savings page: ZSwarm's "running total" report inside the console layout. Everything comes from
// GET /api/hswarm/api/stats?days=N (hswarm/stats.py). Dense on purpose: one line per row, small tiles,
// every table column sortable and sized to its content, explanations behind info bubbles.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { accountDisplay, type HswarmAccountName, useHswarmApi } from '@/lib/hswarm-api'
import { fetchKitUsage, formatTokens, formatUsd } from '@/lib/kit'
import InfoHint from '@/shell/InfoHint.vue'

type Row = Record<string, any>
interface Stats {
  source?: string
  empty?: boolean
  total: Row
  plan: Row
  by_machine: Row[]
  days: Row[]
  claude_by_family: Row[]
  accounts: { rows: Row[]; worked?: number; open?: number }
  rule_check: Row
  recent: Row[]
  today: Row
}
interface Col {
  key: string
  label: string
  num?: boolean
  fmt?: (v: any, r: Row) => string
  muted?: (v: any) => boolean
  title?: (v: any) => string | undefined
  get?: (r: Row) => any
}
interface Table {
  id: string
  title: string
  hint?: string
  cols: Col[]
  rows: Row[]
  folded?: number
}

const { t } = useI18n()
const { fetchStats, fetchAccountNames } = useHswarmApi()

const WINDOWS = [7, 14, 30]
const days = ref(14)
const mode = ref<'list' | 'plan'>('list')
const stats = ref<Stats | null>(null)
const names = ref<Record<string, HswarmAccountName>>({})
const error = ref<string | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    stats.value = await fetchStats(days.value)
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// The Claude side of the per-machine table is the usage kit's, per PC: its Claude Code calls (cli and
// desktop) over all time, the same span as HSwarm's own per-machine totals. Not the Python scanner's.
const kitClaude = ref<Row[]>([])
async function loadKitClaude() {
  try {
    const r = await fetchKitUsage({
      source: ['cli', 'desktop'],
      last: 'all',
      groupBy: 'pc',
      measures: ['tokens', 'cost_usd'],
    })
    kitClaude.value = r.rows
  } catch {
    kitClaude.value = []
  }
}

/** HSwarm's own per-machine rows with the kit's Claude tokens and $ beside them, matched on the machine
 *  name; a PC the kit knows and HSwarm does not still gets its row. */
const machineRows = computed<Row[]>(() => {
  const f = F.value
  const kit = new Map(kitClaude.value.map((r) => [String(r.pc ?? ''), r]))
  const seen = new Set<string>()
  const withClaude = (m: Row, k: Row | undefined): Row => {
    const usd = k ? Number(k.cost_usd ?? 0) : null
    const claude = usd === null ? null : plan.value ? (m.rate == null ? null : usd * m.rate) : usd
    const est = m[f.est]
    return {
      ...m,
      claude_tokens: k ? Number(k.tokens ?? 0) : null,
      claude_cost: claude,
      share: est == null || claude === null || est + claude <= 0 ? null : est / (est + claude),
    }
  }
  const rows = (stats.value?.by_machine ?? []).map((m) => {
    const name = String(m.machine ?? '')
    seen.add(name)
    return withClaude(m, kit.get(name))
  })
  for (const [pc, k] of kit) {
    if (!seen.has(pc)) rows.push(withClaude({ machine: pc || null }, k))
  }
  return rows
})

onMounted(() => {
  load()
  loadKitClaude()
  fetchAccountNames().then((n) => {
    names.value = n
  })
})
watch(days, load)

const plan = computed(() => mode.value === 'plan')
const isEmpty = computed(() => !stats.value || stats.value.empty || !stats.value.total?.n)

// Money fields differ by mode: the plan ones are the same measure priced at the plan's $/token rate.
const F = computed(() =>
  plan.value
    ? {
        est: 'plan_est_usd',
        worker: 'plan_cost_usd',
        saved: 'plan_saved_usd',
        claude: 'plan_claude_usd',
      }
    : { est: 'est_usd', worker: 'worker_usd', saved: 'saved_usd', claude: 'claude_usd' },
)
const totals = computed(() => (plan.value ? (stats.value?.plan ?? {}) : (stats.value?.total ?? {})))

const usd = (n: number | null | undefined) => formatUsd(n, { style: 'whole' })
const axisUsd = (n: number) => formatUsd(n, { style: 'axis' })
const compact = (n: number | null | undefined) => formatTokens(Number(n) || 0)
const int = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US')
const pct = (n: number | null | undefined) => `${Math.round((Number(n) || 0) * 100)}%`
const dayOf = (iso: string | undefined) => (iso ? iso.slice(0, 10) : '—')

const hero = computed(() => {
  const s = stats.value?.total ?? {}
  return {
    saved: usd(totals.value[F.value.saved]),
    tokens: compact(s.est_tokens),
    share: pct(s.share),
    runs: int(s.n),
    tasks: int(s.tasks),
    since: dayOf(s.first),
  }
})

const tiles = computed(() => {
  const tot = totals.value
  const est = Number(tot[F.value.est]) || 0
  const worker = Number(tot[F.value.worker]) || 0
  const low = plan.value ? tot.saved_low_usd : tot.saved_low_usd
  const td = stats.value?.today ?? {}
  return [
    { k: 'estClaude', label: t('hswarm.v.savings.tile.estClaude'), v: usd(est) },
    { k: 'workerCost', label: t('hswarm.v.savings.tile.workerCost'), v: usd(worker) },
    {
      k: 'cheaperBy',
      label: t('hswarm.v.savings.tile.cheaperBy'),
      v: worker > 0 ? `${(est / worker).toFixed(est / worker >= 100 ? 0 : 1)}×` : '—',
    },
    { k: 'savedFloor', label: t('hswarm.v.savings.tile.savedFloor'), v: usd(low), hint: true },
    {
      k: 'todayRuns',
      label: t('hswarm.v.savings.tile.todayRuns'),
      v: int(td.runs),
      sub: `${int(td.tasks)} ${t('hswarm.v.savings.tasks')}`,
    },
    { k: 'todaySaved', label: t('hswarm.v.savings.tile.todaySaved'), v: usd(td.saved_usd) },
  ]
})

// ---- charts: signed stacked bars per day, drawn as plain SVG rects (no text inside, so nothing stretches) ----
interface Series {
  key: string
  label: string
  color: string
  vals: number[]
}
interface Chart {
  id: string
  title: string
  hint?: string
  labels: string[]
  series: Series[]
  signed?: boolean
}
const FAM_COLORS = [
  'var(--viz-1)',
  'var(--viz-3)',
  'var(--viz-5)',
  'var(--viz-2)',
  'var(--viz-4)',
  'var(--viz-6)',
]

const charts = computed<Chart[]>(() => {
  const ds = stats.value?.days ?? []
  const labels = ds.map((d) => d.day)
  const num = (r: Row, k: string) => Number(r[k]) || 0
  const fam = stats.value?.claude_by_family ?? []
  const famNames = [...new Set(fam.flatMap((r) => Object.keys(r.families ?? {})))].sort()
  return [
    {
      id: 'work',
      title: t('hswarm.v.savings.chartWork'),
      hint: t('hswarm.v.savings.chartWorkHint'),
      labels,
      series: [
        {
          key: 'swarm',
          label: t('hswarm.v.savings.swarmEst'),
          color: 'var(--viz-2)',
          vals: ds.map((d) => num(d, F.value.est)),
        },
        {
          key: 'claude',
          label: t('hswarm.v.savings.claudeItself'),
          color: 'var(--viz-3)',
          vals: ds.map((d) => num(d, F.value.claude)),
        },
      ],
    },
    {
      id: 'saved',
      title: t('hswarm.v.savings.chartSaved'),
      hint: t('hswarm.v.savings.chartSavedHint'),
      labels,
      signed: true,
      series: [
        {
          key: 'saved',
          label: t('hswarm.v.savings.saved'),
          color: 'var(--success)',
          vals: ds.map((d) => num(d, F.value.saved)),
        },
      ],
    },
    {
      id: 'family',
      title: t('hswarm.v.savings.chartFamily'),
      hint: t('hswarm.v.savings.chartFamilyHint'),
      labels: fam.map((r) => r.day),
      series: famNames.map((n, i) => ({
        key: n,
        label: n,
        color: FAM_COLORS[i % FAM_COLORS.length],
        vals: fam.map((r) => Number(r.families?.[n]?.[plan.value ? 'plan' : 'usd']) || 0),
      })),
    },
  ]
})

const BAR = 10
function geometry(c: Chart) {
  const n = Math.max(1, c.labels.length)
  const pos = c.labels.map((_, i) => c.series.reduce((a, s) => a + Math.max(0, s.vals[i] ?? 0), 0))
  const neg = c.labels.map((_, i) => c.series.reduce((a, s) => a + Math.min(0, s.vals[i] ?? 0), 0))
  const top = Math.max(0, ...pos)
  const bottom = Math.min(0, ...neg)
  const span = top - bottom || 1
  const H = 100
  const y = (v: number) => ((top - v) / span) * H
  const rects: { x: number; y: number; w: number; h: number; fill: string; tip: string }[] = []
  c.labels.forEach((label, i) => {
    let up = 0
    let down = 0
    for (const s of c.series) {
      const v = s.vals[i] ?? 0
      if (!v) continue
      const from = v > 0 ? up : down
      const to = from + v
      if (v > 0) up = to
      else down = to
      rects.push({
        x: i * BAR + 1,
        y: y(Math.max(from, to)),
        w: BAR - 2,
        h: Math.max(0.5, (Math.abs(v) / span) * H),
        fill: c.signed && v < 0 ? 'var(--destructive)' : s.color,
        tip: `${label} · ${s.label}: ${usd(v)}`,
      })
    }
  })
  return { W: n * BAR, rects, zeroY: y(0), top, bottom, empty: top === 0 && bottom === 0 }
}
const drawn = computed(() => charts.value.map((c) => ({ c, g: geometry(c) })))

// ---- rule check ----
const rule = computed(() => {
  const r = stats.value?.rule_check ?? {}
  return {
    day: r.day as string | undefined,
    partial: !!r.partial,
    tiles: [
      { k: 'haiku', label: t('hswarm.v.savings.rule.haiku'), v: int(r.haiku_requests) },
      { k: 'sonnet', label: t('hswarm.v.savings.rule.sonnet'), v: int(r.sonnet_agents) },
      {
        k: 'opusFable',
        label: t('hswarm.v.savings.rule.opusFable'),
        v: int((r.opus_agents || 0) + (r.fable_agents || 0)),
      },
      { k: 'gate', label: t('hswarm.v.savings.rule.gate'), v: int(r.gate_decisions) },
      {
        k: 'bypassed',
        label: t('hswarm.v.savings.rule.bypassed'),
        v: int(r.ungated_agents_after_gate),
        bad: (r.ungated_agents_after_gate || 0) > 0,
      },
    ],
  }
})

// ---- tables ----
const acctName = (id: string) => accountDisplay(id, names.value, t).text
const acctMuted = (id: string) => accountDisplay(id, names.value, t).muted
const acctTitle = (id: string) => accountDisplay(id, names.value, t).title
const tables = computed<Table[]>(() => {
  const s = stats.value
  if (!s) return []
  const f = F.value
  const money =
    (k: string): Col['fmt'] =>
    (v) =>
      usd(v)
  return [
    {
      id: 'machines',
      title: t('hswarm.v.savings.tMachines'),
      hint: t('hswarm.v.savings.tMachinesHint'),
      rows: machineRows.value,
      cols: [
        { key: 'machine', label: t('hswarm.v.savings.cMachine') },
        { key: 'n', label: t('hswarm.v.savings.cRuns'), num: true, fmt: int as any },
        { key: 'tasks', label: t('hswarm.v.savings.cTasks'), num: true, fmt: int as any },
        { key: f.est, label: t('hswarm.v.savings.cEst'), num: true, fmt: money(f.est) },
        { key: f.worker, label: t('hswarm.v.savings.cWorker'), num: true, fmt: money(f.worker) },
        { key: f.saved, label: t('hswarm.v.savings.cSaved'), num: true, fmt: money(f.saved) },
        {
          key: 'claude_cost',
          label: t('hswarm.v.savings.cClaude'),
          num: true,
          fmt: money('claude_cost'),
        },
        {
          key: 'claude_tokens',
          label: t('hswarm.v.savings.cClaudeTokens'),
          num: true,
          fmt: ((v: number | null) => (v == null ? '—' : compact(v))) as any,
        },
        {
          key: 'share',
          label: t('hswarm.v.savings.cShare'),
          num: true,
          fmt: ((v: number | null) => (v == null ? '—' : pct(v))) as any,
        },
      ],
    },
    {
      id: 'accounts',
      title: t('hswarm.v.savings.tAccounts'),
      hint: t('hswarm.v.savings.tAccountsHint'),
      rows: s.accounts?.rows ?? [],
      folded: 12,
      cols: [
        {
          key: 'account',
          label: t('hswarm.v.savings.cAccount'),
          fmt: (v) => acctName(v),
          muted: acctMuted,
          title: acctTitle,
        },
        { key: 'tier', label: t('hswarm.v.savings.cTier'), fmt: (v) => String(v || '—') },
        { key: 'days', label: t('hswarm.v.savings.cDays'), num: true, fmt: int as any },
        {
          key: plan.value ? 'plan_usd' : 'usd',
          label: t('hswarm.v.savings.cClaude'),
          num: true,
          fmt: money('usd'),
        },
        { key: 'tokens', label: t('hswarm.v.savings.cTokens'), num: true, fmt: compact as any },
        { key: 'runs', label: t('hswarm.v.savings.cRuns'), num: true, fmt: int as any },
        { key: 'tasks', label: t('hswarm.v.savings.cTasks'), num: true, fmt: int as any },
        { key: 'last', label: t('hswarm.v.savings.cLast') },
      ],
    },
    {
      id: 'days',
      title: t('hswarm.v.savings.tDays'),
      rows: [...s.days].reverse(),
      cols: [
        { key: 'day', label: t('hswarm.v.savings.cDay') },
        { key: 'n', label: t('hswarm.v.savings.cRuns'), num: true, fmt: int as any },
        { key: 'tasks', label: t('hswarm.v.savings.cTasks'), num: true, fmt: int as any },
        { key: f.est, label: t('hswarm.v.savings.cEst'), num: true, fmt: money(f.est) },
        { key: f.worker, label: t('hswarm.v.savings.cWorker'), num: true, fmt: money(f.worker) },
        { key: f.saved, label: t('hswarm.v.savings.cSaved'), num: true, fmt: money(f.saved) },
        { key: f.claude, label: t('hswarm.v.savings.cClaude'), num: true, fmt: money(f.claude) },
        { key: 'share', label: t('hswarm.v.savings.cShare'), num: true, fmt: pct as any },
      ],
    },
    {
      id: 'recent',
      title: t('hswarm.v.savings.tRecent'),
      hint: t('hswarm.v.savings.tRecentHint'),
      rows: s.recent,
      folded: 15,
      cols: [
        {
          key: 'ts',
          label: t('hswarm.v.savings.cWhen'),
          fmt: (v) =>
            String(v || '')
              .slice(5, 16)
              .replace('T', ' '),
        },
        { key: 'machine', label: t('hswarm.v.savings.cMachine') },
        {
          key: 'label',
          label: t('hswarm.v.savings.cLabel'),
          fmt: (v, r) => String(v || r.kind || ''),
        },
        { key: 'tasks', label: t('hswarm.v.savings.cTasks'), num: true, fmt: int as any },
        { key: 'est_usd', label: t('hswarm.v.savings.cEst'), num: true, fmt: money('est_usd') },
        {
          key: 'worker_usd',
          label: t('hswarm.v.savings.cWorker'),
          num: true,
          fmt: money('worker_usd'),
        },
        {
          key: 'saved_usd',
          label: t('hswarm.v.savings.cSaved'),
          num: true,
          fmt: money('saved_usd'),
        },
      ],
    },
  ]
})

const sortState = ref<Record<string, { key: string; dir: 1 | -1 } | null>>({})
const expandedTables = ref(new Set<string>())
function sortBy(tid: string, col: Col) {
  const cur = sortState.value[tid]
  const dir = cur?.key === col.key ? (-cur.dir as 1 | -1) : col.num ? -1 : 1
  sortState.value = { ...sortState.value, [tid]: { key: col.key, dir } }
}
function sorted(tb: Table): Row[] {
  const st = sortState.value[tb.id]
  let rows = tb.rows
  if (st) {
    rows = [...rows].sort((a, b) => {
      const x = a[st.key]
      const y = b[st.key]
      if (typeof x === 'number' || typeof y === 'number')
        return ((Number(x) || 0) - (Number(y) || 0)) * st.dir
      return String(x ?? '').localeCompare(String(y ?? '')) * st.dir
    })
  }
  return tb.folded && !expandedTables.value.has(tb.id) ? rows.slice(0, tb.folded) : rows
}
function toggleFold(id: string) {
  const s = new Set(expandedTables.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedTables.value = s
}
const ariaSort = (tid: string, key: string) => {
  const st = sortState.value[tid]
  return st?.key === key ? (st.dir === 1 ? 'ascending' : 'descending') : 'none'
}
</script>

<template>
  <div class="space-y-2 px-5 py-3">
    <!-- Toolbar: window and money basis -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1.5">
        <div class="inline-flex overflow-hidden rounded-md border text-xs" role="group" :aria-label="t('hswarm.v.savings.window')">
          <button
            v-for="w in WINDOWS"
            :key="w"
            type="button"
            class="px-2 py-0.5 tabular-nums"
            :class="days === w ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            :aria-pressed="days === w"
            @click="days = w"
          >{{ w }} {{ t('hswarm.v.savings.daysShort') }}</button>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <div class="inline-flex overflow-hidden rounded-md border text-xs" role="group" :aria-label="t('hswarm.v.savings.basis')">
          <button
            type="button"
            class="px-2 py-0.5"
            :class="!plan ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            :aria-pressed="!plan"
            @click="mode = 'list'"
          >{{ t('hswarm.v.savings.listUsd') }}</button>
          <button
            type="button"
            class="px-2 py-0.5"
            :class="plan ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            :aria-pressed="plan"
            @click="mode = 'plan'"
          >{{ t('hswarm.v.savings.planUsd') }}</button>
        </div>
        <InfoHint :text="t('hswarm.v.savings.basisHint')" />
      </div>
    </div>

    <p v-if="error" class="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{{ error }}</p>
    <p v-else-if="!stats && loading" class="py-4 text-center text-sm text-muted-foreground">{{ t('hswarm.loading') }}</p>
    <p v-else-if="isEmpty && stats" class="py-6 text-center text-sm text-muted-foreground">{{ t('hswarm.v.savings.empty') }}</p>

    <template v-else-if="stats">
      <!-- Hero: one line -->
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border bg-card px-3 py-2">
        <span class="text-3xl font-semibold leading-9 tabular-nums">{{ hero.tokens }}</span>
        <span class="text-sm text-muted-foreground">{{ t('hswarm.v.savings.tokensAvoided') }}</span>
        <span class="text-sm tabular-nums" :class="(totals[F.saved] ?? 0) < 0 ? 'text-destructive' : 'text-success'"><b>{{ hero.saved }}</b> <span class="text-muted-foreground">{{ t('hswarm.v.savings.saved') }}</span></span>
        <span class="text-sm tabular-nums"><b>{{ hero.share }}</b> <span class="text-muted-foreground">{{ t('hswarm.v.savings.ofTheWork') }}</span></span>
        <span class="text-sm text-muted-foreground tabular-nums">{{ hero.runs }} {{ t('hswarm.v.savings.runs') }} · {{ hero.tasks }} {{ t('hswarm.v.savings.tasks') }} · {{ t('hswarm.v.savings.since', { day: hero.since }) }}</span>
        <span v-if="stats.source === 'zswarm'" class="rounded-full border px-1.5 text-[11px] text-muted-foreground">{{ t('hswarm.v.savings.fromZswarm') }}</span>
      </div>

      <!-- Tiles -->
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div v-for="tile in tiles" :key="tile.k" class="min-w-0 rounded-lg border bg-card px-2.5 py-1.5">
          <div class="flex items-center gap-1 text-xs text-muted-foreground">
            <span class="truncate">{{ tile.label }}</span>
            <InfoHint v-if="tile.hint" :text="t('hswarm.v.savings.savedFloorHint')" />
          </div>
          <div class="whitespace-nowrap text-lg font-semibold leading-6 tabular-nums">
            {{ tile.v }}<span v-if="tile.sub" class="ms-1.5 text-xs font-normal text-muted-foreground">{{ tile.sub }}</span>
          </div>
        </div>
      </div>

      <!-- Charts per day -->
      <div class="grid items-start gap-2 lg:grid-cols-3">
        <div v-for="{ c, g } in drawn" :key="c.id" class="min-w-0 rounded-lg border bg-card px-3 py-2">
          <div class="mb-1 flex items-center gap-1 text-sm font-medium">
            <span class="truncate">{{ c.title }}</span>
            <InfoHint v-if="c.hint" :text="c.hint" />
          </div>
          <p v-if="g.empty" class="py-4 text-center text-xs text-muted-foreground">{{ t('hswarm.v.savings.noBars') }}</p>
          <template v-else>
            <div class="flex gap-1.5">
              <div class="flex w-10 shrink-0 flex-col justify-between text-end text-[10px] leading-none text-muted-foreground tabular-nums">
                <span>{{ axisUsd(g.top) }}</span>
                <span v-if="g.bottom < 0">{{ g.bottom < 0 ? `−${axisUsd(-g.bottom)}` : '' }}</span>
                <span v-else>$0</span>
              </div>
              <svg :viewBox="`0 0 ${g.W} 100`" preserveAspectRatio="none" class="h-20 min-w-0 flex-1" role="img" :aria-label="c.title">
                <line x1="0" :x2="g.W" :y1="g.zeroY" :y2="g.zeroY" stroke="currentColor" class="text-border" stroke-width="0.6" vector-effect="non-scaling-stroke" />
                <rect v-for="(r, i) in g.rects" :key="i" :x="r.x" :y="r.y" :width="r.w" :height="r.h" :fill="r.fill"><title>{{ r.tip }}</title></rect>
              </svg>
            </div>
            <div class="ms-11.5 mt-0.5 flex justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>{{ c.labels[0]?.slice(5) }}</span>
              <span>{{ c.labels[c.labels.length - 1]?.slice(5) }}</span>
            </div>
            <div v-if="c.series.length > 1" class="mt-1 flex flex-wrap gap-x-2.5 text-[11px] text-muted-foreground">
              <span v-for="s in c.series" :key="s.key" class="inline-flex items-center gap-1">
                <span class="size-2 rounded-sm" :style="{ background: s.color }" />{{ s.label }}
              </span>
            </div>
          </template>
        </div>
      </div>

      <!-- Rule check -->
      <div class="rounded-lg border bg-card px-3 py-2">
        <div class="mb-1 flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <span>{{ t('hswarm.v.savings.ruleCheck') }}</span>
          <InfoHint :text="t('hswarm.v.savings.ruleCheckHint')" />
          <span class="text-xs font-normal text-muted-foreground tabular-nums">{{ rule.day }}</span>
          <span v-if="rule.partial" class="rounded-full border border-warning/50 px-1.5 text-[11px] font-normal text-warning">{{ t('hswarm.v.savings.stillRunning') }}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div v-for="r in rule.tiles" :key="r.k" class="min-w-0 rounded-md border px-2 py-1">
            <div class="truncate text-xs text-muted-foreground">{{ r.label }}</div>
            <div class="text-base font-semibold leading-5 tabular-nums" :class="r.bad ? 'text-destructive' : ''">{{ r.v }}</div>
          </div>
        </div>
      </div>

      <!-- Tables -->
      <div v-for="tb in tables" :key="tb.id" class="rounded-lg border bg-card">
        <div class="flex items-center gap-1 px-3 pt-2 text-sm font-medium">
          <span>{{ tb.title }}</span>
          <InfoHint v-if="tb.hint" :text="tb.hint" />
          <span class="text-xs font-normal text-muted-foreground tabular-nums">{{ tb.rows.length }}</span>
        </div>
        <div class="overflow-x-auto px-1 pb-1">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-muted-foreground">
                <th
                  v-for="(col, ci) in tb.cols"
                  :key="col.key"
                  :aria-sort="ariaSort(tb.id, col.key)"
                  class="px-2 py-1 font-medium whitespace-nowrap"
                  :class="[col.num ? 'w-px text-end' : 'text-start', ci === 0 ? '' : '']"
                >
                  <button type="button" class="inline-flex items-center gap-0.5 hover:text-foreground" @click="sortBy(tb.id, col)">
                    {{ col.label }}<span class="text-[9px]" aria-hidden="true">{{ sortState[tb.id]?.key === col.key ? (sortState[tb.id]!.dir === 1 ? '▲' : '▼') : '' }}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in sorted(tb)" :key="ri" class="border-t hover:bg-muted/50">
                <td
                  v-for="col in tb.cols"
                  :key="col.key"
                  class="px-2 py-0.5 whitespace-nowrap"
                  :class="[col.num ? 'text-end tabular-nums' : 'max-w-[18rem] truncate', col.muted?.(r[col.key]) ? 'text-muted-foreground' : '']"
                  :title="col.title?.(r[col.key])"
                >{{ col.fmt ? col.fmt(r[col.key], r) : (r[col.key] ?? '—') }}</td>
              </tr>
            </tbody>
          </table>
          <button
            v-if="tb.folded && tb.rows.length > tb.folded"
            type="button"
            class="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            @click="toggleFold(tb.id)"
          >{{ expandedTables.has(tb.id) ? t('hswarm.v.savings.showFewer') : t('hswarm.v.savings.showAll', { n: tb.rows.length }) }}</button>
        </div>
      </div>
    </template>
  </div>
</template>
