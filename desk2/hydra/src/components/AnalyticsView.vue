<script setup lang="ts">
// The analytics tab, "the Uber stats page": every number AgentHydra has about the work, read from
// per-session TOTALS the daemon computed in the background (server/src/analytics.ts) — no
// transcript is opened to draw any of it, which is why the charts are instant on a store with
// thousands of sessions in it.
//
// READ TOP DOWN, MOST IMPORTANT FIRST (owner, 2026-10-05: "my eyeballs don't know what to focus on
// and what I'm supposed to see out of it"). Four numbers lead, each beside what it compares with;
// every section under them has a short title saying what it shows, its explanation behind an info
// icon, and a long list shows its top rows with the rest folded behind "+N more". One question per
// section:
//   lead row             how much did I use, what would it cost, what did HSwarm save, which model?
//   cost over time       when did it happen, is the current period busier? (bars, or a calendar)
//   by model, project    where did the money go?
//   by account           which accounts did AgentHydra's own runs use?
//   sessions and tokens  how much work, what kind of tokens, from which tool?
//   what eats tokens     what is wasting tokens, and how do I cut it?
//   worth a look         which sessions went badly?
//   tools agents call    what do the agents spend their turns doing?
//   busiest hours        when in the week does the work happen?
//   running at once      how much runs in parallel?
//   mistakes             which commands do agents keep getting wrong? (CommandCorrections.vue)
//   recently edited      what changed lately, per repo?
//   coding tools         what else is installed here, and can AgentHydra read it?
//
// COLOUR IS FOR MEANING ONLY (owner, 2026-10-05: "There's just a ton of blue. And no, adding, like,
// a thousand colors to it isn't gonna help"). Bars and grids are gray; the one accent (--viz-seq,
// blue) marks only what matters in that chart: the current period, or the top item.
//
// A PARTIAL STORE IS ALWAYS ON SCREEN. A chart drawn from a half-warmed store looks exactly like
// one drawn from a complete store, so a partial scan says so under the filters. A complete one keeps
// its count behind the title's info icon with the rest of the fine print.
//
// PRICES ARE LIST PRICES. These are subscription accounts; nobody is billed per token. The figure
// answers "what would this have cost on the API", which is why the tile says "at API rates" rather
// than letting a dollar sign imply a bill.
import { BarChart3, DollarSign, FolderGit2, Hash, RefreshCw } from '@lucide/vue'
import { computed, inject, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CommandCorrections from '@/components/CommandCorrections.vue'
import AreaLine from '@/components/charts/AreaLine.vue'
import BarRows from '@/components/charts/BarRows.vue'
import CalendarGrid from '@/components/charts/CalendarGrid.vue'
import EditsFeed from '@/components/charts/EditsFeed.vue'
import HourGrid from '@/components/charts/HourGrid.vue'
import TimeBars from '@/components/charts/TimeBars.vue'
import TokenSplit from '@/components/charts/TokenSplit.vue'
import MultiSelectSubmenu from '@/components/MultiSelectSubmenu.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAnalyticsData } from '@/composables/useAnalyticsData'
import { useAnalyticsPrefs } from '@/composables/useAnalyticsPrefs'
import { useShellWidth } from '@/composables/useShellWidth'
import {
  ANALYTICS_SOURCE_LABEL_KEY,
  ANALYTICS_SOURCES,
  type AnalyticsSource,
} from '@/lib/analytics-sources'
import type {
  EditEntry,
  SessionPeriod,
  TokenSink,
  TokenSinkReport,
} from '@/lib/api'
import * as api from '@/lib/api'
import { OPEN_VIEW } from '@/lib/app-view'
import { modelVendor, vendorLabel } from '@/lib/chart'
import { baseName, formatCompact, formatUsd } from '@/lib/format'
import { accountDisplay, fetchAccountNames, type HswarmAccountName } from '@/lib/hswarm-api'
import { formatUsd as kitUsd } from '@/lib/kit'
import { scopeParam, summarizeSelection } from '@/lib/session-scopes'
import { lastDaysSaved, useSwarmStats } from '@/lib/swarm-stats'
import { money, useSwarmTiles } from '@/lib/swarm-tiles'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const openView = inject(OPEN_VIEW, () => {})
// The header's full-width toggle lifts this page's own reading cap too.
const { fullWidth } = useShellWidth()
const { analyticsPeriod, analyticsTokenMode, analyticsSources, analyticsPc, toggleTokenMode } =
  useAnalyticsPrefs()

/** How many rows a list shows before the rest fold behind "+N more" (owner, 2026-10-05). */
const TOP = 5

/** acct id -> who it is, for the per-account rows (empty when the daemon cannot say). */
const accountNames = ref<Record<string, HswarmAccountName>>({})

function sourceLabel(value: string): string {
  const key = ANALYTICS_SOURCE_LABEL_KEY[value as AnalyticsSource]
  return key ? t(key) : value
}
/** The menu lists the sources that have data; before the first answer, every known one. */
const sourceItems = computed(() => {
  const present = spend.value ? Object.keys(spend.value.kitCoverage.sources) : []
  const known = ANALYTICS_SOURCES.filter((s) => !spend.value || present.includes(s))
  const extra = present.filter((s) => !(ANALYTICS_SOURCES as readonly string[]).includes(s))
  return [...known, ...extra].map((value) => ({ value, label: sourceLabel(value) }))
})
const sourceSummary = computed(() =>
  summarizeSelection(analyticsSources.value, ANALYTICS_SOURCES, {
    all: t('sessions.selectionAll'),
    none: t('sessions.selectionNone'),
    label: sourceLabel,
    more: (first, n) => t('sessions.selectionMore', { first, n }),
  }),
)
function toggleSource(value: string) {
  const v = value as AnalyticsSource
  analyticsSources.value = analyticsSources.value.includes(v)
    ? analyticsSources.value.filter((s) => s !== v)
    : ANALYTICS_SOURCES.filter((s) => s === v || analyticsSources.value.includes(s))
}

/** Narrow every cost/model chart to one vendor. Client-side over the report already fetched: the
 *  vendor is derived from the model id, so the daemon has nothing extra to compute. */
const vendorFilter = ref<string>('all')

// One shared copy (composables/useAnalyticsData.ts), already filled by lib/warm-data.ts when the tab
// is first opened.
const { spend, activity, concurrency, edits, sinks, agentTools, loading, loadAnalytics: load, loadSpend } =
  useAnalyticsData()

/** Why a detected tool is not read. Written as a switch over literal keys rather than an
 *  interpolated one so the i18n checker can see every string that is actually used. */
function toolNoteLabel(note: string | undefined): string {
  if (note === 'encrypted') return t('analytics.toolNoteEncrypted')
  if (note === 'credits') return t('analytics.toolNoteCredits')
  if (note === 'opt-in') return t('analytics.toolNoteOptIn')
  return t('analytics.toolUnread')
}
const refreshing = ref(false)

const allSources = computed(
  () => scopeParam(analyticsSources.value, ANALYTICS_SOURCES) === undefined,
)

onMounted(() => load(true))
// The charts follow the work through lib/warm-data.ts (about every 2 minutes); opening the tab asks again now.
watch(analyticsPeriod, () => load())
watch([analyticsSources, analyticsPc], () => loadSpend())
onMounted(async () => {
  accountNames.value = await fetchAccountNames()
})

async function rescan() {
  refreshing.value = true
  try {
    const r = await api.refreshAnalytics()
    // A failure count is surfaced rather than swallowed: a warm where EVERY file failed reports the
    // same "scanned 0" as a warm with nothing to do, and those are very different states.
    if (r.failed > 0) toast.warning(t('analytics.rescanFailedSome', { n: r.failed }))
    else
      toast.success(
        r.budgetExhausted
          ? t('analytics.rescanPartial', { n: r.scanned })
          : t('analytics.rescanDone', { n: r.scanned }),
      )
    await load()
  } catch {
    toast.error(t('analytics.rescanFailed'))
  } finally {
    refreshing.value = false
  }
}

const PERIOD_LABEL: Record<SessionPeriod, string> = {
  '24h': 'sessions.period24h',
  '7d': 'sessions.period7d',
  '30d': 'sessions.period30d',
  all: 'sessions.periodAll',
}
const periodLabel = computed(() => t(PERIOD_LABEL[analyticsPeriod.value]))

const coverage = computed(() => spend.value?.coverage ?? activity.value?.coverage ?? null)
const complete = computed(() => {
  const c = coverage.value
  return !!c && c.total > 0 && c.sessions >= c.total
})

/** Tokens, for the models a price table cannot reach. Magnitude, so one hue. */
const unpricedBuckets = computed(() =>
  unpricedModelRows.value
    .filter((b) => matchesVendor(b.key))
    .map((b) => ({
      key: b.key,
      label: b.key,
      value: b.tokens?.total ?? b.weighted,
      detail: t('analytics.modelDetail', { turns: b.turns, sessions: b.sessions }),
    })),
)
const unpricedTokenRows = computed(() => unpricedBuckets.value.slice(0, TOP))
const unpricedMore = computed(() => unpricedBuckets.value.slice(TOP))

/*
 * A COST chart contains only things that have a cost.
 *
 * Models with no published price used to be drawn at $0, which does not mean "we could not price
 * this" — it means "this was free", and for a month of GPT usage that is simply a false statement.
 * They are named underneath instead, so their absence is explained rather than silent, and their
 * tokens still appear in the split and the per-tool chart.
 */
/** A bulk-rate discount is set: the cost tile shows the figure at the owner's rate under the list one. */
const atRate = computed(() => spend.value?.hasRateDiscount === true)
const pricedModels = computed(() => (spend.value?.byModel ?? []).filter((b) => b.costUsd !== null))
const unpricedModelRows = computed(() =>
  (spend.value?.byModel ?? []).filter((b) => b.costUsd === null),
)

/** Every vendor present, for the filter. Built from the UNFILTERED report, so the control can never
 *  hide the option that would bring the rest back. */
const vendors = computed(() => {
  const seen = new Map<string, number>()
  for (const b of spend.value?.byModel ?? []) {
    const v = modelVendor(b.key)
    seen.set(v, (seen.get(v) ?? 0) + (b.tokens?.total ?? 0))
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => ({ key, label: vendorLabel(key) }))
})
const matchesVendor = (model: string) =>
  vendorFilter.value === 'all' || modelVendor(model) === vendorFilter.value

/**
 * The unit the charts are drawn in.
 *
 * ONE switch for every panel, not one per chart (see useAnalyticsPrefs): the unit is the question
 * being asked, and a page half in dollars and half in tokens invites reading a cost bar against a
 * token bar. Every bucket now carries both figures from the server, so nothing goes blank in
 * either mode. The lead row is the exception on purpose: it shows tokens AND dollars side by side.
 *
 * Tokens here means the RAW four-way total — what was actually sent and received. It is
 * deliberately NOT the weighted figure beside it in "Sessions and tokens": weighting discounts cache
 * reads to a tenth and multiplies output by five to approximate cost, which is the right number
 * for "what did this cost" and the wrong one for "how many tokens did I use".
 */
const tokenMode = computed(() => analyticsTokenMode.value)
/** A bucket's value in the current unit. */
const metricOf = (b: { costUsd?: number | null; tokens?: { total: number } }) =>
  tokenMode.value ? (b.tokens?.total ?? 0) : (b.costUsd ?? 0)

/**
 * Does this series actually carry token figures?
 *
 * ⛔ A CHART WITH NO DATA MUST NOT LOOK LIKE A CHART WITH ZEROS. Per-day, per-project and
 * per-account token splits are newer than the rest of this tab, so a daemon that has not been
 * restarted since they landed serves buckets with a cost and no `tokens`. Every bar then
 * evaluated to 0 and the panel rendered blank — no bars, no explanation, nothing to tell you the
 * difference between "you spent nothing" and "this build cannot answer in this unit". Panels ask
 * this first and say so instead.
 */
const hasTokens = (rows: { tokens?: { total: number } }[]) =>
  rows.some((b) => (b.tokens?.total ?? 0) > 0)
const dayTokensMissing = computed(() => tokenMode.value && !hasTokens(spend.value?.byDay ?? []))
const projectTokensMissing = computed(
  () => tokenMode.value && !hasTokens(spend.value?.byProject ?? []),
)
const accountTokensMissing = computed(
  () => tokenMode.value && !hasTokens(spend.value?.byAccount ?? []),
)
/** The formatter that matches the unit, handed to every chart. */
const axisUsd = (n: number) => kitUsd(n, { style: 'axis' })
const metricFormat = computed(() => (tokenMode.value ? formatCompact : formatUsd))
/** Largest first in the unit on screen: the server ranks by cost, so in tokens a 2.2B row sat above a
 *  2.4B one (owner, 2026-10-04). */
const largestFirst = <T extends { value: number }>(rows: T[]) =>
  [...rows].sort((a, b) => b.value - a.value)

/** In money only the models with a price (the rest are named under the chart, never drawn at $0);
 *  in tokens every model, since a token count needs no price. */
const modelBuckets = computed(() =>
  largestFirst(
    (tokenMode.value ? (spend.value?.byModel ?? []) : pricedModels.value)
      .filter((b) => matchesVendor(b.key))
      .map((b) => ({
        key: b.key,
        label: b.key,
        value: metricOf(b),
        detail: t('analytics.modelDetail', { turns: b.turns, sessions: b.sessions }),
      })),
  ),
)
const modelRows = computed(() => modelBuckets.value.slice(0, TOP))
const modelMore = computed(() => modelBuckets.value.slice(TOP))

const projectBuckets = computed(() =>
  largestFirst(
    (spend.value?.byProject ?? []).map((b) => ({
      key: b.key,
      label: baseName(b.key) || b.key,
      value: metricOf(b),
      detail: b.key,
    })),
  ),
)
const projectRows = computed(() => projectBuckets.value.slice(0, TOP))
const projectMore = computed(() => projectBuckets.value.slice(TOP))

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'sessions.sourceClaude',
  codex: 'sessions.sourceCodex',
  opencode: 'sessions.sourceOpenCode',
  hermes: 'sessions.sourceHermes',
  dsh: 'sessions.sourceDsh',
  zswarm: 'sessions.sourceZswarm',
}
/** Every provider that has usage, so "my stats only show Claude" is answerable at a glance. */
const providerRows = computed(() =>
  largestFirst(
    (spend.value?.byProvider ?? []).map((p) => ({
      key: p.key,
      label: t(PROVIDER_LABEL[p.key] ?? 'sessions.sourceAll'),
      value: p.tokens.total,
      detail: t('analytics.providerDetail', {
        sessions: p.sessions,
        cost: p.costUsd === null ? '—' : formatUsd(p.costUsd),
      }),
    })),
  ),
)

