// The managed send queue (SPEC "Send queue"): messages for a chat and new chats that the server holds
// until they can go out. A message is never handed to a running turn (that lands in the CLI's own
// queue, which nothing can edit or recall): a chat's oldest item goes once its turn has finished and
// settled, one per turn. New chats start while fewer than maxNewChats of the ones it started run and
// an account has room. Kept in <home>/queue.json, written at once and atomically: a lost prompt costs
// more than a write. A write that fails is logged and made whole by the next one, but nothing is sent
// until queue.json says it is being sent.

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChatStatus,
  ChatSummary,
  CreateChatRequest,
  ImageRef,
  QueueAddRequest,
  QueueItem,
  QueueItemState,
  QueuePatch,
  QueueReorder,
  QueueSendMode,
  QueueSettingsPatch,
  QueueState,
  ServerEvent,
} from '@shared/protocol'
import { createMediaCache, MAX_MEDIA_BYTES, type MediaCache, MEDIA_ROUTE } from '../media/cache'
import { ChatBusyError, ChatError, type ChatManager, checkCwd, type Json, LIVE, obj, optBool, optString, parseCreate } from './chat-manager'

/** What the queue needs of the chat manager (tests fake it). */
export type QueueChats = Pick<ChatManager, 'list' | 'get' | 'listItems' | 'send' | 'createFromQueue'>

export interface QueueOptions {
  home: string
  manager: QueueChats
  emit(event: ServerEvent): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** How long a chat stays ready before its next item goes: a send or a self-started turn right after a turn ends wins. */
  settleMs?: number
  /** How often a new chat waiting for room, or a chat limited with no known reset, is looked at again. */
  retryMs?: number
}

export const MAX_NEW_CHATS = 8
const DEFAULT_MAX_NEW_CHATS = 2

/** What a waiting, held or failed item says. */
export const REASON = {
  turn: 'Waiting for the turn to finish',
  limit: 'Account at its usage limit',
  room: 'Waiting for an account with room',
  agentHydra: 'Waiting for AgentHydra to list the accounts',
  slot: (n: number) => `Waiting for a free slot (${n} queued ${n === 1 ? 'chat runs' : 'chats run'} at once)`,
  paused: 'The queue is paused',
  stopped: 'You stopped this chat. Resume to send.',
  error: 'The last turn failed. Resume to send.',
  restart: 'The server restarted while this chat was working. Resume to send.',
  deleted: 'This chat was deleted',
}

type Hold = QueueState['held'][string]
/** The record kept in queue.json: the uuid a send went out under rides along, off the wire. */
type Stored = QueueItem & { sentUuid?: string }
type MessageItem = Extract<Stored, { kind: 'message' }>
type ChatItem = Extract<Stored, { kind: 'chat' }>

interface QueueFile extends QueueState {
  items: Stored[]
  /** Chats with queued messages last seen with a turn running: a restart finds them killed mid-turn, however the server ended. */
  wasLive: string[]
}

const STATES: QueueItemState[] = ['waiting', 'held', 'sending', 'failed']

/** queue.json did not take an item's 'sending', so it did not go: it waits again. */
class UnsavedError extends ChatError {
  constructor() {
    super(409, 'the send queue could not be saved, so this was not sent: try again')
  }
}

export class QueueManager {
  readonly file: string
  private readonly manager: QueueChats
  private readonly emit: (event: ServerEvent) => void
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly settleMs: number
  private readonly retryMs: number
  private readonly media: MediaCache

  private items: Stored[] = []
  private paused = false
  private sendMode: QueueSendMode = 'immediate'
  private maxNewChats = DEFAULT_MAX_NEW_CHATS
  private held: Record<string, Hold> = {}
  private rev = 0
  private readonly wasLive = new Set<string>()

  /** The last status seen per chat: holds latch on a change, not on a status that lingers. */
  private readonly seen = new Map<string, ChatStatus>()
  /** Since when a chat with queued messages has been ready (settleMs counts from here). */
  private readonly readySince = new Map<string, number>()
  /** Chats resumed while still stopped or failed: an item added now is not held again for that same stop. */
  private readonly released = new Set<string>()
  /** Chats this queue started that may still be running (they fill maxNewChats). */
  private readonly started = new Set<string>()
  /** New-chat items that found no room, and when to try again. */
  private readonly roomRetryAt = new Map<string, number>()
  private creating = false
  private scheduled = false
  private closing = false
  private timer: unknown = null
  private timerAt = Infinity

