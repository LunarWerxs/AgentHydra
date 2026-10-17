// ChatManager (SPEC "The engine" + "Lifecycle"): owns every chat. A new chat is a CliMayte worker (SPEC
// "Chats are CliMayte workers"): its first message starts the worker, every later one is sent to it, and
// its transcript and status are read back from the worker. CliMayte picks the account and moves the chat
// when that account hits its limit or its login dies; Hydra Desk keeps no account policy of its own.
// Sessions continued from outside (imports) and forks still run in a ChatRuntime (the Agent SDK in this
// process) on the account they are named: a resume needs that session's own folder, which a worker
// cannot take. Loads the saved chats at start (all 'closed'), interrupts, answers the runtime's
// permission / question / plan requests, patches, deletes, and keeps climayteActive current.

import { type SearchResult, searchResult } from '@shared/find'
import { randomUUID } from 'node:crypto'
import { branchOf } from '../git/branch'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type {
  AccountInfo,
  AccountRef,
  ChatPatch,
  ChatSummary,
  SusLevel,
  CliMayteWorker,
  CreateChatRequest,
  DeskSettings,
  Effort,
  ElicitationAnswer,
  ImageRef,
  ImportSessionRequest,
  McpStatus,
  ModelChoice,
  PermissionDecision,
  PlanDecision,
  QuestionAnswer,
  CancelQueuedResult,
  ChatServiceInfo,
  ExternalSession,
  ChatServiceKind,
  PinnedService,
  SendNowResult,
  ServerEvent,
  ServiceThread,
  SessionMeta,
  SessionMetaPatch,
  SlashCommandInfo,
  TranscriptItem,
} from '@shared/protocol'
import { type ChatItemsPage, type TranscriptIndex, type TranscriptItem as IndexedItem } from '@shared/protocol'
import { buildTranscriptIndex } from '@shared/transcript-index'
import { NEW_TITLE, newChatTitle, titleFrom } from '@shared/chat-title'
import type { Bridge } from '../bridge'
import { pickHealthy, ROOM_PCT } from '../bridge/accounts'
import type { AhWorker, WorkerSendSetting } from '../bridge/client'
import { isLongLived } from './long-lived'
import { copyMedia, endedTask, settled, TASK_SESSION_ENDED } from './chat-items'
import { climayteSetting, restoreSetting, SUS_WHY, workerTurnSetting } from './chat-worker-status'
import { cutsBefore, forkPoint, placeInCwd, projectsRoot, seedSession } from '../bridge/seed-session'
import { findSessionJsonl } from '../bridge/session-jsonl'
import { chatQueryImpl, claimHosts, openHosts, releaseHosts } from '../host/client'
import { connectorsPending } from '../connectors/registry'
import { chatAddOns } from './desk-prompt'
import { classifyTurn, PushbackStore, type PushbackRow, workerTurnKey } from './pushback'
import { claudeCodeBinaryFor } from './claude-code-binary'
import { ChatRuntime, type QueryImpl } from './chat-runtime'
import { commandInfosFrom, modelChoicesFrom, normalizeModel, STATIC_COMMANDS, STATIC_MODELS } from './models'
import { answersWithPictures, ElicitationAnswerError, QuestionPictureError } from './requests'
import { NOT_SENT_AGAIN, RETRY_DELAYS, type RetryDelays, type RetryItem, retryable, SERVER_ERROR_TRIES, sleep } from './send-retry'
import { mediaCache, toStoredImage } from '../media/cache'
import { noteOf, standInShown, withNamedFiles } from './system-text'
import { indexPictures, type PictureEngine } from '../media/picture-index'
import { SessionMetaStore } from './session-meta'
import { ChatStore, fromStored, type StoredChat } from './store'
import { classifyFailure, FailureLedger, type FailureInput } from './failures'
import { sdkTitleGenerator, type TitleGenerator } from './chat-title'
import { Timings } from './timings'
import { ANSWER_NOW, buildHandoff, FRESH_TOKENS, HANDOFF_TOKENS, PINNED, sessionTokens } from './handoff'
import type { QueuedInput } from './input-queue'
import { forgetChat } from '../../../../server/src/hydra-core/seat-chats'
import { chatFace } from './core-lead'
import { coreDir } from './hydra-core-mode'
import { MANAGER_SLUG } from '../../../../server/src/manager-folders'
import { type CodexDirectory, codexAccount, pickCodexAccount } from './codex/accounts'
import { closeAppServers, type OpenAppServer } from './codex/app-server'
import { CodexRuntime } from './codex/runtime'
import { ChatgptRuntime, type FreeChats } from './chatgpt/runtime'
import type { ServiceRuntime } from './service-runtime'
import {
  CLIMAYTE_ACCOUNT, CUT_NOT_FOUND, ITEMS_BODY_BYTES, LIVE, READ_ONLY_SOURCES, SERVICE_LABEL, TITLE_TRIES, UNDO_NOT_FOUND,
  WORKER_GROUP, WORKER_MODEL,
  type ChatManagerOptions, type Cut, type Entry, type ManagerBridge, type QueueCreated, type RequestAnswerer, type ResolvedAccount, type RetryPace, type SendOptions, type StoredRecord, type UserItem,
} from './chat-manager-types'
import {
  accountName, accountRef, busy, entryOf, forkTitle, importTitle, ranInOf, retryLater, signature, squash, workersKey,
} from './chat-manager-helpers'
import { WorkerSync } from './chat-manager-workers'
import { ChatMoves } from './chat-manager-moves'
export type { ChatManagerOptions, ManagerBridge, QueueCreated, SendOptions } from './chat-manager-types'
export { CLIMAYTE_ACCOUNT, LIVE, WORKER_GROUP, WORKER_MODEL } from './chat-manager-types'

/** A request the manager refuses, with the HTTP status the route answers. */
export class ChatError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
  }
}

/** onlyIfReady's refusal: a turn runs, so the send would join it. The queue waits for the next idle; any other 409 is final. */
export class ChatBusyError extends ChatError {
  constructor() {
    super(409, 'the chat is busy with a turn')
  }
}

export class ChatManager {
  readonly store: ChatStore
  /** Hydra Desk's marks on outside sessions (pin, archive, unread, title, group). */
  readonly sessionMeta: SessionMetaStore
  /** Every failure, appended as it happens (SPEC "Failure ledger"). */
  readonly failures: FailureLedger
  /** How long every stage took (SPEC "Speed (timings)"). */
  readonly timings: Timings
  private readonly chats = new Map<string, Entry>()
  /** Accounts a chat's sign-in failed on, until the time given: placement skips them (CliMayte's identity wall retries every 6 hours too). */
  private readonly signInHeld = new Map<string, number>()
  private readonly emitEvent: (event: ServerEvent) => void
  private readonly settingsOf: () => DeskSettings
  private readonly pushback: PushbackStore
  private readonly bridge: ManagerBridge
  private readonly onChatEnd: ((sessions: string[]) => void) | undefined
  private readonly claudeHome: string | undefined
  private readonly handoffTokens: number
  private readonly freshTokens: number
  private readonly deskUrl: () => string
  private readonly queryImpl: QueryImpl
  private readonly env?: Record<string, string | undefined>
  private readonly agentHydraMcp?: McpServerConfig | null
  private readonly mainClaudeJson?: string | null
  private readonly now: () => number
  private readonly liveListTimeoutMs: number
  private liveModels: ModelChoice[] | null = null
  private readonly newChats: 'climayte' | 'sdk'
  private readonly workers: WorkerSync
  private readonly moves: ChatMoves
  /** The JSON of each chat's items as last answered, while its file and media stand as they were (see itemsBody). */
  private readonly itemIndexes = new Map<string, { stamp: string; index: TranscriptIndex }>()
  private readonly itemsBodies = new Map<string, { stamp: string; body: string; count: number }>()
  private itemsBodyBytes = 0
  /** closeAll ran: the pass over the workers stops at the next worker instead of saving into a folder that may be gone. */
  private closing = false
  /** The branch reads under way (refreshBranch), each running git in a chat's folder: closeAll waits for them. */
  private readonly branchReads = new Set<Promise<void>>()
  private readonly titleGen: TitleGenerator | null
  private readonly retryDelays: RetryDelays
  private readonly codexDir: CodexDirectory | null
  private readonly openCodex: OpenAppServer | undefined
  /** Codex accounts a chat's turn hit the usage limit on, until when: new threads go elsewhere meanwhile. */
  private readonly codexHeld = new Map<string, number>()
  private readonly free: () => FreeChats | undefined
  /** The same for ChatGPT accounts. */
  private readonly chatgptHeld = new Map<string, number>()

  /** The projects folder of a config folder (null: the default one), under the given home so every read and seed agree on it. */
  private root(configDir: string | null): string {
    return projectsRoot(configDir, this.claudeHome)
  }

  constructor(o: ChatManagerOptions) {
    this.store = new ChatStore(o.home, { debounceMs: o.storeDebounceMs })
    this.pushback = new PushbackStore(o.home)
    this.failures = new FailureLedger(o.home, o.now)
    this.timings = Timings.for(o.home, o.now)
    this.sessionMeta = new SessionMetaStore(o.home, o.now)
    // Every transcript item that goes out is the chat's last action when it is newer (the row menu's Last action line).
    this.emitEvent = (event) => {
      if (event.type === 'item.upsert') this.noteAction(event.chatId, event.item.ts)
      o.emit(event)
    }
    this.settingsOf = o.settings
    this.bridge = o.bridge
    this.onChatEnd = o.onChatEnd
    this.claudeHome = o.claudeHome
    this.handoffTokens = o.handoffTokens ?? (Number(process.env.HYDRA_DESK_HANDOFF_TOKENS) || HANDOFF_TOKENS)
    this.freshTokens = o.freshTokens ?? (Number(process.env.HYDRA_DESK_FRESH_TOKENS) || FRESH_TOKENS)
    this.deskUrl = o.deskUrl ?? (() => `http://127.0.0.1:${Number(process.env.HYDRA_DESK_PORT) || 7798}`)
    // A host outlives the server; with no server it ends after the idle-close minutes once its chat is not working.
    this.queryImpl = o.queryImpl ?? chatQueryImpl({ home: o.home, orphanMinutes: () => o.settings().idleCloseMinutes })
    this.env = o.env
    this.agentHydraMcp = o.agentHydraMcp
    this.mainClaudeJson = o.mainClaudeJson
    this.now = o.now ?? Date.now
    this.liveListTimeoutMs = o.liveListTimeoutMs ?? 5000
    this.newChats = o.newChats ?? 'climayte'
    // A test that fakes the query gets no title queries unless it fakes the generator too.
    this.titleGen = o.titleGenerator === undefined ? (o.queryImpl ? null : sdkTitleGenerator(this.queryImpl, o.env, undefined, () => claudeCodeBinaryFor(o.home).path())) : o.titleGenerator
    this.retryDelays = o.retryDelays ?? RETRY_DELAYS
    this.codexDir = o.codex ?? null
    this.openCodex = o.openCodex
    this.free = o.free ?? (() => undefined)
    this.workers = new WorkerSync({
      chats: this.chats, bridge: this.bridge, store: this.store, timings: this.timings, failures: this.failures, emitEvent: this.emitEvent,
      now: () => this.now(), isClosing: () => this.closing, stored: this.stored.bind(this), changed: this.changed.bind(this), systemLine: this.systemLine.bind(this),
      fail: this.fail.bind(this), endTasks: this.endTasks.bind(this), noteTask: this.noteTask.bind(this), dropStandIn: this.dropStandIn.bind(this),
      deskItems: this.deskItems.bind(this), countWorkerTurn: this.countWorkerTurn.bind(this), undelivered: this.undelivered.bind(this),
      markQueued: this.markQueued.bind(this), noteCwd: (e, file) => this.moves.noteCwd(e, file),
    })
    this.moves = new ChatMoves({
      chats: this.chats, bridge: this.bridge, store: this.store, failures: this.failures, emitEvent: this.emitEvent, signInHeld: this.signInHeld,
      deskUrl: () => this.deskUrl(), root: this.root.bind(this), placeable: this.placeable.bind(this), bigSession: this.bigSession.bind(this),
      seedResume: this.seedResume.bind(this), changed: this.changed.bind(this), systemLine: this.systemLine.bind(this), fail: this.fail.bind(this),
    })
    for (const stored of this.store.loadChats()) {
      const e = entryOf(stored as StoredRecord)
      this.chats.set(e.chat.id, e)
    }
    // Messages AgentHydra had not taken when the server stopped are sent again, in order, with their own ids.
    for (const e of this.chats.values()) if (e.retrying?.length) this.retryHeld(e)
    // Our own chats are not "Elsewhere", nor are the Codex threads chats pinned to Codex run in.
    this.bridge.setExcludeSessionIds(() => [...this.sessionIds(), ...this.serviceThreadIds(), ...this.sessionMeta.tombstoned()])
    this.bridge.setExtraWorkerIds(() => this.workerIdsOfChats())
    // Outside sessions are listed with Hydra Desk's marks on them; the pinned and Unassigned ones however old.
    this.bridge.setSessionMeta((list, onAccount) => this.sessionMeta.apply(list, onAccount), () => this.sessionMeta.listedIds())
  }

  // Reads