const accountBuckets = computed(() =>
  largestFirst(
    (spend.value?.byAccount ?? []).map((b) => ({
      key: b.key,
      label: accountDisplay(b.key, accountNames.value, t).text,
      value: metricOf(b),
      detail: t('analytics.accountDetail', { sessions: b.sessions }),
    })),
  ),
)
const accountRows = computed(() => accountBuckets.value.slice(0, TOP))
const accountMore = computed(() => accountBuckets.value.slice(TOP))

// --- the lead row ------------------------------------------------------------------------------
// The four numbers that matter most, each beside what it compares with (owner, 2026-10-05), all
// worked out from what the page already loads: the per-day totals, the two cost totals, HSwarm's
// 14-day feed and the per-model buckets.

/** A local calendar key, the shape the daemon keys byDay with (local, not UTC: server analytics.ts
 *  dayKey). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** The key of the day `n` days before today. */
function dayKeyAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDayKey(d)
}

/** "▲ 18% vs the 7 days before" and its kin; empty when there is no week before to compare with.
 *  Gray, not green or red: more use is not good or bad by itself. */
function versus(now: number, before: number | null): string {
  if (before === null) return ''
  if (before === 0) return now > 0 ? t('analytics.leadNoneBefore') : t('analytics.leadSame')
  const change = (now - before) / before
  const pct = `${Math.abs(Math.round(change * 100))}%`
  if (pct === '0%') return t('analytics.leadSame')
  return change > 0 ? t('analytics.leadUp', { pct }) : t('analytics.leadDown', { pct })
}

