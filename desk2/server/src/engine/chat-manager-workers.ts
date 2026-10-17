// ChatManager's CliMayte worker sync (chat-manager.ts), moved out for its size: reads each chat's worker, and
// applies its account, status, transcript and folder to the chat. It reaches the manager only through WorkersHost.
import { existsSync, watch } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ChatSummary, CliMayteWorker, ServerEvent, TranscriptItem } from '@shared/protocol'
import type { AhWorker } from '../bridge/client'
import { isActiveWorkerStatus, keptWorkerIds, workersOfChat } from '../bridge/climayte'
import { findSessionJsonl } from '../bridge/session-jsonl'
import { isUncOrDevicePath } from './cwd-move'
import { chatDiffers } from './chat-runtime'
import { LIVE_STATUSES, workerAccount, workerChatStatus } from './chat-worker-status'
import type { ChatStore } from './store'
import type { FailureInput, FailureLedger } from './failures'
import type { Timings } from './timings'
import { CLIMAYTE_ACCOUNT, type Entry, type ManagerBridge, TURN_WATCH_MS, type UserItem, WORKER_END_GRACE_MS } from './chat-manager-types'
import { accountName, isFolder, sameFolder, signature, standInsFor } from './chat-manager-helpers'
import { advisorStandInFor } from './system-text'

/** What the worker sync reads and calls on ChatManager: its fields, and the members of the manager it applies to. */
export interface WorkersHost {
  readonly chats: Map<string, Entry>
  readonly bridge: ManagerBridge
  readonly store: ChatStore
  readonly timings: Timings
  readonly failures: FailureLedger
  readonly emitEvent: (event: ServerEvent) => void
  now(): number
  isClosing(): boolean
  stored(): ChatSummary[]
  changed(chat: ChatSummary): void
  systemLine(chatId: string, kind: string, level: 'info' | 'warn', text: string): void
  fail(e: Entry, f: Pick<FailureInput, 'message' | 'fallback' | 'cause' | 'durationMs'>): void
  endTasks(e: Entry, at?: number): boolean
  noteTask(e: Entry, item: TranscriptItem): boolean
  dropStandIn(e: Entry, item: UserItem): void
  deskItems(e: Entry): TranscriptItem[]
  countWorkerTurn(e: Entry, w: AhWorker, items: TranscriptItem[]): void
  undelivered(e: Entry): void
  markQueued(e: Entry): void
  noteCwd(e: Entry, file: string | null): boolean
}

export class WorkerSync {
  syncing: Promise<void> | null = null
  workerRows = new Map<string, AhWorker>()

  constructor(private readonly host: WorkersHost) {}

  /**
   * Reads the CliMayte chats' workers again (every live one, or only `only`): status, account and
   * transcript. One read at a time; a read that fails (AgentHydra down) leaves the chats as they were.
   */
  syncWorkers(only?: string): Promise<void> {
    const run = (this.syncing ?? Promise.resolve())
      .then(() => this.syncWorkersNow(only))
      .catch((err) => console.warn(`[desk] could not read the chats' workers: ${err instanceof Error ? err.message : String(err)}`))
    this.syncing = run
    void run.then(() => {
      if (this.syncing === run) this.syncing = null
    })
    return run
  }

  private async syncWorkersNow(only?: string): Promise<void> {
    const revived = only ? null : this.listedActive()
    const entries = [...this.host.chats.values()].filter((e) => e.chat.workerId && (only ? e.chat.id === only : e.workerLive !== false || revived!.has(e.chat.workerId)))
    if (!entries.length) return
    const from = this.host.now()
    const ids = entries.map((e) => e.chat.workerId as string)
    let raw: AhWorker[]
    try {
      raw = await this.host.bridge.workersByIds(ids)
      this.workerRows = new Map(raw.map((w) => [w.id, w]))
    } catch (err) {
      console.warn(`[desk] could not read the chats' workers this round: ${err instanceof Error ? err.message : String(err)}`)
      raw = ids.flatMap((id) => this.workerRows.get(id) ?? [])
    }
    const byId = new Map(raw.map((w) => [w.id, w]))
    // The chats whose worker runs, or which still show it running, are read first. After a restart every chat starts
    // closed and this pass reads every worker, oldest chat first: the newest, the ones at work, sat on their done ring
    // behind hundreds of finished ones (owner, 2026-10-17: 377 workers, a 79 s pass, the live chats 355th to 368th).
    const live = (e: Entry): boolean => {
      const w = byId.get(e.chat.workerId as string)
      return !!w && (isActiveWorkerStatus(w.status) || LIVE_STATUSES.has(e.chat.status))
    }
    for (const e of [...entries.filter(live), ...entries.filter((e) => !live(e))]) {
      const w = byId.get(e.chat.workerId as string)
      if (w && this.host.chats.get(e.chat.id) === e) await this.applyWorker(e, w)
      // One worker's read at a time: a click's request and the timers run between two workers, not after the whole pass.
      await new Promise((done) => setImmediate(done))
      if (this.host.isClosing()) return
    }
    this.host.timings.poll(this.host.now() - from)
  }