  /** Every chat, newest activity first; `stamps` adds each one's itemsStamp (two file stats a chat). */
  list(o: { archived?: boolean; stamps?: boolean } = {}): ChatSummary[] {
    const shown = [...this.chats.values()].filter((e) => o.archived || !e.chat.archived)
    return shown.map((e) => (o.stamps ? { ...this.view(e.chat), ...this.itemsStampOf(e) } : this.view(e.chat))).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The chat's itemsStamp: the file stamp itemsBody reuses its body on, given only when nothing in memory is laid over
   *  the file (a running turn, a pinned service's turn, a CliMayte stand-in, a message waiting for another service). */
  private itemsStampOf(e: Entry): { itemsStamp?: string } {
    if (e.runtime?.running || e.pinned?.busy || e.sent?.length || e.crossing?.length) return {}
    const stamp = this.store.itemsStamp(e.chat.id)
    return stamp ? { itemsStamp: stamp } : {}
  }

  get(id: string): ChatSummary {
    return this.view(this.entry(id).chat)
  }

  /**
   * The chat's items as the JSON text the window gets, reused while nothing it is made from has changed: the chat's
   * file and media folder (its stamp) and no running turn or in-memory stand-ins. Bounded by its size in bytes.
   */
  itemsBody(id: string): { body: string; count: number } {
    const e = this.entry(id)
    const reusable = (): boolean => e.runtime?.running !== true && !e.sent?.length
    const hit = this.itemsBodies.get(id)
    if (hit && reusable() && hit.stamp === this.store.itemsStamp(id)) {
      this.itemsBodies.delete(id)
      this.itemsBodies.set(id, hit)
      return hit
    }
    const items = this.listItems(id)
    const body = JSON.stringify(items)
    this.dropItemsBody(id)
    if (reusable()) {
      const stamp = this.store.itemsStamp(id)
      if (stamp) {
        this.itemsBodies.set(id, { stamp, body, count: items.length })
        this.itemsBodyBytes += body.length
        while (this.itemsBodyBytes > ITEMS_BODY_BYTES && this.itemsBodies.size > 1) this.dropItemsBody(this.itemsBodies.keys().next().value as string)
      }
    }
    return { body, count: items.length }
  }

  /** One page of the chat's items ending before `before` (default: the newest page). Never stored in the whole-chat body cache. */
  itemsPage(id: string, before: number | undefined, limit: number): ChatItemsPage {
    const all = this.listItems(id)
    const end = before === undefined ? all.length : Math.min(all.length, Math.max(0, Math.floor(before)))
    const start = Math.max(0, end - Math.max(1, Math.floor(limit)))
    return { items: all.slice(start, end), total: all.length, olderBefore: start }
  }

  /** The chat's TranscriptIndex, rebuilt when its file or media stamp changes (or while a turn runs / stand-ins exist). */
  transcriptIndex(id: string): TranscriptIndex {
    const e = this.entry(id)
    const reusable = e.runtime?.running !== true && !e.sent?.length
    const hit = this.itemIndexes.get(id)
    if (hit && reusable && hit.stamp === this.store.itemsStamp(id)) return hit.index
    const index = buildTranscriptIndex(this.listItems(id))
    const stamp = reusable ? this.store.itemsStamp(id) : ''
    this.itemIndexes.delete(id)
    if (stamp) {
      this.itemIndexes.set(id, { stamp, index })
      while (this.itemIndexes.size > 50) this.itemIndexes.delete(this.itemIndexes.keys().next().value as string)
    }
    return index
  }

  /** Find over the whole chat: the hits (capped) and the total, over the text the window's Find matches. */
  search(id: string, query: string): SearchResult {
    return searchResult(this.listItems(id), query)
  }

  /** One item of the chat by id, or null. */
  itemById(id: string, itemId: string): IndexedItem | null {
    return this.listItems(id).find((i) => i.id === itemId) ?? null
  }

  private dropItemsBody(id: string): void {
    this.itemIndexes.delete(id)
    const hit = this.itemsBodies.get(id)
    if (!hit) return
    this.itemsBodies.delete(id)
    this.itemsBodyBytes -= hit.body.length
  }

  listItems(id: string): TranscriptItem[] {
    const e = this.entry(id)
    this.refreshBranch(e)
    // A CliMayte chat: its worker's transcript, with the lines Hydra Desk wrote (a move, a failure) in time order.
    if (e.chat.workerId !== undefined) return this.withWaiting(e, this.deskItems(e))
    const live = e.runtime?.running === true
    const items = this.store.loadItems(id).map((item) => {
      // A request stored 'pending' that no running runtime waits on was left by a process that died (a
      // hard stop, a crash): nothing can answer it, so it is expired, on disk and in every window.
      let done = settled(item)
      if (done !== item && (e.runtime?.isPending(item.id) || e.pinned?.isPending(item.id))) done = item
      // So is a task still 'running' with no runtime running: its session ended (a restart, a crash), and the task with it.
      if (!live) done = endedTask(done)
      if (done === item) return item
      this.store.appendItem(id, done)
      this.emitEvent({ type: 'item.upsert', chatId: id, item: done })
      return done
    })
    if (!live && this.clearTasks(e)) this.changed(e.chat)
    return this.withWaiting(e, items)
  }

  /** A CliMayte chat's whole transcript from its Desk file (chats/<id>.jsonl), oldest first, without touching any account folder. */
  private deskItems(e: Entry): TranscriptItem[] {
    let items = this.store.loadItems(e.chat.id)
    if (!e.emitted) {
      // A one-bubble `:listed` item an earlier reader saved for a handoff's carried list: the list is split by id now.
      const stale = items.filter((i) => i.id.endsWith(':listed'))
      if (stale.length) {
        const gone = new Set(stale.map((i) => i.id))
        this.store.keepItems(e.chat.id, new Set(items.filter((i) => !gone.has(i.id)).map((i) => i.id)))
        for (const id of gone) this.emitEvent({ type: 'item.removed', chatId: e.chat.id, itemId: id })
        items = items.filter((i) => !gone.has(i.id))
      }
    }
    items.sort((a, b) => a.ts - b.ts)
    if (!e.emitted) {
      e.emitted = new Map()
      e.workerSeen = undefined
      for (const item of items) {
        e.emitted.set(item.id, signature(item))
        if (item.kind !== 'task') continue
        if (item.status === 'stopped' && item.summary === TASK_SESSION_ENDED) (e.ended ??= new Set()).add(item.id)
        else if (item.status === 'running' && !isLongLived(item)) (e.bgTasks ??= new Set()).add(item.taskId)
      }
    }
    return e.sent?.length ? [...items, ...e.sent.map((s) => standInShown(s, mediaCache(this.store.home)))] : items
  }

  /** The messages waiting for another service's reply to end (waitForReply), shown queued after the rest. */
  private withWaiting(e: Entry, items: TranscriptItem[]): TranscriptItem[] {
    return e.crossing?.length ? [...items, ...e.crossing.map((w) => withNamedFiles(w.item, mediaCache(this.store.home)))] : items
  }

  /**
   * Copies another Hydra Desk's chats into this one (Desk 2 from the first Desk: `otherHome` is its data folder,
   * ~/.hydra-desk): every chat not here yet, as it was saved there (title, folder, account, worker, archived),
   * with its Desk file and the pictures that names. A chat already here is left as it is; `ids` limits it to those
   * chats. Both apps then list it: a CliMayte chat is the same worker in both, so a message from either goes on.
   */
  importDesk(otherHome: string, ids?: string[]): { imported: string[]; already: string[] } {
    const from = resolve(otherHome)
    if (from.toLowerCase() === resolve(this.store.home).toLowerCase()) throw new ChatError(400, "that is this Hydra Desk's own data folder")
    let rows: unknown
    try {
      rows = JSON.parse(readFileSync(join(from, 'chats.json'), 'utf8'))
    } catch (err) {
      throw new ChatError(404, `no Hydra Desk chats in ${from}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!Array.isArray(rows)) throw new ChatError(400, `${join(from, 'chats.json')} is not a chat list`)
    const wanted = ids ? new Set(ids) : null
    const imported: string[] = []
    const already: string[] = []
    for (const row of rows as StoredRecord[]) {
      if (!row || typeof row.id !== 'string' || !/^[\w-]+$/.test(row.id) || (wanted && !wanted.has(row.id))) continue
      if (this.chats.has(row.id)) {
        already.push(row.id)
        continue
      }
      const items = join(from, 'chats', `${row.id}.jsonl`)
      const target = this.store.itemsFile(row.id)
      if (existsSync(items) && !existsSync(target)) {
        copyFileSync(items, target)
        copyMedia(readFileSync(items, 'utf8'), join(from, 'media'), join(this.store.home, 'media'))
      }
      const e = entryOf(fromStored(row as StoredChat) as StoredRecord)
      this.chats.set(e.chat.id, e)
      this.emitEvent({ type: 'chat.upsert', chat: this.view(e.chat) })
      imported.push(row.id)
    }
    if (imported.length) this.store.saveChats(this.stored())
    return { imported, already }
  }

  sessionIds(): string[] {
    return [...this.chats.values()].flatMap((e) => [...(e.pastSessions ?? []), ...(e.chat.sessionId ? [e.chat.sessionId] : [])])
  }

  /** The Codex threads and ChatGPT chats Desk's pinned chats run in. */
  private serviceThreadIds(): string[] {
    return [...this.chats.values()].flatMap((e) => Object.values(e.chat.serviceThreads ?? {}).map((t) => t.threadId))
  }

  /** What Pin service offers (GET /api/chat-services): Claude always; Codex when one of its accounts is signed in. */
  async services(): Promise<ChatServiceInfo[]> {
    const claude = (await this.bridge.listAccounts().catch(() => [])).filter((a) => a.signedIn).length
    const codex = this.codexDir ? await this.codexDir.instances().then((l) => l.filter((i) => i.loggedIn).length, () => null) : null
    return [
      { kind: 'claude', label: SERVICE_LABEL.claude, ready: true, accounts: claude },
      {
        kind: 'codex',
        label: SERVICE_LABEL.codex,
        ready: !!codex,
        accounts: codex ?? 0,
        ...(codex ? {} : { why: codex === null ? 'AgentHydra is not answering, so Desk cannot see the Codex accounts.' : 'No Codex account is signed in.' }),
      },
      this.chatgptService(),
    ]
  }

  /** ChatGPT runs on the signed-in Free ChatGPT accounts. */
  private chatgptService(): ChatServiceInfo {
    const free = this.free()
    const accounts = free ? free.allInstances().filter((i) => i.provider === 'chatgpt' && i.loggedIn && !i.poolState).length : 0
    const why = !free ? 'ChatGPT needs Free instances, which are not running in this Desk.' : accounts ? null : 'No ChatGPT account is signed in. Sign one in on the Free page.'
    return { kind: 'chatgpt', label: SERVICE_LABEL.chatgpt, ready: !why, accounts, ...(why ? { why } : {}) }
  }

  /** Every Claude session id of a chat, current first then the earlier ones it continued from (a browser page a chat drove stays its own); [] for an unknown chat. */
  browserSessions(chatId: string): string[] {
    const e = this.chats.get(chatId)
    if (!e) return []
    return [...(e.chat.sessionId ? [e.chat.sessionId] : []), ...[...(e.pastSessions ?? [])].reverse()]
  }

  /** The id of the live chat (not archived, not a CliMayte worker's) whose current or past session is `sessionId`, else null. */
  chatForSession(sessionId: string): string | null {
    for (const e of this.chats.values()) {
      if (e.chat.archived || e.chat.workerId !== undefined) continue
      if (e.chat.sessionId === sessionId || e.pastSessions?.includes(sessionId)) return e.chat.id
    }
    return null
  }

  async commands(id: string): Promise<SlashCommandInfo[]> {
    const e = this.entry(id)
    if (!e.runtime?.running || !e.query) return STATIC_COMMANDS
    const live = await this.withTimeout(e.query.supportedCommands())
    return live ? commandInfosFrom(live) : STATIC_COMMANDS
  }

  /** Every finished turn on any service is counted under its setting; the chat's sus pick is read again. */
  private countTurn(chatId: string, service: ChatServiceKind, t: { model: string; effort: string; stopReason: string | null; text: string }): void {
    const v = classifyTurn(t.stopReason, t.text)
    this.pushback.record({ service, model: t.model, effort: t.effort }, v.cls, { chat: chatId, label: v.label })
    const cur = this.chats.get(chatId)
    if (cur) this.refreshSusPick(cur.chat)
  }

  /** GET /api/pushback: what each setting has done so far. */
  pushbackRows(): PushbackRow[] {
    return this.pushback.rows().sort((a, b) => a.pushbackRate - b.pushbackRate || b.turns - a.turns)
  }

  /** Seeds the pushback counts once from the transcripts of the chats this Desk knows; a second run adds nothing. */
  backfillPushback(): { chats: number; turns: number } {
    const chats = [...this.chats.values()].filter((e) => !e.chat.service)
    return this.pushback.backfill(
      chats.map((e) => {
        if (e.chat.workerId === undefined) return { id: e.chat.id, model: e.chat.model, effort: e.chat.effort, items: () => this.store.loadItems(e.chat.id) }
        const w = e.chat.workerId ? this.workers.workerRows.get(e.chat.workerId) : undefined
        const ran = w ? workerTurnSetting(w) : { model: e.chat.model, effort: e.chat.effort }
        return { id: e.chat.id, ...ran, items: () => this.store.loadItems(e.chat.id), worker: { busy: busy(e.chat) } }
      }),
    )
  }

  /** A worker chat's turn that just ended, counted once under the setting its attempt ran on (no stop reason reaches the Desk). */
  private countWorkerTurn(e: Entry, w: AhWorker, items: TranscriptItem[]): void {
    const opened = items.findLastIndex((i) => i.kind === 'user' && !i.queued)
    const reply = items.slice(opened + 1).findLast((i) => i.kind === 'assistant_text')
    const turn = reply?.id ?? items[opened]?.id
    if (!turn) return
    const v = classifyTurn(null, reply?.kind === 'assistant_text' ? reply.text : '')
    const ran = workerTurnSetting(w)
    this.pushback.recordOnce(workerTurnKey(e.chat.id, turn), { service: 'claude', model: ran.model, effort: ran.effort }, v.cls, { chat: e.chat.id, label: v.label })
    this.refreshSusPick(e.chat)
  }

  /** What 'sus' sends a worker chat's next message with, as CliMayte's send takes it; null for no override. */
  private workerSusSetting(chat: ChatSummary): WorkerSendSetting | null {
    if (chat.sus !== 'sus') return null
    const pick = this.pushback.pick()
    return pick ? climayteSetting(pick.model, pick.effort) : null
  }

  /** What 'sus' runs a chat's next Claude turn on: the least-pushing setting with enough turns, else the chat's own. */
  private susTurnOf(chat: ChatSummary): { model: string | null; effort: Effort | null } | null {
    if (chat.sus !== 'sus') return null
    const pick = this.pushback.pick()
    if (!pick) return { model: chat.model, effort: chat.effort }
    return { model: pick.model === 'default' ? null : pick.model, effort: pick.effort === 'default' ? null : (pick.effort as Effort) }
  }

  /** The summary's susPick: what 'sus' resolves to now, null when no setting qualifies yet; absent off 'sus'. */
  private refreshSusPick(chat: ChatSummary): void {
    if (chat.sus !== 'sus') {
      delete chat.susPick
      return
    }
    const pick = this.pushback.pick()
    chat.susPick = pick ? { model: pick.model, effort: pick.effort === 'default' ? null : (pick.effort as Effort), pushbackRate: pick.pushbackRate, turns: pick.turns } : null
  }

  /** A live runtime's model list (remembered once read), else the static menu. */
  async models(): Promise<ModelChoice[]> {
    const live = [...this.chats.values()].find((e) => e.runtime?.running && e.query)
    if (live?.query) {
      const models = await this.withTimeout(live.query.supportedModels())
      if (models?.length) this.liveModels = modelChoicesFrom(models)
    }
    return this.liveModels ?? STATIC_MODELS
  }

  /** A live chat's MCP servers as its session reports them, name and status only (the status carries the config). */
  async mcpStatus(id: string): Promise<McpStatus> {
    const e = this.entry(id)
    if (!e.runtime?.running || !e.query) return { live: false, servers: [] }
    const live = await this.withTimeout(e.query.mcpServerStatus())
    // No answer in time (or a failed read) is not "no server loaded": the window then shows the plain list.
    if (!live) return { live: false, servers: [] }
    return { live: true, servers: live.map((s) => ({ name: s.name, status: s.status })) }
  }

  /** Turns one MCP server on or off in a live chat's session; the next resume loads every server again. */
  async toggleMcp(id: string, name: string, enabled: boolean): Promise<void> {
    const e = this.entry(id)
    if (!e.runtime?.running || !e.query) throw new ChatError(409, 'the chat has no live session')
    const turn = enabled ? 'on' : 'off'
    const r = await this.withTimeout(e.query.toggleMcpServer(name, enabled).then(() => 'done' as const, () => 'failed' as const))
    if (r === 'done') return
    if (r === null) throw new ChatError(502, `could not turn ${name} ${turn}: the session did not answer within ${this.liveListTimeoutMs / 1000}s`)
    throw new ChatError(502, `could not turn ${name} ${turn}`)
  }

  // Writes

  /** A new chat: a CliMayte worker started by its first message (or an SDK chat on the default login, see newChats). */
  async create(req: CreateChatRequest): Promise<ChatSummary> {
    const made = await this.openNew(req)
    void made.firstSend.then((err) => {
      if (!err) return
      console.warn(`[desk] chat ${made.chat.id}: the first message could not be sent: ${err}`)
      // Never silent: the chat says why and keeps the words, which otherwise vanish with the stand-in.
      const e = this.chats.get(made.chat.id)
      if (!e) return
      if (req.prompt?.trim()) this.systemLine(e.chat.id, 'first-send', 'warn', `Your message was not sent: ${err}\n\n${req.prompt}`)
      e.chat.status = 'error'
      e.chat.lastError = err
      this.changed(e.chat)
    })
    return made.chat
  }

  /** A chat the send queue starts (SPEC "Send queue"). It never waits for room: CliMayte queues its worker until an account has it. */
  async createFromQueue(req: CreateChatRequest, o: { waitForRoom: boolean; messageId?: string }): Promise<QueueCreated> {
    const made = await this.openNew(req, o.messageId)
    // On disk now, not after the debounce: the queue records this chat's id next, and a restart that
    // found the id but not the chat would start it, and its prompt, a second time.
    try {
      this.store.flush()
    } catch (err) {
      console.warn(`[desk] chat ${made.chat.id}: the chat list could not be written yet: ${err instanceof Error ? err.message : String(err)}`)
    }
    return made
  }

  private async openNew(req: CreateChatRequest, messageId?: string): Promise<{ chat: ChatSummary; firstSend: Promise<string | null> }> {
    const cwd = checkCwd(req.cwd)
    if (req.parentId && !this.chats.has(req.parentId)) throw new ChatError(400, 'parentId names no Desk chat')
    if (req.sus === 'bad' && !this.codexDir) throw new ChatError(409, 'Codex is not set up in this Desk.')
    if (this.newChats === 'climayte') return this.open(req, cwd, { account: { ...CLIMAYTE_ACCOUNT }, auto: true, note: null }, messageId, true)
    return this.open(req, cwd, await this.resolveAccount(req.accountId ?? this.settingsOf().defaultAccountId), messageId)
  }

  /**
   * The new chat, its first message started before this returns. `worker`: a CliMayte chat, whose model
   * is WORKER_MODEL whatever was asked (the owner chooses neither account nor model).
   */
  private open(req: CreateChatRequest, cwd: string, resolved: ResolvedAccount, messageId?: string, worker = false): { chat: ChatSummary; firstSend: Promise<string | null> } {
    const settings = this.settingsOf()
    const prompt = req.prompt?.trim() ? req.prompt : undefined
    const { account, auto, note } = resolved
    const now = this.now()
    const chat: ChatSummary = {
      id: randomUUID(),
      sessionId: null,
      title: newChatTitle(req),
      cwd,
      account,
      accountAuto: auto,
      ...(req.accountPinned ? { accountPinned: true } : {}),
      model: worker ? WORKER_MODEL : req.model === undefined ? normalizeModel(settings.defaultModel) : normalizeModel(req.model),
      effort: req.effort === undefined ? settings.defaultEffort : req.effort,
      permissionMode: req.permissionMode ?? settings.defaultPermissionMode,
      delegateToCliMayte: req.delegateToCliMayte ?? settings.delegateToCliMayte,
      ...(req.sus && req.sus !== 'fine' ? { sus: req.sus } : {}),
      // Born on 'bad': pinned to Codex from the first message, with nothing to catch up on.
      ...(req.sus === 'bad' ? { service: 'codex' as const } : {}),
      ...(req.parentId ? { parentId: req.parentId } : {}),
      ...(req.managerSlug ? { managerSlug: req.managerSlug } : {}),
      status: 'closed',
      activity: null,
      turnStartedAt: null,
      lastError: null,
      limitResetsAt: null,
      unread: false,
      pinned: false,
      archived: false,
      group: null,
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      contextPct: null,
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0,
      ...(worker ? { workerId: null } : {}),
    }
    this.refreshSusPick(chat)
    const entry: Entry = { chat, runtime: null, query: null, ...(req.title?.trim() ? { titled: true } : {}) }
    this.chats.set(chat.id, entry)
    this.changed(chat)
    this.accountNote(chat.id, note)
    if (prompt && !entry.titled) this.autoTitle(entry, prompt)
    const firstSend: Promise<string | null> =
      prompt || req.images?.length
        ? this.send(chat.id, prompt ?? '', req.images, { messageId }).then(
            () => null,
            (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              this.fail(entry, { message, fallback: 'refused_send' })
              return message
            },
          )
        : Promise.resolve(null)
    return { chat: { ...chat }, firstSend }
  }

  /**
   * Names a chat from its first message, off the send's path; once, and never over a title the owner set. Asked
   * of the chat's own account, or (a CliMayte chat not placed yet, the default login) the healthiest signed-in
   * one, then once more on another; each failure is in the server log. If both fail the first words stay.
   * 2026-10-05: every title ever asked for failed in silence: a new chat's account is CliMayte's stand-in, whose
   * null config folder meant the default login, signed out on the owner's PC.
   */
  private autoTitle(e: Entry, prompt: string): void {
    const gen = this.titleGen
    if (!gen || e.titled) return
    const first = e.chat.title
    const chat = e.chat
    const stale = () => e.titled || chat.title !== first || this.chats.get(chat.id) !== e
    void (async () => {
      const tried = new Set<string>()
      let account: AccountRef | null = null
      for (let n = 1; n <= TITLE_TRIES; n++) {
        // No other account to try: the same one again (a slow answer, a passing error).
        const picked: AccountRef | null = (await this.titleAccount(chat, tried)) ?? account
        if (!picked) return
        account = picked
        tried.add(picked.id)
        let why = 'no usable title in the answer'
        let title: string | null = null
        const from = this.now()
        try {
          title = await gen({ prompt, cwd: chat.cwd, configDir: account.configDir }, (w) => (why = w))
        } catch (err) {
          why = err instanceof Error ? err.message : String(err)
        }
        this.timings.span({ stage: 'title', ms: this.now() - from, chatId: chat.id, accountId: account.id, accountNumber: account.number ?? null, ok: !!title })
        if (stale()) return
        if (title) {
          e.titled = true
          chat.title = title
          this.changed(chat)
          return
        }
        console.warn(`[desk] chat ${chat.id}: no title from ${accountName(account)} (try ${n} of ${TITLE_TRIES}): ${why}`)
      }
    })()
  }

  /** The account a title is asked of: the chat's own when it has a login of its own, else the healthiest not tried; null when none is left. */
  private async titleAccount(chat: ChatSummary, tried: ReadonlySet<string>): Promise<AccountRef | null> {
    if (chat.account.configDir && !tried.has(chat.account.id)) return chat.account
    const next = pickHealthy(this.placeable(await this.bridge.listAccounts().catch(() => [])), tried)
    return next ? accountRef(next) : null
  }

  /** The accounts placement may pick: a sign-in that failed on one holds it out for SIGN_IN_HOLD_MS. */
  private placeable(accounts: AccountInfo[]): AccountInfo[] {
    const now = Date.now()
    return accounts.map((a) => ((this.signInHeld.get(a.id) ?? 0) > now ? { ...a, signedIn: false } : a))
  }

  /**
   * Every message into a chat passes here (the window, the send queue, the API and peers, a message that waited for
   * an old reply). Each picture it carries gets one row in the media cache's index once the message has gone where it
   * runs (indexPictures); one that waits for an old reply gets its rows when it comes back here and goes.
   */
  async send(id: string, text: string, images?: ImageRef[], opts: SendOptions = {}): Promise<{ queued: boolean }> {
    const e = this.entry(id)
    if (!text.trim() && !images?.length) throw new ChatError(400, 'text is required')
    // Named before it goes, so its index rows and its transcript item carry one id.
    if (images?.length && !opts.messageId) opts = { ...opts, messageId: randomUUID() }
    e.lastAsk = text
    // A chat opened empty is named by its first message, as one opened with it is.
    if (!opts.noTitle && !e.titled && e.chat.title === NEW_TITLE && text.trim()) {
      e.chat.title = titleFrom(text)
      this.changed(e.chat)
      this.autoTitle(e, text)
    }
    // The pin moved while the old service was still replying: the message waits for that reply, then goes to the new one.
    if (this.replyElsewhere(e)) {
      if (opts.onlyIfReady) throw new ChatBusyError()
      return this.waitForReply(e, text, images, opts)
    }
    // Pinned to Codex or ChatGPT (Pin service): the turn runs there, whatever ran the chat before.
    if (e.chat.service) {
      if (opts.onlyIfReady && busy(e.chat)) throw new ChatBusyError()
      const sent = this.pinnedOf(e).send(text, images?.length ? images : undefined, opts.messageId)
      this.indexPictures(e, text, images, opts, e.chat.service)
      return sent
    }
    const lead = this.claudeHandoff(e)
    if (e.chat.workerId !== undefined) {
      const sent = this.sendToWorker(e, lead ? `${lead.text}${ANSWER_NOW}${text}` : text, images, opts, text)
      // Indexed once AgentHydra took it (or holds it to send again). A text-only send is handed back untouched: a
      // step more before its caller goes on lets a worker sync started meanwhile read the worker's old folder first.
      if (!images?.length) return sent
      return sent.then((r) => {
        this.indexPictures(e, text, images, opts, 'worker')
        return r
      })
    }
    // Awaited only when there is something to wait for: a new chat's first send starts its process at once.
    if (e.moving) await this.awaitMove(e, id)
    // Sent again by hand while the move was sending it already (the owner saw the limit line): once is enough.
    if (e.runtime?.takeReplayed(text, images)) {
      this.systemLine(id, 'move-dup', 'info', `That message is already being sent again on ${accountName(e.chat.account)} after the move, so it was not sent twice.`)
      return { queued: false }
    }
    const input = this.sdkInput(e, id, text, images)
    const sdk = input instanceof Promise ? await input : input
    if (opts.onlyIfReady && busy(e.chat)) throw new ChatBusyError()
    e.moved = undefined // a new message starts its own tries
    this.timings.sdkSent(e.chat, e.runtime?.running === true)
    let sent: { queued: boolean }
    if (sdk) sent = this.runtimeOf(e).send(sdk.text, sdk.images, opts.messageId, text)
    else if (!lead) sent = this.runtimeOf(e).send(text, images?.length ? images : undefined, opts.messageId)
    else {
      sent = this.runtimeOf(e).send(`${lead.text}${ANSWER_NOW}${text}`, images?.length ? images : undefined, opts.messageId, text)
      this.systemLine(id, 'caught-up', 'info', `Caught up on what was said on ${lead.from}.`)
    }
    this.indexPictures(e, text, images, opts, 'claude')
    return sent
  }

  /** The index rows of a message's pictures (media/picture-index.ts): never a reason for the send to fail. */
  private indexPictures(e: Entry, text: string, images: ImageRef[] | undefined, opts: SendOptions, engine: PictureEngine): void {
    if (!images?.length) return
    const chat = e.chat
    // A pinned chat's account and session are its thread on that service, once it has one.
    const thread = chat.service ? chat.serviceThreads?.[chat.service] : undefined
    const pinned = engine === 'codex' || engine === 'chatgpt' || engine === 'service'
    indexPictures(images, mediaCache(this.store.home), {
      account: pinned ? (thread?.label ?? null) : chat.account.label,
      accountId: pinned ? (thread?.accountId ?? null) : chat.account.id,
      workspace: chat.cwd,
      chatId: chat.id,
      sessionId: (pinned ? thread?.threadId : chat.sessionId) ?? null,
      messageId: opts.messageId ?? null,
      sender: noteOf(text)?.from ?? 'owner',
      engine,
    }, this.now())
  }

  /** Back on Claude after its pin moved it elsewhere: the message first carries what was said there. A worker's
   *  copy of it reads back as the message and a muted line (userTurns); a runtime's shows what was typed. */
  private claudeHandoff(e: Entry): { text: string; from: string } | null {
    const lead = e.chat.serviceLeftAt?.claude !== undefined ? this.serviceHandoff(e, 'claude', !e.chat.sessionId && !e.chat.workerId, null) : null
    if (e.chat.serviceLeftAt?.claude !== undefined) this.clearLeftAt(e, 'claude')
    e.chat.serviceRanOn = undefined
    return lead
  }

  /** Waits out a move under way, then checks the chat is still this one. */
  private async awaitMove(e: Entry, id: string): Promise<void> {
    while (e.moving) await e.moving
    if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)
  }

  /**
   * What the SDK is sent, when it is more than the owner's own words (a takeover's handoff around them). A promise only
   * when there is something to wait for (a grown session's fresh start, a resume to seed): a new chat's first send starts
   * its process at once, before `send` hands back to the create that called it (2026-10-15: an always-awaited version
   * left every new chat 'closed' in create's answer).
   */
  private sdkInput(e: Entry, id: string, text: string, images: ImageRef[] | undefined): QueuedInput | null | Promise<QueuedInput | null> {
    // A session grown past freshTokens is not re-read by every later call: an idle chat's message starts a fresh
    // session from the condensed handoff of its full record, on the same account (owner, 2026-10-11).
    const grown = busy(e.chat) ? null : this.bigSession(e, this.freshTokens)
    if (!grown) return this.coldStartInput(e, id, text, images, null)
    return this.freshFrom(e, grown, { text, images }).then((sdk) => {
      if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)
      return this.coldStartInput(e, id, text, images, sdk)
    })
  }

  /** A cold start is a new process: the tasks the last one started ended with it, and a session that cannot be reopened
   *  here is taken over by a fresh one, not refused (takeOver). Synchronous unless a resume has to be seeded first. */
  private coldStartInput(e: Entry, id: string, text: string, images: ImageRef[] | undefined, sdk: QueuedInput | null): QueuedInput | null | Promise<QueuedInput | null> {
    if (e.runtime?.running) return sdk
    if (this.endTasks(e)) this.changed(e.chat)
    const settle = (cannot: string | null): QueuedInput | null => {
      if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)
      return cannot && !sdk ? this.takeOver(e, cannot, { text, images }) : sdk
    }
    const seeding = this.seedResume(e)
    return seeding ? seeding.then(settle) : settle(null)
  }

  /** A reply is running on a service the chat is no longer pinned to (Claude's, or another pinned runtime's). */
  private replyElsewhere(e: Entry): boolean {
    const to = e.chat.service ?? null
    if (e.pinned?.busy) return e.pinned.kind !== to
    return to !== null && (!!e.runtime?.running || e.chat.workerId !== undefined) && busy(e.chat)
  }

  /** Holds a message until the old service's reply ends (onRuntimeEvent sends it on); it shows queued meanwhile. */
  private waitForReply(e: Entry, text: string, images: ImageRef[] | undefined, opts: SendOptions): { queued: boolean } {
    const item: UserItem = { kind: 'user', id: opts.messageId ?? randomUUID(), ts: this.now(), text, queued: true, ...(images?.length ? { images: images.map((i) => toStoredImage(i)) } : {}) }
    ;(e.crossing ??= []).push({ item, text, ...(images?.length ? { images } : {}), opts: { ...opts, messageId: item.id } })
    this.emitEvent({ type: 'item.upsert', chatId: e.chat.id, item: withNamedFiles(item, mediaCache(this.store.home)) })
    return { queued: true }
  }

  /** After any status change: once the old service's reply is over, what waited for it goes to the service the chat is pinned to now. */
  private sendWaiting(e: Entry | undefined): void {
    if (e?.crossing?.length && !this.replyElsewhere(e)) void this.sendCrossing(e)
  }

  /** The old service's reply ended: the messages that waited go, in order, to the service the chat is pinned to now. */
  private async sendCrossing(e: Entry): Promise<void> {
    const waiting = e.crossing ?? []
    e.crossing = undefined
    for (const w of waiting) {
      if (this.chats.get(e.chat.id) !== e) return
      try {
        await this.send(e.chat.id, w.text, w.images, w.opts)
      } catch (err) {
        this.emitEvent({ type: 'item.removed', chatId: e.chat.id, itemId: w.item.id })
        this.systemLine(e.chat.id, `crossing:${w.item.id}`, 'warn', `A message that waited for the last reply was not sent: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * The warm start (SPEC "Speed (timings)"): the owner began typing in a closed SDK chat, so its process starts
   * now and its start, hooks and MCP servers are over by the time the message is sent. A chat that is running,
   * a worker's, or one whose session cannot resume is left as it is.
   */
  async warm(id: string): Promise<{ started: boolean }> {
    const e = this.entry(id)
    if (e.chat.service || e.chat.workerId !== undefined || e.runtime?.running || e.chat.archived || e.moving) return { started: false }
    // Its next message starts a fresh session (freshIfGrown): resuming the old one now would be thrown away.
    if (this.bigSession(e, this.freshTokens)) return { started: false }
    if (await this.seedResume(e)) return { started: false }
    if (this.chats.get(id) !== e || e.runtime?.running || e.moving) return { started: false }
    if (this.endTasks(e)) this.changed(e.chat)
    const started = this.runtimeOf(e).warm()
    if (started) this.timings.sdkWarmed(id)
    return { started }
  }

  /** Retry on a failed Claude Code download: it starts again and the messages held for the chat go with the process. */
  retryClaudeCode(id: string): { retried: boolean } {
    const e = this.entry(id)
    return { retried: e.runtime?.retryBinary() === true }
  }

  /**
   * A CliMayte chat's message: the first starts its worker, every later one goes to that worker (CliMayte
   * holds one sent while a turn runs and delivers it as the next turn of the same session). Text only.
   */
  private async sendToWorker(e: Entry, text: string, images: ImageRef[] | undefined, opts: SendOptions, typed = text): Promise<{ queued: boolean }> {
    // A worker takes text: each picture is saved in the media cache and named by a line
    // `[Image: source: <path>]` (the form Claude Code uses, so the model opens it with Read).
    const shown = images?.length ? images.map((img) => toStoredImage(img, mediaCache(this.store.home))) : undefined
    // The stand-in keeps what the person typed (`typed`, without a handoff it carries): the worker's copy reads with
    // its picture lines shown as pictures.
    const said = typed
    if (images?.length) text =answersWithPictures({ m: text }, { m: images }, mediaCache(this.store.home)).m!
    while (e.starting) await e.starting
    const chat = e.chat
    if (this.chats.get(chat.id) !== e) throw new ChatError(404, `no chat ${chat.id}`)
    // Messages AgentHydra has not taken yet go first (retryHeld): this one waits behind them, in order.
    const behind = !!e.retrying?.length
    if (opts.onlyIfReady && (busy(chat) || behind)) throw new ChatBusyError()
    const queued = busy(chat) || behind
    // The message shows at once: the worker's JSONL has it only once its CLI runs and the poll reads it.
    const ts = this.now()
    // A worker not started yet holds the message too: it shows as queued until the worker's own copy arrives.
    const standIn: UserItem = { kind: 'user', id: `desk-sent:${ts}:${randomUUID()}`, ts, text: said, ...(shown ? { images: shown } : {}), ...(queued || chat.waiting ? { queued: true } : {}) }
    ;(e.sent ??= []).push(standIn)
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'item.upsert', chatId: chat.id, item: standInShown(standIn, mediaCache(this.store.home)) })
    if (behind) {
      this.holdForRetry(e, standIn, text, false)
      return { queued: true }
    }
    const sentAt = this.now()
    const started = this.beginStart(e)
    let sent: { urgent: boolean; stoppedFor: boolean; delivered: boolean }
    try {
      // The stand-in's id is the message's request id: sent again, AgentHydra starts or queues it once.
      sent = await this.dispatchToWorker(e, text, queued, opts, standIn.id, started)
    } catch (err) {
      // AgentHydra did not answer (busy, restarting, down) or failed on its side: kept and sent again, never dropped.
      const hold = retryable(err) && this.chats.get(chat.id) === e
      if (hold) this.holdForRetry(e, standIn, text, true)
      else this.dropStandIn(e, standIn)
      started?.()
      if (hold) return { queued: true }
      // Never a 404: the chat exists, and the send queue reads a 404 as a deleted chat.
      throw new ChatError(502, `CliMayte did not take the message: ${err instanceof Error ? err.message : String(err)}`)
    }
    started?.()
    if (this.chats.get(chat.id) !== e) return { queued }
    this.timings.workerSent(chat, this.now() - sentAt)
    e.workerLive = true
    const held = await this.settleHeld(e, standIn, text, queued, sent, opts)
    if (held.gone) return { queued: held.queued }
    this.tookMessage(e, held.queued, sent.delivered)
    return { queued: held.queued }
  }

  /** AgentHydra took a message: the chat shows its turn starting, unless the turn running holds or took the message. */
  private tookMessage(e: Entry, queued: boolean, inTurn = false): void {
    const chat = e.chat
    if (!queued && !inTurn) {
      chat.status = 'starting'
      chat.activity = 'Queued'
      chat.turnStartedAt = this.now()
      chat.lastError = null
    }
    chat.updatedAt = this.now()
    this.changed(chat)
    void this.syncWorkers(chat.id)
  }

  /** The start of the chat's worker, when it has none yet: a send that comes meanwhile waits until the worker exists
   *  (startWorkerFor calls the function it answers) or until this message is held when AgentHydra did not answer, so it never starts
   *  a second worker or goes first. Undefined when the chat has its worker. */
  private beginStart(e: Entry): (() => void) | undefined {
    if (e.chat.workerId) return undefined
    let done!: () => void
    e.starting = new Promise<void>((r) => (done = r))
    let open = true
    return () => {
      if (!open) return
      open = false
      e.starting = undefined
      done()
    }
  }

  /** A message AgentHydra did not take: kept with the chat, shown queued, and sent again until it is (retryHeld). */
  private holdForRetry(e: Entry, standIn: UserItem, text: string, tried: boolean): void {
    const first = !e.retrying?.length
    ;(e.retrying ??= []).push({ itemId: standIn.id, text, requestId: standIn.id, ...(tried ? { tried } : {}) })
    const i = e.sent?.indexOf(standIn) ?? -1
    if (i >= 0 && !standIn.queued) {
      const held: UserItem = { ...standIn, queued: true }
      e.sent![i] = held
      this.emitEvent({ type: 'item.upsert', chatId: e.chat.id, item: standInShown(held, mediaCache(this.store.home)) })
    }
    this.store.saveChats(this.stored())
    if (first) this.systemLine(e.chat.id, 'send-retry', 'info', 'AgentHydra did not answer in time, so this message is kept and sent again shortly. It is never sent twice.')
    this.retryHeld(e)
  }

  /** Sends the chat's held messages again, oldest first, one loop per chat. */
  private retryHeld(e: Entry): void {
    if (e.retryLoop || this.closing) return
    let ended = false
    e.retryLoop = this.retryLoopOf(e)
      .then(() => {
        ended = true
      })
      .catch((err) => console.warn(`[desk] chat ${e.chat.id}: sending held messages again failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        e.retryLoop = undefined
        // One held while the loop was ending: a new loop sends it.
        if (ended && e.retrying?.length && this.chats.get(e.chat.id) === e) this.retryHeld(e)
      })
  }

  /**
   * Each held message is sent again with its own request id, so one AgentHydra took after all (it did not answer in
   * time, but started the worker or queued the message) is answered as taken and never runs twice. AgentHydra not
   * answering is waited out for as long as the chat exists; its own error is tried SERVER_ERROR_TRIES times; a refusal
   * is final. An AgentHydra too old to read request ids is not sent it again: that could run it twice.
   */
  private async retryLoopOf(e: Entry): Promise<void> {
    const { firstMs, maxMs } = this.retryDelays
    const live = () => !this.closing && this.chats.get(e.chat.id) === e
    const pace: RetryPace = { wait: firstMs, serverErrors: 0, firstMs, maxMs }
    for (;;) {
      await sleep(pace.wait)
      const item = live() ? e.retrying?.[0] : undefined
      if (!item) return
      if (!(await this.retryOnce(e, item, live, pace))) return
    }
  }

  /** One pass over the held message at the front of the chat's queue: false when the loop ends. */
  private async retryOnce(e: Entry, item: RetryItem, live: () => boolean, pace: RetryPace): Promise<boolean> {
    const takes = await this.bridge.takesRequestIds()
    if (!live()) return false
    // Taken back meanwhile (cancelRetrying).
    if (e.retrying?.[0] !== item) {
      pace.wait = 0
      return true
    }
    if (takes === null) {
      retryLater(pace)
      return true
    }
    if (!takes) {
      // Its stand-in already gone: the worker's own copy arrived, so it did go through.
      this.retryEnded(e, item, e.sent?.some((s) => s.id === item.itemId) ? NOT_SENT_AGAIN : null)
      pace.wait = 0
      return true
    }
    // A new worker runs it as its first turn; a worker's running turn holds it.
    const queued = !!e.chat.workerId && busy(e.chat)
    if (!item.tried) {
      item.tried = true
      this.store.saveChats(this.stored())
    }
    e.retrySending = item
    const failure = await this.dispatchHeld(e, item, queued)
    e.retrySending = undefined
    if (!live()) return false
    if (failure) {
      this.retryFailed(e, item, failure.err, pace)
      return true
    }
    this.retryEnded(e, item, null)
    pace.wait = 0
    pace.serverErrors = 0
    // Its stand-in stays until the worker's own copy arrives; it runs now unless a turn or a wait holds it.
    const standIn = e.sent?.find((s) => s.id === item.itemId)
    if (!(queued || e.chat.waiting)) this.unqueue(e, standIn)
    e.workerLive = true
    this.tookMessage(e, queued)
    return true
  }

  /** A send AgentHydra threw: its own errors are tried again (SERVER_ERROR_TRIES); a refusal ends the message. */
  private retryFailed(e: Entry, item: RetryItem, err: unknown, pace: RetryPace): void {
    if (retryable(err) && (err.unreachable || ++pace.serverErrors < SERVER_ERROR_TRIES)) {
      retryLater(pace)
      return
    }
    this.retryEnded(e, item, `Your message was not sent: CliMayte did not take it: ${err instanceof Error ? err.message : String(err)}`)
    pace.wait = 0
  }

  /** Sends one held message to the worker under its own request id: the error it threw, or null when the worker took it. */
  private async dispatchHeld(e: Entry, item: RetryItem, queued: boolean): Promise<{ err: unknown } | null> {
    try {
      await this.dispatchToWorker(e, item.text, queued, {}, item.requestId)
      return null
    } catch (err) {
      return { err }
    }
  }

  /** A held message leaves the list: taken (`why` null), or not to be sent, when its stand-in goes and the chat keeps
   *  its words and says why. */
  private retryEnded(e: Entry, item: RetryItem, why: string | null): void {
    e.retrying = e.retrying?.filter((r) => r !== item)
    if (!e.retrying?.length) e.retrying = undefined
    this.store.saveChats(this.stored())
    if (why === null) return
    const standIn = e.sent?.find((s) => s.id === item.itemId)
    if (standIn) this.dropStandIn(e, standIn)
    this.systemLine(e.chat.id, `send-failed:${item.itemId}`, 'warn', `${why}\n\n${standIn?.text ?? item.text}`)
    e.chat.lastError = why
    this.changed(e.chat)
  }

  /**
   * The message to the chat's worker, or the worker started with it. `urgent`: sent as AgentHydra's urgent message;
   * `stoppedFor`: that stopped the running turn for it.
   */
  private async dispatchToWorker(
    e: Entry,
    text: string,
    queued: boolean,
    opts: SendOptions,
    requestId?: string,
    started?: () => void,
  ): Promise<{ urgent: boolean; stoppedFor: boolean; delivered: boolean }> {
    const chat = e.chat
    if (!chat.workerId) {
      await this.startWorkerFor(e, text, requestId, started)
      return { urgent: false, stoppedFor: false, delivered: false }
    }
    // The chat moved folders (cwd-move): the worker's next launch resumes its session there.
    const at = e.workerCwd ?? this.bridge.lastWorkers().find((w) => w.id === chat.workerId)?.cwd ?? null
    const moved = at !== null && at !== chat.cwd
    // An AgentHydra without deliver-now (v1.10.0) takes it as an urgent message: the turn stops and the session
    // continues with it first, in this one call. Only for a message it does not hold yet: it would go twice.
    const urgent = queued && opts.now === true && !(await this.bridge.canDeliverNow())
    // A worker started before the connectors' first probe pass lands would run without their MCP servers.
    const connectors = connectorsPending()
    if (connectors) await connectors
    const sus = this.workerSusSetting(chat)
    const restore = !sus && chat.susRestore ? restoreSetting(chat.susRestore) : null
    const had = sus && !chat.susRestore ? this.workers.workerRows.get(chat.workerId) : undefined
    const sent = await this.bridge.sendToWorker(chat.workerId, text, moved ? chat.cwd : undefined, urgent, chatAddOns(chat.cwd, chat.delegateToCliMayte, { id: chat.id, base: this.deskUrl() }, chat.managerSlug), requestId, sus ?? restore ?? undefined)
    if (sus && !chat.susRestore) chat.susRestore = { model: had?.model ?? null, effort: had?.effort ?? null }
    else if (restore) delete chat.susRestore
    if (sus || restore) this.changed(chat)
    this.setWorkerCwd(e, chat.cwd)
    return { urgent, stoppedFor: sent.urgent, delivered: sent.delivered }
  }

  /** The chat's worker, started with its first message; a send meanwhile waits for it (beginStart's `started`). */
  private async startWorkerFor(e: Entry, text: string, requestId?: string, started?: () => void): Promise<void> {
    const chat = e.chat
    const connectors = connectorsPending()
    if (connectors) await connectors
    const sus = this.workerSusSetting(chat)
    const w = await this.bridge.startWorker({
      prompt: text,
      cwd: chat.cwd,
      title: chat.title,
      group: WORKER_GROUP,
      desk: chatAddOns(chat.cwd, chat.delegateToCliMayte, { id: chat.id, base: this.deskUrl() }, chat.managerSlug),
      ...(requestId ? { requestId } : {}),
      ...(sus ? { ...sus, modelWhy: SUS_WHY } : {}),
    })
    e.workerCwd = chat.cwd
    // Started on a Sus pick: what it goes back to is CliMayte's own launch setting.
    if (sus) chat.susRestore = { model: null, effort: null }
    chat.workerId = w.id
    chat.sessionId = w.sessionId
    started?.()
  }

  /**
   * A worker takes nothing mid-turn, so CliMayte held it until the whole task ends; a plain send goes now, as Send now
   * on its bubble would (the owner, 2026-10-05: "every single message, even if I don't have add to queue, always does
   * stinking add to queue"). If that fails it stays held, and the bubble's Send now can try again. `gone`: the chat
   * was deleted meanwhile.
   */
  private async settleHeld(
    e: Entry,
    standIn: UserItem,
    text: string,
    queued: boolean,
    sent: { urgent: boolean; stoppedFor: boolean; delivered: boolean },
    opts: SendOptions,
  ): Promise<{ queued: boolean; gone: boolean }> {
    const chat = e.chat
    if (sent.delivered) {
      this.unqueue(e, standIn)
      return { queued: false, gone: false }
    }
    if (sent.urgent) {
      if (!sent.stoppedFor) return { queued, gone: false }
      this.unqueue(e, standIn)
      return { queued: false, gone: false }
    }
    if (!(queued && opts.now && chat.workerId)) return { queued, gone: false }
    try {
      if ((await this.deliverHeldNow(e, standIn, text)).stopped) queued = false
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.systemLine(chat.id, 'send-now', 'warn', `Your message waits for the current task to end: CliMayte could not send it now (${why}). Its Send now tries again.`)
    }
    return { queued, gone: this.chats.get(chat.id) !== e }
  }

  /**
   * Send now on a message waiting behind a running turn (its bubble says "Queued"): the turn stops and the message
   * goes at once. An SDK chat's CLI keeps its queued sends through a plain interrupt and starts the next one straight
   * away; a CliMayte chat's worker is stopped by AgentHydra, which continues the same session with that held message
   * first (`itemId`, the bubble's stand-in, names it). Nothing waiting any more stops nothing, and says why: a worker
   * waiting for an account runs no turn to stop (2026-10-06: Send now flipped back to itself for half an hour while
   * every account was at its limit, saying nothing).
   */
  async sendNow(id: string, itemId?: string): Promise<SendNowResult> {
    const e = this.entry(id)
    if (e.chat.workerId && !e.pinned?.busy) {
      const standIn = e.sent?.find((s) => s.id === itemId && s.queued)
      let r: { stopped: boolean; message: string }
      try {
        r = await this.deliverHeldNow(e, standIn, standIn?.text.trim() ? standIn.text : undefined)
      } catch (err) {
        throw new ChatError(502, `CliMayte did not send it now: ${err instanceof Error ? err.message : String(err)}`)
      }
      await this.syncWorkers(id)
      if (r.stopped) return { ok: true, stopped: true }
      const waiting = e.chat.status === 'starting'
      const message = waiting
        ? `No turn is running to stop: ${e.chat.activity ?? 'CliMayte has not started this chat yet'}. This message goes first when it starts.`
        : r.message || 'Nothing was stopped: the message had already gone on.'
      return { ok: true, stopped: false, message }
    }
    const live = e.pinned?.busy ? e.pinned : e.runtime?.running ? e.runtime : null
    if (!live || e.chat.queuedCount === 0) return { ok: true, stopped: false, message: 'Nothing was stopped: the message had already gone on.' }
    await live.interrupt()
    return { ok: true, stopped: true }
  }

  /** Takes a queued message back before it is sent: the CLI never runs it, and its bubble leaves the transcript. */
  async cancelQueued(id: string, itemId: string): Promise<CancelQueuedResult> {
    const e = this.entry(id)
    const tooLate = { ok: true as const, cancelled: false, message: 'Too late to cancel: it already went into this turn.' }
    const retrying = e.retrying?.find((r) => r.itemId === itemId)
    if (retrying) return this.cancelRetrying(e, retrying)
    const waiting = e.crossing?.findIndex((w) => w.item.id === itemId) ?? -1
    if (waiting >= 0) {
      e.crossing!.splice(waiting, 1)
      this.emitEvent({ type: 'item.removed', chatId: id, itemId })
      return { ok: true, cancelled: true, message: 'Taken back: it is not sent.' }
    }
    const pinned = e.pinned?.busy ? e.pinned : null
    if (e.chat.workerId && !pinned) return this.cancelHeld(e, itemId, tooLate)
    const live = pinned ?? (e.runtime?.running ? e.runtime : null)
    if (!live || !(await live.cancelQueued(itemId))) return tooLate
    this.store.keepItems(id, new Set(this.listItems(id).map((i) => i.id).filter((x) => x !== itemId)))
    this.emitEvent({ type: 'item.removed', chatId: id, itemId })
    this.changed(e.chat)
    return { ok: true, cancelled: true, message: 'Taken back: it is not sent.' }
  }

  /**
   * Takes back a message the chat is still sending again (retryHeld). One never sent goes at once, even with AgentHydra
   * down; one AgentHydra may have (it did not answer) is taken back from the worker too, and stays when AgentHydra
   * cannot be asked. One that may have started the chat's worker cannot be taken back.
   */
  private async cancelRetrying(e: Entry, item: RetryItem): Promise<CancelQueuedResult> {
    if (e.retrySending === item) return { ok: true, cancelled: false, message: 'It is being sent to CliMayte right now: try again in a moment.' }
    if (item.tried && !e.chat.workerId) {
      return { ok: true, cancelled: false, message: 'AgentHydra may already have started this chat with it, so it cannot be taken back: stop the chat once it starts.' }
    }
    // Out of the list first, so the loop never sends it while AgentHydra is asked.
    const at = e.retrying!.indexOf(item)
    e.retrying!.splice(at, 1)
    if (item.tried) {
      try {
        await this.bridge.cancelWorkerHeld(e.chat.workerId as string, item.text)
      } catch (err) {
        if (this.chats.get(e.chat.id) === e) {
          ;(e.retrying ??= []).splice(at, 0, item)
          this.retryHeld(e)
        }
        throw new ChatError(502, `CliMayte could not take it back (${err instanceof Error ? err.message : String(err)}): it stays, and goes when AgentHydra takes it.`)
      }
    }
    if (!e.retrying?.length) e.retrying = undefined
    const standIn = e.sent?.find((s) => s.id === item.itemId)
    if (standIn) this.dropStandIn(e, standIn)
    else this.store.saveChats(this.stored())
    e.chat.queuedCount = e.sent?.filter((s) => s.queued).length ?? 0
    this.changed(e.chat)
    return { ok: true, cancelled: true, message: 'Taken back: it is not sent.' }
  }

  private async cancelHeld(e: Entry, itemId: string, tooLate: CancelQueuedResult): Promise<CancelQueuedResult> {
    const standIn = e.sent?.find((s) => s.id === itemId && s.queued)
    if (!standIn) return tooLate
    if (!standIn.text.trim()) return { ok: true, cancelled: false, message: 'This message has no text to name it by, so it cannot be taken back.' }
    const r = await this.bridge.cancelWorkerHeld(e.chat.workerId as string, standIn.text)
    if (!r.removed) return tooLate
    this.dropStandIn(e, standIn)
    e.chat.queuedCount = e.sent?.filter((s) => s.queued).length ?? 0
    this.changed(e.chat)
    await this.syncWorkers(e.chat.id)
    return { ok: true, cancelled: true, message: 'Taken back: CliMayte will not send it.' }
  }

  /**
   * AgentHydra's deliver-now for the message the worker holds (`text` names it): its running turn stops and the same
   * session continues with that message first. When it stopped, the stand-in is no longer queued: it is the turn
   * starting now, and the worker's own copy replaces it once its CLI runs. `stopped` when the turn was stopped, else
   * AgentHydra's why.
   */
  private async deliverHeldNow(e: Entry, standIn: UserItem | undefined, text: string | undefined): Promise<{ stopped: boolean; message: string }> {
    const r = await this.bridge.sendToWorkerNow(e.chat.workerId as string, text)
    if (r.stopped) this.unqueue(e, standIn)
    else if (r.message) {
      console.warn(`[desk] chat ${e.chat.id}: Send now stopped nothing: ${r.message}`)
      this.systemLine(e.chat.id, 'send-now-nothing', 'info', r.message)
    }
    return r
  }

  /** A held message's stand-in once its turn was stopped for it: no longer queued, it is the turn starting now. */
  private unqueue(e: Entry, standIn: UserItem | undefined): void {
    const i = standIn && e.sent ? e.sent.indexOf(standIn) : -1
    if (i < 0) return
    const { queued: _q, ...sent } = standIn!
    e.sent![i] = sent
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'item.upsert', chatId: e.chat.id, item: standInShown(sent, mediaCache(this.store.home)) })
  }

  async interrupt(id: string): Promise<void> {
    const e = this.entry(id)
    // A Codex turn, also one still running after the pin moved back to Claude.
    if (e.pinned?.busy) return e.pinned.interrupt()
    if (e.chat.workerId) {
      // Stop with messages held stops the running turn and continues it with them now, in the same session.
      const held = (e.sent ?? []).filter((s) => s.queued)
      if (held.length) {
        let stopped = false
        try {
          stopped = (await this.bridge.sendToWorkerNow(e.chat.workerId)).stopped
        } catch {
          stopped = false
        }
        if (stopped) for (const s of held) this.unqueue(e, s)
        await this.syncWorkers(id).catch(() => {})
        if (stopped) return
      }
      // Stopping a worker cancels it; the next message revives it in the same session. A refused or
      // timed-out cancel reaches the window, which says so and restores the chat's state.
      try {
        await this.bridge.cancelWorker(e.chat.workerId)
      } finally {
        await this.syncWorkers(id).catch(() => {})
      }
      return
    }
    if (e.runtime?.running) await e.runtime.interrupt()
  }

  /**
   * Stops one background task (its Stop in the tasks panel) and answers the task's item as it is then. A chat's own
   * process is asked to stop it, and the task's notice settles it (up to 3 s). A CliMayte worker takes no control
   * message, so its running worker is stopped, turn and all. A task no process runs any more is settled here.
   */
  async stopTask(id: string, taskId: string): Promise<TranscriptItem> {
    const e = this.entry(id)
    const find = () => this.store.loadItems(id).find((i) => i.kind === 'task' && i.taskId === taskId)
    const item = find()
    if (item?.kind !== 'task') throw new ChatError(404, `chat ${id} has no background task ${taskId}`)
    if (item.status !== 'running') return item
    if (e.chat.workerId !== undefined) {
      if (e.workerLive) await this.interrupt(id)
    } else if (await e.runtime?.stopTask(taskId)) {
      for (const until = Date.now() + 3000; Date.now() < until; await Bun.sleep(100)) {
        const now = find()
        if (now?.kind === 'task' && now.status !== 'running') return now
      }
    }
    const last = find()
    if (last?.kind !== 'task' || last.status !== 'running') return last ?? item
    const done: TranscriptItem = { ...last, status: 'stopped', summary: 'Stopped from Hydra Desk.', durationMs: Math.max(0, this.now() - last.ts) }
    this.store.appendItem(id, done)
    this.emitEvent({ type: 'item.upsert', chatId: id, item: done })
    e.emitted?.set(done.id, signature(done))
    if (this.noteTask(e, done)) this.changed(e.chat)
    return done
  }

  respondPermission(id: string, requestId: string, d: PermissionDecision): void {
    this.answer(id, 'permission', requestId, (rt) => rt.respondPermission(requestId, d))
  }

  answerQuestion(id: string, requestId: string, a: QuestionAnswer): void {
    this.answer(id, 'question', requestId, (rt) => rt.answerQuestion(requestId, a))
  }

  respondPlan(id: string, requestId: string, d: PlanDecision): void {
    this.answer(id, 'plan', requestId, (rt) => rt.respondPlan(requestId, d))
  }

  answerElicitation(id: string, requestId: string, a: ElicitationAnswer): void {
    this.answer(id, 'elicitation', requestId, (rt) => rt.answerElicitation(requestId, a))
  }

  async patch(id: string, p: ChatPatch): Promise<ChatSummary> {
    const e = this.entry(id)
    const chat = e.chat
    // A CliMayte chat's account and model are CliMayte's: only its marks change here.
    if (chat.workerId !== undefined) p = { ...p, accountId: undefined, model: undefined, effort: undefined, permissionMode: undefined }
    const resolved = p.accountId !== undefined ? await this.resolveAccount(p.accountId) : null
    const live = e.runtime?.running ? e.runtime : null
    if (p.sus !== undefined) await this.applySus(e, p.sus)
    if (p.service !== undefined) await this.pinService(e, p.service)
    const relocated = this.applyMarks(id, e, p, resolved)
    await this.applyRuntimeSettings(e, live, p)
    // The process keeps the login it started under: it ends once its turn is over (a limited or idle
    // one at once), so the next send starts under the chosen account and resumes the session there.
    if (live && (relocated || (live.startedAs && live.startedAs.id !== chat.account.id))) await live.closeWhenIdle()
    chat.updatedAt = this.now()
    this.changed(chat)
    this.accountNote(id, resolved?.note ?? null)
    // Its sub-chats (seats, sub-managers it opened) are archived and brought back with it; one already there is
    // skipped, which also ends a parent chain that loops back on itself.
    if (p.archived !== undefined) {
      for (const c of [...this.chats.values()]) if (c.chat.parentId === id && c.chat.archived !== p.archived) await this.patch(c.chat.id, { archived: p.archived })
    }
    return { ...chat }
  }

  /**
   * The sus level (SPEC "Sus meter"). 'bad' pins the chat to Codex (the existing pin, which makes the next turn catch up);
   * leaving 'bad' unpins it. 'sus' is read at the next turn.
   */
  private async applySus(e: Entry, to: SusLevel): Promise<void> {
    const chat = e.chat
    const was: SusLevel = chat.sus ?? 'fine'
    if (to === was) return
    if (to === 'bad') await this.pinService(e, 'codex')
    else if (was === 'bad') await this.pinService(e, null)
    if (to === 'fine') delete chat.sus
    else chat.sus = to
    this.refreshSusPick(chat)
  }

  /** The chat's own fields a patch sets at once; true when it was put in another folder by hand. */
  private applyMarks(id: string, e: Entry, p: ChatPatch, resolved: ResolvedAccount | null): boolean {
    const chat = e.chat
    if (p.title !== undefined) {
      chat.title = p.title.trim().slice(0, 200)
      e.titled = true
    }
    if (p.pinned !== undefined) chat.pinned = p.pinned
    const archiving = p.archived === true && !chat.archived
    if (p.archived !== undefined) chat.archived = p.archived
    if (archiving) this.onChatEnd?.(this.browserSessions(id))
    if (p.group !== undefined) chat.group = p.group
    if (p.note !== undefined) chat.note = p.note
    // Put in another folder by hand: the next turn resumes the session there (seedResume / the worker's next send).
    const relocated = p.cwd !== undefined && p.cwd.toLowerCase() !== chat.cwd.toLowerCase()
    if (p.cwd !== undefined) {
      chat.cwd = p.cwd
      e.cwdPending = undefined
    }
    if (p.delegateToCliMayte !== undefined) chat.delegateToCliMayte = p.delegateToCliMayte
    if (p.accountPinned === true) chat.accountPinned = true
    else if (p.accountPinned === false) delete chat.accountPinned
    // An account takes effect at the next runtime start (buildOptions reads chat.account); see below.
    if (resolved) {
      chat.account = resolved.account
      chat.accountAuto = resolved.auto
    }
    if (p.unread === false) {
      if (e.runtime) e.runtime.markViewed()
      else if (e.pinned) e.pinned.markViewed()
      else chat.unread = false
    } else if (p.unread === true) chat.unread = true
    return relocated
  }

  /** The model, effort and permission mode: a running chat takes them through its runtime, a closed one keeps them on the chat. */
  private async applyRuntimeSettings(e: Entry, live: ChatRuntime | null, p: ChatPatch): Promise<void> {
    const chat = e.chat
    if (p.model !== undefined) {
      const model = normalizeModel(p.model)
      if (live) await live.setModel(model)
      else chat.model = model
    }
    if (p.effort !== undefined) {
      if (live) await live.setEffort(p.effort)
      else chat.effort = p.effort
    }
    // Through the runtime even when closed: it remembers the mode a switch to Plan leaves, for the plan's approval.
    if (p.permissionMode !== undefined) await this.runtimeOf(e).setPermissionMode(p.permissionMode)
  }

  /** Drops the chat from Hydra Desk (its runtime closed, its history file removed). */
  async delete(id: string): Promise<void> {
    const e = this.entry(id)
    this.onChatEnd?.(this.browserSessions(id))
    this.sessionMeta.tombstone(this.browserSessions(id))
    this.chats.delete(id)
    e.turnWatch?.stop()
    const rt = e.runtime
    e.runtime = null
    if (rt) await rt.close().catch(() => {})
    await e.pinned?.close().catch(() => {})
    // Its worker goes too while it still runs; a finished one stays in CliMayte's list.
    if (e.chat.workerId && e.workerLive !== false) await this.bridge.cancelWorker(e.chat.workerId).catch(() => {})
    this.store.deleteChat(id)
    this.dropItemsBody(id)
    // Hydra Core keyed this chat's folder, and its seat entry if it is one, by its id (HYDRA_DESK_CHAT_ID).
    try {
      forgetChat(coreDir(), id)
    } catch {
      // floor-ok: a core folder still held open stays behind; the chat itself is gone either way
    }
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'chat.removed', chatId: id })
  }

  /**
   * A new closed chat that continues from a copy of this chat's session: the same folder, account,
   * model and group, its history copied. Its first message resumes the session with forkSession (the
   * SDK's own fork) cut where the session stood now, so neither chat sees the other's later turns.
   */
  fork(id: string): ChatSummary {
    const se = this.entry(id)
    const src = se.chat
    if (src.workerId !== undefined) throw new ChatError(409, 'This chat runs as a CliMayte worker, which cannot be forked: send it a message instead.')
    const from = src.sessionId ?? src.forkedFrom
    if (!from) throw new ChatError(409, 'this chat has no Claude Code session to fork yet')
    // A fork of a fork not started yet keeps that one's cut.
    const forkAt = src.sessionId ? this.forkPointOf(from, src.cwd, [src.account, se.runtime?.startedAs]) : se.forkAt
    const now = this.now()
    const chat: ChatSummary = {
      ...src,
      id: randomUUID(),
      sessionId: null,
      forkedFrom: from,
      title: forkTitle(src.title),
      status: 'closed',
      activity: null,
      turnStartedAt: null,
      lastError: null,
      limitResetsAt: null,
      unread: false,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0,
    }
    // A fork runs none of its source's tasks: a copy still 'running' is settled as ended.
    for (const item of this.store.loadItems(id)) this.store.appendItem(chat.id, endedTask(settled(item)))
    // Its first start copies the source's session from where the source last ran, which has its latest turns.
    this.chats.set(chat.id, { chat, runtime: null, query: null, forkAt, ranIn: ranInOf(se) })
    this.changed(chat)
    return { ...chat }
  }

  /**
   * A fork that leaves out one of the owner's messages and all after it, as Claude Code forks: a new closed
   * chat with the history before message `at`, whose first message resumes the session cut at the entry
   * before it. A CliMayte chat forks so too, its fork a chat of its own on the account whose folder has
   * that session (CliMayte resumes nothing). A message that opened its session forks to a fresh chat.
   */
  async forkBefore(id: string, at: string): Promise<ChatSummary> {
    const se = this.entry(id)
    const src = se.chat
    const items = this.listItems(id)
    const index = items.findIndex((i) => i.id === at)
    const msg = items[index]
    if (msg?.kind !== 'user') throw new ChatError(400, `this chat has no message ${JSON.stringify(at)} of yours to fork at`)
    const found = this.findCut(await this.sessionsOf(se), src.cwd, msg, items.slice(index + 1), [src.account, se.runtime?.startedAs])
    if (!found) throw new ChatError(409, CUT_NOT_FOUND)
    const fresh = found.cut === null
    const now = this.now()
    const { workerId, workerIds: _, ...rest } = src
    const chat: ChatSummary = {
      ...rest,
      id: randomUUID(),
      sessionId: null,
      forkedFrom: fresh ? null : found.sessionId,
      title: forkTitle(src.title),
      status: 'closed',
      activity: null,
      turnStartedAt: null,
      lastError: null,
      limitResetsAt: null,
      unread: false,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0,
    }
    if (workerId !== undefined && fresh) {
      // Nothing to resume: a CliMayte chat again, its worker started by the first message.
      chat.workerId = null
      chat.account = { ...CLIMAYTE_ACCOUNT }
      chat.model = WORKER_MODEL
    } else if (workerId !== undefined) {
      chat.account = await this.accountForConfigDir(found.configDir)
      chat.accountAuto = true
    }
    for (const item of items.slice(0, index)) this.store.appendItem(chat.id, endedTask(settled(item)))
    this.chats.set(chat.id, { chat, runtime: null, query: null, ...(fresh ? {} : { forkAt: found.cut as string, ranIn: found.configDir }) })
    this.changed(chat)
    return { ...chat }
  }

  /**
   * Undo at one of the owner's messages, as Claude Code's rewind: this chat loses that message and all after it,
   * and its next send resumes the session cut at the entry before it, as forkBefore's fork would (the SDK forks
   * it, so the turns taken back stay only in the old session's file, still this chat's own). A turn running now
   * is stopped first, a CliMayte chat's worker cancelled; that chat goes on where forkBefore's fork would. A
   * message that opened its session leaves the chat empty, its next send a fresh start. Every check comes before
   * anything is changed. The window puts the message back in the box.
   */
  async rewind(id: string, at: string): Promise<ChatSummary> {
    const e = this.entry(id)
    // Undo cuts the Claude session; a Codex thread keeps its turns, so the two would disagree.
    if (e.chat.service) throw new ChatError(409, `Undo works on Claude chats, and this one runs on ${SERVICE_LABEL[e.chat.service]}.`)
    if (e.starting) throw new ChatError(409, 'This chat is starting its worker: undo once it has started.')
    if (e.retrying?.length) throw new ChatError(409, 'This chat is still sending a message AgentHydra did not answer: undo once it is sent.')
    const chat = e.chat
    const items = this.listItems(id)
    const index = items.findIndex((i) => i.id === at)
    const msg = items[index]
    if (msg?.kind !== 'user') throw new ChatError(400, `this chat has no message ${JSON.stringify(at)} of yours to undo`)
    const found = this.findCut(await this.sessionsOf(e), chat.cwd, msg, items.slice(index + 1), [chat.account, e.runtime?.startedAs])
    if (!found) throw new ChatError(409, UNDO_NOT_FOUND)
    const fresh = found.cut === null
    const worker = chat.workerId !== undefined
    const account = worker && !fresh ? await this.accountForConfigDir(found.configDir) : null
    if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)

    const rt = e.runtime
    e.runtime = null
    e.query = null
    if (rt) await rt.close().catch(() => {})
    if (chat.workerId && e.workerLive !== false) await this.bridge.cancelWorker(chat.workerId).catch(() => {})
    if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)

    // The session the undone turns are in stays the chat's (never listed under Elsewhere).
    if (chat.sessionId && !e.pastSessions?.includes(chat.sessionId)) e.pastSessions = [...(e.pastSessions ?? []), chat.sessionId]
    chat.sessionId = null
    chat.forkedFrom = fresh ? null : found.sessionId
    e.forkAt = fresh ? undefined : (found.cut as string)
    e.ranIn = fresh ? undefined : found.configDir
    if (worker && fresh) {
      chat.workerId = null
      chat.account = { ...CLIMAYTE_ACCOUNT }
      chat.model = WORKER_MODEL
    } else if (worker && account) {
      delete chat.workerId
      chat.account = account
      chat.accountAuto = true
    }
    Object.assign(chat, { status: 'closed', activity: null, turnStartedAt: null, lastError: null, limitResetsAt: null, pendingCount: 0, queuedCount: 0, contextPct: null })
    // What was remembered of the old worker or process goes with it.
    for (const k of ['emitted', 'workerSeen', 'cwdFile', 'readAccount', 'workerLive', 'workerCwd', 'ended', 'matchKey', 'cwdPending', 'moved', 'workerErrorSeen'] as const) delete e[k]
    const dropped = this.store.keepItems(id, new Set(items.slice(0, index).map((i) => i.id)))
    for (const s of e.sent ?? []) dropped.push(s.id)
    e.sent = undefined
    for (const itemId of new Set(dropped)) this.emitEvent({ type: 'item.removed', chatId: id, itemId })
    // A task still running before the cut ran in the process just stopped.
    this.endTasks(e)
    this.changed(chat)
    return { ...chat }
  }

  /** The sessions a chat's transcript was read from, newest first: its own, the one it forked, those it ran before a move, a worker's before each handoff. */
  private async sessionsOf(e: Entry): Promise<string[]> {
    const chat = e.chat
    const w = chat.workerId ? (await this.bridge.workersByIds([chat.workerId]).catch(() => []))[0] : undefined
    const oldestFirst = [...(e.pastSessions ?? []), chat.forkedFrom, ...(w?.sessions ?? []), w?.sessionId, chat.sessionId]
    return [...new Set(oldestFirst.filter((s): s is string => !!s))].reverse()
  }

  /**
   * Where a fork that leaves out the owner's message `msg` cuts: the session file it is in (`sessions`
   * newest first), the entry before it (null: the message opened that session) and the config folder of
   * that file. The message is its entry's uuid, else its text; the same words sent again are told apart by
   * how many come after it (`after`). Null when no file has it: a fork is never cut at a guess.
   */
  private findCut(sessions: string[], cwd: string, msg: UserItem, after: TranscriptItem[], accounts: (AccountRef | null | undefined)[]): Cut | null {
    const roots = [...accounts.flatMap((a) => (a ? [this.root(a.configDir)] : [])), ...this.bridge.sessionRoots()]
    const reads = sessions.flatMap((sessionId) => {
      const file = findSessionJsonl(sessionId, roots, cwd)
      if (!file) return []
      try {
        return [{ sessionId, file, ...cutsBefore(file, msg.id, msg.text) }]
      } catch (err) {
        console.warn(`[desk] could not read session ${sessionId} for a fork: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    })
    const cutIn = (r: (typeof reads)[number], cut: string | null): Cut => {
      const root = dirname(dirname(r.file))
      const isDefault = resolve(root).toLowerCase() === resolve(this.root(null)).toLowerCase()
      return { sessionId: r.sessionId, cut, configDir: isDefault ? null : dirname(root) }
    }
    const byId = reads.find((r) => r.byId !== undefined)
    if (byId) return cutIn(byId, byId.byId ?? null)
    const text = squash(msg.text)
    let later = after.filter((i) => i.kind === 'user' && squash(i.text) === text).length
    for (const kind of ['exact', 'loose'] as const) {
      if (!reads.some((r) => r[kind].length)) continue
      for (const r of reads) {
        const cuts = r[kind]
        if (later < cuts.length) return cutIn(r, cuts[cuts.length - 1 - later] ?? null)
        later -= cuts.length
      }
      return null
    }
    return null
  }

  /** Changes Hydra Desk's marks on an outside session; the poller's next list carries them. */
  patchSessionMeta(sessionId: string, p: SessionMetaPatch): SessionMeta {
    if (!/^[\w-]{1,100}$/.test(sessionId)) throw new ChatError(400, `bad session id ${JSON.stringify(sessionId)}`)
    return this.sessionMeta.patch(sessionId, p)
  }

  /**
   * Adopts a session run elsewhere: a closed chat with its history; the next send resumes it. With
   * `fork` the chat forks it at its first message instead, and the original stays listed as it is; with
   * `at` too the fork leaves out that message of the owner's and all after it (forkBefore). A Codex chat
   * becomes one pinned to Codex on its own thread and account (codexImport): its next send resumes it there.
   */
  async importSession(req: ImportSessionRequest): Promise<ChatSummary> {
    const adopted = () =>
      req.fork ? undefined : [...this.chats.values()].find((e) => e.chat.sessionId === req.sessionId || e.chat.serviceThreads?.codex?.threadId === req.sessionId)
    const existing = adopted()
    if (existing) return { ...existing.chat }

    const outside = await this.outsideSession(req.sessionId)
    const codex = outside?.source === 'codex' ? await this.codexImport(req, outside) : null
    const rawCwd = req.cwd ?? outside?.cwd
    if (!rawCwd) throw new ChatError(400, `cwd is required: AgentHydra does not know the folder of session ${req.sessionId}`)
    const cwd = checkCwd(rawCwd)
    const { account, auto, note } = codex ? await this.codexClaudeAccount() : await this.importAccount(req.configDir)
    const loaded = await this.externalItemsOf(req.sessionId)
    const loadError = loaded.error
    // Another import of the same session (a second window) may have landed during the awaits above: two
    // chats on one session would have two CLIs appending to one transcript.
    const raced = adopted()
    if (raced) return { ...raced.chat }
    const { cut, items } = this.importCut(req, loaded.items, loadError, cwd, account)

    const settings = this.settingsOf()
    const now = this.now()
    // The marks Hydra Desk kept on the outside session carry over to the chat it becomes.
    const meta = this.sessionMeta.get(req.sessionId)
    const { title, generate, firstAsk } = importTitle(req, items, meta?.title, outside?.title)
    const chat: ChatSummary = {
      id: randomUUID(),
      sessionId: req.fork || codex ? null : req.sessionId,
      forkedFrom: req.fork && cut?.cut !== null ? req.sessionId : null,
      ...(codex ? { service: 'codex' as const, serviceThreads: { codex: codex } } : {}),
      group: meta?.group ?? null,
      ...(meta?.note ? { note: meta.note } : {}),
      title: req.fork ? forkTitle(title) : title,
      cwd,
      account,
      accountAuto: auto,
      model: null,
      effort: null,
      permissionMode: settings.defaultPermissionMode,
      delegateToCliMayte: settings.delegateToCliMayte,
      status: 'closed',
      activity: null,
      turnStartedAt: null,
      lastError: null,
      limitResetsAt: null,
      unread: false,
      pinned: !req.fork && (meta?.pinned ?? false),
      archived: false,
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      contextPct: null,
      pendingCount: 0,
      queuedCount: 0,
      climayteActive: 0,
    }
    for (const item of items) this.store.appendItem(chat.id, item)
    if (loadError) {
      this.store.appendItem(chat.id, { kind: 'system', id: `import:${now}`, ts: now, level: 'warn', text: `The earlier history could not be loaded: ${loadError}` })
    }
    // A fork of an outside session is cut where it stands now, as fork() cuts one of ours, or before the message it forks at.
    if (cut) this.chats.set(chat.id, { chat, runtime: null, query: null, ...(cut.cut === null ? {} : { forkAt: cut.cut, ranIn: cut.configDir }) })
    else this.chats.set(chat.id, { chat, runtime: null, query: null, forkAt: req.fork ? this.forkPointOf(req.sessionId, cwd, [account]) : undefined })
    this.refreshClimayte()
    this.changed(chat)
    this.accountNote(chat.id, note)
    const e = this.chats.get(chat.id)!
    if (generate) this.autoTitle(e, firstAsk!)
    else e.titled = true
    return { ...chat }
  }

  /** The outside session as AgentHydra lists it; undefined when it does not know it. Refused when it cannot resume. */
  private async outsideSession(sessionId: string): Promise<Awaited<ReturnType<Bridge['externalSession']>> | undefined> {
    // The list holds the last 24 hours; an older session (a search hit) is read on its own.
    const outside =
      (await this.bridge.externalSessions().catch(() => [])).find((s) => s.id === sessionId) ??
      (await this.bridge.externalSession(sessionId).catch(() => undefined))
    // A Claude Code session resumes, and a Codex chat on Codex; the rest are read-only. One AgentHydra does not
    // know is let through: its send refuses it when no folder here has it.
    if (outside && outside.source !== 'desktop' && outside.source !== 'cli' && outside.source !== 'codex') {
      throw new ChatError(400, `This ${READ_ONLY_SOURCES[outside.source]} session is read-only: only Claude Desktop, terminal and Codex chats can be continued in AgentHydra.`)
    }
    return outside
  }

  /**
   * The thread an outside Codex chat goes on in: its own, on the Codex account whose folder holds it, signed in. It
   * continues in place, so a fork is refused (Fork works on Claude chats), as is an account Desk cannot reach.
   */
  private async codexImport(req: ImportSessionRequest, outside: ExternalSession): Promise<ServiceThread> {
    const where = outside.instance ? `Codex ${outside.instance}` : 'its Codex account'
    if (req.fork) throw new ChatError(400, 'This Codex chat continues in place: Fork works on Claude chats.')
    if (!this.codexDir) throw new ChatError(409, 'Codex chats cannot continue here: this Desk has no Codex accounts.')
    if (!outside.codexAccountId) throw new ChatError(409, 'AgentHydra does not say which Codex account holds this chat, so it cannot continue here.')
    const found = (await this.codexDir.instances().catch(() => [])).find((i) => i.id === outside.codexAccountId)
    if (!found?.loggedIn) throw new ChatError(409, `${where} is signed out, so this chat cannot continue here.`)
    return { accountId: found.id, label: codexAccount(found).label, threadId: req.sessionId }
  }

  /** A Codex chat's Claude account is only where it would go if pinned back to Claude: never refused, so with no
   *  Claude account to place it on, CliMayte places it. */
  private async codexClaudeAccount(): Promise<ResolvedAccount> {
    return this.resolveAccount(this.settingsOf().defaultAccountId).catch((err: unknown) => {
      if (err instanceof ChatError && err.status === 409) return { account: { ...CLIMAYTE_ACCOUNT }, auto: true, note: null }
      throw err
    })
  }

  /** The account an imported session continues on: the one asked for, else one with room. */
  private async importAccount(configDir: string | null | undefined): Promise<{ account: AccountRef; auto: boolean; note: string | null }> {
    return configDir === undefined ? this.resolveAccount(this.settingsOf().defaultAccountId) : { account: await this.accountForConfigDir(configDir), auto: false, note: null }
  }

  private async externalItemsOf(sessionId: string): Promise<{ items: TranscriptItem[]; error: string | null }> {
    try {
      // The whole history, not only the newest part the outside view polls: the chat it becomes shows every message.
      return { items: await this.bridge.externalHistory(sessionId), error: null }
    } catch (err) {
      return { items: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** A fork at one of the owner's messages: the cut, and the items before that message. */
  private importCut(req: ImportSessionRequest, items: TranscriptItem[], loadError: string | null, cwd: string, account: AccountRef): { cut: Cut | null; items: TranscriptItem[] } {
    if (!(req.fork && req.at)) return { cut: null, items }
    const index = items.findIndex((i) => i.id === req.at)
    const msg = items[index]
    if (msg?.kind !== 'user') throw new ChatError(400, loadError ?? `session ${req.sessionId} has no message ${JSON.stringify(req.at)} of yours to fork at`)
    const cut = this.findCut([req.sessionId], cwd, msg, items.slice(index + 1), [account])
    if (!cut) throw new ChatError(409, CUT_NOT_FOUND)
    return { cut, items: items.slice(0, index) }
  }

  /** Reads the CliMayte chats' workers again (every live one, or only `only`): chat-manager-workers.ts. */
  syncWorkers(only?: string): Promise<void> {
    return this.workers.syncWorkers(only)
  }

  /** Sets climayteActive and the chat's workerIds from the worker list (chat-manager-workers.ts). */
  private matchWorkers(chat: ChatSummary, workers: CliMayteWorker[]): boolean {
    return this.workers.matchWorkers(chat, workers)
  }

  private setWorkerCwd(e: Entry, cwd: string): void {
    this.workers.setWorkerCwd(e, cwd)
  }

  /** A sub-chat changed: its parent counts it again, and a parent that replied turns unread when its last one finishes. */
  private settleParent(child: ChatSummary): void {
    const e = child.parentId ? this.chats.get(child.parentId) : undefined
    if (!e) return
    const parent = e.chat
    const before = parent.climayteActive
    const grew = this.matchWorkers(parent, this.bridge.lastWorkers())
    const n = parent.climayteActive
    if (n === before && !grew) return
    if (n !== before && n === 0 && (parent.status === 'idle' || parent.status === 'stopped' || parent.status === 'closed')) parent.unread = true
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'chat.upsert', chat: this.view(parent) })
    this.settleParent(parent)
  }

  /** Every worker id any chat has matched: the bridge keeps these listed after AgentHydra's recent window drops them. */
  workerIdsOfChats(): string[] {
    return [...new Set([...this.chats.values()].flatMap((e) => e.chat.workerIds ?? []))]
  }

  /** climayteActive from the last worker list the bridge poller read; broadcasts the chats that changed. */
  refreshClimayte(): void {
    void this.syncWorkers()
    const workers = this.bridge.lastWorkers()
    let dirty = false
    const listKey = workersKey(workers)
    for (const e of this.chats.values()) {
      const chat = e.chat
      // Same worker list and same ids on the chat as the last match: the answer is the same, nothing to count or send.
      const matchKey = `${listKey}|${chat.workerId ?? ''}|${chat.sessionId ?? ''}|${chat.workerIds?.length ?? 0}`
      if (e.matchKey === matchKey) continue
      const before = chat.climayteActive
      const grew = this.matchWorkers(chat, workers)
      e.matchKey = grew ? undefined : matchKey
      const n = chat.climayteActive
      if (grew) dirty = true
      if (n === before) {
        if (grew) this.emitEvent({ type: 'chat.upsert', chat: this.view(chat) })
        continue
      }
      // The background work of a chat that already replied finished: unread again, so it is seen as done
      // even if it was read while the work ran.
      const finished = n === 0 && before > 0 && (chat.status === 'idle' || chat.status === 'stopped' || chat.status === 'closed')
      if (finished) {
        chat.unread = true
        dirty = true
      }
      this.emitEvent({ type: 'chat.upsert', chat: this.view(chat) })
    }
    if (dirty) this.store.saveChats(this.stored())
  }

  /**
   * Server start (SPEC "Chat hosts"): the chats whose hosts kept them running through the restart are taken
   * over, what they did meanwhile replayed. A host whose chat is gone is ended. Answers how many were taken over;
   * none while another server that took them still runs on this folder (`port`: this server's).
   */
  async attachHosts(port = 0): Promise<number> {
    if (!(await claimHosts(this.store.home, port))) {
      console.warn('[desk] another Hydra Desk server runs on this data folder: the chats running there stay with it')
      return 0
    }
    let adopted = 0
    for (const c of await openHosts(this.store.home)) {
      const e = this.chats.get(c.hello.chatId)
      if (!e || e.runtime?.running) {
        void c.end()
        continue
      }
      this.runtimeOf(e).start(c)
      // Its tasks still run in the host: they count again.
      for (const item of this.store.loadItems(e.chat.id)) this.noteTask(e, item)
      adopted++
    }
    // A chat no host kept ran nothing through the restart: what it said was running ended with its process.
    for (const e of this.chats.values()) {
      if (e.chat.workerId === undefined && !e.runtime?.running && e.chat.backgroundActive && this.endTasks(e)) this.changed(e.chat)
    }
    return adopted
  }

  /**
   * Server shutdown: hosted chats are let go to run on in their hosts, for the next server to take over (SPEC
   * "Chat hosts"); `chats` ends them too. In-process runtimes close (chats go 'closed'). The list is written now.
   */
  async closeAll(o: { chats?: boolean } = {}): Promise<void> {
    this.closing = true
    await this.workers.syncing?.catch(() => {})
    await Promise.allSettled([...this.branchReads])
    await Promise.all([...this.chats.values()].map((e) => (o.chats ? e.runtime?.close() : e.runtime?.shutdown())?.catch(() => {})))
    await Promise.all([...this.chats.values()].map((e) => (o.chats ? e.pinned?.close() : e.pinned?.shutdown())?.catch(() => {})))
    closeAppServers()
    // The folder goes to the next server only once this one has written its last line.
    try {
      this.store.saveChats(this.stored())
      await this.store.close()
    } finally {
      releaseHosts(this.store.home)
    }
    this.sessionMeta.flushSync()
  }

  // Internals

  /** One ledger row for a failure of chat `e`; remembered so a later move can mark it recovered. */
  private fail(e: Entry, f: Pick<FailureInput, 'message' | 'fallback' | 'cause' | 'durationMs'>): void {
    const c = e.chat
    e.lastFailure = this.failures.record({
      chatId: c.id,
      title: c.title,
      cwd: c.cwd,
      kind: c.workerId !== undefined ? 'worker' : 'sdk',
      accountId: c.account.id,
      accountNumber: c.account.number ?? null,
      model: c.model ?? null,
      sessionId: c.sessionId,
      ...f,
    })
  }

  private entry(id: string): Entry {
    const e = this.chats.get(id)
    if (!e) throw new ChatError(404, `no chat ${id}`)
    return e
  }

  /**
   * Pin service: the chat's next turns run on `to` (null: Claude again). The turn running now finishes where it
   * is; the next one runs on the new service and first reads what was said since the chat was last there.
   */
  private async pinService(e: Entry, to: PinnedService | null): Promise<void> {
    const chat = e.chat
    const from: ChatServiceKind = chat.service ?? 'claude'
    const target: ChatServiceKind = to ?? 'claude'
    if (from === target) return
    if (to === 'chatgpt' && !this.free()) throw new ChatError(409, 'ChatGPT needs Free instances, which are not running in this Desk.')
    if (to === 'codex' && !this.codexDir) throw new ChatError(409, 'Codex is not set up in this Desk.')
    chat.serviceLeftAt = { ...chat.serviceLeftAt, [from]: this.now() }
    chat.service = to
    // The Claude process keeps running its turn; it ends once that turn is over.
    if (from === 'claude' && e.runtime?.running) await e.runtime.closeWhenIdle()
    if (from !== 'claude' && e.pinned && !e.pinned.busy) {
      await e.pinned.close()
      e.pinned = null
    }
    this.systemLine(chat.id, 'service', 'info', to ? `This chat now runs on ${SERVICE_LABEL[target]}.` : 'This chat runs on Claude again.')
  }

  /** The chat caught up on `kind`: the next turn there reads nothing more. */
  private clearLeftAt(e: Entry, kind: ChatServiceKind): void {
    const { [kind]: _gone, ...rest } = e.chat.serviceLeftAt ?? {}
    e.chat.serviceLeftAt = Object.keys(rest).length ? rest : undefined
  }

  /**
   * What a turn on `kind` first reads (Pin service): a condensed handoff of the chat's record since its pin last
   * left `kind`, or of all of it for a thread there that is new (`fresh`), and what ran it meanwhile. Null when no
   * reply came in that stretch. `sentId`, the message being sent, is the handoff's last line, not part of it.
   */
  private serviceHandoff(e: Entry, kind: ChatServiceKind, fresh: boolean, sentId: string | null, movedFrom?: string): { text: string; from: string } | null {
    const chat = e.chat
    const left = chat.serviceLeftAt?.[kind]
    if (!fresh && left === undefined) return null
    const since = fresh ? 0 : left!
    const items = this.store.loadItems(chat.id).filter((i) => i.ts > since && i.id !== sentId && !(i.kind === 'user' && i.queued))
    if (!items.some((i) => i.kind === 'assistant_text')) return null
    // What last ran a turn, not what the pin last left: Codex -> ChatGPT -> Claude while Codex replied never ran ChatGPT.
    const from = movedFrom ?? SERVICE_LABEL[chat.serviceRanOn ?? 'claude']
    const text = buildHandoff({
      chatId: chat.id,
      title: chat.title,
      cwd: chat.cwd,
      items,
      sessions: this.browserSessions(chat.id),
      tokens: null,
      why: PINNED,
      deskUrl: this.deskUrl(),
      services: { from, to: SERVICE_LABEL[kind] },
    })
    return { text, from }
  }

  /** A turn starts on `kind`: what it first reads, and from then on a handoff says the chat ran there. */
  private turnOn(e: Entry, kind: PinnedService, fresh: boolean, sentId: string, movedFrom?: string): { text: string; from: string } | null {
    const lead = this.serviceHandoff(e, kind, fresh, sentId, movedFrom)
    e.chat.serviceRanOn = kind
    return lead
  }

  /** The runtime of the service the chat is pinned to; one left from an earlier pin is closed. */
  private pinnedOf(e: Entry): ServiceRuntime {
    const kind = e.chat.service
    if (!kind) throw new ChatError(409, 'This chat runs on Claude.')
    if (e.pinned?.kind === kind) return e.pinned
    if (e.pinned) void e.pinned.close().catch(() => {})
    e.pinned = kind === 'codex' ? this.codexRuntime(e) : this.chatgptRuntime(e)
    return e.pinned
  }

  private chatgptRuntime(e: Entry): ChatgptRuntime {
    const free = this.free()
    if (!free) throw new ChatError(409, 'ChatGPT needs Free instances, which are not running in this Desk.')
    return new ChatgptRuntime({
      chat: e.chat,
      store: this.store,
      emit: (event) => this.onRuntimeEvent(event),
      settings: this.settingsOf,
      now: this.now,
      free,
      held: this.chatgptHeld,
      handoff: (fresh, sentId, movedFrom) => this.turnOn(e, 'chatgpt', fresh, sentId, movedFrom),
      onTurnClassified: (t) => this.countTurn(e.chat.id, 'chatgpt', t),
      caughtUp: () => this.clearLeftAt(e, 'chatgpt'),
    })
  }

  private codexRuntime(e: Entry): CodexRuntime {
    const dir = this.codexDir
    return new CodexRuntime({
      chat: e.chat,
      store: this.store,
      emit: (event) => this.onRuntimeEvent(event),
      settings: this.settingsOf,
      now: this.now,
      open: this.openCodex,
      pickAccount: (avoid) => (dir ? pickCodexAccount(dir, avoid, this.codexHeld, this.now()) : Promise.resolve({ why: 'Codex is not set up in this Desk.' })),
      findAccount: async (id) => {
        const found = (await dir?.instances().catch(() => []))?.find((i) => i.id === id && i.loggedIn)
        return found ? codexAccount(found) : null
      },
      handoff: (fresh, sentId, movedFrom) => this.turnOn(e, 'codex', fresh, sentId, movedFrom),
      onTurnClassified: (t) => this.countTurn(e.chat.id, 'codex', t),
      caughtUp: () => this.clearLeftAt(e, 'codex'),
      hold: (accountId, until) => this.codexHeld.set(accountId, until),
    })
  }

  private runtimeOf(e: Entry): ChatRuntime {
    if (e.runtime) return e.runtime
    const chatId = e.chat.id
    e.runtime = new ChatRuntime({
      chat: e.chat,
      store: this.store,
      deskUrl: this.deskUrl,
      emit: (event) => this.onRuntimeEvent(event),
      queryImpl: (params) => {
        const q = this.queryImpl(params)
        const cur = this.chats.get(chatId)
        if (cur) cur.query = q
        this.timings.sdkStarted(e.chat, q, { attach: !!params.attach })
        return q
      },
      onMessage: (msg) => this.timings.sdkMessage(e.chat, msg),
      env: this.env,
      settings: this.settingsOf,
      agentHydraMcp: this.agentHydraMcp,
      mainClaudeJson: this.mainClaudeJson,
      now: this.now,
      onClosed: () => {
        const cur = this.chats.get(chatId)
        if (cur) cur.query = null
        this.timings.sdkClosed(chatId)
      },
      forkAt: () => this.chats.get(chatId)?.forkAt ?? null,
      onTurnEnd: () => this.checkMoved(chatId),
      susTurn: () => {
        const cur = this.chats.get(chatId)
        if (!cur) return null
        this.refreshSusPick(cur.chat)
        return this.susTurnOf(cur.chat)
      },
      // A refusal is counted and nothing more: the message is never sent again on another setting or service.
      onTurnClassified: (t) => this.countTurn(chatId, 'claude', t),
      onFailure: (f) => {
        const cur = this.chats.get(chatId)
        if (cur) this.fail(cur, f)
      },
      onLimited: (window, signIn) => this.carryToAnotherAccount(chatId, signIn === true, window),
    })
    return e.runtime
  }

  /** A turn ended in another folder: chat-manager-moves.ts. */
  private checkMoved(chatId: string): void {
    this.moves.checkMoved(chatId)
  }

  /** A turn failed on its account (limit or sign-in): chat-manager-moves.ts. */
  private carryToAnotherAccount(chatId: string, signIn: boolean, window: string | null): boolean {
    return this.moves.carryToAnotherAccount(chatId, signIn, window)
  }

  /** The session the chat leaves and its size, when it is past `limit` (by default too big to copy and resume on
   *  another account); else null. */
  private bigSession(e: Entry, limit = this.handoffTokens): { sessionId: string; tokens: number } | null {
    const sessionId = e.chat.sessionId
    if (!sessionId) return null
    const ranIn = ranInOf(e)
    const file = findSessionJsonl(sessionId, [...(ranIn === undefined ? [] : [this.root(ranIn)]), ...this.bridge.sessionRoots()], e.chat.cwd)
    const tokens = file ? sessionTokens(file) : null
    return tokens !== null && tokens > limit ? { sessionId, tokens } : null
  }

  /** An idle chat whose session has grown past freshTokens starts fresh: chat-manager-moves.ts. */
  private freshFrom(e: Entry, grown: { sessionId: string; tokens: number }, send: QueuedInput): Promise<QueuedInput> {
    return this.moves.freshFrom(e, grown, send)
  }

  /** The saved session cannot be reopened: a fresh session from a handoff: chat-manager-moves.ts. */
  private takeOver(e: Entry, why: string, send: QueuedInput): QueuedInput | null {
    return this.moves.takeOver(e, why, send)
  }

  private onRuntimeEvent(event: ServerEvent): void {
    if (event.type === 'chat.upsert') {
      const e = this.chats.get(event.chat.id)
      if (!e) return // deleted while its runtime wound down
      // A fork that has its own session resumes that from now on: the cut is spent.
      if (e.forkAt && e.chat.sessionId) e.forkAt = undefined
      // A start publishes the chat: from then on its session's latest copy is in that account's folder.
      if (e.runtime?.startedAs) e.ranIn = e.runtime.startedAs.configDir
      // A closed runtime took its background tasks with it: their items say so, and stop counting.
      if (e.chat.status === 'closed' && e.bgTasks?.size) this.endTasks(e, this.now())
      this.sendWaiting(e)
      this.matchWorkers(e.chat, this.bridge.lastWorkers())
      this.store.saveChats(this.stored())
      this.emitEvent({ type: 'chat.upsert', chat: this.view(e.chat) })
      this.settleParent(e.chat)
      this.turnEnded(e)
      return
    }
    if ((event.type === 'item.upsert' || event.type === 'item.delta' || event.type === 'notify') && !this.chats.has(event.chatId)) return
    this.emitEvent(event)
    if (event.type === 'item.upsert' && this.noteTask(this.chats.get(event.chatId)!, event.item)) this.changed(this.chats.get(event.chatId)!.chat)
  }

  /** Keeps backgroundActive in step with one task item (running and not long-lived counts); true when it changed. */
  private noteTask(e: Entry, item: TranscriptItem): boolean {
    if (item.kind !== 'task') return false
    const running = (e.bgTasks ??= new Set())
    if (item.status === 'running' && !isLongLived(item)) running.add(item.taskId)
    else running.delete(item.taskId)
    const chat = e.chat
    const n = running.size
    if (n === (chat.backgroundActive ?? 0)) return false
    chat.backgroundActive = n
    // A chat that already replied and whose last background task just ended is unread again, as with CliMayte workers.
    if (n === 0 && chat.climayteActive === 0 && (chat.status === 'idle' || chat.status === 'stopped')) chat.unread = true
    return true
  }

  /** No task of the chat runs any more; true when backgroundActive changed. */
  private clearTasks(e: Entry): boolean {
    e.bgTasks?.clear()
    if (!e.chat.backgroundActive) return false
    e.chat.backgroundActive = 0
    return true
  }

  /**
   * The process that ran the chat's session is gone (closed, moved, a fresh session, a finished worker): each
   * task item still 'running' in its Desk file is settled as ended (endedTask), on disk and in every window, and
   * nothing counts as running any more. `at`: when it ended, if that was seen. True when backgroundActive changed.
   * 2026-10-05: a chat's panel listed three commands 'running' for five hours after its session had ended.
   */
  private endTasks(e: Entry, at?: number): boolean {
    const chatId = e.chat.id
    for (const item of this.store.loadItems(chatId)) {
      const done = endedTask(item, at)
      if (done === item) continue
      this.store.appendItem(chatId, done)
      this.emitEvent({ type: 'item.upsert', chatId, item: done })
      e.emitted?.set(done.id, signature(done))
      ;(e.ended ??= new Set()).add(done.id)
    }
    return this.clearTasks(e)
  }

  private answer(id: string, kind: string, requestId: string, fn: (rt: RequestAnswerer) => void): void {
    const e = this.entry(id)
    const rt: RequestAnswerer | null = e.pinned?.isPending(requestId) ? e.pinned : e.runtime
    if (!rt) throw new ChatError(404, `no pending ${kind} request ${requestId}: the chat is not running`)
    try {
      fn(rt)
    } catch (err) {
      // A form answer its fields refuse is the caller's to fix; anything else means no such open request.
      if (err instanceof ElicitationAnswerError || err instanceof QuestionPictureError) throw new ChatError(400, err.message)
      throw new ChatError(404, err instanceof Error ? err.message : String(err))
    }
  }

  /** An item went out: it is the chat's last action when it is newer. No upsert of its own, as items stream: the chat's next one carries it. */
  private noteAction(chatId: string, at: number): void {
    const chat = this.chats.get(chatId)?.chat
    if (chat && Number.isFinite(at) && at > (chat.lastActionAt ?? 0)) chat.lastActionAt = at
  }

  private changed(chat: ChatSummary): void {
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'chat.upsert', chat: this.view(chat) })
    // A CliMayte worker's status arrives here, not as a runtime event.
    this.sendWaiting(this.chats.get(chat.id))
    this.settleParent(chat)
    const e = this.chats.get(chat.id)
    if (e) this.turnEnded(e)
  }

  /** Reads the chat folder's branch in the background (kept per folder, git/branch.ts) and sends the chat when it changed.
   *  The read runs git in that folder, which Windows will not let anyone remove while it runs, so closeAll waits for every
   *  read still under way and none starts once it has begun (2026-10-17: Windows CI's account-failover tests failed with
   *  EBUSY removing a chat's folder right after closeAll, 22 of them on every run since 91a3826e). */
  private refreshBranch(e: Entry): void {
    const cwd = e.chat.cwd
    if (!cwd || this.closing) return
    const read = branchOf(cwd).then((branch) => {
      if ((e.chat.gitBranch ?? null) === branch && e.chat.gitBranch !== undefined) return
      e.chat.gitBranch = branch
      this.emitEvent({ type: 'chat.upsert', chat: this.view(e.chat) })
    })
    this.branchReads.add(read)
    const done = () => void this.branchReads.delete(read)
    read.then(done, done)
  }

  /** A chat that was live and no longer is ends its turn once: AgentHydra tells the chats waiting on it (completions.ts). */
  private turnEnded(e: Entry): void {
    if (LIVE.has(e.chat.status)) {
      e.turnLive = true
      return
    }
    if (!e.turnLive) return
    e.turnLive = false
    this.refreshBranch(e)
    const outcome = e.chat.status === 'error' ? 'failed' : e.chat.status === 'stopped' ? 'cancelled' : 'done'
    this.bridge.completionFinished(`desk-chat:${e.chat.id}`, outcome).catch(() => {})
  }

  /** A manager's photo or persona changed: every chat on it is sent again with the new label. */
  managerChanged(slug: string): void {
    for (const e of this.chats.values()) {
      const chat = this.view(e.chat)
      if (chat.manager?.slug === slug) this.emitEvent({ type: 'chat.upsert', chat })
    }
  }

  private view(chat: ChatSummary): ChatSummary {
    return { ...chat, manager: chatFace(chat) }
  }

  private stored(): ChatSummary[] {
    return [...this.chats.values()].map((e) => {
      if (!e.forkAt && e.ranIn === undefined && !e.pastSessions && e.workerCwd === undefined && !e.sent?.length && !e.retrying?.length) return e.chat
      const record: StoredRecord = { ...e.chat }
      if (e.forkAt) record.forkAt = e.forkAt
      if (e.ranIn !== undefined) record.ranIn = e.ranIn
      if (e.pastSessions) record.pastSessions = e.pastSessions
      if (e.workerCwd !== undefined) record.workerCwd = e.workerCwd
      if (e.sent?.length) record.sent = e.sent
      if (e.retrying?.length) record.retrying = e.retrying
      return record
    })
  }

  /** The account an SDK chat (an import, a fork, a chat from before CliMayte ran them) runs on: the one
   *  named, refused while signed out (it could only fail). '', 'auto' and the retired 'default' place it. */
  private async resolveAccount(accountId: string): Promise<ResolvedAccount> {
    if (!accountId || accountId === 'auto' || accountId === 'default') return this.placeAccount()
    const accounts = await this.bridge.listAccounts().catch(() => [])
    const a = accounts.find((x) => x.id === accountId)
    if (!a) throw new ChatError(400, `unknown account ${accountId}: AgentHydra lists ${accounts.map((x) => x.id).join(', ') || 'no accounts'}`)
    if (!a.signedIn) throw new ChatError(409, `${a.label} is signed out`)
    return { account: accountRef(a), auto: false, note: null }
  }

  /** The signed-in account with room that 'auto' places on; refused when none has room. */
  private async placeAccount(): Promise<ResolvedAccount> {
    const account = pickHealthy(this.placeable(await this.bridge.listAccounts().catch(() => [])), new Set())
    if (!account) throw new ChatError(409, `no account has room: every signed-in account is at or past ${ROOM_PCT}% or unread`)
    return { account: accountRef(account), auto: true, note: null }
  }

  /** Puts why 'auto' found no account into the chat's transcript, and the server log. */
  private accountNote(chatId: string, note: string | null): void {
    if (!note) return
    this.systemLine(chatId, 'account', 'warn', note)
    console.warn(`[desk] chat ${chatId}: ${note}`)
  }

  /** A CliMayte chat's sent message stops standing in: its worker's copy arrived, or the send failed. */
  private dropStandIn(e: Entry, item: UserItem): void {
    e.sent = e.sent?.filter((s) => s !== item)
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'item.removed', chatId: e.chat.id, itemId: item.id })
  }

