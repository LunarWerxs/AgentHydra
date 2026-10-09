// Chats on disk (SPEC "Store"): <home>/chats.json holds ChatSummary[] without the volatile fields,
// written atomically (temp file + rename) and debounced; <home>/chats/<chatId>.jsonl holds one
// TranscriptItem per line, append-only, where the last line for an id wins on load.

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from '@shared/protocol'
import { userTurns } from './system-text'
import { mediaCache } from '../media/cache'
import { appendFile, open, rm, stat } from 'node:fs/promises'
import { renameOver, renameOverAsync, writeFlushed, writeFlushedAsync } from '../write-flushed'

/** Live-only fields: never saved, reset on load (every chat starts 'closed'). */
const VOLATILE = ['status', 'activity', 'turnStartedAt', 'pendingCount', 'queuedCount', 'climayteActive', 'backgroundActive'] as const
/** Chats whose raw transcript lines stay in memory; the least recently read goes first. */
const LINE_CACHE_MAX = 20

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
  /** Wait before a scheduled write that failed is tried again, ms. */
  retryMs?: number
  /** The timer's rename of chats.json; a test holds it here. */
  renameAsync?: typeof renameOverAsync
}

export class ChatStore {
  readonly home: string
  private readonly debounceMs: number
  private readonly retryMs: number
  private readonly renameAsync: typeof renameOverAsync
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingChats: ChatSummary[] | null = null
  /** Item files whose tail was checked for a torn last line this process. */
  private checkedTails = new Set<string>()
  /** Per item file: the last line per id as the file stood at this size and mtime, so a poll need not read the file again. */
  private lineCache = new Map<string, { size: number; mtimeMs: number; offset: number; lines: Map<string, string>; tail: Map<string, string> }>()
  /** The chats.json text last written, so an unchanged list is not written again. */
  private lastSaved: string | null = null
  /** Bumped by every write of chats.json: a timer's write that a newer one overtook does not rename its temp over it. */
  private generation = 0
  /** The timer's writes, one after another. */
  private writing: Promise<void> = Promise.resolve()
  /**
   * Item lines not yet in their file, per file: `waiting` not yet handed to the disk, `flying` being appended now.
   * Reads lay them over the file (the last line per id wins, so a line already written counts once).
   */
  private appends = new Map<string, Appends>()

  constructor(home: string, opts: ChatStoreOptions = {}) {
    this.home = home
    this.debounceMs = opts.debounceMs ?? 250
    this.retryMs = opts.retryMs ?? 3000
    this.renameAsync = opts.renameAsync ?? renameOverAsync
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
    this.arm(this.debounceMs)
  }

  /** Writes a scheduled save and the queued item lines now (server shutdown, tests); a failed write throws and keeps the list pending. */
  flush(): void {
    // Lines in flight too: the process may end before they land, and a line written twice reads once (the last per id wins).
    for (const [file, q] of this.appends) {
      if (!q.flying.length && !q.waiting.length) continue
      appendFileSync(file, this.tailPrefix(file) + [...q.flying, ...q.waiting.splice(0)].join(''))
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const chats = this.pendingChats
    if (!chats) return
    this.pendingChats = null
    this.generation++
    try {
      const text = JSON.stringify(chats.map(toStored))
      if (text === this.lastSaved && existsSync(this.chatsFile)) return
      const tmp = `${this.chatsFile}.${process.pid}.tmp`
      writeFlushed(tmp, text)
      renameOver(tmp, this.chatsFile)
      this.lastSaved = text
    } catch (err) {
      if (!this.pendingChats) this.pendingChats = chats
      throw err
    }
  }

  /** The write a timer runs, off the server's thread (a busy disk held a flush for seconds). A failed one keeps the list pending and throws. */
  private async flushAsync(): Promise<void> {
    const chats = this.pendingChats
    if (!chats) return
    this.pendingChats = null
    const generation = ++this.generation
    const tmp = `${this.chatsFile}.${process.pid}.${generation}.tmp`
    try {
      const text = JSON.stringify(chats.map(toStored))
      if (text === this.lastSaved && (await stat(this.chatsFile).then(() => true, () => false))) return
      await writeFlushedAsync(tmp, text)
      if (generation !== this.generation) return void (await rm(tmp, { force: true }))
      await this.renameAsync(tmp, this.chatsFile)
      if (generation !== this.generation) return this.restoreLastSaved()
      this.lastSaved = text
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined)
      if (!this.pendingChats && generation === this.generation) this.pendingChats = chats
      throw err
    }
  }

