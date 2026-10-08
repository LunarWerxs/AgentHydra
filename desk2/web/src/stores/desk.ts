import { ref, shallowRef, computed, reactive, shallowReactive, isReactive, toRaw, watch } from 'vue'
import type {
  ChatSummary,
  TranscriptItem,
  ExternalSession,
  HomeStats,
  HomeStatsRange,
  CliMayteWorker,
  SwarmJob,
  AccountInfo,
  AccountRef,
  DeskSettings,
  ServerEvent,
  ClientEvent,
  CreateChatRequest,
  SendMessageRequest,
  PermissionDecision,
  QuestionAnswer,
  PlanDecision,
  ChatPatch,
  ImportSessionRequest,
  ForkChatRequest,
  RewindChatRequest,
  SearchHit,
  SessionMeta,
  SessionMetaPatch,
  ElicitationAnswer,
  QueueAddRequest,
  QueueItem,
  QueuePatch,
  QueueReorder,
  QueueSettingsPatch,
  QueueState,
  SendNowRequest,
  SendNowResult,
  ExternalBranchRequest,
  ExternalBranchResult
} from '@shared/protocol'
import { openBackgroundTasks } from '@/components/tasks/api'
import { movedOrder } from '@/components/composer/queue'
import { SEARCH_LIMIT, SEARCH_MIN_CHARS, SearchError } from '@/components/sidebar/search'
import { accountRefOf, externalChat, holderOf, isExternalChatId, sessionOfChatId } from '@/components/external/logic'
import { chatViewOf } from '@/components/shell/logic'
import { loadDraft, saveDraft } from '@/components/composer/logic'
import { draftImages, PUT_BACK_EVENT, saveDraftImages, type DraftImage, type PutBack } from '@/components/composer/draft-images'
import { putBackDraft } from '@/components/composer/change-project'
import { reloadIfStale, watchBundle } from '@/lib/stale-bundle'
import { refusalText, serverHello, watchServerUpdate } from '@/lib/server-update'
import { rememberView, restoreView } from '@/lib/view-memory'
import { readCache, readListCache, writeCache } from '@/lib/list-cache'
import { wantsDesktopNotice } from './notify'
import { reportAtPaint, reportTiming } from '@/lib/timing'

const BASE_URL = '/api'

function getWsUrl() {
  if (typeof location === 'undefined') return 'ws://localhost/ws'
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
}

interface DeskStoreState {
  chats: ChatSummary[]
  external: ExternalSession[]
  workers: CliMayteWorker[]
  remoteWorkers: CliMayteWorker[]
  /** HSwarm's jobs on this PC and on the other PCs (`pc` set), split as the workers are (splitJobs). */
  swarmJobs: SwarmJob[]
  remoteSwarmJobs: SwarmJob[]
  accounts: AccountInfo[]
  settings: DeskSettings | null
  connected: boolean
  selected:
    | { kind: 'chat'; id: string }
    | { kind: 'new'; cwd?: string }
    | { kind: 'external'; id: string }
    | { kind: 'elsewhere' }
    | { kind: 'settings' }
}

let ws: WebSocket | null = null
let wsReconnectDelay = 1000
const maxReconnectDelay = 30000
let wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * The server's one worker list, split by PC. This PC's (`workers`) feed every count, panel, card and Stop
 * button; the other PCs' (`pc` set: no session, no origin, ids that may repeat ours, nothing here can stop
 * them) feed only the sidebar's CliMayte rows.
 */
function splitWorkers(list: CliMayteWorker[]): Pick<DeskStoreState, 'workers' | 'remoteWorkers'> {
  return { workers: list.filter((w) => !w.pc), remoteWorkers: list.filter((w) => !!w.pc) }
}

/** The server's one job list (swarm.update), split by PC like the workers: the other PCs' show only with the cloud on. */
function splitJobs(list: SwarmJob[]): Pick<DeskStoreState, 'swarmJobs' | 'remoteSwarmJobs'> {
  return { swarmJobs: list.filter((j) => !j.pc), remoteSwarmJobs: list.filter((j) => !!j.pc) }
}

// Outside sessions and CliMayte workers start from this browser's last copy (lib/list-cache.ts), so a
// reload shows the sidebar before the server's welcome lands.
const store = reactive<DeskStoreState>({
  // The last chat list too (2026-10-08): it was the one sidebar list a reload drew empty until hello.
  chats: readListCache<ChatSummary>('chats') ?? [],
  external: readListCache<ExternalSession>('external') ?? [],
  ...splitWorkers(readListCache<CliMayteWorker>('workers') ?? []),
  ...splitJobs([]),
  accounts: [],
  settings: null,
  connected: false,
  // A reload onto a new build comes back to the chat or screen it left.
  selected: restoreView({ kind: 'chat', id: '' })
})
watch(
  () => store.selected,
  (view) => {
    rememberView(view)
    if (view.kind === 'chat' && itemsByChat.has(view.id)) touchChat(view.id)
  },
  { deep: true }
)

// Every loaded chat's transcript. Only the map and each chat's array are reactive: the items inside stay
// plain objects, so a streamed delta is not tracked through a proxy per item. An item that changes is
// replaced in its array (replaceItem), which is what tells the views showing it.
const itemsByChat = shallowReactive(new Map<string, TranscriptItem[]>())

