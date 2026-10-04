// Chats on disk (SPEC "Store"): <home>/chats.json holds ChatSummary[] without the volatile fields,
// written atomically (temp file + rename) and debounced; <home>/chats/<chatId>.jsonl holds one
// TranscriptItem per line, append-only, where the last line for an id wins on load.

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'

/** Live-only fields: never saved, reset on load (every chat starts 'closed'). */
const VOLATILE = ['status', 'activity', 'turnStartedAt', 'pendingCount', 'queuedCount', 'climayteActive', 'backgroundActive'] as const

export type StoredChat = Omit<ChatSummary, (typeof VOLATILE)[number]>

export function toStored(chat: ChatSummary): StoredChat {
  const copy: Record<string, unknown> = { ...chat }
  for (const k of VOLATILE) delete copy[k]
  return copy as StoredChat
}

export function fromStored(stored: StoredChat): ChatSummary {
  // Chats saved before accountAuto existed count as named (a limit moves them all the same). Ones saved before
  // group and forkedFrom existed have neither.
  return { ...stored, accountAuto: stored.accountAuto === true, group: stored.group ?? null, forkedFrom: stored.forkedFrom ?? null, status: 'closed', activity: null, turnStartedAt: null, pendingCount: 0, queuedCount: 0, climayteActive: 0 }
}

export interface ChatStoreOptions {
  /** Debounce for chats.json writes, ms. */
  debounceMs?: number
}

export class ChatStore {
  readonly home: string
  private readonly debounceMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingChats: ChatSummary[] | null = null
  /** Item files whose tail was checked for a torn last line this process. */
  private checkedTails = new Set<string>()

  constructor(home: string, opts: ChatStoreOptions = {}) {
    this.home = home
    this.debounceMs = opts.debounceMs ?? 250
    mkdirSync(join(home, 'chats'), { recursive: true })
  }

  get chatsFile(): string {
    return join(this.home, 'chats.json')
  }

  itemsFile(chatId: string): string {
    if (!/^[\w-]+$/.test(chatId)) throw new Error(`bad chat id: ${chatId}`)
    return join(this.home, 'chats', `${chatId}.jsonl`)
  }

  /** Every saved chat, status 'closed'. A missing or unreadable chats.json is an empty list. */
  loadChats(): ChatSummary[] {
    let raw: string
    try {
      raw = readFileSync(this.chatsFile, 'utf8')
    } catch {
      return []
    }
    try {
      const list = JSON.parse(raw) as unknown
      if (!Array.isArray(list)) return []
      return (list as StoredChat[]).filter((c) => c && typeof c.id === 'string').map(fromStored)
    } catch {
      return []
    }
  }

  /** Schedules a write of the whole list; the latest list given wins. */
  saveChats(chats: ChatSummary[]): void {
    this.pendingChats = chats
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
  }

  /** Writes a scheduled save now (server shutdown, tests). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const chats = this.pendingChats
    if (!chats) return
    this.pendingChats = null
    const tmp = `${this.chatsFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(chats.map(toStored), null, 2))
    renameSync(tmp, this.chatsFile)
  }

  /** Appends one finished item. A torn last line left by a crash is closed off first. */
  appendItem(chatId: string, item: TranscriptItem): void {
    const file = this.itemsFile(chatId)
    let prefix = ''
    if (!this.checkedTails.has(file)) {
      this.checkedTails.add(file)
      if (!endsWithNewline(file)) prefix = '\n'
    }
    appendFileSync(file, prefix + JSON.stringify(item) + '\n')
  }

  /** The chat's items in first-seen order, the last line per id winning; unparsable lines skipped. */
  loadItems(chatId: string): TranscriptItem[] {
    let raw: string
    try {
      raw = readFileSync(this.itemsFile(chatId), 'utf8')
    } catch {
      return []
    }
    const byId = new Map<string, TranscriptItem>()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as TranscriptItem
        if (item && typeof item.id === 'string') byId.set(item.id, item)
      } catch {
        // a torn line (crash mid-write): skip it
      }
    }
    return [...byId.values()]
  }

  /** Drops the chat's transcript file (the caller drops it from the list and saves). */
  deleteChat(chatId: string): void {
    const file = this.itemsFile(chatId)
    this.checkedTails.delete(file)
    rmSync(file, { force: true })
  }
}

/** True for a missing or empty file, or one whose last byte is a newline. */
function endsWithNewline(file: string): boolean {
  if (!existsSync(file)) return true
  const size = statSync(file).size
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}
