// Pure sidebar search logic (tested in web/test/shell): the "Everywhere" rows from AgentHydra's
// transcript search, the debounced runner that never lets a slower earlier answer overwrite a newer
// one, the keyboard targets and the emphasised parts of a line. No Vue, no store.
import type { ChatSummary, SearchHit } from '@shared/protocol'
import type { View } from '../shell/logic'
import type { ChatGroup } from './logic'

export const SEARCH_MIN_CHARS = 2
export const SEARCH_DEBOUNCE_MS = 250
export const SEARCH_LIMIT = 25

/** A failed search; `offline`: AgentHydra is not answering (the route's 503). */
export class SearchError extends Error {
  constructor(
    readonly offline: boolean,
    message: string
  ) {
    super(message)
    this.name = 'SearchError'
  }
}

const isAbort = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'AbortError'

export type SearchPhase = 'idle' | 'loading' | 'done' | 'offline' | 'failed'

export interface SearchState {
  query: string
  phase: SearchPhase
  hits: SearchHit[]
  error: string | null
}

export const IDLE_SEARCH: SearchState = { query: '', phase: 'idle', hits: [], error: null }

export interface SearchTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: SearchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * Feeds the search box's text to `run` after `debounceMs` of quiet. Each input supersedes every
 * answer still in flight: only the latest query's answer (or failure) reaches `onChange`.
 */
export function createSearchRunner(opts: {
  run: (query: string) => Promise<SearchHit[]>
  onChange: (state: SearchState) => void
  debounceMs?: number
  timers?: SearchTimers
}) {
  const timers = opts.timers ?? realTimers
  const debounceMs = opts.debounceMs ?? SEARCH_DEBOUNCE_MS
  let state = IDLE_SEARCH
  let pending: unknown = null
  let seq = 0

  const emit = (next: SearchState) => {
    state = next
    opts.onChange(next)
  }
  const cancel = () => {
    if (pending !== null) timers.clear(pending)
    pending = null
  }

  function input(text: string): void {
    const query = text.trim()
    // The same text is not asked again while it is being asked or was answered; after a failure it is
    // (Enter in the box retries).
    if (query === state.query && (state.phase === 'loading' || state.phase === 'done')) return
    cancel()
    const mine = ++seq
    if (query.length < SEARCH_MIN_CHARS) return emit({ ...IDLE_SEARCH, query })
    emit({ query, phase: 'loading', hits: [], error: null })
    pending = timers.set(() => {
      pending = null
      opts.run(query).then(
        (hits) => mine === seq && emit({ query, phase: 'done', hits, error: null }),
        (err: unknown) =>
          mine === seq &&
          // The store aborts a search a newer one superseded: not a failure, and nothing to show.
          !isAbort(err) &&
          emit({
            query,
            phase: err instanceof SearchError && err.offline ? 'offline' : 'failed',
            hits: [],
            error: err instanceof Error ? err.message : String(err)
          })
      )
    }, debounceMs)
  }

  return {
    input,
    state: (): SearchState => state,
    /** Drops the pending query and any answer still in flight (the box went away). */
    stop(): void {
      cancel()
      seq++
    }
  }
}