/** The chats whose transcripts are kept, least recently opened first; the rest are fetched again when opened. */
const KEEP_CHATS = 12
const recentChats: string[] = []

function touchChat(id: string) {
  const at = recentChats.indexOf(id)
  if (at >= 0) recentChats.splice(at, 1)
  recentChats.push(id)
  const open = store.selected.kind === 'chat' ? store.selected.id : ''
  for (let i = 0; recentChats.length > KEEP_CHATS && i < recentChats.length; ) {
    const old = recentChats[i]
    if (old === open) {
      i++
      continue
    }
    recentChats.splice(i, 1)
    itemsByChat.delete(old)
    indexes.delete(old)
  }
}

/** A chat's loaded transcript; an array put in the map by hand is made reactive here. */
function chatItems(id: string): TranscriptItem[] | undefined {
  const items = itemsByChat.get(id)
  if (!items || isReactive(items)) return items
  const wrapped = shallowReactive(items)
  itemsByChat.set(id, wrapped)
  return wrapped
}

// Where each item id sits in its chat's array, so a streamed delta or an upsert finds its item at once. An
// entry stands only for the array and length it was built on; anything else rebuilds it.
const indexes = new Map<string, { arr: TranscriptItem[]; len: number; byId: Map<string, number> }>()

function indexFor(chatId: string, items: TranscriptItem[]) {
  const raw = toRaw(items)
  let entry = indexes.get(chatId)
  if (!entry || entry.arr !== raw || entry.len !== raw.length) {
    const byId = new Map<string, number>()
    raw.forEach((it, i) => {
      if (!byId.has(it.id)) byId.set(it.id, i)
    })
    entry = { arr: raw, len: raw.length, byId }
    indexes.set(chatId, entry)
  }
  return entry
}

function indexOfItem(chatId: string, items: TranscriptItem[], id: string): number {
  const entry = indexFor(chatId, items)
  const at = entry.byId.get(id)
  if (at === undefined) return -1
  if (entry.arr[at]?.id === id) return at
  indexes.delete(chatId)
  return items.findIndex((i) => i.id === id)
}

function appendItem(chatId: string, items: TranscriptItem[], item: TranscriptItem) {
  const entry = indexFor(chatId, items)
  entry.byId.set(item.id, items.length)
  items.push(item)
  entry.len = toRaw(items).length
}

/** Puts a new copy of an item in its place: the arrays are shallow, so a change in place would reach no view. */
function replaceItem(items: TranscriptItem[], at: number, item: TranscriptItem) {
  items[at] = item
}

/** The new list with the old row kept for every row that did not change, so only the changed rows draw again. */
const rowSignatures = new WeakMap<object, string>()
function reconcile<T extends { id: string }>(old: T[], next: T[]): T[] {
  const before = new Map(old.map((o) => [o.id, o]))
  const out = next.map((n) => {
    const sig = JSON.stringify(n)
    const o = before.get(n.id)
    let oldSig: string | undefined
    if (o) {
      const raw = toRaw(o)
      oldSig = rowSignatures.get(raw)
      if (oldSig === undefined) oldSig = JSON.stringify(raw)
    }
    // Each row kept remembers its text, so the next reconcile stringifies only the new answer's rows.
    const kept = o && oldSig === sig ? o : n
    rowSignatures.set(toRaw(kept), sig)
    return kept
  })
  return out.length === old.length && out.every((o, i) => o === old[i]) ? old : out
}

// The lists' browser copies are written once things settle, not on every broadcast; leaving the page writes them at once.
const pendingCache = new Map<string, unknown>()
let cacheTimer: ReturnType<typeof setTimeout> | null = null

function flushCache() {
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = null
  for (const [key, value] of pendingCache) writeCache(key, value)
  pendingCache.clear()
}

function cacheLater(key: string, value: unknown) {
  pendingCache.set(key, value)
  cacheTimer ??= setTimeout(flushCache, 2000)
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushCache)

/** A request; a refusal rejects with the server's own sentence (its { error } body), else the status. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  // Nothing answered (the browser says only "Failed to fetch"): the server is stopped or restarting.
  const res = await fetch(BASE_URL + path, init).catch((err: unknown) => {
    throw new Error("This window's server is not answering (it may be restarting)", { cause: err })
  })
  if (!res.ok) {
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
    throw new Error(refusalText(res.status, error) ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

function connectWebSocket() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return
  }

  ws = new WebSocket(getWsUrl())

  ws.onopen = () => {
    store.connected = true
    wsReconnectDelay = 1000
    sendVisibility()
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data) as ServerEvent
    handleServerEvent(msg)
  }

  ws.onerror = () => {
    store.connected = false
  }

  ws.onclose = () => {
    store.connected = false
    scheduleReconnect()
  }
}

/** Tells the server whether this window is on screen: it polls AgentHydra slower while none is. */
function sendVisibility() {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'visibility', visible: !document.hidden } satisfies ClientEvent))
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', sendVisibility)

/** Drops a map's oldest entries (its first keys) past max. */
function capMap<V>(map: Map<string, V>, max: number) {
  for (const key of map.keys()) {
    if (map.size <= max) return
    map.delete(key)
  }
}

function scheduleReconnect() {
  if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout)
  wsReconnectTimeout = setTimeout(() => {
    connectWebSocket()
  }, wsReconnectDelay)
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, maxReconnectDelay)
}