/** Only a 30-day or all-time window reaches back past the week before this one. */
const reachesWeekBefore = computed(
  () => analyticsPeriod.value === '30d' || analyticsPeriod.value === 'all',
)
/** Raw tokens in the newest 7 days and in the 7 before them, off the per-day totals. A shorter
 *  window shows its whole total with nothing to compare it with: a 0 for a week the window does not
 *  reach would claim a quiet week. */
const usage = computed<{ weekly: boolean; tokens: number; before: number | null }>(() => {
  const s = spend.value
  const days = s?.byDay ?? []
  if (!reachesWeekBefore.value || !hasTokens(days))
    return { weekly: false, tokens: s?.tokens.total ?? 0, before: null }
  const from = dayKeyAgo(6)
  const beforeFrom = dayKeyAgo(13)
  let tokens = 0
  let before = 0
  for (const b of days) {
    const n = b.tokens?.total ?? 0
    if (b.key >= from) tokens += n
    else if (b.key >= beforeFrom) before += n
  }
  return { weekly: true, tokens, before }
})
const usageVersus = computed(() => {
  if (usage.value.weekly) return versus(usage.value.tokens, usage.value.before)
  return reachesWeekBefore.value ? '' : t('analytics.leadNoWeekBefore')
})

/** Where the rates came from and how old they are. A dollar total with no price date is a number
 *  nobody can audit, and "downloaded" versus "shipped with this build" is the difference between
 *  last week's rate card and this release's. */
const pricesNote = computed(() => {
  const s = spend.value
  if (!s) return ''
  return s.priceSource === 'catalog'
    ? t('analytics.pricesFetched', { date: s.pricesAsOf })
    : t('analytics.pricesBundled', { date: s.pricesAsOf })
})
/** Under the API-rate cost: the same work at the owner's own rate once a discount is set (Routing
 *  page), else the price date. */
const costVersus = computed(() => {
  const s = spend.value
  if (s && atRate.value && s.totalCostAtRateUsd !== null)
    return t('analytics.leadAtRate', { cost: formatUsd(s.totalCostAtRateUsd) })
  return pricesNote.value
})

// HSwarm's figure reads the same 14-day feed its card on other tabs does (lib/swarm-stats.ts polls
// it once however many read it). The card is not on this tab any more: its headline is this tile and
// the rest of its numbers sit behind the tile's info icon (owner, 2026-10-05: a section that repeats
// a number is merged).
const { stats: swarm, offline: swarmOffline } = useSwarmStats(14)
const { tiles: swarmTiles, week: swarmWeek } = useSwarmTiles(swarm)
/** Saved in the 7 days before HSwarm's newest 7; null when the feed holds less than a fortnight or
 *  measured none of those days. */
const swarmBefore = computed(() => {
  const days = swarm.value?.days ?? []
  return days.length >= 14 ? lastDaysSaved(days.slice(0, -7), 7).sum : null
})
const swarmVersus = computed(() => {
  if (swarm.value?.empty) return t('swarmStats.empty')
  const now = swarmWeek.value.sum
  if (now === null) return swarmOffline.value && !swarm.value ? t('swarmStats.offline') : ''
  return versus(now, swarmBefore.value)
})

/** The model with the most use in the unit on screen: the same row the model chart draws in the
 *  accent, with its share of every model shown there. */
const busiestModel = computed(() => {
  const top = modelBuckets.value[0]
  const total = modelBuckets.value.reduce((n, b) => n + b.value, 0)
  if (!top || top.value <= 0 || total <= 0) return null
  return { key: top.key, detail: top.detail, pct: `${Math.round((top.value / total) * 100)}%` }
})

/** A sink's name and fix. A switch over literal keys, like toolNoteLabel, so the i18n checker can
 *  see every string in use. The server sends an English `fix` too; that one is for API and MCP
 *  readers, this one is translated. */
