// Pure sidebar logic (tested in web/test/shell). No Vue, no store.
import type { ChatStatus, ChatSummary, ExternalSession } from '@shared/protocol'
import { accountTitle } from '../accounts/format'

/** The folder a chat belongs to, as the real sidebar labels it: the basename, case kept. */
export function folderLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Two spellings of one folder ("C:\x\Connections", "c:/x/connections/") share a key. */
export function folderKey(cwd: string): string {
  return cwd.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/** The filter menu: Active (not archived, the default), Archived only, or All (Archived as its own group last). */
export type SidebarFilter = 'active' | 'archived' | 'all'
export const FILTER_LABELS: Record<SidebarFilter, string> = {
  active: 'Active',
  archived: 'Archived',
  all: 'All'
}

/** A remembered filter, back from storage: anything but a known one is the default, Active. */
export function parseFilter(stored: string | null | undefined): SidebarFilter {
  return stored && Object.hasOwn(FILTER_LABELS, stored) ? (stored as SidebarFilter) : 'active'
}

/**
 * The list a chat the current one hides is shown in (a new chat started while Archived or a search is
 * on): no search, and Active for a live chat, All for an archived one under Active.
 */
export function revealChat(chat: Pick<ChatSummary, 'archived'>, filter: SidebarFilter): { query: string; filter: SidebarFilter } {
  if (chat.archived) return { query: '', filter: filter === 'active' ? 'all' : filter }
  return { query: '', filter: filter === 'archived' ? 'active' : filter }
}

/**
 * What renaming an outside session sends: the new name; null (an emptied field) for the session's own
 * name again; undefined when nothing changed. The window only sees the shown title (the overlay's once
 * renamed), so an empty field is the way back to the session's own name.
 */
export function externalRename(draft: string, shown: string): string | null | undefined {
  const title = draft.trim()
  if (!title) return null
  return title === shown ? undefined : title
}

const ACTIVE: ChatStatus[] = ['starting', 'working', 'needs_you']
/** A turn runs now; one waiting on you does not. */
const RUNNING: ChatStatus[] = ['starting', 'working']

/** One row of the list: a Hydra Desk chat, or a session running elsewhere (read-only until continued here). */
export type SidebarEntry =
  | { kind: 'chat'; id: string; at: number; chat: ChatSummary }
  | { kind: 'external'; id: string; at: number; session: ExternalSession }

export interface ChatGroup {
  key: string // the cwd, '' for no folder, 'group:<name>' for a moved-to group, 'name:<folder>' for another PC's folder known only by its last name (tasks.ts), or 'pinned' / 'archived'
  label: string
  cwd: string | null // folder for "New session in <folder>"; null for Pinned / Archived / No folder / a moved-to group
  entries: SidebarEntry[]
  hidden?: boolean // hidden (its right-click's Hide), shown because Show hidden is on or a search is typed
}

export interface SidebarGroups {
  pinned: ChatGroup | null // hidden when empty, as in the real app
  folders: ChatGroup[]
  archived: ChatGroup | null // filter 'all' only, when non-empty
  hiddenOut: number // the folder groups Hide left out of `folders`
}

/** Hide's tooltip, in both lists' group menus. */
export const HIDE_TITLE = 'Hides this group, not its chats (they stay active). Filter, Show hidden groups brings it back.'

/** Hide is offered on a folder or moved-to group's header; Pinned and Archived are not projects. */
export const hideable = (g: Pick<ChatGroup, 'key'>): boolean => g.key !== 'pinned' && g.key !== 'archived'

/**
 * The groups a list shows once the hidden ones (a group's right-click → Hide, by its groupOrderKey) are
 * out (owner, 2026-10-05: "I don't want to like archive because they're meant to be there, but I also
 * don't feel like seeing"): with `show` (the Filter menu's Show hidden, or a typed search, which finds
 * every row) they stay, marked `hidden`. The desk list and the cloud list both use it.
 */
export function dropHidden<T extends { hidden?: boolean }>(
  groups: T[],
  keyOf: (g: T) => string,
  hidden: ReadonlySet<string> | undefined,
  show: boolean
): { shown: T[]; out: number } {
  if (!hidden?.size) return { shown: groups, out: 0 }
  const shown: T[] = []
  for (const g of groups) {
    if (!hidden.has(keyOf(g))) shown.push(g)
    else if (show) shown.push(Object.assign(g, { hidden: true }))
  }
  return { shown, out: groups.length - shown.length }
}

/** The hidden keys after Hide (`on`) or Unhide on the group `key`. */
export function setHidden(hidden: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(hidden)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

const newestFirst = (a: SidebarEntry, b: SidebarEntry) => b.at - a.at
export const NO_FOLDER = 'No folder'

/** The marks a row is grouped by, whichever kind it is (an outside session's are Hydra Desk's overlay). */
const marksOf = (e: SidebarEntry) => (e.kind === 'chat' ? e.chat : e.session)
const entryCwd = (e: SidebarEntry) => (e.kind === 'chat' ? e.chat.cwd : (e.session.cwd ?? ''))

/**
 * Active: Pinned first (its own group, newest first), then one group per folder, and one per group a
 * row was moved to, ordered by its newest row; sessions running elsewhere sit in the same groups,
 * except CliMayte's own workers and sessions that already are one of our chats. A moved-to group named
 * like a folder group joins it. Archived: only the archived rows, grouped the same way. All: Active plus
 * an Archived group last. Search drops rows; a group left empty is dropped. A `hidden` group (by its
 * groupOrderKey, so a moved-to group that joined it goes with it) is left out unless `showHidden` or a
 * search; a pinned row of it stays in Pinned.
 */
export function groupChats(
  chats: ChatSummary[],
  opts: {
    query?: string
    filter?: SidebarFilter
    external?: ExternalSession[]
    /** Whether the Apps scope lets an outside session's app through (cloud/logic.ts appShown); Desk's own chats are never filtered. */
    showApp?: (s: ExternalSession) => boolean
    order?: SidebarOrder
    hidden?: ReadonlySet<string>
    showHidden?: boolean
  } = {}
): SidebarGroups {
  const query = (opts.query ?? '').trim().toLowerCase()
  const filter = opts.filter ?? 'active'
  const ours = new Set(chats.map((c) => c.sessionId).filter(Boolean))
  const entries: SidebarEntry[] = [
    ...chats.map((chat): SidebarEntry => ({ kind: 'chat', id: chat.id, at: chat.updatedAt, chat })),
    ...(opts.external ?? [])
      .filter((s) => s.source !== 'climayte' && !ours.has(s.id) && (opts.showApp?.(s) ?? true))
      .map((session): SidebarEntry => ({ kind: 'external', id: session.id, at: session.lastActivityAt ?? 0, session }))
  ].filter((e) => !query || marksOf(e).title.toLowerCase().includes(query))
  const live = filter === 'archived' ? [] : entries.filter((e) => !marksOf(e).archived)
  const archivedRows = filter === 'active' ? [] : entries.filter((e) => marksOf(e).archived)

  const inGroups = filter === 'archived' ? archivedRows : live.filter((e) => !marksOf(e).pinned)
  const pinned = live.filter((e) => marksOf(e).pinned).sort(newestFirst)
  // One folder however its path is spelled (Windows paths ignore case and slash direction); the group
  // shows the path of its newest row exactly as that row has it. Moved-to groups ignore case too.
  const byFolder = new Map<string, SidebarEntry[]>()
  const byGroup = new Map<string, SidebarEntry[]>()
  const add = (map: Map<string, SidebarEntry[]>, key: string, e: SidebarEntry) => {
    const list = map.get(key)
    if (list) list.push(e)
    else map.set(key, [e])
  }
  for (const e of inGroups) {
    const group = marksOf(e).group
    if (group) add(byGroup, group.toLowerCase(), e)
    else add(byFolder, folderKey(entryCwd(e)), e)
  }
  const groups: ChatGroup[] = [...byFolder.values()].map((list) => {
    const cwd = entryCwd(list.sort(newestFirst)[0]!)
    return { key: cwd, label: cwd ? folderLabel(cwd) : NO_FOLDER, cwd: cwd || null, entries: list }
  })
  for (const [name, list] of byGroup) {
    const folder = namesakeFolder(groups, name)
    if (folder) folder.entries.push(...list)
    else groups.push({ key: `group:${name}`, label: marksOf(list.sort(newestFirst)[0]!).group!, cwd: null, entries: list })
  }
  for (const g of groups) g.entries.sort(newestFirst)
  groups.sort((a, b) => b.entries[0]!.at - a.entries[0]!.at)
  const archived = filter === 'all' ? archivedRows.sort(newestFirst) : []
  // A saved order wins over activity, so sending a message moves nothing (Jacob, 2026-10-04).
  const order = opts.order
  const rows = (list: SidebarEntry[]) => (order ? stableOrder(list, (e) => e.id, order.rows) : list)
  for (const g of groups) g.entries = rows(g.entries)
  const folders = dropHidden(order ? stableOrder(groups, groupOrderKey, order.groups) : groups, groupOrderKey, opts.hidden, !!opts.showHidden || !!query)

  return {
    pinned: pinned.length ? { key: 'pinned', label: 'Pinned', cwd: null, entries: rows(pinned) } : null,
    folders: folders.shown,
    archived: archived.length ? { key: 'archived', label: 'Archived', cwd: null, entries: archived } : null,
    hiddenOut: folders.out
  }
}

/**
 * The folder group a moved-to group named `name` joins: of the folder groups with that name, the one whose
 * folder sorts first. Two folders can share a name (C:/a/app, C:/b/app), and the desk list and the cloud
 * list build their groups in different orders, so the first one found would differ between them.
 */
export function namesakeFolder<T extends { cwd: string | null; label: string }>(groups: readonly T[], name: string): T | undefined {
  const lower = name.toLowerCase()
  let best: { group: T; key: string } | undefined
  for (const g of groups) {
    if (!g.cwd || g.label.toLowerCase() !== lower) continue
    const key = folderKey(g.cwd)
    if (!best || key < best.key) best = { group: g, key }
  }
  return best?.group
}

/**
 * The order the sidebar keeps (order.ts), each first to last: group keys (groupOrderKey) and row keys, a
 * desk row's id (a Desk chat's id, an outside session's session id) or the session id of a row only the
 * cloud list has. `cloud`: the keys the cloud list added at the end that the desk list has not shown since;
 * the first time it does (a desk chat started in another PC's folder), it lifts them to the top as new.
 */
export interface SidebarOrder {
  groups: readonly string[]
  rows: readonly string[]
  cloud?: readonly string[]
}

/** A group's place in the saved order: its folder however spelled, or its moved-to group key. */
export function groupOrderKey(g: ChatGroup): string {
  return g.cwd ? folderKey(g.cwd) : g.key
}

const ranks = new WeakMap<readonly string[], Map<string, number>>()
/** Each saved key's place, built once per saved list (a list is replaced when it changes, never edited). */
function rankOf(saved: readonly string[]): Map<string, number> {
  let rank = ranks.get(saved)
  if (!rank) ranks.set(saved, (rank = new Map(saved.map((k, i) => [k, i]))))
  return rank
}

/**
 * Items in their saved order; ones the order does not know yet go first, as they came (newest first),
 * except the ones `last` picks, which go after the known ones (the cloud list's own rows and groups).
 */
export function stableOrder<T>(items: T[], keyOf: (t: T) => string, saved: readonly string[], last: (t: T) => boolean = () => false): T[] {
  const rank = rankOf(saved)
  const fresh = items.filter((t) => !rank.has(keyOf(t)))
  const known = items.filter((t) => rank.has(keyOf(t))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
  return [...fresh.filter((t) => !last(t)), ...known, ...fresh.filter(last)]
}

/**
 * The saved order after a list showed `shown`: the keys it lacks are added, at the top (the desk list's:
 * a new desk row or group joins at the top) or at the end (the cloud list's own), in the order shown; a
 * key already saved never moves. The two lists share one order (order.ts), so recording what one shows
 * must not push the other's rows about (owner, 2026-10-04: "For some reason they change order").
 */
export function recordOrder(saved: readonly string[], shown: readonly string[], at: 'top' | 'end'): string[] {
  const known = new Set(saved)
  const added = [...new Set(shown.filter((k) => !known.has(k)))]
  return at === 'top' ? [...added, ...saved] : [...saved, ...added]
}

/**
 * The saved order after the desk list showed these groups and rows: theirs join at the top, and a key the
 * cloud list added (`cloud`) counts as new the first time the desk list shows it, so a group or row that
 * gains a desk row (a desk chat started in another PC's folder) joins at the top whichever list saw it first.
 */
export function recordDeskOrder(order: SidebarOrder, shownGroups: readonly string[], shownRows: readonly string[]): SidebarOrder {
  const cloud = new Set(order.cloud ?? [])
  const lifted = new Set([...shownGroups, ...shownRows].filter((k) => cloud.has(k)))
  const unlifted = (saved: readonly string[]) => (lifted.size ? saved.filter((k) => !lifted.has(k)) : saved)
  return {
    groups: recordOrder(unlifted(order.groups), shownGroups, 'top'),
    rows: recordOrder(unlifted(order.rows), shownRows, 'top'),
    cloud: unlifted(order.cloud ?? [])
  }
}

/** The saved order after the cloud list showed its own groups and rows (`added`): at the end, marked as its. */
export function recordCloudOrder(order: SidebarOrder, added: SidebarOrder): SidebarOrder {
  const known = new Set([...order.groups, ...order.rows])
  const fresh = [...added.groups, ...added.rows].filter((k) => !known.has(k))
  return {
    groups: recordOrder(order.groups, added.groups, 'end'),
    rows: recordOrder(order.rows, added.rows, 'end'),
    cloud: recordOrder(order.cloud ?? [], fresh, 'end')
  }
}

/** Whether a row shows an attention dot: orange (waiting on you, or background tasks running) or green (done, unread). */
export function isOrange(e: SidebarEntry): boolean {
  const tone = (e.kind === 'chat' ? statusGlyph(e.chat) : externalGlyph(e.session)).tone
  return tone === 'warning' || tone === 'success'
}

/** Whether a row's turn runs now: a folded group's heading counts these (RunningBadge.vue). */
export function entryRunning(e: SidebarEntry): boolean {
  return e.kind === 'chat' ? RUNNING.includes(e.chat.status) : e.session.status === 'working'
}

/** The sessions whose turn runs now, ours and those running elsewhere: the cloud list's folded groups count by them. */
export function runningSessionIds(chats: Pick<ChatSummary, 'sessionId' | 'status'>[], external: Pick<ExternalSession, 'id' | 'status'>[]): Set<string> {
  return new Set([
    ...chats.flatMap((c) => (c.sessionId && RUNNING.includes(c.status) ? [c.sessionId] : [])),
    ...external.flatMap((s) => (s.status === 'working' ? [s.id] : []))
  ])
}

/**
 * The desk rows' dots by session id (a chat's row before an outside session's, as groupChats has it): the
 * cloud list draws the same dot on every row the desk list shows, the hollow ring of an idle one included.
 */
export function deskGlyphs(
  chats: Pick<ChatSummary, 'sessionId' | 'status' | 'unread'>[],
  external: Pick<ExternalSession, 'id' | 'status' | 'unread' | 'source'>[]
): Map<string, StatusGlyph> {
  const out = new Map<string, StatusGlyph>()
  for (const [id, g] of [
    ...chats.map((c) => [c.sessionId, statusGlyph(c)] as const),
    ...external.filter((s) => s.source !== 'climayte').map((s) => [s.id, externalGlyph(s)] as const)
  ])
    if (id && !out.has(id)) out.set(id, g)
  return out
}

/**
 * The row order after rows turned orange (Jacob, 2026-10-04: a chat that finishes and needs checking
 * goes to the top of its project, the latest one first; nothing else moves). `wasOrange` is each row's
 * state last time; a row it does not know yet is not raised (it joins at the top anyway).
 */
export function raiseNewlyOrange(rows: readonly string[], entries: SidebarEntry[], wasOrange: ReadonlyMap<string, boolean>): string[] {
  const raised = entries.filter((e) => wasOrange.get(e.id) === false && isOrange(e)).map((e) => e.id)
  if (!raised.length) return [...rows]
  const set = new Set(raised)
  return [...raised, ...rows.filter((k) => !set.has(k))]
}

/** `order` with `key` moved to just before `before` (null: to the end). */
export function moveInOrder(order: readonly string[], key: string, before: string | null): string[] {
  const rest = order.filter((k) => k !== key)
  const at = before === null ? -1 : rest.indexOf(before)
  return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)]
}

/**
 * Where a dragged row lands: the key it goes just before in the saved order (null: after every other), or
 * undefined when the drop changes nothing. `keys` are the group's rows as shown; the drop is on `over`, on
 * its lower half when `after`. Rows of other groups are never a target.
 */
export function rowDropBefore(keys: readonly string[], from: string, over: string, after: boolean): string | null | undefined {
  if (from === over || !keys.includes(from) || !keys.includes(over)) return undefined
  const rest = keys.filter((k) => k !== from)
  const at = rest.indexOf(over) + (after ? 1 : 0)
  const next = [...rest.slice(0, at), from, ...rest.slice(at)]
  if (next.every((k, i) => k === keys[i])) return undefined
  return next[next.indexOf(from) + 1] ?? null
}

/** Every group a row can be moved to, by name: the folder groups and the moved-to ones, each once, A-Z. */
export function groupChoices(chats: Pick<ChatSummary, 'cwd' | 'group'>[], external: Pick<ExternalSession, 'cwd' | 'group' | 'source'>[] = []): string[] {
  const names = new Map<string, string>()
  const add = (name: string) => {
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
  }
  for (const r of [...chats, ...external.filter((s) => s.source !== 'climayte')]) {
    if (r.group) add(r.group)
    if (r.cwd) add(folderLabel(r.cwd))
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** The dot of a session running elsewhere: the same language, stale is a dim ring, unread (marked here) orange. */
export function externalGlyph(s: Pick<ExternalSession, 'status' | 'unread'>): StatusGlyph {
  switch (s.status) {
    case 'working':
      return { shape: 'dot', tone: 'muted', motion: 'blink', dim: false, label: 'Running elsewhere' }
    case 'needs_you':
      return { shape: 'dot', tone: 'warning', motion: 'pulse', dim: false, label: 'Needs you elsewhere' }
    case 'stale':
      return s.unread
        ? { shape: 'dot', tone: 'warning', motion: 'none', dim: true, label: 'Unread' }
        : { shape: 'ring', tone: 'muted', motion: 'none', dim: true, label: 'Stale' }
    default:
      return s.unread
        ? { shape: 'dot', tone: 'warning', motion: 'none', dim: false, label: 'Unread' }
        : { shape: 'ring', tone: 'muted', motion: 'none', dim: false, label: 'Idle elsewhere' }
  }
}

/** "Claude Desktop", "Claude Code CLI", ... for the source glyph's tooltip. */
export function sourceLabel(source: ExternalSession['source']): string {
  return { desktop: 'Claude Desktop', cli: 'Claude Code CLI', climayte: 'CliMayte', codex: 'Codex', other: 'Another app' }[source]
}

/**
 * The status dot. The real language: idle is a hollow ring, running a solid blinking dot. Hydra Desk
 * paints every "waiting for you" state orange: a question or permission (pulsing) and a finished turn
 * not looked at yet (solid; the real app uses blue there). Error is red, a usage limit a pink hollow
 * ring (it waits for the reset, not for you), closed dims the title. Blue is HSwarm's alone: only a row
 * that stands for a running HSwarm job has it (`swarm`, SWARM_RUNNING).
 */
export interface StatusGlyph {
  shape: 'ring' | 'dot'
  tone: 'muted' | 'warning' | 'success' | 'danger' | 'limited' | 'swarm'
  motion: 'none' | 'blink' | 'pulse'
  dim: boolean // the row title is dimmed (closed)
  label: string // aria-label of the dot, in words
}

/** A CliMayte chat whose worker waits for an account: it is not launching, whatever its status says. */
export const isWaitingForAccount = (chat: Pick<ChatSummary, 'status'> & { waiting?: ChatSummary['waiting'] }): boolean => chat.status === 'starting' && !!chat.waiting

/** 'Waiting for an account, starts about 12:00': the time only when AgentHydra gave one still ahead. */
export function waitingLine(wait: NonNullable<ChatSummary['waiting']>, now: number = Date.now()): string {
  return wait.until !== null && wait.until > now ? `Waiting for an account, starts about ${resetClock(wait.until, now)}` : 'Waiting for an account'
}

export function statusGlyph(chat: Pick<ChatSummary, 'status' | 'unread'> & { waiting?: ChatSummary['waiting']; climayteActive?: number; backgroundActive?: number }): StatusGlyph {
  switch (chat.status) {
    case 'starting':
      if (chat.waiting) return { shape: 'dot', tone: 'muted', motion: 'blink', dim: false, label: 'Waiting' }
      return { shape: 'dot', tone: 'muted', motion: 'blink', dim: false, label: 'Starting' }
    case 'working':
      return { shape: 'dot', tone: 'muted', motion: 'blink', dim: false, label: 'Running' }
    case 'needs_you':
      return { shape: 'dot', tone: 'warning', motion: 'pulse', dim: false, label: 'Needs you' }
    case 'error':
      return { shape: 'dot', tone: 'danger', motion: 'none', dim: false, label: 'Error' }
    case 'limited':
      return { shape: 'ring', tone: 'limited', motion: 'none', dim: false, label: 'Usage limit' }
    case 'closed':
      return settledGlyph(chat, true, 'Closed')
    default: // idle, stopped
      return settledGlyph(chat, false, chat.status === 'stopped' ? 'Stopped' : 'Idle')
  }
}

/**
 * A chat that is not running. Background work still running keeps it orange whether or not it was read
 * (Jacob, 2026-10-04: it must never look done while its workers run): its CliMayte workers, and its own
 * background tasks less the long-lived ones (a dev server never ends, so it does not count). Done and
 * not looked at is green.
 */
function settledGlyph(chat: Pick<ChatSummary, 'unread'> & { climayteActive?: number; backgroundActive?: number }, dim: boolean, idle: string): StatusGlyph {
  if ((chat.climayteActive ?? 0) + (chat.backgroundActive ?? 0) > 0) return { shape: 'dot', tone: 'warning', motion: 'none', dim, label: 'Replied, background tasks running' }
  return chat.unread
    ? { shape: 'dot', tone: 'success', motion: 'none', dim, label: 'Done, unread' }
    : { shape: 'ring', tone: 'muted', motion: 'none', dim, label: idle }
}

/** The dot of a row that stands for a running HSwarm job no chat is known to have called (tasks.ts AddedRow.job). */
export const SWARM_RUNNING: StatusGlyph = { shape: 'dot', tone: 'swarm', motion: 'blink', dim: false, label: 'HSwarm job running' }

/**
 * A running mark's classes: the one shared pulse (style.css .run-pulse, the working dot's blink, still under
 * reduced motion) in its tone. Gray for a CliMayte task, as for a chat that works here or on another PC; blue for
 * an HSwarm job, and for nothing else in the sidebar, where nothing spins (owner, 2026-10-05: "Only the HSwarm
 * items should have blue ... a slow blue pulsing icon"). The tone is the text color: an icon takes it, a dot
 * draws it with bg-current.
 */
export function runPulse(tone: 'gray' | 'blue'): string {
  return `run-pulse ${tone === 'blue' ? 'text-accent-text' : 'text-[var(--status-working)]'}`
}

/** The 6px dot's classes for a glyph; every place that draws a status dot uses these. Working blinks with runPulse's pulse. */
export function glyphDotClass(g: Pick<StatusGlyph, 'shape' | 'tone' | 'motion'>): string {
  if (g.shape === 'ring') {
    return g.tone === 'limited'
      ? 'border-[1.5px] border-[var(--status-limited)]'
      : 'border border-[color-mix(in_srgb,var(--status-idle)_50%,transparent)]'
  }
  const tone = {
    muted: 'bg-[var(--status-working)]',
    warning: 'bg-[var(--status-needs-you)]',
    success: 'bg-[var(--status-done)]',
    danger: 'bg-[var(--status-error)]',
    limited: 'bg-[var(--status-limited)]',
    swarm: 'bg-accent-text'
  }[g.tone]
  const motion = { none: '', blink: ' run-pulse', pulse: ' animate-dot-pulse' }[g.motion]
  return tone + motion
}

/** Elapsed time of a running turn, short: "12s", "4m", "1h 5m". */
export function elapsedLabel(startedAt: number | null, now: number = Date.now()): string {
  if (startedAt == null) return ''
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** "14:05" (today) or "Mon 14:05", for a limited chat's reset time. */
export function resetClock(at: number | null, now: number = Date.now()): string {
  if (at == null) return ''
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** The row's hover tooltip: status in words, activity, elapsed, account. */
export function rowTooltip(chat: ChatSummary, now: number = Date.now()): string {
  const g = statusGlyph(chat)
  const lines = [chat.title, g.label]
  if (chat.activity) lines.push(chat.activity)
  if (chat.status === 'working' && chat.turnStartedAt) lines.push(`Working for ${elapsedLabel(chat.turnStartedAt, now)}`)
  if (chat.status === 'limited' && chat.limitResetsAt) lines.push(`Resets ${resetClock(chat.limitResetsAt, now)}`)
  if (chat.status === 'error' && chat.lastError) lines.push(chat.lastError)
  if (chat.climayteActive > 0) lines.push(`${chat.climayteActive} CliMayte ${chat.climayteActive === 1 ? 'worker' : 'workers'} active`)
  lines.push(accountTitle(chat.account))
  return lines.join('\n')
}

/** What the row menu needs to know of a row: one of our chats, or a session run outside (marked here). */
export interface RowState {
  outside: boolean
  stoppable: boolean // a turn is running here
  pinned: boolean
  archived: boolean
  unread: boolean
  group: string | null
  cwd: string
  sessionId: string | null // null until the chat's session exists
  claudeSession: boolean // `claude --resume` can open it
  forkable: boolean
  /** Whether the person muted this chat's sound (lib/chat-audio.ts); left out, the menu has no Mute entry (a row that cannot mute). */
  muted?: boolean
}

export function chatRow(chat: ChatSummary): RowState {
  return {
    outside: false,
    stoppable: ACTIVE.includes(chat.status),
    pinned: chat.pinned,
    archived: chat.archived,
    unread: chat.unread,
    group: chat.group,
    cwd: chat.cwd,
    sessionId: chat.sessionId,
    claudeSession: true,
    forkable: Boolean(chat.sessionId ?? chat.forkedFrom)
  }
}

export function externalRow(s: ExternalSession): RowState {
  const claude = s.source === 'desktop' || s.source === 'cli'
  return {
    outside: true,
    stoppable: false,
    pinned: s.pinned,
    archived: s.archived,
    unread: s.unread,
    group: s.group,
    cwd: s.cwd ?? '',
    sessionId: s.id,
    claudeSession: claude,
    forkable: claude
  }
}

/**
 * The row menu, as the real app's (three dots and right-click share it): Open in ›, Pin P, Mark as
 * unread U, Rename R, Fork F, Move to group ›, Archive A, Delete D. `shortcut` is the letter that runs
 * the item while the menu is open; `separator` draws a 1px rule; an entry with `items` is a submenu.
 */
export type RowAction =
  | 'open'
  | 'reveal'
  | 'copyResume'
  | 'copySessionId'
  | 'stop'
  | 'pin'
  | 'unpin'
  | 'markUnread'
  | 'markRead'
  | 'mute'
  | 'unmute'
  | 'rename'
  | 'fork'
  | 'moveTo'
  | 'newGroup'
  | 'removeFromGroup'
  | 'archive'
  | 'unarchive'
  | 'delete'
export interface RowMenuItem {
  action: RowAction
  label: string // for moveTo, the group's name
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  title?: string // the native tooltip
}
export type RowMenuEntry = RowMenuItem | 'separator' | { label: string; items: (RowMenuItem | 'separator')[] }

const OUTSIDE_ARCHIVE = 'Hides it in Hydra Desk. Sessions run outside are never deleted here: their files belong to the app that ran them.'

export function rowMenu(row: RowState, groups: string[] = []): RowMenuEntry[] {
  const current = (row.group ?? folderLabel(row.cwd)).toLowerCase()
  const moveTo: (RowMenuItem | 'separator')[] = groups.map((g) => ({ action: 'moveTo', label: g, checked: g.toLowerCase() === current }))
  if (moveTo.length) moveTo.push('separator')
  moveTo.push({ action: 'newGroup', label: 'New group…' })
  if (row.group) moveTo.push({ action: 'removeFromGroup', label: 'Remove from group' })

  const out: RowMenuEntry[] = [
    {
      label: 'Open in',
      items: [
        { action: 'reveal', label: 'File Explorer', disabled: !row.cwd },
        { action: 'copyResume', label: 'Copy resume command', disabled: !row.sessionId || !row.claudeSession },
        { action: 'copySessionId', label: 'Copy session ID', disabled: !row.sessionId }
      ]
    },
    'separator'
  ]
  if (row.stoppable) out.push({ action: 'stop', label: 'Stop' })
  out.push(row.pinned ? { action: 'unpin', label: 'Unpin', shortcut: 'P' } : { action: 'pin', label: 'Pin', shortcut: 'P' })
  out.push(row.unread ? { action: 'markRead', label: 'Mark as read', shortcut: 'U' } : { action: 'markUnread', label: 'Mark as unread', shortcut: 'U' })
  if (row.muted !== undefined) out.push(row.muted ? { action: 'unmute', label: 'Unmute chat', shortcut: 'M' } : { action: 'mute', label: 'Mute chat', shortcut: 'M' })
  out.push({ action: 'rename', label: 'Rename', shortcut: 'R' })
  out.push({ action: 'fork', label: 'Fork', shortcut: 'F', disabled: !row.forkable })
  out.push('separator', { label: 'Move to group', items: moveTo }, 'separator')
  out.push(
    row.archived
      ? { action: 'unarchive', label: 'Unarchive', shortcut: 'A' }
      : { action: 'archive', label: 'Archive', shortcut: 'A', ...(row.outside ? { title: OUTSIDE_ARCHIVE } : {}) }
  )
  if (!row.outside) out.push({ action: 'delete', label: 'Delete', shortcut: 'D', danger: true })
  return out
}

/** The item a key press runs while the menu is open (the letter hints), or null. */
export function shortcutItem(entries: RowMenuEntry[], key: string): RowMenuItem | null {
  if (key.length !== 1) return null
  const letter = key.toUpperCase()
  for (const e of entries) if (e !== 'separator' && !('items' in e) && e.shortcut === letter && !e.disabled) return e
  return null
}

/** Moving to a folder group is moving back to the row's own folder (null) when it is that folder. */
export function moveTarget(row: Pick<RowState, 'cwd'>, name: string): string | null {
  return row.cwd && folderLabel(row.cwd).toLowerCase() === name.toLowerCase() ? null : name
}

/** The patch a menu item stands for (a chat's or an outside session's marks); null for the rest. */
export function rowPatch(item: RowMenuItem, row: Pick<RowState, 'cwd'>): { pinned?: boolean; archived?: boolean; unread?: boolean; group?: string | null } | null {
  switch (item.action) {
    case 'pin':
      return { pinned: true }
    case 'unpin':
      return { pinned: false }
    case 'markUnread':
      return { unread: true }
    case 'markRead':
      return { unread: false }
    case 'archive':
      return { archived: true }
    case 'unarchive':
      return { archived: false }
    case 'moveTo':
      return { group: moveTarget(row, item.label) }
    case 'removeFromGroup':
      return { group: null }
    default:
      return null
  }
}

/** What "Copy resume command" puts on the clipboard. */
export const resumeCommand = (sessionId: string): string => `claude --resume ${sessionId}`

/** Footer account control: initial, name, plan (the real shows "E  eek · Max"). */
export function accountFace(
  defaultAccountId: string,
  accounts: { id: string; label: string; plan: string | null }[]
): { initial: string; name: string; plan: string | null } {
  const acc = accounts.find((a) => a.id === defaultAccountId)
  if (!acc) return { initial: 'A', name: 'Auto', plan: accounts.length ? `${accounts.length} accounts` : null }
  // "#68 eek (Max 20x)" -> "eek"; emails never shown.
  const name =
    acc.label
      .replace(/[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/^#\d+\s*/, '')
      .trim() || (acc.id === 'default' ? 'Default' : `#${acc.id}`)
  // The real footer names the plan family only: an eek on Max 20x reads "eek · Max".
  return { initial: name[0]!.toUpperCase(), name, plan: acc.plan ? acc.plan.split(/\s+/)[0]! : null }
}