/** Items streamed for chats whose history is not loaded yet; the load takes them in (keepNewer). */
const unloadedUpserts = new Map<string, TranscriptItem[]>()
const UNLOADED_UPSERTS_MAX = 200
/** Background chats whose streamed items are kept; past it the chat that streamed first is dropped, and its history fetch has them anyway. */
const UNLOADED_CHATS_MAX = 50

/** Speed tracking: when Send was clicked in a chat whose bubble has not shown yet (performance.now()). */
const sendClicks = new Map<string, number>()

/** The chat's history with what streamed before and while it was fetched, now its whole cached transcript. */
function landItems(id: string, snapshot: TranscriptItem[]): TranscriptItem[] {
  const since = [...(unloadedUpserts.get(id) ?? []), ...(itemsByChat.get(id) ?? [])]
  unloadedUpserts.delete(id)
  const items = keepNewer(withWindowNotes(id, snapshot), since)
  const kept = shallowReactive(items)
  itemsByChat.set(id, kept)
  itemsError.delete(id)
  reloadTries = 0
  indexes.delete(id)
  touchChat(id)
  return kept
}

type EventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>

function onHello(event: EventOf<'hello'>) {
  store.chats = event.chats
  cacheLater('chats', event.chats)
  store.settings = event.settings
  // Full reload: clear items cache
  itemsByChat.clear()
  indexes.clear()
  recentChats.length = 0
  unloadedUpserts.clear()
  reloadOpenChat()
  // Whole, whatever its rev: a restarted server may count afresh. A server without a queue sends none.
  queueState.value = event.queue ?? null
  void reloadIfStale()
  serverHello()
}

function onChatUpsert(event: EventOf<'chat.upsert'>) {
  const idx = store.chats.findIndex((c) => c.id === event.chat.id)
  if (idx >= 0) {
    store.chats[idx] = event.chat
  } else {
    store.chats.push(event.chat)
  }
  cacheLater('chats', store.chats)
}

function onChatRemoved(event: EventOf<'chat.removed'>) {
  store.chats = store.chats.filter((c) => c.id !== event.chatId)
  cacheLater('chats', store.chats)
  itemsByChat.delete(event.chatId)
  indexes.delete(event.chatId)
  const gone = recentChats.indexOf(event.chatId)
  if (gone >= 0) recentChats.splice(gone, 1)
  unloadedUpserts.delete(event.chatId)
}

function onItemUpsert(event: EventOf<'item.upsert'>) {
  // Speed tracking: the sent message's bubble is drawn at the next frame.
  const clicked = event.item.kind === 'user' ? sendClicks.get(event.chatId) : undefined
  if (clicked !== undefined) {
    sendClicks.delete(event.chatId)
    reportAtPaint('click_to_bubble', clicked, event.chatId)
  }
  // A chat whose history is not loaded keeps what streams aside: put in the cache, it would stand for
  // the whole transcript and opening the chat would never fetch its history.
  let items = chatItems(event.chatId)
  if (!items) {
    items = unloadedUpserts.get(event.chatId) ?? []
    unloadedUpserts.set(event.chatId, items)
    capMap(unloadedUpserts, UNLOADED_CHATS_MAX)
  }
  const idx = indexOfItem(event.chatId, items, event.item.id)
  if (idx >= 0) replaceItem(items, idx, event.item)
  else appendItem(event.chatId, items, event.item)
  // Only the newest few are kept for an unloaded chat: the history fetch already holds the older ones.
  if (!chatItems(event.chatId) && items.length > UNLOADED_UPSERTS_MAX) {
    items.splice(0, items.length - UNLOADED_UPSERTS_MAX)
    indexes.delete(event.chatId)
  }
}

function onItemDelta(event: EventOf<'item.delta'>) {
  const items = chatItems(event.chatId) ?? unloadedUpserts.get(event.chatId)
  const at = items ? indexOfItem(event.chatId, items, event.itemId) : -1
  const item = items?.[at]
  if (items && item && (item.kind === 'assistant_text' || item.kind === 'thinking')) {
    replaceItem(items, at, { ...item, text: item.text + event.text })
  }
}

function onItemRemoved(event: EventOf<'item.removed'>) {
  const items = chatItems(event.chatId) ?? unloadedUpserts.get(event.chatId)
  const idx = items ? indexOfItem(event.chatId, items, event.itemId) : -1
  if (idx >= 0) {
    items!.splice(idx, 1)
    indexes.delete(event.chatId)
  }
}

function handleServerEvent(event: ServerEvent) {
  switch (event.type) {
    case 'hello':
      onHello(event)
      break

    case 'queue.update':
      takeQueue(event.queue)
      break

    case 'chat.upsert':
      onChatUpsert(event)
      break

    case 'chat.removed':
      onChatRemoved(event)
      break

    case 'item.upsert':
      onItemUpsert(event)
      break

    case 'item.delta':
      onItemDelta(event)
      break

    case 'item.removed':
      onItemRemoved(event)
      break

    case 'notify':
      dispatchNotification(event)
      break

    case 'bridge.status':
      // Bridge status update
      break

    case 'external.update':
      store.external = reconcile(store.external, event.sessions)
      cacheLater('external', event.sessions)
      break

    case 'climayte.update':
      Object.assign(store, splitWorkers(event.workers))
      cacheLater('workers', event.workers)
      break

    case 'swarm.update':
      Object.assign(store, splitJobs(event.jobs))
      break

    case 'accounts.update':
      store.accounts = event.accounts
      break

    case 'settings.update':
      store.settings = event.settings
      break
  }
}

