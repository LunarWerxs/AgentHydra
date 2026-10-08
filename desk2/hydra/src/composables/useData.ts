import { useStorage } from '@vueuse/core'
import { computed, ref, shallowRef } from 'vue'
import type {
  Account,
  AgentStatus,
  Incident,
  QueueItem,
  SchedulerState,
  SessionPeriod,
  SessionSummary,
} from '@/lib/api'
import * as api from '@/lib/api'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import { reconcileList, sameData } from '@/lib/reconcile'
import {
  ARCHIVED_VALUES,
  DEFAULT_ARCHIVED,
  DEFAULT_SOURCES,
  DISPATCHED_VALUES,
  effectiveScopes,
  type ListScopes,
  RATE_LIMIT_VALUES,
  SHAPE_VALUES,
  SOURCE_VALUES,
  sessionScopeQuery,
  WIDE_SCOPES,
} from '@/lib/session-scopes'
import { visibleInterval } from '@/lib/visible-poll'
import { usePanels } from './usePanels'
import { registerSharedPref } from './useSharedPrefs'
import { storedSelection } from './useStoredSelection'

// Polled payloads are replaced whole and never edited in place, so they are shallow: no deep proxy
// over hundreds of rows, and an unchanged poll keeps the old reference and wakes nothing.
const sessions = shallowRef<SessionSummary[]>([])
const queue = shallowRef<QueueItem[]>([])
const incidents = shallowRef<Incident[]>([])
// Live working / waiting / done per session (server/src/agent-status.ts). One cheap indexed read,
// so it rides the fast timer: a status that lags by twelve seconds is not live.
const agentStatuses = shallowRef<AgentStatus[]>([])
const accounts = shallowRef<Account[]>([])
const scheduler = shallowRef<SchedulerState | null>(null)
const sessionsLoading = ref(false)
// Server-side instance scope for the sessions list ('' = all). Lives here so the
// polling refresh keeps honoring whatever the sidebar filter picked.
// null = every instance (the default, and it keeps covering instances added later); a list = just
// those ticked, with [] meaning none. Session-only, like the single value it replaces.
const sessionInstanceFilter = ref<string[] | null>(null)

// Archived sessions (Claude's own `isArchived` flag) are shown alongside live sessions by
// default; untick one half to narrow to only live or only archived chats.
// All scopes are applied server-side BEFORE the newest-N cap, so a quiet corner of the list can't
// be starved out of the window by rows it was never going to show.
//
// `.archivedScope2` / `.source2`, not the old keys: the owner's stored value was the old all-ticked
// default (useStorage writes its default on first read), so changing the default alone would reach
// nobody. A new key applies the new defaults once and, after that, his own choices persist. Same
// versioning idiom as useUsageMode's `.usageMode2`.
const ARCHIVED_KEY = 'agenthydra.sessions.archivedScope2'
const SOURCE_KEY = 'agenthydra.sessions.source2'
const sessionArchivedScope = storedSelection(ARCHIVED_KEY, ARCHIVED_VALUES, DEFAULT_ARCHIVED)
// How far back the list reaches, by last activity. Defaults to the last 24 hours: this list
// answers "what am I working on", and a store that has been accumulating transcripts for months
// answers it worse the further back it goes. Applied server-side before the cap, like the scopes
// above, so a widened window genuinely reaches further rather than reshuffling the same 200 rows.
const sessionPeriod = useStorage<SessionPeriod>('agenthydra.sessions.period', '24h')
// Provider scope for the unified local conversation list.
// Every source but HSwarm until the owner ticks it.
const sessionSourceFilter = storedSelection(SOURCE_KEY, SOURCE_VALUES, DEFAULT_SOURCES)
// Work AgentHydra queued vs work driven by hand. Everything ticked by default and never narrowed on
// our own initiative — same rule the `done` mark carries: this list may be narrowed on request,
// never pruned behind the user's back. Applied server-side before the cap, like the scopes above.
const sessionDispatchedScope = storedSelection('agenthydra.sessions.dispatched', DISPATCHED_VALUES)
// Session SHAPE (lib/session-shape.ts). Unlike the scopes above this one is applied in the browser,
// because it is a classification of rows already fetched rather than a question the daemon could
// answer more cheaply — the two inputs are on every row already.
const sessionShapeScope = storedSelection('agenthydra.sessions.shape', SHAPE_VALUES)
// Conversations the provider cut off at a usage/quota wall: never hit one, hit one and resumed, still
// stopped at one. Everything ticked by default and, like the dispatched scope above, never narrowed
// on our own initiative. Applied server-side, but NOT from the cheap mtime index: the verdict comes
// from the transcript parse, so the daemon narrows to what its scan cache already knows and settles
// the rest exactly (see listSessions in server/src).
const sessionRateLimitScope = storedSelection('agenthydra.sessions.rateLimited', RATE_LIMIT_VALUES)