  constructor(o: QueueOptions) {
    this.file = join(o.home, 'queue.json')
    this.manager = o.manager
    this.emit = o.emit
    this.now = o.now ?? Date.now
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.settleMs = o.settleMs ?? 800
    this.retryMs = o.retryMs ?? 15_000
    this.media = createMediaCache(join(o.home, 'media'))
    const chats = new Map(this.manager.list({ archived: true }).map((c) => [c.id, c]))
    for (const c of chats.values()) this.seen.set(c.id, c.status)
    const saved = this.load()
    if (saved) {
      this.recover(saved, chats)
      this.save(this.state())
    }
    this.kick()
  }

  // Reads

  state(): QueueState {
    return { items: this.items.map(wire), paused: this.paused, sendMode: this.sendMode, maxNewChats: this.maxNewChats, held: { ...this.held }, rev: this.rev }
  }

  // Writes (the routes)

  add(req: QueueAddRequest): QueueItem {
    const text = req.kind === 'message' ? req.text : (req.prompt ?? '')
    if (!text.trim() && !req.images?.length) throw new ChatError(400, 'text is required')
    const now = this.now()
    const base = { id: randomUUID(), rev: 1, createdAt: now, updatedAt: now, state: 'waiting' as const, reason: null, text }
    const images = this.keep(req.images)
    let item: Stored
    if (req.kind === 'message') {
      const chat = this.manager.get(req.chatId)
      item = { ...base, kind: 'message', chatId: chat.id }
      if (images) item.images = images
      this.items.push(item)
      const stopped = (chat.status === 'stopped' || chat.status === 'error') && !this.released.has(chat.id)
      if (!this.held[chat.id] && stopped) this.hold(chat)
      else if (this.held[chat.id]) this.set(item, 'held', holdReason(this.held[chat.id]!, chat))
      if (LIVE.has(chat.status)) this.wasLive.add(chat.id)
    } else {
      const { kind: _k, prompt: _p, images: _i, ...create } = req
      item = { ...base, ...create, kind: 'chat', cwd: checkCwd(req.cwd), startedChatId: null }
      if (images) item.images = images
      this.items.push(item)
    }
    this.changed()
    this.kick()
    return wire(item)
  }

  edit(id: string, p: QueuePatch): QueueItem {
    const item = this.item(id)
    if (item.state === 'sending') throw new ChatError(409, 'this item is being sent')
    if (p.ifRev !== undefined && p.ifRev !== item.rev) throw new ChatError(409, 'this item changed meanwhile: reload it')
    const text = p.text ?? item.text
    const images = p.images === undefined ? item.images : this.keep(p.images)
    if (!text.trim() && !images?.length) throw new ChatError(400, 'text is required')
    const next = item.state === 'failed' ? this.reopen(item) : item
    next.text = text
    if (images?.length) next.images = images
    else delete next.images
    next.rev++
    next.updatedAt = this.now()
    this.changed()
    this.kick()
    return wire(next)
  }

  remove(id: string): void {
    const item = this.item(id)
    if (item.state === 'sending') throw new ChatError(409, 'this item is being sent')
    this.drop(item)
    this.roomRetryAt.delete(id)
    this.changed()
    this.kick()
  }

  reorder(r: QueueReorder): QueueState {
    if (r.ifRev !== undefined && r.ifRev !== this.rev) throw new ChatError(409, 'the queue changed meanwhile: reload it')
    const byId = new Map(this.items.map((i) => [i.id, i]))
    if (r.ids.length !== byId.size || new Set(r.ids).size !== r.ids.length || r.ids.some((id) => !byId.has(id)))
      throw new ChatError(409, 'the order must name every queued item once: reload the queue')
    this.items = r.ids.map((id) => byId.get(id)!)
    this.changed()
    this.kick()
    return this.state()
  }