// A reconnect (the server restarted, the socket dropped) lost what streamed meanwhile and hello cleared the
// cache: the open chat is fetched again, so its history and any docked request come back without a switch.
// Upserts that land while the fetch is out are newer than its snapshot, so they are kept over it.
function reloadOpenChat() {
  const sel = store.selected
  if (sel.kind !== 'chat' || !store.chats.some((c) => c.id === sel.id)) return
  const id = sel.id
  fetchJson<TranscriptItem[]>(`/chats/${id}/items`)
    .then((items) => {
      landItems(id, items)
    })
    .catch((err: unknown) => retryOpenChat(id, err))
}

/** Why each chat's history did not load, by chat id; gone once it lands. */
const itemsError = shallowReactive(new Map<string, string>())
/** Waits between tries at the open chat's history after a failure; the last repeats. */
export const RELOAD_WAITS_MS = [1000, 2000, 4000, 8000]
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let reloadTries = 0

/**
 * The open chat's history failed to load: it is asked for again while the chat stays open and unloaded.
 * 2026-10-05: after a server restart chats sat on "No messages yet", their history on disk, until the owner
 * opened another chat and came back ("did we delete something?").
 */
function retryOpenChat(id: string, err: unknown) {
  itemsError.set(id, err instanceof Error ? err.message : String(err))
  if (reloadTimer) clearTimeout(reloadTimer)
  const wait = RELOAD_WAITS_MS[Math.min(reloadTries++, RELOAD_WAITS_MS.length - 1)]
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    const sel = store.selected
    if (sel.kind === 'chat' && sel.id === id && !itemsByChat.has(id)) reloadOpenChat()
  }, wait)
}

/** The snapshot with every item that arrived since it was asked for in place of its own copy, and after it when it has none. */
function keepNewer(snapshot: TranscriptItem[], since: readonly TranscriptItem[] | undefined): TranscriptItem[] {
  if (!since?.length) return snapshot
  const newer = new Map(since.map((i) => [i.id, i]))
  const out = snapshot.map((i) => newer.get(i.id) ?? i)
  const had = new Set(snapshot.map((i) => i.id))
  for (const i of since) if (!had.has(i.id)) out.push(i)
  return out
}

function dispatchNotification(event: {
  chatId: string
  reason: 'finished' | 'needs_you' | 'error' | 'limited'
  title: string
  body: string
}) {
  const chat = store.chats.find((c) => c.id === event.chatId)
  if (!chat) return

  const viewing = store.selected.kind === 'chat' && store.selected.id === event.chatId
  if (wantsDesktopNotice({ enabled: store.settings?.notifications, hidden: document.hidden, viewing })) {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(event.title, { body: event.body })
      notification.onclick = () => {
        window.focus()
        store.selected = { kind: 'chat', id: event.chatId }
      }
    }
  }

  updateWindowTitle()
}

function updateWindowTitle() {
  const working = store.chats.filter((c) => c.status === 'working').length
  const needsYou = store.chats.filter((c) => c.status === 'needs_you').length
  const parts = []
  if (working > 0) parts.push(`${working} working`)
  if (needsYou > 0) parts.push(`${needsYou} need you`)
  const prefix = parts.length > 0 ? `(${parts.join(', ')}) ` : ''
  document.title = `${prefix}AgentHydra`
}

watch(
  () => [store.chats.filter((c) => c.status === 'working').length, store.chats.filter((c) => c.status === 'needs_you').length, store.connected],
  () => {
    updateWindowTitle()
  }
)

// An outside session the window offers to carry on (ExternalSession.canResume) is a stand-in chat
// 'ext:<session id>' until its first message: that imports the session under its account (the
// existing import path), applies what was changed in the composer meanwhile, sends the message (which
// resumes it) and opens the new chat. A session no CLI instance holds, with no account picked for it,
// is placed by the server at the import; the 'landing' (the Settings default account or Auto's pick,
// read when the view opens) is what the stand-in shows meanwhile. The server copies the transcript into
// that account's folder when the message goes out.
const externalPatches = reactive(new Map<string, ChatPatch>())
const landings = reactive(new Map<string, AccountRef>())

// The poller's list holds the last 24 hours. An older outside session the window opened anyway (a search
// hit) is fetched on its own and kept here; the public list shows it after the list's own rows, and a
// row the list carries wins.
const extraExternal = reactive(new Map<string, ExternalSession>())
/** Older sessions kept; past it the first opened goes, and opening it again fetches it again. */
const EXTRA_EXTERNAL_MAX = 50
const fetchingExternal = new Set<string>()

function allExternal(): ExternalSession[] {
  if (!extraExternal.size) return store.external
  const listed = new Set(store.external.map((s) => s.id))
  return [...store.external, ...[...extraExternal.values()].filter((s) => !listed.has(s.id))]
}

function findExternal(sessionId: string): ExternalSession | undefined {
  return store.external.find((s) => s.id === sessionId) ?? extraExternal.get(sessionId)
}

// The managed send queue (SPEC "Send queue"): the server holds it and sends from it; the window shows it
// and edits it, never dispatches. A queue.update or an answer older than the queue shown is dropped.
const queueState = shallowRef<QueueState | null>(null)

