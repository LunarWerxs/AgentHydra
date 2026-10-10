// Pure shell logic (tested in web/test/shell): navigation history, shortcuts, new-session stats, the split beside a wide pane.
import type { ChatSummary, HeatCell } from '@shared/protocol'

export type View =
  | { kind: 'chat'; id: string }
  | { kind: 'new'; cwd?: string }
  | { kind: 'external'; id: string }
  | { kind: 'elsewhere' }
  | { kind: 'settings' }

export function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * An outside-session view of one of Desk's own chats' sessions IS that chat (AgentHydra lists a Desk chat's session
 * as a CliMayte worker, which has no composer): every way of opening it lands on the chat's own view.
 */
export function chatViewOf(view: View, chats: readonly Pick<ChatSummary, 'id' | 'sessionId'>[]): View {
  if (view.kind !== 'external') return view
  const chat = chats.find((c) => c.sessionId === view.id)
  return chat ? { kind: 'chat', id: chat.id } : view
}

/** Settings is a dialog over the window: the view under it (and the one closing it returns to) is the last other view. */
export function viewUnder(selected: View, last: View): View {
  return selected.kind === 'settings' ? last : selected
}

/** Back / Forward over the views the user visited (the chrome bar's arrows). */
export class NavHistory {
  private stack: View[] = []
  private index = -1

  /** Record a visit. Visiting the current view again is a no-op; a new visit drops the forward list. */
  visit(view: View): void {
    if (this.index >= 0 && sameView(this.stack[this.index]!, view)) return
    this.stack = this.stack.slice(0, this.index + 1)
    this.stack.push(view)
    if (this.stack.length > 100) this.stack.shift()
    this.index = this.stack.length - 1
  }
  get canBack(): boolean {
    return this.index > 0
  }
  get canForward(): boolean {
    return this.index < this.stack.length - 1
  }
  back(): View | null {
    return this.canBack ? this.stack[--this.index]! : null
  }
  forward(): View | null {
    return this.canForward ? this.stack[++this.index]! : null
  }
  /** Drop views of a chat that no longer exists. */
  forget(chatId: string): void {
    const cur = this.stack[this.index]
    this.stack = this.stack.filter((v) => !(v.kind === 'chat' && v.id === chatId))
    const at = cur ? this.stack.findIndex((v) => sameView(v, cur)) : -1
    this.index = at >= 0 ? at : this.stack.length - 1
  }
}

/** Why the window would mark the open chat or outside session read by itself: it was just opened, its
 *  status moved on (a turn started or ended), its unread mark just arrived, or the window came back. */
export type ReadCue = 'opened' | 'turn' | 'mark' | 'focus'

/** The chats and outside sessions a person marked unread by hand (a row's menu, the title bar, U). The
 *  window marks what is open read by itself, and before this that undid a hand mark at once (an outside
 *  session) or the next time the window came back (a chat). A hand mark now holds until the item is
 *  opened again or a new turn moves its status on, which is when the window reads it as seen again.
 *  Idea from stablyai/orca's per-turn auto-acknowledge key (MIT). */
export class UnreadHold {
  private readonly held = new Set<string>()

  /** A person's own mark: unread holds it, read lets it go. */
  mark(id: string, unread: boolean): void {
    if (unread) this.held.add(id)
    else this.held.delete(id)
  }

  /** Whether the window marks `id` read now, on `cue`. Opening it reads it; a new turn reads it when the
   *  window has focus; both end a hand mark. A mark arriving, or the window coming back, never undoes one. */
  reads(id: string, cue: ReadCue, focused: boolean): boolean {
    if (cue === 'opened' || cue === 'turn') this.held.delete(id)
    if (cue === 'opened') return true
    if (this.held.has(id)) return false
    return cue === 'focus' || focused
  }
}

/** The one hold the sidebar's marks and the frame's own read marks share. */
export const unreadHold = new UnreadHold()

export const PEEK_OPEN_MS = 120
export const PEEK_CLOSE_MS = 200

