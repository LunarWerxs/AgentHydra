import { useStorage } from '@vueuse/core'
import { ref } from 'vue'
import type {
  Account,
  ArchivedScope,
  QueueItem,
  SchedulerState,
  SessionPeriod,
  SessionSourceScope,
  SessionSummary,
} from '@/lib/api'
import * as api from '@/lib/api'
import { registerSharedPref } from './useSharedPrefs'

const sessions = ref<SessionSummary[]>([])
const queue = ref<QueueItem[]>([])
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

// All three are ALSO mirrored through the daemon (composables/useSharedPrefs.ts): the daemon hops
// to another port whenever its preferred one is busy, and a browser scopes localStorage per origin
// — port included — so without this these reset to their defaults on any launch that hops. Each one
// declares its value set, because the store is a plain file and an unknown scope would reach a
// control that has no such option.
const ARCHIVED_SCOPES: readonly ArchivedScope[] = ['hide', 'include', 'only']
const SESSION_PERIODS: readonly SessionPeriod[] = ['24h', '7d', '30d', 'all']
const SESSION_SOURCES: readonly SessionSourceScope[] = ['all', 'claude', 'codex', 'opencode']
registerSharedPref('agenthydra.sessions.archivedScope', sessionArchivedScope, ARCHIVED_SCOPES)
registerSharedPref('agenthydra.sessions.period', sessionPeriod, SESSION_PERIODS)
registerSharedPref('agenthydra.sessions.source', sessionSourceFilter, SESSION_SOURCES)
// true once the first queue fetch has settled — gates the queue's first-load skeletons
const queueLoaded = ref(false)
const lastError = ref<string | null>(null)

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

async function refreshSessions() {
  sessionsLoading.value = true
  const r = await guard(
    api.getSessions(
      200,
      sessionInstanceFilter.value,
      sessionArchivedScope.value,
      sessionPeriod.value,
      sessionSourceFilter.value,
    ),
  )
  if (r) sessions.value = r
  sessionsLoading.value = false
}
async function refreshQueue() {
  const r = await guard(api.getQueue())
  if (r) queue.value = r
  queueLoaded.value = true
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
  refreshAccounts()
  refreshScheduler()
  // queue + scheduler are cheap and change often while runs are active
  fastTimer = window.setInterval(() => {
    refreshQueue()
    refreshScheduler()
  }, 2000)
  // sessions require disk scans — refresh more lazily
  slowTimer = window.setInterval(refreshSessions, 12000)
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
    accounts,
    scheduler,
    sessionsLoading,
    sessionInstanceFilter,
    sessionArchivedScope,
    sessionPeriod,
    sessionSourceFilter,
    queueLoaded,
    lastError,
    refreshSessions,
    refreshQueue,
    refreshAccounts,
    refreshScheduler,
    startPolling,
    stopPolling,
  }
}
