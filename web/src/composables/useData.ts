import { useStorage } from '@vueuse/core'
import { ref } from 'vue'
import type {
  Account,
  ArchivedScope,
  DispatchedScope,
  Incident,
  QueueItem,
  RateLimitScope,
  SchedulerState,
  SessionPeriod,
  SessionSourceScope,
  SessionSummary,
} from '@/lib/api'
import * as api from '@/lib/api'
import { SHAPE_SCOPES, type ShapeScope } from '@/lib/session-shape'
import { registerSharedPref } from './useSharedPrefs'

const sessions = ref<SessionSummary[]>([])
const queue = ref<QueueItem[]>([])
const incidents = ref<Incident[]>([])
const accounts = ref<Account[]>([])
const scheduler = ref<SchedulerState | null>(null)
const sessionsLoading = ref(false)
// Server-side instance scope for the sessions list ('' = all). Lives here so the
// polling refresh keeps honoring whatever the sidebar filter picked.
const sessionInstanceFilter = ref('')
// Archived sessions (Claude's own `isArchived` flag) are shown alongside live sessions by
// default. The three-way scope remains useful for narrowing to only live or only archived chats.
// All scopes are applied server-side BEFORE the newest-N cap, so a quiet corner of the list can't
// be starved out of the window by rows it was never going to show.
const sessionArchivedScope = useStorage<ArchivedScope>(
  'agenthydra.sessions.archivedScope',
  'include',
)
// How far back the list reaches, by last activity. Defaults to the last 24 hours: this list
// answers "what am I working on", and a store that has been accumulating transcripts for months
// answers it worse the further back it goes. Applied server-side before the cap, like the scopes
// above, so a widened window genuinely reaches further rather than reshuffling the same 200 rows.
const sessionPeriod = useStorage<SessionPeriod>('agenthydra.sessions.period', '24h')
// Provider scope for the unified local conversation list.
const sessionSourceFilter = useStorage<SessionSourceScope>('agenthydra.sessions.source', 'all')
// Work AgentHydra queued vs work driven by hand. 'all' by default and never narrowed on our own
// initiative — same rule the `done` mark carries: this list may be narrowed on request, never
// pruned behind the user's back. Applied server-side before the cap, like the scopes above.
const sessionDispatchedScope = useStorage<DispatchedScope>('agenthydra.sessions.dispatched', 'all')
// Session SHAPE (lib/session-shape.ts). Unlike the scopes above this one is applied in the browser,
// because it is a classification of rows already fetched rather than a question the daemon could
// answer more cheaply — the two inputs are on every row already.
const sessionShapeScope = useStorage<ShapeScope>('agenthydra.sessions.shape', 'all')
// Conversations the provider cut off at a usage/quota wall. 'all' by default and, like the
// dispatched scope above, never narrowed on our own initiative. Applied server-side, but NOT from
// the cheap mtime index: the verdict comes from the transcript parse, so the daemon narrows to what
// its scan cache already knows and settles the rest exactly (see listSessions in server/src).
const sessionRateLimitScope = useStorage<RateLimitScope>('agenthydra.sessions.rateLimited', 'all')

// All of these are ALSO mirrored through the daemon (composables/useSharedPrefs.ts): the daemon hops
// to another port whenever its preferred one is busy, and a browser scopes localStorage per origin
// — port included — so without this these reset to their defaults on any launch that hops. Each one
// declares its value set, because the store is a plain file and an unknown scope would reach a
// control that has no such option.
const ARCHIVED_SCOPES: readonly ArchivedScope[] = ['hide', 'include', 'only']
const SESSION_PERIODS: readonly SessionPeriod[] = ['24h', '7d', '30d', 'all']
const SESSION_SOURCES: readonly SessionSourceScope[] = ['all', 'claude', 'codex', 'opencode']
const DISPATCHED_SCOPES: readonly DispatchedScope[] = ['all', 'queued', 'manual']
const RATE_LIMIT_SCOPES: readonly RateLimitScope[] = ['all', 'only', 'pending']
registerSharedPref('agenthydra.sessions.archivedScope', sessionArchivedScope, ARCHIVED_SCOPES)
registerSharedPref('agenthydra.sessions.period', sessionPeriod, SESSION_PERIODS)
registerSharedPref('agenthydra.sessions.source', sessionSourceFilter, SESSION_SOURCES)
registerSharedPref('agenthydra.sessions.dispatched', sessionDispatchedScope, DISPATCHED_SCOPES)
registerSharedPref('agenthydra.sessions.shape', sessionShapeScope, SHAPE_SCOPES)
registerSharedPref('agenthydra.sessions.rateLimited', sessionRateLimitScope, RATE_LIMIT_SCOPES)
// true once the first queue fetch has settled — gates the queue's first-load skeletons
const queueLoaded = ref(false)
const lastError = ref<string | null>(null)

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
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
  // try/finally, because guard() only catches a REJECTED promise. If api.getSessions throws
  // synchronously — a bad filter value, a URL that fails to build — it never returns a promise for
  // guard to attach to, so the throw escapes past every line below and the flag stays true for the
  // life of the page. Nothing would ever refresh the session list again, and the list would sit
  // there looking merely stale rather than broken.
  try {
    const r = await guard(
      api.getSessions(
        200,
        sessionInstanceFilter.value,
        sessionArchivedScope.value,
        sessionPeriod.value,
        sessionSourceFilter.value,
        sessionDispatchedScope.value,
        sessionRateLimitScope.value,
      ),
    )
    if (r) sessions.value = r
  } finally {
    sessionsLoading.value = false
    sessionsInFlight = false
  }
  if (sessionsRefreshQueued) {
    sessionsRefreshQueued = false
    await refreshSessions()
  }
}
async function refreshQueue() {
  const r = await guard(api.getQueue())
  if (r) queue.value = r
  queueLoaded.value = true
}
async function refreshIncidents() {
  const r = await guard(api.getIncidents())
  if (r) incidents.value = r
}
async function refreshAccounts() {
  const r = await guard(api.getAccounts())
  if (r) accounts.value = r
}
async function refreshScheduler() {
  const r = await guard(api.getScheduler())
  if (r) scheduler.value = r
}

let fastTimer: number | null = null
let slowTimer: number | null = null

function startPolling() {
  if (fastTimer !== null) return
  refreshSessions()
  refreshQueue()
  refreshIncidents()
  refreshAccounts()
  refreshScheduler()
  // queue + scheduler are cheap and change often while runs are active
  fastTimer = window.setInterval(() => {
    refreshQueue()
    refreshScheduler()
  }, 2000)
  // sessions require disk scans — refresh more lazily. Incidents change only on a new failure or an
  // ack/resolve click (both already re-fetch on their own), so the slow cadence is plenty.
  slowTimer = window.setInterval(() => {
    refreshSessions()
    refreshIncidents()
  }, 12000)
}

function stopPolling() {
  if (fastTimer !== null) window.clearInterval(fastTimer)
  if (slowTimer !== null) window.clearInterval(slowTimer)
  fastTimer = null
  slowTimer = null
}

export function useData() {
  return {
    sessions,
    queue,
    incidents,
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
    queueLoaded,
    lastError,
    refreshSessions,
    refreshQueue,
    refreshIncidents,
    refreshAccounts,
    refreshScheduler,
    startPolling,
    stopPolling,
  }
}