/**
 * The collapsed sidebar's hover flyout. It opens PEEK_OPEN_MS after the pointer reached the show-sidebar
 * toggle, the left-edge strip or the flyout (or keyboard focus went into it), and closes PEEK_CLOSE_MS
 * after both left. While a menu or dialog is open it neither opens nor closes; it waits that out.
 * `close()` is at once (a chat was chosen, Escape).
 */
export class SidebarPeek {
  open = false
  private pointer = false
  private focus = false
  private pending: boolean | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onChange: (open: boolean) => void,
    private readonly overlayOpen: () => boolean = () => false
  ) {}

  /** Called on every pointer move while the sidebar is collapsed: cheap when nothing changes. */
  hover(inside: boolean): void {
    this.pointer = inside
    this.sync()
  }
  focused(inside: boolean): void {
    this.focus = inside
    this.sync()
  }
  close(): void {
    this.cancel()
    this.pointer = false
    this.focus = false
    this.set(false)
  }
  dispose(): void {
    this.cancel()
  }

  private sync(): void {
    const want = this.pointer || this.focus
    if (want === this.pending) return
    this.cancel()
    if (want !== this.open) this.schedule(want)
  }
  private schedule(want: boolean): void {
    this.pending = want
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.pending = null
        if (this.overlayOpen()) this.schedule(want)
        else this.set(want)
      },
      want ? PEEK_OPEN_MS : PEEK_CLOSE_MS
    )
  }
  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }
  private set(open: boolean): void {
    if (open === this.open) return
    this.open = open
    this.onChange(open)
  }
}

export type ShellShortcut = 'new' | 'toggleSidebar' | 'search' | 'back' | 'forward'

/** The letter a shortcut reads: the typed letter on a Latin layout (Dvorak's N is N wherever it sits), and
 *  the physical key's on any other, where Ctrl+N on the N key types 'т' (Cyrillic) and matched nothing.
 *  Idea from stablyai/orca's shortcut matching (MIT). */
function shortcutLetter(e: { key: string; code?: string }): string {
  const k = e.key.toLowerCase()
  if (k.length !== 1 || /^[a-z]$/.test(k)) return k
  const physical = /^Key([A-Z])$/.exec(e.code ?? '')
  return physical ? physical[1].toLowerCase() : k
}

/** Ctrl+N new session, Ctrl+B sidebar, Ctrl+K search, Alt+Left / Alt+Right back and forward. */
export function matchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string }
): ShellShortcut | null {
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey && !e.shiftKey) {
    const k = shortcutLetter(e)
    if (k === 'n') return 'new'
    if (k === 'b') return 'toggleSidebar'
    if (k === 'k') return 'search'
  }
  if (e.altKey && !mod && !e.shiftKey) {
    if (e.key === 'ArrowLeft') return 'back'
    if (e.key === 'ArrowRight') return 'forward'
  }
  return null
}

export type StatsRange = 'all' | '30d' | '7d'
const DAY = 86_400_000

export interface DeskStats {
  sessions: number
  folders: number
  activeDays: number
  peakHour: string // '1 PM', or '–'
  favoriteModel: string // a model label, or 'Default'
  totalCost: string // '$12.40'
  models: { label: string; sessions: number }[]
  /** Activity per day, oldest first, `days` long, ending today: chats touched (`count`) and 0..4 intensity. */
  heat: HeatCell[]
}

/** 'claude-opus-5-5' -> 'Opus 5.5'; an alias or unknown id is shown as given. */
export function modelName(model: string | null): string {
  if (!model) return 'Default'
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return model
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
}