  /** Messages held behind a wait are queued until their worker's copy arrives. */
  private markQueued(e: Entry): void {
    if (!e.sent?.some((s) => !s.queued)) return
    const marked = new Set<string>()
    e.sent = e.sent.map((s) => {
      if (s.queued) return s
      marked.add(s.id)
      return { ...s, queued: true }
    })
    this.store.saveChats(this.stored())
    for (const item of e.sent) if (marked.has(item.id)) this.emitEvent({ type: 'item.upsert', chatId: e.chat.id, item: standInShown(item, mediaCache(this.store.home)) })
  }

  /** A failed worker never reached the messages still held for it: they are dropped and the chat says so. One the chat
   *  is still sending again (retrying) stays: the chat sends it, and "send it again" would run it twice. */
  private undelivered(e: Entry): void {
    const ours = new Set(e.retrying?.map((r) => r.itemId))
    for (const item of e.sent?.filter((s) => s.queued && !ours.has(s.id)) ?? []) {
      this.dropStandIn(e, item)
      this.systemLine(e.chat.id, `undelivered:${item.id}`, 'warn',`Not delivered, send it again: "${item.text.slice(0, 80)}"`)
    }
  }

  private systemLine(chatId: string, kind: string, level: 'info' | 'warn', text: string): void {
    const ts = this.now()
    const item: TranscriptItem = { kind: 'system', id: `${kind}:${ts}`, ts, level, text }
    this.store.appendItem(chatId, item)
    this.emitEvent({ type: 'item.upsert', chatId, item })
  }