  configure(p: QueueSettingsPatch): QueueState {
    const paused = p.paused ?? this.paused
    const sendMode = p.sendMode ?? this.sendMode
    const maxNewChats = p.maxNewChats ?? this.maxNewChats
    if (paused !== this.paused || sendMode !== this.sendMode || maxNewChats !== this.maxNewChats) {
      this.paused = paused
      this.sendMode = sendMode
      this.maxNewChats = maxNewChats
      this.changed()
    }
    this.kick()
    return this.state()
  }

  retry(id: string): QueueItem {
    const item = this.item(id)
    if (item.state !== 'failed') throw new ChatError(409, 'only a failed item can be tried again')
    const next = this.reopen(item)
    next.rev++
    this.changed()
    this.kick()
    return wire(next)
  }

  /** Releases a chat's hold: its queued messages go again, starting once the chat is ready. */
  resume(chatId: string): QueueState {
    if (this.release(chatId)) this.changed()
    this.kick()
    return this.state()
  }

  /**
   * This item now, past pause, hold and readiness: a message to a busy chat joins its running turn as a
   * plain send does, and a new chat starts without waiting for a slot or for room ('auto' falls back to
   * the default login as a plain create does).
   */
  async sendNow(id: string): Promise<{ ok: true; chatId: string; queued: boolean }> {
    let item = this.item(id)
    if (item.state === 'sending') throw new ChatError(409, 'this item is being sent')
    if (item.state === 'failed') item = this.reopen(item)
    if (item.kind === 'message') {
      this.release(item.chatId)
      const { queued } = await this.deliver(item, false)
      return { ok: true, chatId: item.chatId, queued }
    }
    const chatId = await this.start(item, false)
    // Unreachable: only a start that may wait for room answers null.
    if (chatId === null) throw new ChatError(409, REASON.room)
    return { ok: true, chatId, queued: false }
  }

  // The chats

  /** Every chat event the manager emits; the work it causes runs later, never inside the manager's call, and nothing here throws into it. */
  observe(event: ServerEvent): void {
    try {
      this.see(event)
    } catch (err) {
      console.warn(`[desk] the send queue could not take in ${event.type}: ${errorText(err)}`)
    }
  }

  private see(event: ServerEvent): void {
    if (this.closing) return
    if (event.type === 'chat.removed') return this.removed(event.chatId)
    if (event.type !== 'chat.upsert') return
    const c = event.chat
    if (this.seen.get(c.id) === c.status) return
    this.seen.set(c.id, c.status)
    this.readySince.delete(c.id)
    this.released.delete(c.id)
    let touched = false
    // Latched on the change: a stop's leftover CLI sends can turn it working and idle again, and an
    // error goes 'closed' after idling; neither releases it.
    if ((c.status === 'stopped' || c.status === 'error') && !this.held[c.id] && this.messages(c.id).some((i) => i.state === 'waiting')) touched = this.hold(c)
    const live = LIVE.has(c.status) && this.messages(c.id).some((i) => i.state !== 'failed')
    if (live !== this.wasLive.has(c.id)) {
      if (live) this.wasLive.add(c.id)
      else this.wasLive.delete(c.id)
      touched = true
    }
    if (this.started.has(c.id) && !LIVE.has(c.status)) {
      // A slot is free and an account may have room again: the waiting new chats try now.
      this.started.delete(c.id)
      this.roomRetryAt.clear()
    }
    if (touched) this.changed()
    this.kick()
  }