function sinkLabel(id: TokenSink['id']): string {
  if (id === 'dead-skills') return t('analytics.sinkDeadSkills')
  if (id === 'dead-mcp') return t('analytics.sinkDeadMcp')
  if (id === 'deep-context')
    return t('analytics.sinkDeepContext', {
      threshold: formatCompact(sinks.value?.deepContext.threshold ?? 0),
    })
  if (id === 'output') return t('analytics.sinkOutput')
  if (id === 'subagents') return t('analytics.sinkSubagents')
  return t('analytics.sinkCacheWrites')
}
function sinkFix(id: TokenSink['id']): string {
  if (id === 'dead-skills') return t('analytics.fixDeadSkills')
  if (id === 'dead-mcp') return t('analytics.fixDeadMcp')
  if (id === 'deep-context') return t('analytics.fixDeepContext')
  if (id === 'output') return t('analytics.fixOutput')
  if (id === 'subagents') return t('analytics.fixSubagents')
  return t('analytics.fixCacheWrites')
}
const percent = (n: number) => `${Math.round(n * 100)}%`

/** Loaded-but-unused rows, biggest dead prefix first. Rows something used everywhere are left
 *  out: they are not a sink, and the list is for deciding what to uninstall. */
function deadRows(rows: TokenSinkReport['skills']) {
  return rows
    .filter((r) => r.deadTokens > 0)
    .map((r) => ({
      key: r.key,
      label: r.key,
      value: r.deadTokens,
      detail: t('analytics.deadDetail', {
        tokens: formatCompact(r.loadTokens),
        loaded: r.sessionsLoaded,
        used: r.sessionsUsed,
      }),
    }))
}
const deadSkillRows = computed(() => deadRows(sinks.value?.skills ?? []))
const deadMcpRows = computed(() => deadRows(sinks.value?.mcpServers ?? []))
const cacheRows = computed(() =>
  (sinks.value?.cacheByAccount ?? []).map((c) => ({
    key: c.key ?? '',
    label: c.key ?? t('analytics.sinkUnlinked'),
    value: c.ratio,
    detail: t('analytics.accountDetail', { sessions: c.sessions }),
  })),
)

const toolBuckets = computed(() =>
  (activity.value?.tools ?? []).map((tRow) => ({
    key: tRow.key,
    label: tRow.key.startsWith('mcp__') ? tRow.key.split('__').slice(-1)[0] || tRow.key : tRow.key,
    value: tRow.count,
    detail: tRow.key,
  })),
)
const toolRows = computed(() => toolBuckets.value.slice(0, TOP))
const toolMore = computed(() => toolBuckets.value.slice(TOP))

/**
 * Cost over time, by day or by month.
 *
 * ROLLED UP TO MONTHS PAST A THRESHOLD, because a bar per day stops being a chart and becomes a
 * texture: a year is 365 bars a couple of pixels wide, and nobody reads a single day out of that.
 * The threshold is on the number of buckets rather than on the selected window, so a sparse "all
 * time" over three weeks still shows its days and a dense one does not.
 */
const MAX_DAY_BARS = 70

/** 'auto' rolls up only once a day chart would stop being readable; the other two are the reader
 *  saying they know better, which on a window of a month or two they often do. */
const timeGrain = ref<'auto' | 'day' | 'month'>('auto')
const groupedByMonth = computed(() => {
  if (timeGrain.value !== 'auto') return timeGrain.value === 'month'
  return (spend.value?.byDay ?? []).length > MAX_DAY_BARS
})

/** A window of two days or less comes with every clock hour (server analytics.ts byHour): drawn by
 *  the day it was two bars that hardly moved (owner, 2026-10-04). */
const byHour = computed(() => spend.value?.byHour ?? null)

/**
 * Which picture of the per-day figures the time panel draws: bars for the trend, or the calendar
 * for "which weeks was I actually working". One panel with two views rather than two panels: both
 * drew the same number per day (owner, 2026-10-05: sections that repeat a number are merged).
 *
 * Not persisted through useAnalyticsPrefs: unlike the unit switch (a way of working) this is a
 * "let me look at it the other way" flip, and the bars are the right thing to land on.
 */
const timeView = ref<'bars' | 'calendar'>('bars')
const timeTitle = computed(() => {
  const tok = tokenMode.value
  if (timeView.value === 'calendar') return tok ? t('analytics.tokensByDay') : t('analytics.costByDay')
  if (byHour.value) return tok ? t('analytics.tokensByHour') : t('analytics.costByHour')
  if (groupedByMonth.value) return tok ? t('analytics.tokensByMonth') : t('analytics.costByMonth')
  return tok ? t('analytics.tokensByDay') : t('analytics.costByDay')
})

/**
 * The current period, the one part of the time panel drawn in the accent, every other bar gray:
 * today's hours on an hourly chart, this month on a monthly one, else the newest 7 days (the week
 * the lead row compares). On a 7-day window the newest 7 days would be the whole chart, so there it
 * is today alone.
 */
const accentPeriod = computed<'today' | 'week' | 'month'>(() => {
  if (byHour.value || analyticsPeriod.value === '7d' || analyticsPeriod.value === '24h') return 'today'
  return groupedByMonth.value ? 'month' : 'week'
})
const accentLabel = computed(() =>
  accentPeriod.value === 'today'
    ? t('analytics.accentToday')
    : accentPeriod.value === 'month'
      ? t('analytics.accentMonth')
      : t('analytics.accentWeek'),
)
/** Is this bucket key (an hour's ISO instant, a `YYYY-MM` month or a `YYYY-MM-DD` day) in the
 *  current period? Handed to the bars and the calendar, so the two views mark the same days. */
const isCurrent = computed(() => {
  // Worked out again whenever the report changes, so a tab left open past midnight moves "today" on.
  if (!spend.value) return () => false
  const today = dayKeyAgo(0)
  const weekFrom = dayKeyAgo(6)
  const month = today.slice(0, 7)
  const period = accentPeriod.value
  return (key: string): boolean => {
    if (key.length > 10) return localDayKey(new Date(key)) === today
    if (key.length === 7) return key === month
    if (period === 'today') return key === today
    if (period === 'month') return key.startsWith(month)
    return key >= weekFrom
  }
})

// One formatter per kind of label, built once: toLocale*String builds a new one on every call.
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' })

const dayPoints = computed(() => {
  if (byHour.value)
    return byHour.value.map((b) => ({
      key: b.key,
      label: hourLabel.format(new Date(b.key)),
      value: metricOf(b),
    }))
  const days = spend.value?.byDay ?? []
  if (!groupedByMonth.value)
    return days.map((b) => ({
      key: b.key,
      // "12 Aug" rather than the ISO key: the axis has two labels on it and they are for orienting,
      // not for reading a date off.
      label: dayLabel.format(new Date(`${b.key}T00:00:00`)),
      value: metricOf(b),
    }))
  // Summed, not averaged: the question this chart answers is "what did that month come to".
  const months = new Map<string, number>()
  for (const b of days) {
    const month = b.key.slice(0, 7)
    months.set(month, (months.get(month) ?? 0) + metricOf(b))
  }
  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => ({
      key,
      label: monthLabel.format(new Date(`${key}-01T00:00:00`)),
      value,
    }))
})