  /** A timer rename that landed after a forced save put the older list back on disk: rewrite the newest one, synchronously. */
  private restoreLastSaved(): void {
    if (this.lastSaved === null) return
    const tmp = `${this.chatsFile}.${process.pid}.tmp`
    writeFlushed(tmp, this.lastSaved)
    renameOver(tmp, this.chatsFile)
  }

  /** Waits for the timer's writes so far (tests). */
  settled(): Promise<void> {
    return this.writing
  }

  /** A timer's save never throws out of the timer: a failed one is logged and tried again. */
  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.writing = this.writing.then(() =>
        this.flushAsync().catch((err) => {
          console.error(`[store] ${this.chatsFile} could not be saved, trying again: ${(err as Error).stack ?? err}`)
          if (!this.timer && this.pendingChats) this.arm(this.retryMs)
        }),
      )
    }, ms)
  }

  /**
   * Appends one finished item: queued, and written in order off the server's thread (a worker's items are synced at
   * every poll, and a busy disk held one append for two seconds). Reads see it at once. A torn last line left by a
   * crash is closed off first.
   */
  appendItem(chatId: string, item: TranscriptItem): void {
    const file = this.itemsFile(chatId)
    let q = this.appends.get(file)
    if (!q) this.appends.set(file, (q = { chatId, waiting: [], flying: [], seq: 0, draining: false }))
    q.waiting.push(JSON.stringify(item) + '\n')
    q.seq++
    if (!q.draining) {
      q.draining = true
      const started = q
      setImmediate(() => void this.drainAppends(file, started))
    }
  }

  /** Waits until every queued item line is written (tests). */
  async settledItems(): Promise<void> {
    while (this.appends.size) await new Promise((r) => setTimeout(r, 5))
  }

  private tailPrefix(file: string): string {
    if (this.checkedTails.has(file)) return ''
    this.checkedTails.add(file)
    return endsWithNewline(file) ? '' : '\n'
  }

  private async drainAppends(file: string, q: Appends): Promise<void> {
    while (q.waiting.length) {
      q.flying = q.waiting.splice(0)
      try {
        let prefix = ''
        if (!this.checkedTails.has(file)) {
          this.checkedTails.add(file)
          if (!(await endsWithNewlineAsync(file))) prefix = '\n'
        }
        await appendFile(file, prefix + q.flying.join(''))
      } catch (err) {
        console.error(`[store] ${q.flying.length} item(s) could not be saved to ${file}: ${(err as Error).message ?? err}`)
      }
      q.flying = []
      const after = q.after
      q.after = undefined
      if (after === 'delete') await rm(file, { force: true }).catch(() => undefined)
      else if (after) this.keepItems(q.chatId, after)
    }
    q.draining = false
    if (this.appends.get(file) === q) this.appends.delete(file)
  }

  /** The lines given to appendItem that may not be in the file yet, oldest first. */
  private pendingLines(file: string): string {
    const q = this.appends.get(file)
    return q ? q.flying.join('') + q.waiting.join('') : ''
  }

  /** Changes whenever the chat's item file or the media folder changes; '' when the chat has no file. */
  itemsStamp(chatId: string): string {
    const file = this.itemsFile(chatId)
    const q = this.appends.get(file)
    const queued = q ? `:q${q.seq}` : ''
    const st = statSync(file, { throwIfNoEntry: false })
    if (!st) return queued
    const media = statSync(join(this.home, 'media'), { throwIfNoEntry: false })
    return `${st.ino}:${st.size}:${st.mtimeMs}:${media?.mtimeMs ?? 0}${queued}`
  }

  /** The chat's items in first-seen order, the last line per id winning; unparsable lines skipped. */
  loadItems(chatId: string): TranscriptItem[] {
    const file = this.itemsFile(chatId)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
    } catch {
      this.lineCache.delete(file)
      const queued = new Map<string, string>()
      addLines(queued, this.pendingLines(file))
      return this.itemsOf(queued)
    }
    let cached = this.lineCache.get(file)
    if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
      // An append only grows the file: read from where the last read stopped. Anything else (shrunk, or rewritten at the same size) reads it whole.
      const from = cached && st.size > cached.size ? cached.offset : 0
      let chunk: Buffer
      try {
        chunk = readFrom(file, from, st.size)
      } catch {
        this.lineCache.delete(file)
        return []
      }
      const lines = from > 0 && cached ? cached.lines : new Map<string, string>()
      const end = chunk.lastIndexOf(0x0a) + 1
      addLines(lines, chunk.toString('utf8', 0, end))
      // A last line with no newline yet may be a write in progress: counted if it parses, read again from its start next time.
      const tail = new Map<string, string>()
      addLines(tail, chunk.toString('utf8', end))
      cached = { size: st.size, mtimeMs: st.mtimeMs, offset: from + end, lines, tail }
    }
    // Most recently read last; the oldest entries go once there are more than the cap (a miss just reads the file again).
    this.lineCache.delete(file)
    this.lineCache.set(file, cached)
    while (this.lineCache.size > LINE_CACHE_MAX) this.lineCache.delete(this.lineCache.keys().next().value as string)
    // Parsed afresh on every call: callers keep and change the items they get, so a shared object would leak between them.
    const out = new Map(cached.lines)
    for (const [id, line] of cached.tail) out.set(id, line)
    addLines(out, this.pendingLines(file))
    return this.itemsOf(out)
  }

  private itemsOf(out: Map<string, string>): TranscriptItem[] {
    // A user item saved before notes and picture lines were read is shown as it reads now (same id), or not at all.
    const media = mediaCache(this.home)
    return [...out.values()].flatMap((line): TranscriptItem[] => {
      const item = JSON.parse(line) as TranscriptItem
      return item.kind === 'user' ? userTurns(item, media) : [item]
    })
  }

  /**
   * Keeps only the items `keep` names (Undo): the file is written again from its own lines, the last per id, in
   * their order, and swapped in whole. Answers the ids it dropped.
   */
  keepItems(chatId: string, keep: ReadonlySet<string>): string[] {
    const file = this.itemsFile(chatId)
    const q = this.appends.get(file)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      if (!q) return []
      text = ''
    }
    // The raw lines, never loadItems' items: a user item is read as it shows now (userTurn), which is not what was saved.
    const lines = new Map<string, string>()
    addLines(lines, text + this.pendingLines(file))
    if (q) {
      // Queued lines are in this rewrite; one being appended now may land after it, so the rewrite runs again then.
      q.waiting.length = 0
      if (q.flying.length) q.after = new Set(keep)
    }
    const tmp = `${file}.${process.pid}.tmp`
    writeFlushed(tmp, [...lines].flatMap(([id, line]) => (keep.has(id) ? [line + '\n'] : [])).join(''))
    renameOver(tmp, file)
    this.checkedTails.add(file)
    this.lineCache.delete(file)
    return [...lines.keys()].filter((id) => !keep.has(id))
  }

  /** Drops the chat's transcript file (the caller drops it from the list and saves). */
  deleteChat(chatId: string): void {
    const file = this.itemsFile(chatId)
    const q = this.appends.get(file)
    if (q) {
      // A line being appended now may land after the removal: the file is removed again once it has.
      q.waiting.length = 0
      if (q.flying.length) q.after = 'delete'
    }
    this.checkedTails.delete(file)
    this.lineCache.delete(file)
    rmSync(file, { force: true })
  }
}

/** A chat file's item lines not yet written (ChatStore.appendItem). */
interface Appends {
  chatId: string
  waiting: string[]
  flying: string[]
  /** Counts every line given, so the items stamp changes with each. */
  seq: number
  draining: boolean
  /** What to do again once the lines in flight have landed: a deleteChat or a keepItems that ran meanwhile. */
  after?: 'delete' | ReadonlySet<string>
}

/** endsWithNewline on the file thread pool. */
async function endsWithNewlineAsync(file: string): Promise<boolean> {
  const size = (await stat(file).catch(() => null))?.size
  if (!size) return true
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    await fh.close()
  }
}

/** The file's bytes from `from` to `to`. */
function readFrom(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** Each parsable item line in `text`, filed by id (a later line replaces an earlier one, keeping its place); a torn line is skipped. */
function addLines(lines: Map<string, string>, text: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as TranscriptItem
      if (item && typeof item.id === 'string') lines.set(item.id, line)
    } catch {
      // a torn line (crash mid-write): skip it
    }
  }
}

/** True for a missing or empty file, or one whose last byte is a newline. */
function endsWithNewline(file: string): boolean {
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (!size) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}