  /** Server shutdown, run before the chats close: their 'closed' must not read as their turns ending. */
  stop(): void {
    this.closing = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  // The dispatcher

  private kick(): void {
    if (this.closing || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closing) return
      try {
        this.pump()
      } catch (err) {
        console.warn(`[desk] the send queue could not run: ${errorText(err)}`)
      }
    })
  }

  private pump(): void {
    const now = this.now()
    let wake = Infinity
    let touched = false
    const note = (item: Stored, reason: string | null) => {
      if (this.set(item, 'waiting', reason)) touched = true
    }

    const byChat = new Map<string, MessageItem[]>()
    for (const item of this.items) {
      if (item.kind !== 'message') continue
      const list = byChat.get(item.chatId)
      if (list) list.push(item)
      else byChat.set(item.chatId, [item])
    }
    for (const [chatId, list] of byChat) {
      const waiting = list.filter((i) => i.state === 'waiting')
      // One in flight per chat; a held chat's items are 'held', not waiting.
      if (!waiting.length || list.some((i) => i.state === 'sending') || this.held[chatId]) continue
      const chat = this.chatOf(chatId)
      if (!chat) {
        for (const i of waiting) touched = this.set(i, 'failed', REASON.deleted) || touched
        continue
      }
      const wait: { reason: string; at?: number } | null = this.paused ? { reason: REASON.paused } : this.waitOf(chat, now)
      if (wait) {
        for (const i of waiting) note(i, wait.reason)
        if (wait.at !== undefined) wake = Math.min(wake, wait.at)
        this.readySince.delete(chatId)
        continue
      }
      for (const i of waiting) note(i, null)
      const since = this.readySince.get(chatId) ?? now
      this.readySince.set(chatId, since)
      if (now < since + this.settleMs) {
        wake = Math.min(wake, since + this.settleMs)
        continue
      }
      this.readySince.delete(chatId)
      void this.deliver(waiting[0]!, true).catch(logUnexpected)
    }

    for (const id of this.started) if (!LIVE.has(this.seen.get(id) ?? 'closed')) this.started.delete(id)
    let running = this.started.size
    let starting = this.creating
    // An 'auto' chat waiting for room keeps the 'auto' ones behind it waiting; a named account does not wait.
    let autoWaits = false
    for (const item of this.items) {
      if (item.kind !== 'chat' || item.state !== 'waiting') continue
      const auto = !item.accountId || item.accountId === 'auto'
      if (this.paused) note(item, REASON.paused)
      else if (auto && autoWaits) note(item, REASON.room)
      else if (running >= this.maxNewChats) note(item, REASON.slot(this.maxNewChats))
      else if ((this.roomRetryAt.get(item.id) ?? 0) > now) {
        autoWaits ||= auto
        wake = Math.min(wake, this.roomRetryAt.get(item.id)!)
      } else if (!starting) {
        // One create at a time: its end runs the dispatcher again.
        starting = true
        running++
        this.roomRetryAt.delete(item.id)
        this.creating = true
        void this.start(item, true)
          .catch(logUnexpected)
          .finally(() => {
            this.creating = false
            this.kick()
          })
      }
    }

    if (touched) this.changed()
    this.arm(wake)
  }

  /** Why a chat's next message cannot go now (and when to look again); null when it is ready. */
  private waitOf(chat: ChatSummary, now: number): { reason: string; at?: number } | null {
    switch (chat.status) {
      case 'starting':
      case 'working':
      case 'needs_you':
        return { reason: REASON.turn }
      case 'limited':
        // A known reset ahead is waited for. Past it, or with none known, the send goes: the manager
        // moves a chat off an account it holds at its limit to one with room.
        if (chat.limitResetsAt !== null && chat.limitResetsAt > now) return { reason: REASON.limit, at: chat.limitResetsAt }
        return null
      default:
        // idle and closed; stopped and error only once resumed (a hold stops them before this)
        return null
    }
  }

  /** Hands a message to its chat. The dispatch asks onlyIfReady: a turn that started meanwhile puts it back to wait. */
  private async deliver(item: MessageItem, dispatch: boolean): Promise<{ queued: boolean }> {
    const before = { state: item.state, reason: item.reason }
    item.sentUuid = randomUUID()
    this.set(item, 'sending', null)
    try {
      // Sent only once queue.json has this uuid: it is how a restart tells whether the message went.
      if (!this.changed()) throw new UnsavedError()
      const r = await this.manager.send(item.chatId, item.text, await this.readBack(item.images), { onlyIfReady: dispatch, messageId: item.sentUuid })
      this.drop(item)
      return r
    } catch (err) {
      delete item.sentUuid
      if (err instanceof ChatError && err.status === 404) this.set(item, 'failed', REASON.deleted)
      else if (!dispatch || err instanceof ChatBusyError || err instanceof UnsavedError) this.set(item, before.state, before.reason)
      else this.set(item, 'failed', errorText(err))
      throw err
    } finally {
      this.changed()
      this.kick()
    }
  }

  /** Starts a new-chat item: its chat id once the first message went out; null when 'auto' found no room yet. */
  private async start(item: ChatItem, waitForRoom: boolean): Promise<string | null> {
    const before = { state: item.state, reason: item.reason }
    item.sentUuid = randomUUID()
    this.set(item, 'sending', null)
    try {
      if (!this.changed()) throw new UnsavedError()
      const made = await this.manager.createFromQueue(createRequest(item, await this.readBack(item.images)), { waitForRoom, messageId: item.sentUuid })
      if ('waiting' in made) {
        delete item.sentUuid
        this.set(item, 'waiting', made.waiting === 'no-room' ? REASON.room : REASON.agentHydra)
        this.roomRetryAt.set(item.id, this.now() + this.retryMs)
        return null
      }
      item.startedChatId = made.chat.id
      this.started.add(made.chat.id)
      // A failed write here cannot stop it: the chat has started, and the next change records its id.
      this.changed()
      const err = await made.firstSend
      if (err !== null) throw new ChatError(502, `The chat started, but its first message failed: ${err}`)
      this.drop(item)
      return made.chat.id
    } catch (err) {
      delete item.sentUuid
      if (err instanceof UnsavedError) {
        // Not started: it tries again after retryMs, where the pump's next pass would start it at once.
        this.set(item, before.state, before.reason)
        this.roomRetryAt.set(item.id, this.now() + this.retryMs)
      } else this.set(item, 'failed', errorText(err))
      throw err
    } finally {
      this.changed()
      this.kick()
    }
  }

  private arm(at: number): void {
    if (at === this.timerAt) return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.timerAt = at
    if (at === Infinity) return
    this.timer = this.setTimer(
      () => {
        this.timer = null
        this.timerAt = Infinity
        this.kick()
      },
      Math.max(0, at - this.now()),
    )
  }

  // Items and holds

  private item(id: string): Stored {
    const item = this.items.find((i) => i.id === id)
    if (!item) throw new ChatError(404, `no queued item ${id}`)
    return item
  }

  private messages(chatId: string): MessageItem[] {
    return this.items.filter((i): i is MessageItem => i.kind === 'message' && i.chatId === chatId)
  }

  private chatOf(id: string): ChatSummary | null {
    try {
      return this.manager.get(id)
    } catch (err) {
      if (err instanceof ChatError && err.status === 404) return null
      throw err
    }
  }

  /** True when the state or reason changed. */
  private set(item: Stored, state: QueueItemState, reason: string | null): boolean {
    if (item.state === state && item.reason === reason) return false
    item.state = state
    item.reason = reason
    item.updatedAt = this.now()
    return true
  }

  private drop(item: Stored): void {
    const i = this.items.indexOf(item)
    if (i >= 0) this.items.splice(i, 1)
  }

  /** Holds a stopped or failed chat's waiting messages until the owner resumes it. */
  private hold(chat: ChatSummary): boolean {
    const why: Hold = chat.status === 'stopped' ? 'stopped' : 'error'
    this.held[chat.id] = why
    for (const i of this.messages(chat.id)) if (i.state === 'waiting') this.set(i, 'held', holdReason(why, chat))
    return true
  }

  private release(chatId: string): boolean {
    if (!this.held[chatId]) return false
    delete this.held[chatId]
    this.released.add(chatId)
    for (const i of this.messages(chatId)) if (i.state === 'held') this.set(i, 'waiting', null)
    return true
  }

  /** A failed item back in line. A new chat that exists but whose first message failed becomes a message to that chat. */
  private reopen(item: Stored): Stored {
    let next = item
    if (item.kind === 'chat' && item.startedChatId) {
      if (this.chatOf(item.startedChatId)) {
        next = asMessage(item, item.startedChatId)
        this.items[this.items.indexOf(item)] = next
      } else item.startedChatId = null
    }
    if (next.kind === 'chat') {
      this.set(next, 'waiting', null)
      return next
    }
    const chat = this.chatOf(next.chatId)
    if (!chat) throw new ChatError(409, REASON.deleted)
    const why = this.held[chat.id]
    this.set(next, why ? 'held' : 'waiting', why ? holdReason(why, chat) : null)
    return next
  }

  private removed(chatId: string): void {
    this.seen.delete(chatId)
    this.readySince.delete(chatId)
    this.released.delete(chatId)
    this.started.delete(chatId)
    let touched = this.wasLive.delete(chatId)
    if (this.held[chatId]) {
      delete this.held[chatId]
      touched = true
    }
    // A message being sent fails by its own send's answer.
    for (const i of this.messages(chatId)) if (i.state !== 'sending') touched = this.set(i, 'failed', REASON.deleted) || touched
    if (touched) this.changed()
    this.kick()
  }

  // Pictures

  /** Into the media cache, kept as url refs. One that cannot be kept is refused here: toStoredImage would drop it silently. */
  private keep(images: ImageRef[] | undefined): ImageRef[] | undefined {
    if (!images?.length) return undefined
    return images.map((img, i) => {
      if (img.dataBase64 !== undefined) {
        const ref = this.media.putBase64(img.dataBase64, img.name)
        if (!ref) throw new ChatError(400, `images[${i}] cannot be queued: a picture must be a PNG, JPEG, GIF or WebP of at most ${MAX_MEDIA_BYTES / 1024 / 1024} MB`)
        return ref
      }
      if (img.url?.startsWith(MEDIA_ROUTE) && this.media.lookup(img.url.slice(MEDIA_ROUTE.length))) return { ...img }
      throw new ChatError(400, `images[${i}] needs dataBase64, or the ${MEDIA_ROUTE} url of a picture already queued`)
    })
  }

  /** The bytes again: the SDK input skips a picture without dataBase64. */
  private async readBack(images: ImageRef[] | undefined): Promise<ImageRef[] | undefined> {
    if (!images) return undefined
    return Promise.all(
      images.map(async (img) => {
        const hit = img.url?.startsWith(MEDIA_ROUTE) ? this.media.lookup(img.url.slice(MEDIA_ROUTE.length)) : null
        if (!hit) throw new ChatError(400, `${img.name ?? 'A picture'} is no longer in the media cache: edit the item to attach it again`)
        return { ...img, dataBase64: (await readFile(hit.path)).toString('base64') }
      }),
    )
  }

  // queue.json

  /** False when queue.json could not be written. */
  private changed(): boolean {
    // A hold with nothing left to hold is spent.
    const heldIds = Object.keys(this.held)
    if (heldIds.length) {
      const live = new Set<string>()
      for (const i of this.items) if (i.kind === 'message' && i.state !== 'failed') live.add(i.chatId)
      for (const id of heldIds) if (!live.has(id)) delete this.held[id]
    }
    this.rev++
    const state = this.state()
    const saved = this.save(state)
    this.emit({ type: 'queue.update', queue: state })
    return saved
  }

  /**
   * False when it failed (on Windows an antivirus scan or the indexer can hold queue.json): the queue
   * goes on from memory, and the next change writes the whole of it again.
   */
  private save(state: QueueState): boolean {
    const data: QueueFile = { ...state, items: this.items, wasLive: [...this.wasLive] }
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, this.file)
      return true
    } catch (err) {
      console.warn(`[desk] ${this.file} could not be written; the next change tries again: ${errorText(err)}`)
      return false
    }
  }

  /** null when there is no file. An unreadable one is an empty queue, the file kept aside (and said in the log). */
  private load(): QueueFile | null {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.keepUnreadable(err)
      return null
    }
    const r: Json = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : {}
    const max = r.maxNewChats
    const held: Record<string, Hold> = {}
    if (r.held && typeof r.held === 'object') {
      for (const [id, why] of Object.entries(r.held as Json)) if (why === 'stopped' || why === 'error' || why === 'restart') held[id] = why
    }
    return {
      items: Array.isArray(r.items) ? r.items.filter(isStored) : [],
      paused: r.paused === true,
      sendMode: r.sendMode === 'queue' ? 'queue' : 'immediate',
      maxNewChats: Number.isInteger(max) && (max as number) >= 1 && (max as number) <= MAX_NEW_CHATS ? (max as number) : DEFAULT_MAX_NEW_CHATS,
      held,
      rev: typeof r.rev === 'number' ? r.rev : 0,
      wasLive: Array.isArray(r.wasLive) ? r.wasLive.filter((id): id is string => typeof id === 'string') : [],
    }
  }

  /** The next save would replace it: renamed to queue.json.bad-<ms>, whatever a hand edit or a torn write left in it can still be recovered. */
  private keepUnreadable(err: unknown): void {
    const kept = `${this.file}.bad-${this.now()}`
    try {
      renameSync(this.file, kept)
      console.warn(`[desk] ${this.file} could not be read, so the send queue starts empty; it is kept as ${kept}: ${errorText(err)}`)
    } catch (moveErr) {
      console.warn(`[desk] ${this.file} could not be read, so the send queue starts empty, and it could not be kept aside (${errorText(moveErr)}): ${errorText(err)}`)
    }
  }

  /**
   * The saved queue as this start finds it: every chat is 'closed' now. A message whose chat is gone is
   * dropped. One that was being sent went out when the chat's transcript has its uuid (dropped), else it
   * waits again. A chat that was working when the server ended is held until resumed.
   */
  private recover(saved: QueueFile, chats: Map<string, ChatSummary>): void {
    this.paused = saved.paused
    this.sendMode = saved.sendMode
    this.maxNewChats = saved.maxNewChats
    this.rev = saved.rev
    const delivered = (chatId: string, uuid: string | undefined) => uuid !== undefined && this.manager.listItems(chatId).some((i) => i.kind === 'user' && i.id === uuid)
    for (const entry of saved.items) {
      let item: Stored = entry
      if (item.kind === 'chat' && item.state === 'sending') {
        const started = item.startedChatId && chats.has(item.startedChatId) ? item.startedChatId : null
        if (started) item = asMessage(item, started)
        else {
          delete item.sentUuid
          item.startedChatId = null
          item.state = 'waiting'
        }
      }
      if (item.kind === 'message') {
        if (!chats.has(item.chatId)) continue
        if (item.state === 'sending') {
          if (delivered(item.chatId, item.sentUuid)) continue
          delete item.sentUuid
          item.state = 'waiting'
        }
      }
      this.items.push(item)
    }
    for (const [id, why] of Object.entries(saved.held)) if (chats.has(id)) this.held[id] = why
    for (const id of saved.wasLive) if (chats.has(id) && !this.held[id]) this.held[id] = 'restart'
    for (const [id, why] of Object.entries(this.held)) {
      for (const i of this.messages(id)) if (i.state === 'waiting') this.set(i, 'held', holdReason(why, chats.get(id) ?? null))
      if (!this.messages(id).some((i) => i.state !== 'failed')) delete this.held[id]
    }
  }
}