/** One entry per day that had activity, in the unit the tab is showing. Straight off the same
 *  byDay series the bars use, so the two views cannot disagree about a day. */
const calendarDays = computed(() =>
  (spend.value?.byDay ?? []).map((b) => ({ key: b.key, value: metricOf(b) })),
)

const concurrencyPoints = computed(() =>
  concurrency.value.map((p) => ({ at: p.at, value: p.sessions })),
)

/** Grouped by project, because "which repo has been getting attention" is the question a feed of
 *  bare paths cannot answer. */
const editGroups = computed(() => {
  const groups = new Map<string, EditEntry[]>()
  for (const e of edits.value) {
    const key = e.project || 'unknown'
    const list = groups.get(key) ?? []
    if (list.length < 8) list.push(e)
    groups.set(key, list)
  }
  return [...groups.entries()].slice(0, 8)
})
/** The newest few projects; the rest fold behind "+N more". */
const EDIT_GROUPS = 3
const editsAll = ref(false)
const shownEditGroups = computed(() =>
  editsAll.value ? editGroups.value : editGroups.value.slice(0, EDIT_GROUPS),
)

const healthRows = computed(() => activity.value?.health ?? [])
const healthAll = ref(false)
const shownHealth = computed(() =>
  healthAll.value ? healthRows.value : healthRows.value.slice(0, TOP),
)

/** Two columns of three before the fold. */
const AGENT_TOOLS = 6
const agentToolsAll = ref(false)
const shownAgentTools = computed(() =>
  agentToolsAll.value ? agentTools.value : agentTools.value.slice(0, AGENT_TOOLS),
)

const clockLabel = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
const agentHours = computed(() => Math.round((activity.value?.agentMinutes ?? 0) / 60))
// Edit survival across the period, as a whole percentage; null until any session has a score.
const survivalAverage = computed(() => {
  const s = activity.value?.editSurvival
  return s && s.average !== null ? { pct: Math.round(s.average * 100), n: s.sessions } : null
})
</script>