  /**
   * A session resumes only from its account's own config folder. One run elsewhere (Claude Desktop, a
   * terminal, another login) is copied there first, a fork: without the copy the resume fails with
   * "No conversation found". The folder the chat last ran in is the source (also after a restart): its
   * copy has the latest turns. Answers why the session cannot resume, or null: a session Hydra Desk never
   * ran (adopted from outside, or a fork of one) that no folder on this machine has, said in the
   * transcript too. One it ran was written by its own process, so a resume is never refused here. Null
   * (no promise) when the chat has no session yet: nothing to copy.
   */
  private seedResume(e: Entry): Promise<string | null> | null {
    // A fork not started yet resumes (and forks) the session it came from.
    const sessionId = e.chat.sessionId ?? e.chat.forkedFrom
    if (!sessionId) return null
    return (e.seeding ??= this.seedNow(e, sessionId).finally(() => (e.seeding = undefined)))
  }

  private async seedNow(e: Entry, sessionId: string): Promise<string | null> {
    const chat = e.chat
    const ranIn = ranInOf(e)
    const prefer = ranIn === undefined ? null : this.root(ranIn)
    try {
      const r = await seedSession(sessionId, chat.cwd, chat.account.configDir, this.bridge.sessionRoots(), this.claudeHome, prefer)
      if (r.status === 'copied') {
        this.systemLine(chat.id, 'seed', 'info', `Copied this session into ${chat.account.label}'s folder to continue it under that login. The original is unchanged.`)
      } else if (r.status === 'refreshed') {
        this.systemLine(chat.id, 'seed', 'info', `Brought ${chat.account.label}'s copy of this session up to date with the turns run under another login.`)
      } else if (r.status === 'missing' && ranIn === undefined) {
        const why = `No folder on this machine has session ${sessionId}, so it cannot be resumed.`
        this.systemLine(chat.id, 'seed', 'warn', why)
        return why
      }
    } catch (err) {
      console.warn(`[desk] chat ${chat.id}: could not copy session ${sessionId} into ${chat.account.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // The CLI resumes from the project folder of the cwd it starts in: after a move the transcript is copied under the new folder's name.
    try {
      await placeInCwd(sessionId, chat.cwd, chat.account.configDir, this.claudeHome)
    } catch (err) {
      console.warn(`[desk] chat ${chat.id}: could not place session ${sessionId} under ${chat.cwd}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  /** Where a fork of `sessionId` cuts it (forkPoint), looking in these accounts' folders and every known one; undefined when no file says. */
  private forkPointOf(sessionId: string, cwd: string, accounts: (AccountRef | null | undefined)[]): string | undefined {
    const roots = [...accounts.flatMap((a) => (a ? [this.root(a.configDir)] : [])), ...this.bridge.sessionRoots()]
    try {
      return forkPoint(sessionId, cwd, roots) ?? undefined
    } catch (err) {
      console.warn(`[desk] could not read where session ${sessionId} ends; the fork takes it as it is at its first message: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  private async accountForConfigDir(configDir: string | null): Promise<AccountRef> {
    if (!configDir) return (await this.placeAccount()).account
    const want = resolve(configDir).toLowerCase()
    const accounts = await this.bridge.listAccounts().catch(() => [])
    const a = accounts.find((x) => x.configDir && resolve(x.configDir).toLowerCase() === want)
    return a ? accountRef(a) : { id: configDir, label: basename(configDir), configDir }
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), this.liveListTimeoutMs)
    })
    try {
      return await Promise.race([p.catch(() => null), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

export function checkCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new ChatError(400, `cwd must be an absolute path, got ${JSON.stringify(cwd)}`)
  const full = resolve(cwd)
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new ChatError(400, `the folder ${full} does not exist`)
  return full
}