function holdReason(why: Hold, chat: ChatSummary | null): string {
  if (why === 'stopped') return REASON.stopped
  if (why === 'restart') return REASON.restart
  return chat?.lastError || REASON.error
}

/** An item as the window gets it. */
function wire(item: Stored): QueueItem {
  const { sentUuid: _s, ...rest } = item
  return { ...rest, ...(item.images ? { images: item.images.map((i) => ({ ...i })) } : {}) } as QueueItem
}

function asMessage(item: ChatItem, chatId: string): MessageItem {
  const next: MessageItem = { id: item.id, rev: item.rev, createdAt: item.createdAt, updatedAt: item.updatedAt, state: item.state, reason: item.reason, text: item.text, kind: 'message', chatId }
  if (item.images) next.images = item.images
  if (item.sentUuid) next.sentUuid = item.sentUuid
  return next
}

function createRequest(item: ChatItem, images: ImageRef[] | undefined): CreateChatRequest {
  return {
    cwd: item.cwd,
    prompt: item.text,
    images,
    title: item.title,
    accountId: item.accountId,
    model: item.model,
    effort: item.effort,
    permissionMode: item.permissionMode,
    delegateToCliMayte: item.delegateToCliMayte,
  }
}

/** Our own file: the shape is checked, not every value. */
function isStored(x: unknown): x is Stored {
  if (!x || typeof x !== 'object') return false
  const o = x as Json
  if (typeof o.id !== 'string' || typeof o.text !== 'string' || !STATES.includes(o.state as QueueItemState)) return false
  if (o.images !== undefined && !Array.isArray(o.images)) return false
  return (o.kind === 'message' && typeof o.chatId === 'string') || (o.kind === 'chat' && typeof o.cwd === 'string')
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The item already says why it did not go; the log keeps what was not a refusal. */
function logUnexpected(err: unknown): void {
  if (!(err instanceof ChatError)) console.warn(`[desk] the send queue: ${errorText(err)}`)
}

// Input validation for the queue routes: each returns the parsed body or throws ChatError(400) with the reason.

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/

/** Pictures as bytes (dataBase64) or as the url of one already queued (an edit sends those back). */
function optQueueImages(b: Json): ImageRef[] | undefined {
  const v = b.images
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ChatError(400, 'images must be an array')
  return v.map((img, i) => {
    if (!img || typeof img !== 'object') throw new ChatError(400, `images[${i}] must be an object`)
    const o = img as Json
    if (typeof o.mediaType !== 'string' || !IMAGE_TYPE.test(o.mediaType)) throw new ChatError(400, `images[${i}].mediaType must be image/png, image/jpeg, image/gif or image/webp`)
    const ref: ImageRef = { mediaType: o.mediaType }
    if (typeof o.dataBase64 === 'string') ref.dataBase64 = o.dataBase64
    else if (typeof o.url === 'string') ref.url = o.url
    else throw new ChatError(400, `images[${i}] needs dataBase64 or url`)
    if (typeof o.name === 'string') ref.name = o.name
    return ref
  })
}

function optRev(b: Json): number | undefined {
  const v = b.ifRev
  if (v === undefined) return undefined
  if (!Number.isInteger(v)) throw new ChatError(400, 'ifRev must be a whole number')
  return v as number
}

function onlyKeys(b: Json, keys: string[]): void {
  const unknown = Object.keys(b).filter((k) => !keys.includes(k))
  if (unknown.length) throw new ChatError(400, `cannot change ${unknown.join(', ')}; this takes ${keys.join(', ')}`)
}

export function parseQueueAdd(body: unknown): QueueAddRequest {
  const b = obj(body)
  const images = optQueueImages(b)
  if (b.kind === 'message') {
    const chatId = optString(b, 'chatId')
    if (!chatId?.trim()) throw new ChatError(400, 'chatId is required')
    const req: QueueAddRequest = { kind: 'message', chatId, text: optString(b, 'text') ?? '' }
    if (images) req.images = images
    return req
  }
  if (b.kind === 'chat') {
    const req: QueueAddRequest = { kind: 'chat', ...parseCreate({ ...b, images: undefined }) }
    if (images) req.images = images
    return req
  }
  throw new ChatError(400, "kind must be 'message' or 'chat'")
}

export function parseQueuePatch(body: unknown): QueuePatch {
  const b = obj(body)
  onlyKeys(b, ['text', 'images', 'ifRev'])
  const p: QueuePatch = {}
  const text = optString(b, 'text')
  if (text !== undefined) p.text = text
  const images = optQueueImages(b)
  if (images) p.images = images
  const ifRev = optRev(b)
  if (ifRev !== undefined) p.ifRev = ifRev
  return p
}

export function parseQueueSettings(body: unknown): QueueSettingsPatch {
  const b = obj(body)
  onlyKeys(b, ['paused', 'sendMode', 'maxNewChats'])
  const p: QueueSettingsPatch = {}
  const paused = optBool(b, 'paused')
  if (paused !== undefined) p.paused = paused
  if (b.sendMode !== undefined) {
    if (b.sendMode !== 'immediate' && b.sendMode !== 'queue') throw new ChatError(400, 'sendMode must be immediate or queue')
    p.sendMode = b.sendMode
  }
  if (b.maxNewChats !== undefined) {
    const n = b.maxNewChats
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_NEW_CHATS) throw new ChatError(400, `maxNewChats must be a whole number from 1 to ${MAX_NEW_CHATS}`)
    p.maxNewChats = n as number
  }
  return p
}

export function parseQueueReorder(body: unknown): QueueReorder {
  const b = obj(body)
  const ids = b.ids
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new ChatError(400, 'ids must be an array of queued item ids')
  const r: QueueReorder = { ids: ids as string[] }
  const ifRev = optRev(b)
  if (ifRev !== undefined) r.ifRev = ifRev
  return r
}