<template>
  <div class="scroll-slim h-full overflow-y-auto">
    <div class="mx-auto w-full space-y-4 p-4" :class="fullWidth ? '' : 'max-w-5xl'">
      <!-- filters in one row above everything -->
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="me-auto flex items-center gap-2 text-sm font-semibold">
          <BarChart3 class="size-4" />{{ $t('analytics.title') }}
          <!-- The fine print, behind one icon: what the dollars are, how much of the store is
               behind them, and the toolkit's own notes on where the answer is narrower than asked. -->
          <InfoHint>
            <span class="block">{{ $t('analytics.listPrice') }}</span>
            <span v-if="coverage" class="mt-1 block">
              {{
                complete
                  ? $t('analytics.complete', { n: coverage.sessions })
                  : $t('analytics.partial', { n: coverage.sessions, total: coverage.total })
              }}
            </span>
            <span v-for="note in spend?.notes ?? []" :key="note" class="mt-1 block">{{ note }}</span>
          </InfoHint>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm">{{ periodLabel }}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-48">
            <DropdownMenuRadioGroup v-model="analyticsPeriod">
              <DropdownMenuRadioItem value="24h">{{ $t('sessions.period24h') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="7d">{{ $t('sessions.period7d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="30d">{{ $t('sessions.period30d') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all">{{ $t('sessions.periodAll') }}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm">
              {{ $t('analytics.sourceFilter') }}: {{ sourceSummary }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-52">
            <MultiSelectSubmenu
              :label="$t('analytics.sourceFilter')"
              :summary="sourceSummary"
              :items="sourceItems"
              :selected="analyticsSources"
              @toggle="toggleSource"
              @all="analyticsSources = [...ANALYTICS_SOURCES]"
              @none="analyticsSources = []"
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button :variant="analyticsPc === 'all' ? 'outline' : 'secondary'" size="sm">
              {{ analyticsPc === 'all' ? $t('analytics.pcAll') : $t('analytics.pcSelf') }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-48">
            <DropdownMenuRadioGroup v-model="analyticsPc">
              <DropdownMenuRadioItem value="all">{{ $t('analytics.pcAll') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="self">{{ $t('analytics.pcSelf') }}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu v-if="vendors.length > 1">
          <DropdownMenuTrigger as-child>
            <Button :variant="vendorFilter === 'all' ? 'outline' : 'secondary'" size="sm">
              {{ vendorFilter === 'all' ? $t('analytics.allVendors') : vendorLabel(vendorFilter) }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-w-52">
            <DropdownMenuRadioGroup v-model="vendorFilter">
              <DropdownMenuRadioItem value="all">{{ $t('analytics.allVendors') }}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem v-for="v in vendors" :key="v.key" :value="v.key">
                {{ v.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <!-- One switch for the charts. Money answers "what would this have cost on the API";
             tokens answer "how much did I actually use", which several panels simply could not
             say before. See useAnalyticsPrefs for why it is a mode rather than a per-chart pick. -->
        <IconTooltip
          :label="tokenMode ? $t('analytics.showMoney') : $t('analytics.showTokens')"
          :description="$t('analytics.unitToggleHint')"
        >
          <Button
            :variant="tokenMode ? 'secondary' : 'outline'"
            size="sm"
            :aria-pressed="tokenMode"
            @click="toggleTokenMode"
          >
            <component :is="tokenMode ? Hash : DollarSign" />
            {{ tokenMode ? $t('analytics.unitTokens') : $t('analytics.unitMoney') }}
          </Button>
        </IconTooltip>
        <IconTooltip :label="$t('analytics.rescan')" :description="$t('analytics.rescanHint')">
          <Button variant="outline" size="sm" :disabled="refreshing" @click="rescan">
            <RefreshCw :class="refreshing ? 'animate-spin' : ''" />
          </Button>
        </IconTooltip>
      </div>

      <!-- a partial store says so before any number: it looks exactly like a complete one -->
      <p v-if="coverage && !complete" class="text-2xs leading-snug text-muted-foreground">
        {{ $t('analytics.partial', { n: coverage.sessions, total: coverage.total }) }}
      </p>

      <template v-if="loading">
        <Skeleton class="h-24 w-full" />
        <Skeleton class="h-44 w-full" />
        <Skeleton class="h-44 w-full" />
      </template>

      <template v-else-if="!spend || (spend.calls === 0 && allSources)">
        <div class="rounded-lg border border-border p-6 text-center text-xs text-muted-foreground">
          {{ $t('analytics.empty') }}
        </div>
      </template>

      <template v-else>
        <!-- The lead row: four numbers, each beside what it compares with, no plot. A stat tile is
             the right form when the answer is one number. Fixed units on purpose (tokens, dollars,
             dollars, a model), so the unit switch never turns two tiles into the same figure. -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="min-w-0 rounded-lg border border-border p-3">
            <p class="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span class="truncate">
                {{ $t('analytics.leadUsed') }} · {{ usage.weekly ? $t('sessions.period7d') : periodLabel }}
              </span>
              <InfoHint :text="$t('analytics.leadUsedNote')" />
            </p>
            <p class="text-xl font-semibold tabular-nums">{{ formatCompact(usage.tokens) }}</p>
            <p class="mt-0.5 truncate text-2xs text-muted-foreground">{{ usageVersus }}</p>
          </div>
          <div class="min-w-0 rounded-lg border border-border p-3">
            <p class="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span class="truncate">{{ $t('analytics.leadCost') }} · {{ periodLabel }}</span>
              <InfoHint>
                <span class="block">{{ $t('analytics.listPrice') }}</span>
                <span class="mt-1 block">{{ pricesNote }}</span>
              </InfoHint>
            </p>
            <p class="text-xl font-semibold tabular-nums">
              {{ spend.totalCostUsd === null ? '—' : formatUsd(spend.totalCostUsd)
              }}<span v-if="spend.unpricedModels.length">+</span>
            </p>
            <p class="mt-0.5 truncate text-2xs text-muted-foreground">{{ costVersus }}</p>
          </div>
          <div class="min-w-0 rounded-lg border border-border p-3">
            <p class="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span class="truncate">{{ $t('analytics.leadSaved') }} · {{ $t('sessions.period7d') }}</span>
              <!-- the rest of HSwarm's card: today, all time, tasks and tokens kept off today -->
              <InfoHint>
                <template v-for="tile in swarmTiles" :key="tile.key">
                  <span class="block tabular-nums">{{ tile.label }}: {{ tile.value }}</span>
                  <span v-if="tile.hint" class="block">{{ tile.hint }}</span>
                </template>
              </InfoHint>
            </p>
            <button
              type="button"
              class="text-xl font-semibold tabular-nums hover:underline"
              :title="$t('analytics.leadSavedOpen')"
              @click="openView('hswarm')"
            >
              {{ money(swarmWeek.sum) }}
            </button>
            <p class="mt-0.5 truncate text-2xs text-muted-foreground">{{ swarmVersus }}</p>
          </div>
          <div class="min-w-0 rounded-lg border border-border p-3">
            <p class="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span class="truncate">{{ $t('analytics.leadModel') }} · {{ periodLabel }}</span>
              <InfoHint :text="$t('analytics.leadModelNote')" />
            </p>
            <p class="truncate text-xl font-semibold" :title="busiestModel?.detail">
              {{ busiestModel?.key ?? '—' }}
            </p>
            <p class="mt-0.5 truncate text-2xs text-muted-foreground">
              {{
                !busiestModel
                  ? ''
                  : tokenMode
                    ? $t('analytics.leadModelTokens', { pct: busiestModel.pct })
                    : $t('analytics.leadModelCost', { pct: busiestModel.pct })
              }}
            </p>
          </div>
        </div>

        <!-- A source filter with no calls empties the spend area only: activity, concurrency, edits
             and the tool list below do not depend on it. -->
        <div
          v-if="spend.calls === 0"
          class="rounded-lg border border-border p-6 text-center text-xs text-muted-foreground"
        >
          {{ $t('analytics.emptySources') }}
        </div>
        <template v-else>
        <!-- Over time: bars for the trend, or the same days as a calendar. Gray, with the current
             period in the accent and named beside the title, so the blue explains itself. -->
        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-medium">
            {{ timeTitle }}
            <InfoHint
              :text="timeView === 'calendar' ? $t('analytics.calendarNote') : $t('analytics.timeNote')"
            />
            <span class="ms-1 flex items-center gap-1 text-3xs font-normal text-muted-foreground">
              <span class="size-2 rounded-xs bg-(--viz-seq)"></span>{{ accentLabel }}
            </span>
            <!-- Pushed right and quiet: a grain or view switch is a preference, not a headline. -->
            <span class="ms-auto flex items-center gap-0.5">
              <template v-if="timeView === 'bars' && !byHour">
                <button
                  v-for="g in (['day', 'month'] as const)"
                  :key="g"
                  type="button"
                  class="rounded px-1.5 py-0.5 text-3xs font-normal transition-colors"
                  :class="
                    (g === 'month') === groupedByMonth
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  :aria-pressed="(g === 'month') === groupedByMonth"
                  @click="timeGrain = g"
                >{{ g === 'day' ? $t('analytics.grainDay') : $t('analytics.grainMonth') }}</button>
                <span class="mx-1 h-3 w-px bg-border"></span>
              </template>
              <button
                v-for="v in (['bars', 'calendar'] as const)"
                :key="v"
                type="button"
                class="rounded px-1.5 py-0.5 text-3xs font-normal transition-colors"
                :class="
                  timeView === v
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                "
                :aria-pressed="timeView === v"
                @click="timeView = v"
              >{{ v === 'bars' ? $t('analytics.grainBars') : $t('analytics.grainCalendar') }}</button>
            </span>
          </h3>
          <p
            v-if="dayTokensMissing"
            class="py-6 text-center text-2xs text-muted-foreground"
          >{{ $t('analytics.noTokenData') }}</p>
          <CalendarGrid
            v-else-if="timeView === 'calendar'"
            :days="calendarDays"
            :format="metricFormat"
            :value-label="tokenMode ? $t('analytics.tipTokens') : $t('analytics.tipCost')"
            :is-accent="isCurrent"
          />
          <TimeBars
            v-else
            :points="dayPoints"
            :format="metricFormat"
            :axis-format="tokenMode ? formatCompact : axisUsd"
            :value-label="tokenMode ? $t('analytics.tipTokens') : $t('analytics.tipCost')"
            :share-label="$t('analytics.tipShareOfWindow')"
            :peak-label="
              byHour
                ? $t('analytics.tipBusiestHour')
                : groupedByMonth
                  ? $t('analytics.tipBusiestMonth')
                  : $t('analytics.tipBusiestDay')
            "
            :is-accent="isCurrent"
          />
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">
              {{ tokenMode ? $t('analytics.tokensByModel') : $t('analytics.costByModel') }}
            </h3>
            <BarRows
              :rows="modelRows"
              :more="modelMore"
              :more-label="$t('analytics.showMore', { n: modelMore.length })"
              :format="metricFormat"
              accent="top"
            />
            <!-- Named, not drawn at zero: a model with no published price did not cost nothing. In
                 tokens they are in the list above, where a count needs no price. -->
            <div v-if="!tokenMode && unpricedTokenRows.length" class="mt-3 border-t border-border pt-2">
              <p class="mb-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                {{ $t('analytics.unpricedTitle') }}
                <InfoHint :text="$t('analytics.unpricedNote')" />
              </p>
              <BarRows
                :rows="unpricedTokenRows"
                :more="unpricedMore"
                :more-label="$t('analytics.showMore', { n: unpricedMore.length })"
                :format="formatCompact"
                accent="none"
              />
            </div>
          </section>
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">
              {{ tokenMode ? $t('analytics.tokensByProject') : $t('analytics.costByProject') }}
            </h3>
            <p
              v-if="projectTokensMissing"
              class="py-6 text-center text-2xs text-muted-foreground"
            >{{ $t('analytics.noTokenData') }}</p>
            <BarRows
              v-else
              :rows="projectRows"
              :more="projectMore"
              :more-label="$t('analytics.showMore', { n: projectMore.length })"
              :format="metricFormat"
              accent="top"
            />
          </section>
        </div>

        <div class="grid gap-3" :class="accountRows.length ? 'lg:grid-cols-2' : ''">
          <section v-if="accountRows.length" class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              {{ tokenMode ? $t('analytics.tokensByAccount') : $t('analytics.costByAccount') }}
              <InfoHint :text="$t('analytics.accountNote')" />
            </h3>
            <p
              v-if="accountTokensMissing"
              class="py-6 text-center text-2xs text-muted-foreground"
            >{{ $t('analytics.noTokenData') }}</p>
            <BarRows
              v-else
              :rows="accountRows"
              :more="accountMore"
              :more-label="$t('analytics.showMore', { n: accountMore.length })"
              :format="metricFormat"
              accent="top"
            />
          </section>

          <!-- How much work, of what kind, from which tool: the old headline counts (sessions,
               agent hours, raw and weighted tokens), the token split and the per-tool rows in one
               place, since each is a way of sizing the same volume. -->
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              {{ $t('analytics.volume') }}
              <InfoHint>
                <span class="block">{{ $t('analytics.volumeNote') }}</span>
                <span class="mt-1 block">{{ $t('analytics.tokenSplitNote') }}</span>
              </InfoHint>
            </h3>
            <dl class="mb-3 flex flex-wrap gap-x-6 gap-y-1">
              <div>
                <dt class="text-2xs text-muted-foreground">{{ $t('analytics.sessions') }}</dt>
                <dd class="text-sm font-semibold tabular-nums">{{ formatCompact(spend.sessions) }}</dd>
              </div>
              <div>
                <dt class="text-2xs text-muted-foreground">{{ $t('analytics.agentHours') }}</dt>
                <dd class="text-sm font-semibold tabular-nums">{{ formatCompact(agentHours) }}</dd>
              </div>
              <!-- On a 24-hour or 7-day window the lead row's tokens tile already is this figure, so
                   it is said once, there. -->
              <div v-if="usage.weekly">
                <dt class="text-2xs text-muted-foreground">{{ $t('analytics.totalTokens') }}</dt>
                <dd class="text-sm font-semibold tabular-nums">{{ formatCompact(spend.tokens.total) }}</dd>
              </div>
              <!-- Says what "weighted" MEANS on the figure itself: it sits beside a raw total
                   several times its size, and without it the only honest reaction is to assume one
                   of them is broken. -->
              <div>
                <dt class="flex items-center gap-1 text-2xs text-muted-foreground">
                  {{ $t('analytics.tokens') }}
                  <InfoHint :text="$t('analytics.tokensNote')" />
                </dt>
                <dd class="text-sm font-semibold tabular-nums">{{ formatCompact(spend.totalWeighted) }}</dd>
              </div>
            </dl>
            <TokenSplit :tokens="spend.tokens" />
            <div v-if="providerRows.length > 1" class="mt-3 border-t border-border pt-2">
              <p class="mb-1.5 text-2xs text-muted-foreground">{{ $t('analytics.byProvider') }}</p>
              <BarRows :rows="providerRows" :format="formatCompact" accent="top" />
            </div>
          </section>
        </div>
        </template>

        <!-- Token sinks: WHY the spend above happened. Structural sinks are configuration (a skill
             or MCP server loaded into every prompt and never used), behavioral ones are how the
             sessions ran. Badges name the kind and an estimate, never colour alone; each fix sits
             behind its row's info icon. -->
        <section v-if="sinks && sinks.sessions" class="rounded-lg border border-border p-3">
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
            {{ $t('analytics.sinks') }}
            <InfoHint :text="$t('analytics.sinksNote')" />
          </h3>
          <ul class="mb-3 space-y-1">
            <li v-for="s in sinks.sinks" :key="s.id" class="flex items-center gap-2 text-2xs">
              <span class="flex min-w-0 flex-1 items-center gap-1">
                <span class="truncate font-medium">{{ sinkLabel(s.id) }}</span>
                <InfoHint :text="sinkFix(s.id)" />
              </span>
              <Badge variant="outline" class="shrink-0">
                <span class="font-normal">{{ s.kind === 'structural' ? $t('analytics.sinkStructural') : $t('analytics.sinkBehavioral') }}</span>
              </Badge>
              <Badge
                v-if="s.basis === 'estimated'"
                variant="secondary"
                class="shrink-0"
              ><span class="font-normal">{{ $t('analytics.sinkEstimated') }}</span></Badge>
              <span class="shrink-0 tabular-nums">{{ formatCompact(s.weighted) }}</span>
              <span class="w-10 shrink-0 text-end tabular-nums text-muted-foreground">
                {{ percent(s.share) }}
              </span>
            </li>
          </ul>
          <div class="grid gap-3 lg:grid-cols-2">
            <div>
              <h4 class="mb-1 text-2xs font-medium">{{ $t('analytics.deadSkills') }}</h4>
              <p
                v-if="!deadSkillRows.length"
                class="text-2xs text-muted-foreground"
              >{{ $t('analytics.deadNone') }}</p>
              <BarRows
                v-else
                :rows="deadSkillRows.slice(0, TOP)"
                :more="deadSkillRows.slice(TOP)"
                :more-label="$t('analytics.showMore', { n: deadSkillRows.slice(TOP).length })"
                :format="formatCompact"
                accent="top"
              />
            </div>
            <div>
              <h4 class="mb-1 text-2xs font-medium">{{ $t('analytics.deadMcp') }}</h4>
              <p
                v-if="!deadMcpRows.length"
                class="text-2xs text-muted-foreground"
              >{{ $t('analytics.deadNone') }}</p>
              <BarRows
                v-else
                :rows="deadMcpRows.slice(0, TOP)"
                :more="deadMcpRows.slice(TOP)"
                :more-label="$t('analytics.showMore', { n: deadMcpRows.slice(TOP).length })"
                :format="formatCompact"
                accent="top"
              />
            </div>
          </div>
          <p class="mt-3 text-2xs text-muted-foreground">
            {{
              $t('analytics.sinkCounts', {
                deep: formatCompact(sinks.deepContext.calls),
                calls: formatCompact(sinks.calls),
                spawns: formatCompact(sinks.subagents.spawns),
              })
            }}
          </p>
          <div v-if="cacheRows.length" class="mt-3">
            <h4 class="mb-1 text-2xs font-medium">{{ $t('analytics.cacheByAccount') }}</h4>
            <BarRows
              :rows="cacheRows.slice(0, TOP)"
              :more="cacheRows.slice(TOP)"
              :more-label="$t('analytics.showMore', { n: cacheRows.slice(TOP).length })"
              :format="percent"
              accent="none"
            />
          </div>
        </section>

        <div class="grid gap-3 lg:grid-cols-2">
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              {{ $t('analytics.health') }}
              <InfoHint :text="$t('analytics.healthNote')" />
            </h3>
            <!-- edit survival: the share of written code still on disk hours later (server/src/edit-survival.ts) -->
            <p v-if="survivalAverage" class="mb-2 text-2xs text-muted-foreground">
              {{ $t('analytics.survivalAverage', survivalAverage) }}
            </p>
            <p
              v-if="!healthRows.length"
              class="text-2xs text-muted-foreground"
            >{{ $t('analytics.healthNone') }}</p>
            <ul v-else class="space-y-1">
              <li
                v-for="h in shownHealth"
                :key="h.session_id"
                class="flex items-center gap-2 text-2xs"
              >
                <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="h.project">
                  {{ baseName(h.project) || h.project }}
                </span>
                <!-- badges, not colour alone: each signal is named as well as counted -->
                <Badge v-if="h.toolErrorStreak >= 3" variant="outline" class="shrink-0">
                  {{ $t('analytics.streak', { n: h.toolErrorStreak }) }}
                </Badge>
                <Badge v-if="h.compactions" variant="outline" class="shrink-0">
                  {{ $t('analytics.compactions', { n: h.compactions }) }}
                </Badge>
                <Badge v-if="h.edits >= 40" variant="outline" class="shrink-0">
                  {{ $t('analytics.churn', { n: h.edits }) }}
                </Badge>
                <Badge
                  v-if="h.editSurvival != null && h.editSurvival < 0.5"
                  variant="outline"
                  class="shrink-0"
                >
                  {{ $t('analytics.survived', { pct: Math.round(h.editSurvival * 100) }) }}
                </Badge>
              </li>
              <li v-if="healthRows.length > TOP">
                <button
                  type="button"
                  class="mt-0.5 text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  @click="healthAll = !healthAll"
                >
                  {{ healthAll ? $t('analytics.showLess') : $t('analytics.showMore', { n: healthRows.length - TOP }) }}
                </button>
              </li>
            </ul>
          </section>

          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 text-xs font-medium">{{ $t('analytics.toolMix') }}</h3>
            <BarRows
              :rows="toolRows"
              :more="toolMore"
              :more-label="$t('analytics.showMore', { n: toolMore.length })"
              :format="formatCompact"
              accent="top"
            />
          </section>
        </div>

        <div class="grid gap-3 lg:grid-cols-2">
          <!-- "What time of day do I work": every date folded into a 7x24 rhythm, the busiest
               hour in the accent. The calendar ("which weeks") is the time panel's second view. -->
          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              {{ $t('analytics.hoursTitle') }}
              <InfoHint :text="$t('analytics.hourNote')" />
            </h3>
            <HourGrid :hours="activity?.hours ?? []" />
          </section>

          <section class="rounded-lg border border-border p-3">
            <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
              {{ $t('analytics.concurrency') }}
              <InfoHint :text="$t('analytics.concurrencyNote')" />
            </h3>
            <AreaLine
              :points="concurrencyPoints"
              :format="(n: number) => String(Math.round(n))"
              :label-at="clockLabel"
              :value-label="$t('analytics.tipSessions')"
              :change-label="$t('analytics.tipChange')"
              :peak-label="$t('analytics.tipPeak')"
              accent-peak
            />
          </section>
        </div>

        <CommandCorrections />

        <section class="rounded-lg border border-border p-3">
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
            {{ $t('analytics.recentEdits') }}
            <InfoHint :text="$t('analytics.editsNote')" />
          </h3>
          <p
            v-if="!editGroups.length"
            class="text-2xs text-muted-foreground"
          >{{ $t('analytics.editsNone') }}</p>
          <div v-for="[project, list] in shownEditGroups" :key="project" class="mb-3">
            <p class="mb-0.5 flex items-baseline gap-2 text-2xs font-medium">
              <FolderGit2 class="size-3 shrink-0 text-muted-foreground" />
              {{ baseName(project) || project }}
              <span class="text-3xs font-normal text-muted-foreground">{{ project }}</span>
            </p>
            <EditsFeed :project="project" :edits="list" />
          </div>
          <button
            v-if="editGroups.length > EDIT_GROUPS"
            type="button"
            class="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            @click="editsAll = !editsAll"
          >
            {{ editsAll ? $t('analytics.showLess') : $t('analytics.showMore', { n: editGroups.length - EDIT_GROUPS }) }}
          </button>
        </section>

        <!-- What ELSE is on this machine. Listed even where we cannot read it: silence would read
             as "AgentHydra looked and found nothing", which is a different claim entirely. -->
        <section v-if="agentTools.length" class="rounded-lg border border-border p-3">
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-medium">
            {{ $t('analytics.toolsFound') }}
            <InfoHint :text="$t('analytics.toolsFoundNote')" />
          </h3>
          <ul class="grid gap-1 sm:grid-cols-2">
            <li
              v-for="tool in shownAgentTools"
              :key="tool.id"
              class="flex items-center gap-2 rounded px-1 py-0.5 text-2xs hover:bg-muted/50"
              :title="tool.roots.join('\n')"
            >
              <span class="min-w-0 flex-1 truncate">
                {{ tool.name }}
                <span class="ms-1 text-3xs text-muted-foreground">{{ tool.vendor }}</span>
              </span>
              <span class="shrink-0 tabular-nums text-muted-foreground">
                {{ formatCompact(tool.files) }}<span v-if="tool.truncated">+</span>
              </span>
              <!-- A badge, not a colour: "we cannot read this" is a fact that has to be readable
                   without seeing hue, and it needs its reason next to it. -->
              <Badge
                v-if="tool.format === null"
                variant="outline"
                class="shrink-0"
              >
                <span class="font-normal">{{ toolNoteLabel(tool.note) }}</span>
              </Badge>
              <Badge v-else variant="secondary" class="shrink-0">
                <span class="font-normal">{{ $t('analytics.toolRead') }}</span>
              </Badge>
            </li>
          </ul>
          <button
            v-if="agentTools.length > AGENT_TOOLS"
            type="button"
            class="mt-1 text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            @click="agentToolsAll = !agentToolsAll"
          >
            {{ agentToolsAll ? $t('analytics.showLess') : $t('analytics.showMore', { n: agentTools.length - AGENT_TOOLS }) }}
          </button>
        </section>
      </template>
    </div>
  </div>
</template>
