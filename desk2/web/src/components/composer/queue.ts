// The window half of the managed send queue (SPEC "Send queue"): what Enter and Ctrl+Enter do, the hover
// that shows the queue chevron on the send button, and how the popover and the tray present the server's
// queue. The server holds the queue and sends from it; nothing here dispatches.
import type { ChatStatus, QueueItem, QueueSendMode, QueueState } from '@shared/protocol'

/** The statuses the composer treats as a running turn (its Stop button and "Queue" label read the same). */
export const QUEUE_BUSY: ChatStatus[] = ['working', 'starting', 'needs_you']

export type QueuedMessage = Extract<QueueItem, { kind: 'message' }>

/** The items of one chat still in its queue: a failed one no longer holds the order. */
export function queuedForChat(queue: QueueState | null, chatId: string | null): QueuedMessage[] {
  if (!queue || !chatId) return []
  return queue.items.filter((i): i is QueuedMessage => i.kind === 'message' && i.chatId === chatId && i.state !== 'failed')
}

/** How many of one chat's messages a new one would wait behind: a held one waits for Resume, not for its turn. */
export function aheadInLine(queue: QueueState | null, chatId: string | null): number {
  return queuedForChat(queue, chatId).filter((i) => i.state === 'waiting' || i.state === 'sending').length
}

/**
 * Whether a message goes out now or into the queue. `status` is null on the new-session screen; `queued` is
 * aheadInLine. Ctrl+Enter queues while a turn runs or messages wait ahead (a stopped, failed or limited chat
 * has nothing to wait for, so it sends); a plain Enter queues behind messages already waiting (their order
 * holds), or while a turn runs when the mode says so. A new chat queued waits for an account with room.
 */
export function sendOrEnqueue(s: { status: ChatStatus | null; queued: number; sendMode: QueueSendMode; ctrl: boolean }): 'send' | 'enqueue' {
  if (!s.status) return s.ctrl || s.sendMode === 'queue' ? 'enqueue' : 'send'
  if (s.queued > 0) return 'enqueue'
  return (s.ctrl || s.sendMode === 'queue') && QUEUE_BUSY.includes(s.status) ? 'enqueue' : 'send'
}

/** What a plain Enter does: the queue popover's choice and the send button's right-click menu. Short on purpose. */
export const SEND_MODES: { value: QueueSendMode; label: string; hint: string }[] = [
  { value: 'immediate', label: 'Send immediately', hint: 'Into the running turn' },
  { value: 'queue', label: 'Send as a queue', hint: 'After the turn ends' }
]

const HELD_HINT = 'Resume them in the queue (right-click)'

/**
 * The send button's label and tip, in the popover's words: in 'immediate' mode a busy chat's Enter goes
 * into the running turn, so it reads as a send. `held`: this chat's queued messages wait for Resume.
 */
export function sendWords(s: { enqueue: boolean; busy: boolean; newChat: boolean; held: boolean }): { label: 'Send' | 'Queue'; tip: string } {
  if (s.enqueue) {
    const tip = s.newChat
      ? 'Queue (Enter): starts when an account has room'
      : s.held
        ? `Queue (Enter): held with this chat's queued messages. ${HELD_HINT}`
        : 'Queue (Enter): sends when this chat finishes its turn'
    return { label: 'Queue', tip }
  }
  const tip = s.busy ? 'Send (Enter): goes to the running turn now' : 'Send (Enter)'
  return { label: 'Send', tip: s.held ? `${tip}\nThis chat's queued messages are held. ${HELD_HINT}` : tip }
}

export interface HoverIntent {
  /** The pointer came in: shows after the delay unless it leaves first. */
  enter(): void
  /** The pointer left: cancels a pending show and hides. */
  leave(): void
  /** Shows at once (keyboard focus). */
  now(): void
  dispose(): void
}

/** Hover that has to rest `delayMs` before it counts; timers are injected so a test can drive them. */
export function createHoverIntent<T>(
  delayMs: number,
  setT: (fn: () => void, ms: number) => T,
  clearT: (t: T) => void,
  onChange: (shown: boolean) => void
): HoverIntent {
  let timer: T | null = null
  let shown = false
  const set = (v: boolean) => {
    if (shown === v) return
    shown = v
    onChange(v)
  }
  const cancel = () => {
    if (timer !== null) clearT(timer)
    timer = null
  }
  return {
    enter() {
      if (shown || timer !== null) return
      timer = setT(() => {
        timer = null
        set(true)
      }, delayMs)
    },
    leave() {
      cancel()
      set(false)
    },
    now() {
      cancel()
      set(true)
    },
    dispose: cancel
  }
}

