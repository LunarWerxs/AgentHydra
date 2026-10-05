// The Analytics tab's data, one shared copy: the page only reads it. lib/warm-data.ts keeps it fresh
// in the background (about every 2 minutes), and the page asks again when it opens or its window or
// source selection changes. Module scope, so it is already filled when the tab is first opened.
import { ref, shallowRef } from 'vue'
import { ANALYTICS_SOURCES } from '@/lib/analytics-sources'
import type {
  ActivityReport,
  AgentPresence,
  ConcurrencyPoint,
  EditEntry,
  SpendReport,
  TokenSinkReport,
} from '@/lib/api'
import * as api from '@/lib/api'
import { scopeParam } from '@/lib/session-scopes'
import { useAnalyticsPrefs } from './useAnalyticsPrefs'

const spend = shallowRef<SpendReport | null>(null)
const activity = shallowRef<ActivityReport | null>(null)
const concurrency = shallowRef<ConcurrencyPoint[]>([])
const edits = shallowRef<EditEntry[]>([])
/** Where the tokens went and why (server/src/analytics.ts sinkReport). */
const sinks = shallowRef<TokenSinkReport | null>(null)
/** Tools found on this machine, readable or not. Independent of the period filter: an install is
 *  not something that happened in the last 30 days. */
const agentTools = shallowRef<AgentPresence[]>([])
// The reports are replaced whole by each read and never edited, so they are shallow: no deep proxy
// over a large payload, and a refresh that brings the same report again writes nothing.
/** What each report looked like when it last landed, so an identical one can be told apart. */
const seen = new WeakMap<object, string>()
/** Stores `next` unless it says the same as what is held. */
function land<T>(target: { value: T }, next: T) {
  const had = target.value
  if (had && next && typeof had === 'object' && typeof next === 'object') {
    let before = seen.get(had)
    if (before === undefined) {
      before = JSON.stringify(had)
      seen.set(had, before)
    }
    const after = JSON.stringify(next)
    if (before === after) return
    seen.set(next, after)
  }
  target.value = next
}

/** True until the first read settles, and while a non-quiet read (a changed window) is running. */
const loading = ref(true)

// Request tokens: only the newest request of each kind may land, and `loading` clears only when
// nothing newer is still in flight. `latest` guards the period-wide reads, `latestSpend` the one read
// that also depends on the source selection.
let latest = 0
let latestSpend = 0
let pageBusy = false
let spendBusy = false
const settle = () => {
  loading.value = pageBusy || spendBusy
}

/** The spend read, the only one a source change repeats. `quiet`: a timed or on-open refresh, which
 *  keeps the charts on screen instead of the skeletons. */
async function loadSpend(wantQuiet = false): Promise<void> {
  const { analyticsPeriod, analyticsSources, analyticsPc } = useAnalyticsPrefs()
  // Nothing on screen yet: the skeletons are the honest state, so the first read is never quiet.
  const quiet = wantQuiet && spend.value !== null
  const mine = ++latestSpend
  if (!quiet) {
    spendBusy = true
    loading.value = true
  }
  try {
    const s = await api.getSpend(
      analyticsPeriod.value,
      scopeParam(analyticsSources.value, ANALYTICS_SOURCES),
      analyticsPc.value === 'self' ? 'self' : undefined,
    )
    if (mine === latestSpend) land(spend, s)
  } catch {
    if (mine === latestSpend && !quiet) spend.value = null
  } finally {
    if (mine === latestSpend) {
      spendBusy = false
      settle()
    }
  }
}

async function loadAnalytics(wantQuiet = false): Promise<void> {
  const { analyticsPeriod } = useAnalyticsPrefs()
  const quiet = wantQuiet && activity.value !== null
  const mine = ++latest
  const period = analyticsPeriod.value
  if (!quiet) {
    pageBusy = true
    loading.value = true
  }
  const spendDone = loadSpend(wantQuiet)
  try {
    // In parallel: independent reads of the same warmed table. The tool scan is the one that touches
    // disk; it is capped and cached server-side, and its failure must not take the charts with it.
    const [a, c, e, tools, k] = await Promise.all([
      api.getActivity(period),
      api.getConcurrency(period, period === '24h' ? 60 : 180),
      api.getRecentEdits(120),
      // The tool scan does not depend on time, so a quiet refresh leaves it out.
      quiet ? null : api.getAgentTools().catch(() => ({ tools: [] })),
      // An addition to the page: a daemon without the route must not blank every chart.
      api.getSinks(period).catch(() => null),
    ])
    if (mine !== latest) return // the window moved on while we were fetching
    land(activity, a)
    land(concurrency, c.buckets)
    // Always replaced: the feed's "3m ago" labels are worked out when it draws, so even an unchanged
    // list is drawn again on each refresh to keep them true.
    edits.value = e.edits
    if (tools) land(agentTools, tools.tools)
    land(sinks, k)
  } catch {
    if (mine === latest && !quiet) activity.value = null
  } finally {
    if (mine === latest) {
      pageBusy = false
      settle()
    }
  }
  await spendDone
}

export function useAnalyticsData() {
  return { spend, activity, concurrency, edits, sinks, agentTools, loading, loadAnalytics, loadSpend }
}