function hourLabel(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12} ${ampm}`
}

/** The stats card on the new-session screen, from Hydra Desk's own chats (the data we really have). */
export function computeStats(chats: ChatSummary[], range: StatsRange, now: number = Date.now(), days = 189): DeskStats {
  const since = range === 'all' ? -Infinity : now - (range === '30d' ? 30 : 7) * DAY
  const inRange = chats.filter((c) => c.updatedAt >= since)
  const dayKey = (t: number) => new Date(t).toDateString()

  const activeDays = new Set<string>()
  const hours = new Array<number>(24).fill(0)
  const models = new Map<string, number>()
  let cost = 0
  for (const c of inRange) {
    for (const t of [c.createdAt, c.updatedAt]) {
      if (t >= since) activeDays.add(dayKey(t))
    }
    hours[new Date(c.updatedAt).getHours()]!++
    const name = modelName(c.model)
    models.set(name, (models.get(name) ?? 0) + 1)
    cost += c.costUsd
  }
  const modelList = [...models.entries()].map(([label, sessions]) => ({ label, sessions })).sort((a, b) => b.sessions - a.sessions)
  const peak = inRange.length ? hours.indexOf(Math.max(...hours)) : -1

  // Heat: chats touched per day over the last `days` days (all chats, so the grid is the same for every range).
  const counts = new Array<number>(days).fill(0)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime() - (days - 1) * DAY
  for (const c of chats) {
    for (const t of new Set([dayKey(c.createdAt), dayKey(c.updatedAt)])) {
      const d = new Date(t).getTime()
      const i = Math.round((d - start) / DAY)
      if (i >= 0 && i < days) counts[i]!++
    }
  }
  const max = Math.max(1, ...counts)
  const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const heat: HeatCell[] = counts.map((n, i) => ({
    day: localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i))),
    count: n,
    level: n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4))
  }))

  return {
    sessions: inRange.length,
    folders: new Set(inRange.map((c) => c.cwd)).size,
    activeDays: activeDays.size,
    peakHour: peak < 0 ? '–' : hourLabel(peak),
    favoriteModel: modelList[0]?.label ?? '–',
    totalCost: `$${cost.toFixed(2)}`,
    models: modelList,
    heat
  }
}

// ---- the split beside a wide pane (the servers pane, Changes with RepoYeti) ----
// The chat keeps the width it was dragged to and the pane takes the rest of the window, so resizing the window resizes
// the pane, as Claude's own app does. Each side keeps only enough room to stay usable; there is no other limit.
export const CHAT_MIN = 300
export const SIDE_MIN = 300
export const CHAT_DEFAULT = 560

/** The chat's width in a stage `stage` px wide, for `want`: whatever leaves the pane its minimum, the chat its own first. */
export const splitChat = (want: number, stage: number): number => Math.round(Math.max(CHAT_MIN, Math.min(want, stage - SIDE_MIN)))

/** splitChat as the stage's grid columns, so the split is right before anything is measured and as the window resizes. */
export const splitColumns = (want: number): string => `max(${CHAT_MIN}px, min(${Math.round(want)}px, calc(100% - ${SIDE_MIN}px))) minmax(0, 1fr)`

// The Background tasks panel docked beside the chat opens narrower than its first 440px and its left edge drags it (owner, 2026-10-08: "should be resizeable, and
// probably open narrower, it is currently VERY wide"). The chat keeps CHAT_MIN however wide it is dragged.
export const TASKS_MIN = 300
export const TASKS_MAX = 720
export const TASKS_DEFAULT = 360

/** The panel's width in a stage `stage` px wide (0 before it is measured), for `want`. */
export const tasksPanelWidth = (want: number, stage: number): number =>
  Math.round(Math.max(TASKS_MIN, Math.min(want, TASKS_MAX, stage > 0 ? stage - CHAT_MIN : TASKS_MAX)))

// ---- the archived notice at the bottom of the chat on screen ----
export type ArchivedNotice = { kind: 'chat' | 'external'; id: string; patch: { archived: false } }

/** The notice an archived chat or outside session shows at its bottom, and what clicking it patches; none otherwise. */
export function archivedNotice(
  view: View,
  chat: Pick<ChatSummary, 'id' | 'archived'> | null,
  external: { id: string; archived?: boolean } | null
): ArchivedNotice | null {
  if (view.kind === 'chat' && chat?.archived) return { kind: 'chat', id: chat.id, patch: { archived: false } }
  if (view.kind === 'external' && external?.archived) return { kind: 'external', id: external.id, patch: { archived: false } }
  return null
}