/** Items of the same chat (or all new chats) form one line; the server keeps each line's order. */
function lineOf(item: QueueItem): string {
  return item.kind === 'message' ? item.chatId : 'new'
}

/**
 * The whole id order after moving `id` one place within its own line (past the neighbour of the same
 * chat; other chats' items keep their places), or null at the line's end.
 */
export function movedOrder(items: QueueItem[], id: string, direction: -1 | 1): string[] | null {
  const ids = items.map((i) => i.id)
  const at = ids.indexOf(id)
  if (at < 0) return null
  const line = lineOf(items[at])
  let to = at + direction
  while (to >= 0 && to < items.length && lineOf(items[to]) !== line) to += direction
  if (to < 0 || to >= items.length) return null
  ids[at] = ids[to]
  ids[to] = id
  return ids
}

export type HeldWhy = QueueState['held'][string]

/** Why a chat's queue is held, finishing "<chat title>: ...". */
export function heldText(why: HeldWhy): string {
  return why === 'stopped' ? 'you stopped it' : why === 'error' ? 'it failed' : 'the server restarted'
}

export interface QueueBadge {
  label: string
  reason: string | null
  tone: 'muted' | 'warn'
}

/** A badge only when the item is not plainly waiting. */
export function queueBadge(item: QueueItem, held: QueueState['held']): QueueBadge | null {
  if (item.state === 'sending') return { label: 'Sending…', reason: null, tone: 'muted' }
  if (item.state === 'held') {
    const why = item.kind === 'message' ? held[item.chatId] : undefined
    return { label: 'Held', reason: item.reason ?? (why ? heldText(why) : null), tone: 'warn' }
  }
  if (item.state === 'failed') return { label: 'Failed', reason: item.reason, tone: 'warn' }
  return null
}

export function imagesLabel(count: number): string | null {
  return count ? `${count} ${count === 1 ? 'image' : 'images'}` : null
}

/** A queued text as a row shows it: trimmed, and cut long before the 2-line clamp would hide the rest. */
export function previewText(text: string, max = 280): string {
  const t = text.trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** A tray row's one line: the text, or for a message of pictures only, their count. */
export function trayText(item: QueueItem): string {
  return previewText(item.text) || (imagesLabel(item.images?.length ?? 0) ?? '')
}

export interface QueueRow {
  item: QueueItem
  /** Place in its own line: 1 goes out next for that chat (or next among new chats). */
  position: number
  /** Another chat's title or "New chat"; null for the chat the composer is on. */
  chip: string | null
  first: boolean
  last: boolean
  text: string
  images: string | null
  badge: QueueBadge | null
}

/**
 * The popover's rows: the open chat's line first, then the other lines in the order their first item
 * stands in the server's queue. Each line keeps the server's order, so grouping never reorders a send.
 */
export function queueRows(queue: QueueState | null, chatId: string | null, titles: Map<string, string>): QueueRow[] {
  if (!queue) return []
  const lines = new Map<string, QueueItem[]>()
  if (chatId) lines.set(chatId, [])
  for (const item of queue.items) {
    const line = lineOf(item)
    const list = lines.get(line)
    if (list) list.push(item)
    else lines.set(line, [item])
  }
  const rows: QueueRow[] = []
  for (const [line, items] of lines) {
    items.forEach((item, i) => {
      rows.push({
        item,
        position: i + 1,
        chip: line === chatId ? null : item.kind === 'chat' ? 'New chat' : (titles.get(line) ?? 'Another chat'),
        first: i === 0,
        last: i === items.length - 1,
        text: previewText(item.text),
        images: imagesLabel(item.images?.length ?? 0),
        badge: queueBadge(item, queue.held)
      })
    })
  }
  return rows
}

/** One banner per held chat: "<title>: you stopped it", with Resume. */
export function heldRows(queue: QueueState | null, titles: Map<string, string>): { chatId: string; text: string }[] {
  if (!queue) return []
  return Object.entries(queue.held).map(([chatId, why]) => ({ chatId, text: `${titles.get(chatId) ?? 'A chat'}: ${heldText(why)}` }))
}