// All of these are ALSO mirrored through the daemon (composables/useSharedPrefs.ts): the daemon hops
// to another port whenever its preferred one is busy, and a browser scopes localStorage per origin
// — port included — so without this these reset to their defaults on any launch that hops. Each one
// declares its value set, because the store is a plain file and an unknown scope would reach a
// control that has no such option.
const SESSION_PERIODS: readonly SessionPeriod[] = ['24h', '7d', '30d', 'all']
registerSharedPref(ARCHIVED_KEY, sessionArchivedScope, ARCHIVED_VALUES)
registerSharedPref('agenthydra.sessions.period', sessionPeriod, SESSION_PERIODS)
registerSharedPref(SOURCE_KEY, sessionSourceFilter, SOURCE_VALUES)
registerSharedPref('agenthydra.sessions.dispatched', sessionDispatchedScope, DISPATCHED_VALUES)
registerSharedPref('agenthydra.sessions.shape', sessionShapeScope, SHAPE_VALUES)
registerSharedPref('agenthydra.sessions.rateLimited', sessionRateLimitScope, RATE_LIMIT_VALUES)

// The sidebar's search box lives here, not in the view, because it decides WHICH list is fetched:
// while it has text the list is the wide one (every source, archived, instance and period), unless
// "Only this view" is ticked, in which case the sidebar's own filters still apply to the search.
const sessionSearch = ref('')
const searchOnlyThisView = useStorage('agenthydra.sessions.searchOnlyView', false)
registerSharedPref('agenthydra.sessions.searchOnlyView', searchOnlyThisView)
const viewScopes = computed<ListScopes>(() => ({
  instance: sessionInstanceFilter.value,
  archived: sessionArchivedScope.value,
  period: sessionPeriod.value,
  source: sessionSourceFilter.value,
  dispatched: sessionDispatchedScope.value,
  rateLimit: sessionRateLimitScope.value,
  shape: sessionShapeScope.value,
}))
/** The scopes in force right now: the view's, or everything while a search is running. */
const activeScopes = computed(() =>
  effectiveScopes(viewScopes.value, sessionSearch.value, searchOnlyThisView.value),
)
// The daemon caps a page at 500; the wide list asks for all of them, the view's for 200.
const WIDE_LIMIT = 500
// true once the first queue fetch has settled — gates the queue's first-load skeletons
const queueLoaded = ref(false)

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Per-resource poll status (AH-20). Each resource owns its OWN loading/error/lastSuccessAt so one
// endpoint's outage can never contaminate another's — the single shared `lastError` this replaces
// looked plausible right up until you noticed nothing ever read it, and a queue failure and a
// sessions failure were indistinguishable inside it anyway.
//
// `stale`: the latest fetch failed but an EARLIER one already succeeded — keep showing what we
// have, just label it stale, rather than blanking a screen that still has good (if aging) data.
// `unavailable`: the FIRST fetch ever failed — there is nothing to show, so a consumer should
// render an "unavailable: <reason>" state with Retry instead of its normal empty-state CTA, which
// would otherwise read as "you have zero of these" rather than "we couldn't ask".
function resourceStatus() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastSuccessAt = ref<number | null>(null)
  const stale = computed(() => error.value !== null && lastSuccessAt.value !== null)
  const unavailable = computed(() => error.value !== null && lastSuccessAt.value === null)
  return { loading, error, lastSuccessAt, stale, unavailable }
}
type ResourceStatus = ReturnType<typeof resourceStatus>

const sessionsStatus = resourceStatus()
const queueStatus = resourceStatus()
const schedulerStatus = resourceStatus()
const incidentsStatus = resourceStatus()
const accountsStatus = resourceStatus()
const agentStatusStatus = resourceStatus()