  /** The workers AgentHydra's last list shows active. A finished worker is not read again, so one of these whose chat
   *  holds it finished was woken from outside the window (a ping when a job it started ends, another chat's
   *  climayte_send): it is read once more, and its chat shows it working (owner, 2026-10-16: such a chat sat on its
   *  done dot while it worked, until it was opened). */
  private listedActive(): Set<string> {
    return new Set(this.host.bridge.lastWorkers().flatMap((w) => (w.active ? [w.id] : [])))
  }

  /** The chat as its worker stands: status, account (a move is said in the transcript), model, transcript. */
  private async applyWorker(e: Entry, w: AhWorker): Promise<void> {
    const chat = e.chat
    const before = { ...chat }
    const was = chat.status
    this.endMovedWorkerTasks(e, w, before)
    if (w.accountId && w.accountId !== chat.account.id) this.applyWorkerAccount(e, w)

    // Read the live JSONL(s), then append to the Desk file only what is new or changed; push just those. The
    // Desk file is read once, for what it already holds (emitted), not on every poll.
    if (!e.emitted) this.host.deskItems(e)
    // The turn ended: its JSONL is looked for afresh. A new session's file is missing when its first poll looks, and
    // the bridge leaves a missed file 5 s, then 10, before looking again, so a short first turn was never read while
    // it ran and its done came in before its reply (live, 2026-10-14: idle at 11.4 s, the reply read at 12.4 s).
    const ending = LIVE_STATUSES.has(was) && workerChatStatus(w).status === 'idle'
    const rescan = e.readAccount !== w.accountId || ending
    const writing = w.sessionId && w.accountId ? { sessionId: w.sessionId, accountId: w.accountId } : undefined
    const items = await this.host.bridge.workerItems([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])], chat.cwd, { rescan, writing })
    // Deleted meanwhile, or Undo let this worker go.
    if (this.host.chats.get(chat.id) !== e || chat.workerId !== w.id) {
      e.turnWatch?.stop()
      e.turnWatch = undefined
      return
    }
    e.readAccount = w.accountId
    const newReply = this.syncWorkerItems(e, items)
    // The status after the transcript: a chat never reads done before its reply is in. A message waiting for that
    // reply goes once the chat is not busy, and a status set before the read let any change during it send the
    // message without the reply (live, 2026-10-14: Codex was asked 'What code word did I give you?' bare). A JSONL
    // that does not show what was sent yet is behind the worker: the chat stays busy, at most WORKER_END_GRACE_MS.
    if (this.endHeldForReply(e, before, ending)) return
    const next = this.applyWorkerStatus(e, w, was)
    this.watchTurnFile(e, LIVE_STATUSES.has(next.status) && writing ? this.host.bridge.workerFileOf(writing.sessionId) : null)
    if (ending && next.status === 'idle') this.host.countWorkerTurn(e, w, items)
    if (next.status === 'error') this.host.undelivered(e)
    else if (next.waiting) this.host.markQueued(e)
    this.host.timings.workerSeen(chat, { running: w.status === 'running' || w.status === 'checking', active: e.workerLive === true, newReply, ok: next.status !== 'error' })
    // A finished worker's process is gone, and every background task it started with it.
    if (!e.workerLive) this.host.endTasks(e)
    this.adoptWorkerCwd(e, w)
    this.noteWorkerFolderEnd(e, w, was, next.status)
    this.forgetFinishedWorker(e)
    if (!chatDiffers(before, chat)) return
    chat.updatedAt = Math.max(chat.updatedAt, w.updatedAt || 0)
    this.host.changed(chat)
  }

  /** Moved to another account, or continued in a fresh session: the process that ran the old session is gone,
   *  and the background tasks it started with it (their notices never come). */
  private endMovedWorkerTasks(e: Entry, w: AhWorker, before: ChatSummary): void {
    const moved = !!w.accountId && w.accountId !== e.chat.account.id && e.chat.account.id !== CLIMAYTE_ACCOUNT.id
    const freshSession = !!before.sessionId && !!w.sessionId && w.sessionId !== before.sessionId
    if (moved || freshSession) this.host.endTasks(e)
  }

  /** The worker's turn ended but its JSONL does not show what was sent yet: the chat stays busy, at most
   *  WORKER_END_GRACE_MS, so it never reads done before its reply. True while the end is held. */
  private endHeldForReply(e: Entry, before: ChatSummary, ending: boolean): boolean {
    if (ending && e.sent?.length && this.host.now() - (e.endHeldSince ??= this.host.now()) < WORKER_END_GRACE_MS) {
      if (chatDiffers(before, e.chat)) this.host.changed(e.chat)
      return true
    }
    e.endHeldSince = undefined
    return false
  }

  /** A worker's turn ended in another folder: the sidebar follows once the move holds (the next send passes the new folder to the worker, see SPEC "A chat moves folders"). */
  private noteWorkerFolderEnd(e: Entry, w: AhWorker, was: ChatSummary['status'], nextStatus: ChatSummary['status']): void {
    if (w.sessionId && LIVE_STATUSES.has(was) && !LIVE_STATUSES.has(nextStatus)) {
      this.host.noteCwd(e, this.workerFile(e, w.sessionId, w.accountId ?? null))
    }
  }

  /** A finished worker is not polled again: what remembers its items is let go (the Desk file seeds it again). */
  private forgetFinishedWorker(e: Entry): void {
    if (e.workerLive) return
    e.emitted = undefined
    e.workerSeen = undefined
    e.cwdFile = undefined
  }

  /**
   * The folder AgentHydra has for the worker (its pending one, else where it runs) moves the chat, at once, when the
   * chat still sits where the worker was last started or sent. A folder the Desk side set first is passed to the
   * worker by the next send instead, so it is never undone here.
   */
  private adoptWorkerCwd(e: Entry, w: AhWorker): void {
    const chat = e.chat
    const known = e.workerCwd ?? w.cwd
    if (!sameFolder(chat.cwd, known)) return
    const reported = w.pendingCwd ?? w.cwd
    if (!reported || !isAbsolute(reported) || isUncOrDevicePath(reported) || sameFolder(reported, known)) return
    const target = resolve(reported)
    if (!isFolder(target)) return
    chat.cwd = target
    this.setWorkerCwd(e, target)
    this.host.systemLine(chat.id, 'cwd', 'info', `Moved this chat to ${target}.`)
    this.host.changed(chat)
  }

  setWorkerCwd(e: Entry, cwd: string): void {
    if (e.workerCwd !== undefined && sameFolder(e.workerCwd, cwd)) return
    e.workerCwd = cwd
    this.host.store.saveChats(this.host.stored())
  }

  /** The worker runs on another account than the chat says: the chat follows, and a move is said in the transcript. */
  private applyWorkerAccount(e: Entry, w: AhWorker): void {
    const chat = e.chat
    const from = chat.account.id === CLIMAYTE_ACCOUNT.id ? null : chat.account
    chat.account = workerAccount(w)
    if (!from) return
    this.host.timings.workerMoved(chat, `${accountName(from)}>${accountName(chat.account)}`)
    if (e.lastFailure) this.host.failures.recovered(e.lastFailure, chat.account.id)
    this.host.systemLine(chat.id, 'moved', 'info', `CliMayte moved this chat from ${from.label} to ${chat.account.label}.`)
  }

  private applyWorkerStatus(e: Entry, w: AhWorker, was: ChatSummary['status']): ReturnType<typeof workerChatStatus> {
    const chat = e.chat
    const next = workerChatStatus(w)
    chat.status = next.status
    chat.activity = next.activity
    chat.waiting = next.waiting
    chat.lastError = next.status === 'error' ? (w.error ?? 'The worker failed.') : null
    if (chat.lastError && (was !== 'error' || chat.lastError !== e.workerErrorSeen)) this.host.fail(e, { message: chat.lastError, fallback: 'worker_failed' })
    e.workerErrorSeen = chat.lastError
    if (LIVE_STATUSES.has(next.status)) chat.turnStartedAt ??= this.host.now()
    else chat.turnStartedAt = null
    if (LIVE_STATUSES.has(was) && !LIVE_STATUSES.has(next.status)) chat.unread = true
    chat.model = w.reportedModel ?? w.model ?? chat.model
    if (w.sessionId) chat.sessionId = w.sessionId
    e.workerLive = isActiveWorkerStatus(w.status)
    return next
  }

  /** The worker's items that are new or changed go to the Desk file and the windows; true when one is a new reply. */
  private syncWorkerItems(e: Entry, items: TranscriptItem[]): boolean {
    const chat = e.chat
    const emitted = e.emitted!
    let newReply = false
    // The same array as last time: nothing in the worker's files changed, so nothing in it is new.
    const unchanged = items === e.workerSeen
    e.workerSeen = items
    for (const item of unchanged ? [] : items) {
      // The Urgency Advisor's message comes back as his note, not a user turn: without this its stand-in stayed
      // "Queued" after the worker had it, and read "Not delivered" when the worker ended (2026-10-17). Checked before
      // the already-shown skip, so a stand-in kept across a restart goes too.
      if (item.kind === 'note' && item.advisor && e.sent?.length) {
        const i = advisorStandInFor(e.sent, item)
        if (i >= 0) this.host.dropStandIn(e, e.sent[i]!)
      }
      const sig = signature(item)
      if (emitted.get(item.id) === sig) continue
      // The ended session's JSONL still says 'running' or answers its old notice: the settled item stays.
      if (item.kind === 'task' && e.ended?.has(item.id)) continue
      if (!emitted.has(item.id) && (item.kind === 'assistant_text' || item.kind === 'thinking' || item.kind === 'tool_use')) newReply = true
      emitted.set(item.id, sig)
      if (item.kind === 'user' && e.sent?.length) {
        const sent = e.sent
        for (const i of standInsFor(sent, item, new Set(e.retrying?.map((r) => r.itemId)))) this.host.dropStandIn(e, sent[i]!)
      }
      this.host.store.appendItem(chat.id, item)
      this.host.emitEvent({ type: 'item.upsert', chatId: chat.id, item })
      this.host.noteTask(e, item)
    }
    return newReply
  }

  /** Watches the file a turn in flight writes to: a write reads the worker at once, instead of at the next poll. */
  private watchTurnFile(e: Entry, file: string | null): void {
    if (e.turnWatch?.file === file) return
    e.turnWatch?.stop()
    e.turnWatch = undefined
    if (!file) return
    const turn: NonNullable<Entry['turnWatch']> = {
      file,
      stop: () => {
        clearTimeout(turn.timer)
        watcher?.close()
      }
    }
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(file, { persistent: false }, () => {
        clearTimeout(turn.timer)
        turn.timer = setTimeout(() => void this.syncWorkers(e.chat.id), TURN_WATCH_MS)
      })
    } catch {
      return
    }
    watcher.on('error', turn.stop)
    e.turnWatch = turn
  }

  /** The worker's session file: the one found last time while the session and account are the same and it is still there, else searched for. */
  private workerFile(e: Entry, sessionId: string, account: string | null): string | null {
    const hit = e.cwdFile
    if (hit && hit.sessionId === sessionId && hit.account === account && existsSync(hit.file)) return hit.file
    const file = findSessionJsonl(sessionId, this.host.bridge.sessionRoots(), e.chat.cwd)
    e.cwdFile = file ? { sessionId, account, file } : undefined
    return file
  }

  /** Sets climayteActive (its active workers and running seats), drops the stored workerIds that are another chat's, and adds the workers now matched; true when workerIds changed. */
  matchWorkers(chat: ChatSummary, workers: CliMayteWorker[]): boolean {
    const mine = workersOfChat(workers, chat)
    chat.climayteActive = mine.filter((w) => w.active).length + this.seatsRunning(chat.id)
    const others = new Set<string>()
    for (const e of this.host.chats.values()) if (e.chat.id !== chat.id && e.chat.workerId) others.add(e.chat.workerId)
    const ids = chat.workerIds ?? []
    const kept = keptWorkerIds(workers, chat, others)
    const keptSet = new Set(kept)
    const fresh = mine.map((w) => w.id).filter((id) => !keptSet.has(id))
    if (!fresh.length && kept.length === ids.length) return false
    chat.workerIds = [...kept, ...fresh]
    return true
  }

  /** The chat's sub-chats (seats, sub-managers) still at work, counted as its drones are (A4-F8): one that is
   *  working, asking or starting, or whose own drones or seats still run. Seat workers carry no origin session, so
   *  workersOfChat never finds them. */
  private seatsRunning(id: string): number {
    let n = 0
    for (const e of this.host.chats.values()) {
      const c = e.chat
      if (c.parentId === id && (c.status === 'working' || c.status === 'needs_you' || c.status === 'starting' || c.climayteActive > 0)) n++
    }
    return n
  }
}