function takeQueue(next: QueueState) {
  if (!queueState.value || next.rev >= queueState.value.rev) queueState.value = next
}

/** A queue request; a refusal ({ error } with 400/404/409) rejects with the server's own words. */
async function queueJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/queue${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  const answer: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const error = (answer as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' && error ? error : `${res.status} ${res.statusText}`)
  }
  return answer as T
}

// The search in flight; a newer query cancels it.
let searchAbort: AbortController | null = null

/** What a superseded search rejects with; the sidebar's runner ignores it. */
function searchSuperseded(): Error {
  const err = new Error('A newer search replaced this one.')
  err.name = 'AbortError'
  return err
}

async function pickLanding(): Promise<AccountRef | null> {
  const id = store.settings?.defaultAccountId
  const named = id && id !== 'auto' ? store.accounts.find((a) => a.id === id) : undefined
  if (named) return accountRefOf(named)
  return fetchJson<AccountRef>('/accounts/pick').catch(() => null)
}

/**
 * Imports an outside session under the account picked for it in the title bar, else the CLI instance
 * that holds it (in place); else the server places it at the import, as it places a new chat: the pick
 * is fresh, never the expired default login, and the chat stays Auto so a usage limit moves it. With
 * `fork`, as a new chat that forks it at its first message; with `at` too, cut just before that message of the owner's.
 */
async function importOutside(s: ExternalSession, fork = false, at?: string): Promise<ChatSummary> {
  const pickedId = externalPatches.get(s.id)?.accountId
  const picked = pickedId && pickedId !== 'auto' ? store.accounts.find((a) => a.id === pickedId) : undefined
  if (!picked && s.accountId && !store.accounts.some((a) => a.id === s.accountId)) throw new Error(`Hydra Desk does not list the account ${s.accountId} yet.`)
  // A holder signed out cannot resume it: the server places it then, as a copy on an account with room.
  const account = picked ?? holderOf(s, store.accounts)
  return fetchJson<ChatSummary>('/chats/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: s.id,
      cwd: s.cwd ?? undefined,
      title: s.title,
      ...(account ? { configDir: account.configDir } : {}),
      ...(fork ? { fork: true } : {}),
      ...(at ? { at } : {})
    } satisfies ImportSessionRequest)
  })
}

async function resumeExternal(sessionId: string, message: SendMessageRequest): Promise<{ queued: boolean }> {
  const s = findExternal(sessionId)
  if (!s || !s.canResume) throw new Error('This session cannot be continued here right now.')
  const chat = await importOutside(s)
  // The import holds the session's history: in the cache before the send, the chat opens on the whole
  // conversation with the message under it, as the stand-in showed it, never on the new lines alone.
  await landHistory(chat.id)
  // From here the chat exists: it opens whether the send goes or not, so a refused one is a chat to
  // retry in, its message back in the box. The stand-in's composer is gone by the time the refusal
  // reaches it, so the new chat's transcript says why.
  try {
    const patch = externalPatches.get(sessionId)
    if (patch && Object.keys(patch).length) {
      await fetchJson(`/chats/${chat.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    }
    externalPatches.delete(sessionId)
    return await fetchJson<{ queued: boolean }>(`/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    })
  } catch (err) {
    saveDraft(typeof localStorage === 'undefined' ? null : localStorage, chat.id, message.text)
    noteNotSent(chat.id, err instanceof Error ? err.message : String(err), message)
    throw err
  } finally {
    landChat(chat)
  }
}

// What the window itself writes into a chat's transcript: a first message refused after its chat was
// made, which only the window knows of. Kept here, so the chat's items loaded from the server keep it.
const windowNotes = new Map<string, { item: TranscriptItem; reason: string }[]>()
/** Notes kept per chat, and chats with notes; past it the oldest go. */
const WINDOW_NOTES_MAX = 20

// The server's own refusal line (a session no folder here has) already says why: not said twice.
const statesReason = (items: TranscriptItem[], reason: string) => items.some((i) => i.kind === 'system' && i.text === reason)

function noteNotSent(chatId: string, reason: string, message: SendMessageRequest) {
  const images = message.images?.length ?? 0
  const lines = [`Not sent: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`]
  if (message.text.trim()) lines.push('Your message is back in the box.')
  // Only the text is kept as a draft.
  if (images) lines.push(images === 1 ? 'The attached image was dropped: attach it again.' : `The ${images} attached images were dropped: attach them again.`)
  const now = Date.now()
  const note = { item: { kind: 'system', id: `window:not-sent:${now}`, ts: now, level: 'warn', text: lines.join(' ') } satisfies TranscriptItem, reason }
  windowNotes.set(chatId, [...(windowNotes.get(chatId) ?? []), note].slice(-WINDOW_NOTES_MAX))
  capMap(windowNotes, WINDOW_NOTES_MAX)
  const shown = chatItems(chatId)
  if (shown && !statesReason(shown, reason)) appendItem(chatId, shown, note.item)
}

/** The chat's items from the server with the window's own notes put in by their time. */
function withWindowNotes(chatId: string, items: TranscriptItem[]): TranscriptItem[] {
  const notes = windowNotes.get(chatId)
  if (!notes) return items
  const out = [...items]
  for (const { item, reason } of notes) {
    if (statesReason(items, reason)) continue
    const at = out.findIndex((i) => i.ts > item.ts)
    out.splice(at < 0 ? out.length : at, 0, item)
  }
  return out
}