/** Runs `p`, recording success/failure onto `status` and never throwing — but unlike the old
 *  shared `guard()`, only ever touches the ONE status object it was handed. */
function guard<T>(p: Promise<T>, status: ResourceStatus): Promise<T | undefined> {
  return p.then(
    (v) => {
      status.error.value = null
      status.lastSuccessAt.value = Date.now()
      return v
    },
    (e) => {
      status.error.value = errorMessage(e)
      return undefined
    },
  )
}

// A slow store can make /api/sessions take longer than the interval that asks for it. Without a
// guard the timer keeps firing anyway and the requests stack up, so the server answers a queue of
// identical questions whose results are all thrown away except the last.
//
// COALESCED, not dropped, and the difference matters: every filter control calls this too, so a
// refresh that arrives mid-flight can be a user changing the instance or the period — discarding
// that would leave the list showing the OLD filter with no way back but waiting for the next tick.
// So a request that arrives during one is remembered and re-run once, which reads the filter refs
// afresh and therefore answers with whatever the user last chose.
let sessionsInFlight = false
let sessionsRefreshQueued = false

async function refreshSessions() {
  if (sessionsInFlight) {
    sessionsRefreshQueued = true
    return
  }
  sessionsInFlight = true
  sessionsLoading.value = true
  sessionsStatus.loading.value = true
  // try/finally, because guard() only catches a REJECTED promise. If api.getSessions throws
  // synchronously — a bad filter value, a URL that fails to build — it never returns a promise for
  // guard to attach to, so the throw escapes past every line below and the flag stays true for the
  // life of the page. Nothing would ever refresh the session list again, and the list would sit
  // there looking merely stale rather than broken.
  try {
    // Instance, queued work and usage wall are facts about Claude sessions. With Claude unticked
    // their submenus are disabled, so whatever they hold must not reach the server.
    const sc = activeScopes.value
    const q = sessionScopeQuery(sc)
    const r = await guard(
      api.getSessions(
        sc === WIDE_SCOPES ? WIDE_LIMIT : 200,
        q.instance ?? '',
        q.archived,
        sc.period,
        q.source,
        q.dispatched,
        q.ratelimited,
        true,
        sessionSearch.value.trim(),
      ),
      sessionsStatus,
    )
    // A rejected fetch must not touch the sessions the list is already showing — the old data
    // stays on screen (sessionsStatus.stale says so) rather than being blanked by an outage.
    if (r) sessions.value = reconcileList(sessions.value, r, (x) => x.locator)
  } finally {
    sessionsLoading.value = false
    sessionsStatus.loading.value = false
    sessionsInFlight = false
  }
  if (sessionsRefreshQueued) {
    sessionsRefreshQueued = false
    await refreshSessions()
  }
}
// Same hazard as the sessions coalescer above, but the shape that fits is simpler: queue and
// scheduler refreshes take no filter, so there is nothing to re-run with fresher inputs — the only
// thing that can go wrong is a slow OLDER request landing after a faster NEWER one and overwriting
// it. A generation counter is enough: only the response belonging to the most recently ISSUED call
// may be applied. This is not "last to resolve wins", it is "last to be asked for wins" — an old
// request that resolves last is still discarded, which is what stops a slow poll from resurrecting
// a row a post-mutation refresh had already dropped.
let queueGeneration = 0
let lastQueueFetch = 0
const { queueOpen } = usePanels()
function schedulerCounts() {
  const s = scheduler.value
  return `${s?.running_count ?? ''}/${s?.queued_count ?? ''}`
}
async function refreshQueue() {
  const gen = ++queueGeneration
  lastQueueFetch = Date.now()
  queueStatus.loading.value = true
  const r = await guard(api.getQueue(), queueStatus)
  if (gen !== queueGeneration) return
  queueStatus.loading.value = false
  // Same rule as sessions: a failed poll leaves the last-known queue on screen (marked stale via
  // queueStatus.stale) instead of wiping it, and `queueLoaded` still flips once the FIRST attempt
  // has settled either way, so a first-load failure falls through to queueStatus.unavailable
  // rather than being read as "queue is empty".
  if (r) queue.value = reconcileList(queue.value, r, (i) => i.id)
  queueLoaded.value = true
}
async function refreshIncidents() {
  const r = await guard(api.getIncidents(), incidentsStatus)
  if (r) incidents.value = reconcileList(incidents.value, r, (i) => i.id)
}
async function refreshAgentStatuses() {
  const r = await guard(api.getAgentStatuses(), agentStatusStatus)
  if (r) agentStatuses.value = reconcileList(agentStatuses.value, r, (a) => a.sessionId)
}
async function refreshAccounts() {
  const r = await guard(api.getAccounts(), accountsStatus)
  if (r) accounts.value = reconcileList(accounts.value, r, (a) => a.id)
}
let schedulerGeneration = 0
async function refreshScheduler() {
  const gen = ++schedulerGeneration
  schedulerStatus.loading.value = true
  const r = await guard(api.getScheduler(), schedulerStatus)
  if (gen !== schedulerGeneration) return
  schedulerStatus.loading.value = false
  if (r && !sameData(scheduler.value, r)) scheduler.value = r
}