/** "now", "5m", "3h", "2d", "6w": how long ago a hit was last active. */
export function relativeTime(at: number | null, now: number = Date.now()): string {
  if (at == null) return ''
  const m = Math.floor(Math.max(0, now - at) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`
}

/** One "Everywhere" row: the hit, and what opening it shows (our chat when it is one, else the outside session). */
export interface EverywhereRow {
  key: string
  hit: SearchHit
  view: Extract<View, { kind: 'chat' | 'external' }>
}

/**
 * The session ids the local list already shows (our chats' and the outside sessions'). A collapsed
 * group shows none of its rows, so their hits stay in Everywhere, where the arrow keys reach them.
 */
export function shownSessionIds(groups: ChatGroup[], collapsed: ReadonlySet<string> = new Set()): Set<string> {
  const ids = new Set<string>()
  for (const g of groups)
    for (const e of collapsed.has(g.key) ? [] : g.entries) {
      if (e.kind === 'external') ids.add(e.id)
      else if (e.chat.sessionId) ids.add(e.chat.sessionId)
    }
  return ids
}

/** AgentHydra's hits minus the ones already shown above; a hit that is one of our chats opens that chat. */
export function everywhereRows(hits: SearchHit[], chats: ChatSummary[], shown: ReadonlySet<string>): EverywhereRow[] {
  const ours = new Map(chats.filter((c) => c.sessionId).map((c) => [c.sessionId!, c.id]))
  return hits
    .filter((h) => !shown.has(h.sessionId))
    .map((hit): EverywhereRow => {
      const chatId = ours.get(hit.sessionId)
      return { key: `hit:${hit.sessionId}`, hit, view: chatId ? { kind: 'chat', id: chatId } : { kind: 'external', id: hit.sessionId } }
    })
}

export interface SearchTarget {
  key: string
  view: View
}

/** What the arrow keys move through: the local rows of open groups, then the Everywhere rows. */
export function searchTargets(groups: ChatGroup[], collapsed: ReadonlySet<string>, rows: EverywhereRow[]): SearchTarget[] {
  const out: SearchTarget[] = []
  for (const g of groups) {
    if (collapsed.has(g.key)) continue
    for (const e of g.entries)
      out.push({ key: `${e.kind}:${e.id}`, view: e.kind === 'chat' ? { kind: 'chat', id: e.id } : { kind: 'external', id: e.id } })
  }
  for (const r of rows) out.push({ key: r.key, view: r.view })
  return out
}

/** The cursor after an arrow key: -1 is the box itself; it stops at both ends. */
export function moveCursor(cursor: number, delta: 1 | -1, count: number): number {
  return Math.max(-1, Math.min(count - 1, cursor + delta))
}

/**
 * Where the cursor is in the targets now. It follows its row (`key`), not its place: a poll that
 * inserts a row above it must not move Enter onto another session. A row that went away leaves the
 * cursor at its old place (`at`), clamped to the list; -1 is the box.
 */
export function resolveCursor(targets: SearchTarget[], key: string | null, at: number): number {
  if (key === null) return -1
  const i = targets.findIndex((t) => t.key === key)
  return i >= 0 ? i : Math.min(at, targets.length - 1)
}

/**
 * Escape in the search box. With text it clears the text and the keystroke ends there, or the window's
 * own Escape would close the peeked sidebar in the same press; an empty box closes and lets it on.
 */
export function searchEscape(e: Pick<KeyboardEvent, 'preventDefault' | 'stopPropagation'>, query: string): 'clear' | 'close' {
  if (!query) return 'close'
  e.preventDefault()
  e.stopPropagation()
  return 'clear'
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A line split into plain and emphasised parts, the query's words emphasised wherever they appear. */
export function highlightParts(text: string, query: string): { text: string; mark: boolean }[] {
  if (!text) return []
  // Matched on the line itself, not a lowercased copy: lowercasing can change the length ("İ" becomes
  // two code units) and would shift every mark after it.
  const ranges: [number, number][] = []
  for (const t of new Set(query.split(/\s+/).filter(Boolean)))
    for (const m of text.matchAll(new RegExp(escapeRegExp(t), 'giu'))) ranges.push([m.index!, m.index! + m[0].length])
  ranges.sort((a, b) => a[0] - b[0])
  const parts: { text: string; mark: boolean }[] = []
  let at = 0
  for (let i = 0; i < ranges.length; ) {
    const start = ranges[i]![0]
    let end = ranges[i]![1]
    // Overlapping or touching words make one emphasised part.
    for (i++; i < ranges.length && ranges[i]![0] <= end; i++) end = Math.max(end, ranges[i]![1])
    if (start > at) parts.push({ text: text.slice(at, start), mark: false })
    parts.push({ text: text.slice(start, end), mark: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false })
  return parts
}