/** Fetches a chat's history into the cache; on a failure it stays unloaded and opening the chat fetches it. */
async function landHistory(id: string): Promise<void> {
  try {
    landItems(id, await fetchJson<TranscriptItem[]>(`/chats/${id}/items`))
  } catch {} // floor-ok: left unloaded, DeskFrame loads it when the chat opens
}

// A chat the window just made is listed and opened at once: the server's chat.upsert may come after
// the POST answers, and until then the chat view would fall back to the new-session screen. A summary
// the socket already delivered is newer, so it is kept.
function landChat(chat: ChatSummary) {
  if (!store.chats.some((c) => c.id === chat.id)) store.chats.push(chat)
  store.selected = { kind: 'chat', id: chat.id }
}

// Public API

export function useDesk() {
  return {
    // State
    chats: computed(() => store.chats),
    itemsByChat: computed(() => itemsByChat),
    itemsError: computed(() => itemsError),
    external: computed(allExternal),
    workers: computed(() => store.workers),
    /** The other PCs' CliMayte workers, for the sidebar's CliMayte rows only (splitWorkers). */
    remoteWorkers: computed(() => store.remoteWorkers),
    /** HSwarm's jobs on this PC, and the other PCs' (the sidebar shows those with the cloud on). */
    swarmJobs: computed(() => store.swarmJobs),
    remoteSwarmJobs: computed(() => store.remoteSwarmJobs),
    accounts: computed(() => store.accounts),
    settings: computed(() => store.settings),
    connected: computed(() => store.connected),
    selected: computed(() => store.selected),
    queue: computed(() => queueState.value),

    // Actions
    async init() {
      if (Notification.permission === 'default') {
        Notification.requestPermission()
      }
      connectWebSocket()
      watchBundle()
      watchServerUpdate()
    },

    select(
      view:
        | { kind: 'chat'; id: string }
        | { kind: 'new'; cwd?: string }
        | { kind: 'external'; id: string }
        | { kind: 'elsewhere' }
        | { kind: 'settings' }
    ) {
      store.selected = chatViewOf(view, store.chats)
    },

    openSettings() {
      store.selected = { kind: 'settings' }
    },

    /** Creates the chat (its first message goes with it), lists it and opens it. */
    async createChat(req: CreateChatRequest): Promise<ChatSummary> {
      const chat = await fetchJson<ChatSummary>('/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      })
      landChat(chat)
      return chat
    },

    async send(chatId: string, message: SendMessageRequest): Promise<{ queued: boolean }> {
      if (isExternalChatId(chatId)) return resumeExternal(sessionOfChatId(chatId), message)
      const clicked = performance.now()
      sendClicks.set(chatId, clicked)
      const sent = await fetchJson<{ queued: boolean }>(`/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      })
      reportTiming('click_to_server', performance.now() - clicked, chatId)
      return sent
    },

    async interrupt(chatId: string): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}/interrupt`, { method: 'POST' })
    },

    /** Send now on a message queued behind a running turn: the turn stops and that message goes at once. */
    async sendNow(chatId: string, itemId?: string): Promise<SendNowResult> {
      return fetchJson<SendNowResult>(`/chats/${chatId}/send-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId } satisfies SendNowRequest)
      })
    },

    async respondPermission(
      chatId: string,
      requestId: string,
      decision: PermissionDecision
    ): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}/permission/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision)
      })
    },

    async answerQuestion(
      chatId: string,
      requestId: string,
      answer: QuestionAnswer
    ): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}/question/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answer)
      })
    },

    async respondPlan(
      chatId: string,
      requestId: string,
      decision: PlanDecision
    ): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}/plan/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision)
      })
    },

    async answerElicitation(
      chatId: string,
      requestId: string,
      answer: ElicitationAnswer
    ): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}/elicitation/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answer)
      })
    },

    async updateChat(chatId: string, patch: ChatPatch): Promise<ChatSummary> {
      if (isExternalChatId(chatId)) {
        const id = sessionOfChatId(chatId)
        const s = findExternal(id)
        if (!s) throw new Error('This session is no longer listed.')
        const next = { ...externalPatches.get(id), ...patch }
        externalPatches.set(id, next)
        return externalChat(s, store.accounts, next, landings.get(id) ?? null)
      }
      return fetchJson(`/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
    },

    async removeChat(chatId: string): Promise<{ ok: boolean }> {
      return fetchJson(`/chats/${chatId}`, { method: 'DELETE' })
    },

    /** Fork: a new chat continuing from a copy of the chat's session, listed and opened. */
    async forkChat(chatId: string): Promise<ChatSummary> {
      const chat = await fetchJson<ChatSummary>(`/chats/${chatId}/fork`, { method: 'POST' })
      landChat(chat)
      return chat
    },

    /** Fork of an outside session: imported as a new chat that forks it at its first message; the original stays listed. */
    async forkExternal(sessionId: string): Promise<ChatSummary> {
      const s = findExternal(sessionId)
      if (!s) throw new Error('This session is no longer listed.')
      const chat = await importOutside(s, true)
      landChat(chat)
      return chat
    },

    /**
     * Fork at a message of the owner's (its hover toolbar): a new chat cut just before it, listed and opened
     * with the message's text and pictures waiting unsent in its box. An outside session is imported as that fork.
     */
    async forkAt(chatId: string, itemId: string, message: { text: string; images?: DraftImage[] }): Promise<ChatSummary> {
      // An outside session's transcript names it by its session id, its stand-in chat by the external id.
      const outside = store.chats.some((c) => c.id === chatId) ? undefined : findExternal(isExternalChatId(chatId) ? sessionOfChatId(chatId) : chatId)
      if (!outside && isExternalChatId(chatId)) throw new Error('This session is no longer listed.')
      const chat = outside
        ? await importOutside(outside, true, itemId)
        : await fetchJson<ChatSummary>(`/chats/${chatId}/fork`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ at: itemId } satisfies ForkChatRequest)
          })
      // In the box before the chat opens: its composer loads the draft when it changes to this chat.
      saveDraft(typeof localStorage === 'undefined' ? null : localStorage, chat.id, message.text)
      saveDraftImages(chat.id, message.images ?? [])
      landChat(chat)
      return chat
    },

    /**
     * Undo at a message of the owner's (its hover toolbar, or its reply's): the chat drops it and all after it,
     * and its text and pictures go back in the box, above anything typed there since.
     */
    async rewind(chatId: string, itemId: string, message: { text: string; images?: DraftImage[] }): Promise<ChatSummary> {
      const chat = await fetchJson<ChatSummary>(`/chats/${chatId}/rewind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: itemId } satisfies RewindChatRequest)
      })
      const back: PutBack = { chatId, text: message.text, images: message.images ?? [] }
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<PutBack>(PUT_BACK_EVENT, { detail: back }))
      // No box shows the chat now: it waits as the chat's draft.
      if (!back.taken) {
        const storage = typeof localStorage === 'undefined' ? null : localStorage
        saveDraft(storage, chatId, putBackDraft(message.text, loadDraft(storage, chatId)))
        saveDraftImages(chatId, [...back.images, ...draftImages(chatId)])
      }
      return chat
    },

    /** Retry under "Could not get Claude Code": the download starts again and the chat goes on with what was sent. */
    async retryClaudeCode(chatId: string): Promise<void> {
      await fetchJson<{ retried: boolean }>(`/chats/${chatId}/claude-code/retry`, { method: 'POST' })
    },

    /** Hydra Desk's marks on an outside session; shown at once, the poller's next list carries them too. */
    async updateSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<SessionMeta> {
      const meta = await fetchJson<SessionMeta>(`/external/sessions/${encodeURIComponent(sessionId)}/meta`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      const s = findExternal(sessionId)
      if (s) Object.assign(s, { pinned: meta.pinned, archived: meta.archived, unread: meta.unread, group: meta.group }, meta.title ? { title: meta.title } : {})
      return meta
    },

    /** "Copy up to here into a new chat" on an outside Claude Code session's reply: AgentHydra writes the copy beside it, which opens. */
    async branchExternal(sessionId: string, uuid: string): Promise<string> {
      const title = findExternal(sessionId)?.title
      const made = await fetchJson<ExternalBranchResult>(`/external/sessions/${encodeURIComponent(sessionId)}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, ...(title ? { title } : {}) } satisfies ExternalBranchRequest)
      })
      store.selected = { kind: 'external', id: made.id }
      return made.id
    },

    /** Lists an outside session the list lacks (older than its 24 hours) by fetching it; rejects on AgentHydra's 404. */
    async ensureExternal(sessionId: string): Promise<void> {
      if (findExternal(sessionId) || fetchingExternal.has(sessionId)) return
      fetchingExternal.add(sessionId)
      try {
        extraExternal.set(sessionId, await fetchJson<ExternalSession>(`/external/sessions/${encodeURIComponent(sessionId)}`))
        capMap(extraExternal, EXTRA_EXTERNAL_MAX)
      } finally {
        fetchingExternal.delete(sessionId)
      }
    },

    async revealFolder(path: string): Promise<{ path: string }> {
      return fetchJson('/folders/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
    },

    /** Open in Explorer for a file a chat shows: `{ path, cwd? }` or `{ media: '/api/media/<id>' }`; the folder opens with the file selected. */
    async revealFile(body: { path?: string; cwd?: string; media?: string }): Promise<{ path: string; folder: boolean }> {
      return fetchJson('/files/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    },

    /**
     * AgentHydra's transcript search; a 503 means AgentHydra is not answering. Each call cancels the one
     * still in flight, whose promise rejects with an AbortError; a query too short to search only cancels.
     */
    async search(query: string): Promise<SearchHit[]> {
      searchAbort?.abort()
      searchAbort = null
      if (query.trim().length < SEARCH_MIN_CHARS) return []
      const ctl = new AbortController()
      searchAbort = ctl
      // Settles the moment a newer call aborts, whether or not the request itself honours the signal.
      const superseded = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(searchSuperseded()), { once: true }))
      const ask = async () => {
        const res = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`, { signal: ctl.signal })
        const body = (await res.json().catch(() => null)) as SearchHit[] | { error?: string } | null
        if (res.ok && Array.isArray(body)) return body
        const reason = body && !Array.isArray(body) && body.error ? body.error : `${res.status} ${res.statusText}`
        throw new SearchError(res.status === 503, reason)
      }
      try {
        return await Promise.race([ask(), superseded])
      } finally {
        if (searchAbort === ctl) searchAbort = null
      }
    },

    /** The stats card's figures over every source AgentHydra counts; each range's answer is kept in this browser. */
    async homeStats(range: HomeStatsRange): Promise<HomeStats> {
      const stats = await fetchJson<HomeStats>(`/stats/home?range=${range}`)
      writeCache(`home-stats.${range}`, stats)
      return stats
    },
    /** The answer kept for the range, or null (none yet, or another build's shape). */
    cachedHomeStats(range: HomeStatsRange): HomeStats | null {
      const kept = readCache<HomeStats>(`home-stats.${range}`)
      return kept?.range === range && Array.isArray(kept.heat) && kept.heat.every((c) => typeof c === 'object' && c !== null) && Array.isArray(kept.sources) && Array.isArray(kept.missing) ? kept : null
    },

    async loadItems(chatId: string): Promise<TranscriptItem[]> {
      const opened = performance.now()
      const snapshot = await fetchJson<TranscriptItem[]>(`/chats/${chatId}/items`).catch((err: unknown) => {
        if (store.selected.kind === 'chat' && store.selected.id === chatId) retryOpenChat(chatId, err)
        throw err
      })
      const items = landItems(chatId, snapshot)
      reportAtPaint('open_to_paint', opened, chatId)
      return items
    },

    async loadExternalItems(sessionId: string): Promise<TranscriptItem[]> {
      return fetchJson(`/external/sessions/${sessionId}/items`)
    },

    /** What was changed in the composer of an outside session before its first message. */
    externalPatch(sessionId: string): ChatPatch {
      return externalPatches.get(sessionId) ?? {}
    },
    /** Where a session no CLI instance holds will continue: Settings' default account or Auto's pick. */
    landingOf(sessionId: string): AccountRef | null {
      return landings.get(sessionId) ?? null
    },
    async ensureLanding(sessionId: string): Promise<void> {
      const landing = await pickLanding()
      if (landing) landings.set(sessionId, landing)
    },
    /** The stand-in chat of an outside session the composer can carry on now, else null. */
    standInOf(sessionId: string): ChatSummary | null {
      const s = findExternal(sessionId)
      return s?.canResume ? externalChat(s, store.accounts, externalPatches.get(sessionId), landings.get(sessionId) ?? null) : null
    },

    /** Opens the Background tasks panel, scrolled to `taskId` (a unit, worker or task id) when given. */
    openBackgroundTasks(taskId?: string | null) {
      openBackgroundTasks(taskId)
    },

    async cancelWorker(workerId: string): Promise<{ ok: boolean }> {
      return fetchJson(`/climayte/workers/${workerId}/cancel`, { method: 'POST' })
    },

    /** Stops one background task of a Desk chat; answers the task's item as it is then (settled, normally). */
    async stopTask(chatId: string, taskId: string): Promise<{ item: TranscriptItem }> {
      return fetchJson(`/chats/${chatId}/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' })
    },

    async sendToWorker(workerId: string, text: string): Promise<{ ok: boolean }> {
      return fetchJson(`/climayte/workers/${workerId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
    },

    async updateSettings(settings: Partial<DeskSettings>): Promise<DeskSettings> {
      return fetchJson('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
    },

    // The send queue: the item answers are also broadcast as queue.update; the queue answers are taken at once.
    async queueAdd(req: QueueAddRequest): Promise<QueueItem> {
      return queueJson('', 'POST', req)
    },

    async queueEdit(id: string, patch: QueuePatch): Promise<QueueItem> {
      return queueJson(`/${encodeURIComponent(id)}`, 'PATCH', patch)
    },

    async queueRemove(id: string): Promise<{ ok: true }> {
      return queueJson(`/${encodeURIComponent(id)}`, 'DELETE')
    },

    /** One place up or down within the item's own chat; nothing is sent at the end of it. */
    async queueMove(id: string, direction: -1 | 1): Promise<QueueState | null> {
      const q = queueState.value
      const ids = q && movedOrder(q.items, id, direction)
      if (!q || !ids) return null
      const next = await queueJson<QueueState>('/reorder', 'POST', { ids, ifRev: q.rev } satisfies QueueReorder)
      takeQueue(next)
      return next
    },

    async queueSendNow(id: string): Promise<{ ok: boolean; chatId: string; queued: boolean }> {
      return queueJson(`/${encodeURIComponent(id)}/send-now`, 'POST')
    },

    async queueRetry(id: string): Promise<QueueItem> {
      return queueJson(`/${encodeURIComponent(id)}/retry`, 'POST')
    },

    async queueResume(chatId: string): Promise<QueueState> {
      const next = await queueJson<QueueState>(`/chats/${encodeURIComponent(chatId)}/resume`, 'POST')
      takeQueue(next)
      return next
    },

    async queueSettings(patch: QueueSettingsPatch): Promise<QueueState> {
      const next = await queueJson<QueueState>('', 'PATCH', patch)
      takeQueue(next)
      return next
    },

    disconnect() {
      if (ws) {
        ws.close()
        ws = null
      }
      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout)
      }
    }
  }
}

// Initialize on first use
let initialized = false
if (typeof window !== 'undefined' && !initialized) {
  initialized = true
  const desk = useDesk()
  desk.init().catch(console.error)
}