const SLOW_MS = 12000
let lastSchedulerFetch = 0
let stopFast: (() => void) | null = null
let stopSlow: (() => void) | null = null

// The scheduler is read every 2 s only while the drawer is open or something is queued or running;
// otherwise at the slow pace, which is what an idle pane needs to notice new work. The queue answer
// carries every item with its whole prompt, so it is fetched only when the scheduler's counts moved,
// at 2 s while live, and otherwise every 15 s as a safety net for edits made elsewhere.
async function fastTick() {
  const s = scheduler.value
  // A queued item cannot start while headless queueing is off (lib/headless.ts), so it is not work in flight:
  // one stuck in the queue pinned this poll, and the queue's whole prompts, at 2 s for the pane's life.
  const queued = HEADLESS_QUEUEING_ENABLED ? (s?.queued_count ?? 0) : 0
  const busy = queueOpen.value || (s?.running_count ?? 0) > 0 || queued > 0
  if (!busy && Date.now() - lastSchedulerFetch < SLOW_MS) return
  lastSchedulerFetch = Date.now()
  const before = schedulerCounts()
  await refreshScheduler()
  const live = queueOpen.value || (scheduler.value?.running_count ?? 0) > 0
  if (live || schedulerCounts() !== before || Date.now() - lastQueueFetch >= 15000) refreshQueue()
}

// Desk 2's copy has no Sessions tab and nothing on screen reads `sessions` or `agentStatuses`
// (Desk draws its own cloud list), so neither is polled: a view that wants one calls
// refreshSessions() / refreshAgentStatuses() itself. The sessions poll made the daemon re-scan
// transcripts every 12 s for a list nobody saw.
function startPolling() {
  if (stopFast !== null) return
  refreshQueue()
  refreshIncidents()
  refreshAccounts()
  lastSchedulerFetch = Date.now()
  refreshScheduler()
  // Both rest while the page is hidden and catch up once when it is shown again (lib/visible-poll.ts);
  // the scheduler's catch-up still waits out its slow pace, so a quick slide in and out costs nothing.
  stopFast = visibleInterval(() => void fastTick(), 2000)
  // Incidents change only on a new failure or an ack/resolve click (both already re-fetch on their
  // own), so the slow cadence is plenty.
  stopSlow = visibleInterval(() => void refreshIncidents(), SLOW_MS)
}

function stopPolling() {
  stopFast?.()
  stopSlow?.()
  stopFast = null
  stopSlow = null
}

export function useData() {
  return {
    sessions,
    queue,
    incidents,
    agentStatuses,
    accounts,
    scheduler,
    sessionsLoading,
    sessionInstanceFilter,
    sessionArchivedScope,
    sessionPeriod,
    sessionSourceFilter,
    sessionDispatchedScope,
    sessionRateLimitScope,
    sessionShapeScope,
    sessionSearch,
    searchOnlyThisView,
    viewScopes,
    activeScopes,
    queueLoaded,
    sessionsStatus,
    queueStatus,
    schedulerStatus,
    incidentsStatus,
    accountsStatus,
    refreshSessions,
    refreshQueue,
    refreshIncidents,
    refreshAgentStatuses,
    refreshAccounts,
    refreshScheduler,
    startPolling,
    stopPolling,
  }
}
