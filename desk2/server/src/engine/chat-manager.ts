// ChatManager (SPEC "The engine" + "Lifecycle"): owns every chat. A new chat is a CliMayte worker (SPEC
// "Chats are CliMayte workers"): its first message starts the worker, every later one is sent to it, and
// its transcript and status are read back from the worker. CliMayte picks the account and moves the chat
// when that account hits its limit or its login dies; Hydra Desk keeps no account policy of its own.
// Sessions continued from outside (imports) and forks still run in a ChatRuntime (the Agent SDK in this
// process) on the account they are named: a resume needs that session's own folder, which a worker
// cannot take. Loads the saved chats at start (all 'closed'), interrupts, answers the runtime's
// permission / question / plan requests, patches, deletes, and keeps climayteActive current.

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { McpServerConfig, Query } from '@anthropic-ai/claude-agent-sdk'
import type {
  AccountInfo,
  AccountRef,
  ChatPatch,
  ChatSummary,
  ChatWait,
  CliMayteWorker,
  CreateChatRequest,
  DeskSettings,
  Effort,
  ElicitationAnswer,
  ForkChatRequest,
  ImageRef,
  ImportSessionRequest,
  McpStatus,
  ModelChoice,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  QuestionAnswer,
  RewindChatRequest,
  SendNowRequest,
  SendNowResult,
  ServerEvent,
  SessionMeta,
  SessionMetaPatch,
  SlashCommandInfo,
  TranscriptItem,
} from '@shared/protocol'
import { type Bridge, DEFAULT_ACCOUNT } from '../bridge'
import type { AhWorker } from '../bridge/client'
import { isActiveWorkerStatus, workerAccountLabel, workersOfChat } from '../bridge/climayte'
import { isLongLived } from './long-lived'
import { cutsBefore, forkPoint, placeInCwd, projectsRoot, seedSession } from '../bridge/seed-session'
import { findSessionJsonl, firstCwdFrom, lastCwd } from '../bridge/session-jsonl'
import { askedToMove, isUncOrDevicePath, movedOutOf } from './cwd-move'
import { chatQueryImpl, claimHosts, openHosts, releaseHosts } from '../host/client'
import { connectorsPending } from '../connectors/registry'
import { chatAddOns } from './desk-prompt'
import { claudeCodeBinaryFor } from './claude-code-binary'
import { ChatRuntime, chatDiffers, type QueryImpl } from './chat-runtime'
import { commandInfosFrom, modelChoicesFrom, normalizeModel, STATIC_COMMANDS, STATIC_MODELS } from './models'
import { answersWithPictures, ElicitationAnswerError, QuestionPictureError } from './requests'
import { mediaCache, toStoredImage } from '../media/cache'
import { withNamedFiles, withoutNamedLines } from './system-text'
import { SessionMetaStore } from './session-meta'
import { ChatStore, fromStored, type StoredChat } from './store'
import { classifyFailure, FailureLedger, type FailureInput } from './failures'
import { sdkTitleGenerator, type TitleGenerator } from './chat-title'
import { Timings } from './timings'
import { buildHandoff, CONTINUE_TEXT, HANDOFF_TOKENS, sessionTokens } from './handoff'
import type { QueuedInput } from './input-queue'

export type ManagerBridge = Pick<Bridge, 'startWorker' | 'sendToWorker' | 'canDeliverNow' | 'sendToWorkerNow' | 'cancelWorker' | 'workersByIds' | 'workerItems' | 'listAccounts' | 'externalSessions' | 'externalSession' | 'externalItems' | 'sessionRoots' | 'lastWorkers' | 'setExtraWorkerIds' | 'setExcludeSessionIds' | 'setSessionMeta'>

export interface ChatManagerOptions {
  home: string
  /** The home folder whose .claude a chat with no account folder is seeded into (default: the user's own). Tests pass a temp folder so they never write into the real Claude config. */
  claudeHome?: string
  /** A move to another account starts a fresh session from a condensed handoff above this many tokens of
   *  session (SPEC "Account failover"). Default HYDRA_DESK_HANDOFF_TOKENS, else HANDOFF_TOKENS. */
  handoffTokens?: number
  /** Hydra Desk's own address, which a handoff names for the full transcript and each chat's move line. */
  deskUrl?: () => string
  emit(event: ServerEvent): void
  settings: () => DeskSettings
  bridge: ManagerBridge
  /** Default: chats run in chat hosts (SPEC "Chat hosts"), or in this process with HYDRA_DESK_HOSTS=0. */
  queryImpl?: QueryImpl
  env?: Record<string, string | undefined>
  /** undefined = each runtime reads ~/.claude.json; null = none. */
  agentHydraMcp?: McpServerConfig | null
  /** See ChatRuntimeDeps.mainClaudeJson. */
  mainClaudeJson?: string | null
  now?: () => number
  storeDebounceMs?: number
  /** How long supportedCommands() / supportedModels() may take before the static list answers. */
  liveListTimeoutMs?: number
  /** What a new chat is: a CliMayte worker (the default, and the only one the app uses), or 'sdk', a
   *  ChatRuntime on the default login, which the runtime's own tests start chats with. */
  newChats?: 'climayte' | 'sdk'
  /** Names a new chat from its first message; null = never. Default: a Sonnet query (none when queryImpl is faked). */
  titleGenerator?: TitleGenerator | null
}

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

/** What the send queue's dispatch asks of a send (SPEC "Send queue"). */
export interface SendOptions {
  /** Refuse with 409 while a turn runs or is about to, instead of joining the CLI's own queue (which nothing can edit or recall). */
  onlyIfReady?: boolean
  /** The SDK message uuid, which is also the user item's id: a send the queue made is found in the transcript by it. */
  messageId?: string
  /**
   * A person's plain send (Enter in "Send immediately", or Send now on a queue row): to a running CliMayte worker it
   * goes now, as Send now on its bubble does, not after the worker's whole task. An SDK chat's CLI takes it into the
   * running turn anyway.
   */
  now?: boolean
  /** An automatic note (AgentHydra's CliMayte ping), not the owner's words: it never names a chat that has no title yet. */
  noTitle?: boolean
}

/** createFromQueue's answer: the chat and how its first message went (its error, or null). `waiting` is
 *  never answered now that CliMayte queues a worker until an account has room; the queue still reads it. */
export type QueueCreated = { waiting: 'no-room' | 'unreachable' } | { chat: ChatSummary; firstSend: Promise<string | null> }

export const TITLE_MAX = 60
/** A chat's title until its first message names it. */
export const NEW_TITLE = 'New session'
/** How many accounts a generated title is asked of: the first, and one retry. */
const TITLE_TRIES = 2
/** A chat with a turn under way (the send queue waits on these). */
export const LIVE = new Set<ChatSummary['status']>(['starting', 'working', 'needs_you'])
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
const IMPORT_TITLE = 'Claude Code session'
/** Outside sessions that cannot be continued here, as their refusal names them. */
const READ_ONLY_SOURCES: Record<'climayte' | 'codex' | 'other', string> = { climayte: 'CliMayte worker', codex: 'Codex', other: 'outside' }
/** The CliMayte group Hydra Desk's chats run in. */
export const WORKER_GROUP = 'hydra-desk'
/** What a worker chat shows as its model: AgentHydra's chat mode launches it on Opus (xhigh), and Desk forces nothing. */
export const WORKER_MODEL = 'opus'
/** The account a chat shows before CliMayte has placed its worker. */
export const CLIMAYTE_ACCOUNT: AccountRef = { id: 'climayte', label: 'CliMayte', configDir: null }

/** A turn runs or is about to: ChatRuntime.send queues a message behind it (the same test). */
const busy = (c: ChatSummary): boolean => c.status === 'working' || c.status === 'needs_you' || (c.status === 'starting' && c.turnStartedAt !== null)

/** The items JSON kept across chats (characters, about bytes): the least recently answered goes first. */
const ITEMS_BODY_BYTES = 64 * 1024 * 1024

/** What an item is remembered as in Entry.emitted: a 64-bit hash of its JSON, not the JSON itself. */
const signature = (item: TranscriptItem): string => String(Bun.hash(JSON.stringify(item)))

/** A short hash of what matching workers to chats reads from the worker list (workersOfChat, activeness). */
function workersKey(workers: readonly CliMayteWorker[]): string {
  const hit = workerKeys.get(workers)
  if (hit !== undefined) return hit
  let text = ''
  for (const w of workers) text += `${w.id},${w.pc ?? ''},${w.active ? 1 : 0},${w.sessionId ?? ''},${w.originSessionId ?? ''},${w.originWorkerId ?? ''},${w.sessions?.join('+') ?? ''};`
  const key = String(Bun.hash(text))
  workerKeys.set(workers, key)
  return key
}
/** The bridge answers the very same array while the worker list did not change, so its key is worked out once. */
const workerKeys = new WeakMap<readonly CliMayteWorker[], string>()

/** The first line of the prompt, at most 60 chars (SPEC "Titles"). */
export function titleFrom(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  if (line.length <= TITLE_MAX) return line
  return line.slice(0, TITLE_MAX - 1).trimEnd() + '…'
}

interface Entry {
  chat: ChatSummary
  runtime: ChatRuntime | null
  /** The query the runtime runs now (for supportedCommands / supportedModels). */
  query: Query | null
  /** Set while the chat's worker is being started: a second send waits for it instead of starting another. */
  starting?: Promise<void>
  /** A CliMayte chat: a short hash of what each item of its Desk file looked like when last written or emitted (the file is the record, the worker's session JSONL the live source). Dropped once its worker is finished; the Desk file seeds it again. */
  emitted?: Map<string, string>
  /** What matchWorkers last matched the chat on (the worker list and the chat's own ids): the same input is not matched again. */
  matchKey?: string
  /** A CliMayte chat: the worker's session file and the account it was found under, so a poll does not search the session folders again. */
  cwdFile?: { sessionId: string; account: string | null; file: string }
  /** The worker's items as the last poll went through them: the bridge answers the same array while nothing changed. */
  workerSeen?: TranscriptItem[]
  /** The account the worker's JSONL was last read under: a change means the live file may have moved, so it is looked for again. */
  readAccount?: string | null
  /** False once its worker was seen finished: the poll stops reading it until the next send. */
  workerLive?: boolean
  /** A fork not started yet: the uuid of the source session's last entry when it was forked (its cut). */
  forkAt?: string
  /** The config folder the chat's last process ran under (null = the default login), kept across restarts:
   *  its copy of the session has the latest turns. Undefined: Hydra Desk never ran it. */
  ranIn?: string | null
  /** The sessions this chat ran before a move started a fresh one (oldest first, Hydra Desk's handoff): still its own, never "Elsewhere". */
  pastSessions?: string[]
  /** The accounts the message in flight has failed on or moved through (carryToAnotherAccount); cleared by the next send. */
  moved?: string[]
  /** Set while carryToAnotherAccount moves the chat: a send waits for it (then it goes to the new account, after the replay). */
  moving?: Promise<void>
  /** The session copy under way (seedResume): a second start waits for it instead of copying onto the same file. */
  seeding?: Promise<string | null>
  /** The owner named this chat (or it was named once already): the generated title never replaces it. */
  titled?: boolean
  /** The ids of its own background tasks still running that count toward backgroundActive (long-lived ones do not). */
  bgTasks?: Set<string>
  /** A CliMayte chat: the task items Hydra Desk settled because their session ended (endTasks). The worker's own
   *  JSONL still says 'running' for them, which never replaces the settled item; a real notice still does. */
  ended?: Set<string>
  /** A folder the session ended its last turn in, outside the chat's own (cwd-move): the move happens only if the next turn begins and ends there. `offset` is the transcript's size at that turn end. */
  cwdPending?: { target: string; file: string; offset: number }
  /** The owner's latest message (cwd-move: a move it asked for needs no second turn). */
  lastAsk?: string
  /** The folder the chat's worker was last started or sent into; a different chat.cwd is a move to pass on. */
  workerCwd?: string
  /** A CliMayte chat: the messages sent that its worker's JSONL does not show yet, shown meanwhile (memory only, never in the Desk file). */
  sent?: UserItem[]
  /** The ledger id of the chat's latest failure: a move to another account marks it recovered. */
  lastFailure?: string
  /** A CliMayte chat: the worker error already in the ledger, so a re-read of the same failure adds no row. */
  workerErrorSeen?: string | null
}

type UserItem = Extract<TranscriptItem, { kind: 'user' }>
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The stand-in a worker's own copy of a sent message replaces: the one with its text, else the oldest sent before it. */
function standInFor(sent: UserItem[], real: UserItem): number {
  const text = squash(real.text)
  const same = sent.findIndex((s) => text.includes(squash(withoutNamedLines(s.text))))
  return same >= 0 ? same : sent.findIndex((s) => s.ts <= real.ts + 60_000)
}

/** An imported session's title. One nobody named (no title, or only its first words) is named from its first message, as a new chat is. */
function importTitle(req: ImportSessionRequest, items: TranscriptItem[], kept: string | null | undefined, listed: string | undefined): { title: string; generate: boolean; firstAsk: string | undefined } {
  const firstAsk = items.find((i): i is UserItem => i.kind === 'user' && !!i.text.trim())?.text
  const named = !!req.title?.trim() || !!kept?.trim()
  const words = firstAsk ? titleFrom(firstAsk) : null
  const generate = !req.fork && !named && !!firstAsk && (!listed?.trim() || listed.trim() === words)
  const title = req.title?.trim() || listed?.trim() || words || IMPORT_TITLE
  return { title, generate, firstAsk }
}

/** How many accounts one message is tried on (the first and the ones it moves to). */
const MAX_MOVES = 4

/** '#126' for a numbered account, else its label. */
const accountName = (a: AccountRef): string => (a.number !== undefined ? `#${a.number}` : a.label)

/** The healthiest account not tried yet: signed in and under both limits, the least used first; the default login (unmeasured) last. */
export function pickHealthy(accounts: AccountInfo[], tried: string[]): AccountInfo | null {
  const ok = accounts.filter((a) => a.signedIn && !tried.includes(a.id) && (a.fiveHourPct ?? 0) < 100 && (a.weeklyPct ?? 0) < 100)
  const load = (a: AccountInfo): number => (a.id === DEFAULT_ACCOUNT.id ? 1000 : Math.max(a.fiveHourPct ?? 50, a.weeklyPct ?? 50))
  return ok.sort((a, b) => load(a) - load(b))[0] ?? null
}

/** The account a chat gets (resolveAccount). */
interface ResolvedAccount {
  account: AccountRef
  auto: boolean
  note: string | null
}

/** The stored chat record: a fork's cut and the folder the chat last ran in ride along, kept out of ChatSummary and so off the wire. */
type StoredRecord = ChatSummary & { forkAt?: unknown; ranIn?: unknown; pastSessions?: unknown; workerCwd?: unknown }

export class ChatManager {
  readonly store: ChatStore
  /** Hydra Desk's marks on outside sessions (pin, archive, unread, title, group). */
  readonly sessionMeta: SessionMetaStore
  /** Every failure, appended as it happens (SPEC "Failure ledger"). */
  readonly failures: FailureLedger
  /** How long every stage took (SPEC "Speed (timings)"). */
  readonly timings: Timings
  private readonly chats = new Map<string, Entry>()
  private readonly emitEvent: (event: ServerEvent) => void
  private readonly settingsOf: () => DeskSettings
  private readonly bridge: ManagerBridge
  private readonly claudeHome: string | undefined
  private readonly handoffTokens: number
  private readonly deskUrl: () => string
  private readonly queryImpl: QueryImpl
  private readonly env?: Record<string, string | undefined>
  private readonly agentHydraMcp?: McpServerConfig | null
  private readonly mainClaudeJson?: string | null
  private readonly now: () => number
  private readonly liveListTimeoutMs: number
  private liveModels: ModelChoice[] | null = null
  private readonly newChats: 'climayte' | 'sdk'
  private syncing: Promise<void> | null = null
  /** The JSON of each chat's items as last answered, while its file and media stand as they were (see itemsBody). */
  private readonly itemsBodies = new Map<string, { stamp: string; body: string; count: number }>()
  private itemsBodyBytes = 0
  /** closeAll ran: the pass over the workers stops at the next worker instead of saving into a folder that may be gone. */
  private closing = false
  private readonly titleGen: TitleGenerator | null

  /** The projects folder of a config folder (null: the default one), under the given home so every read and seed agree on it. */
  private root(configDir: string | null): string {
    return projectsRoot(configDir, this.claudeHome)
  }

  constructor(o: ChatManagerOptions) {
    this.store = new ChatStore(o.home, { debounceMs: o.storeDebounceMs })
    this.failures = new FailureLedger(o.home, o.now)
    this.timings = Timings.for(o.home, o.now)
    this.sessionMeta = new SessionMetaStore(o.home)
    this.emitEvent = o.emit
    this.settingsOf = o.settings
    this.bridge = o.bridge
    this.claudeHome = o.claudeHome
    this.handoffTokens = o.handoffTokens ?? (Number(process.env.HYDRA_DESK_HANDOFF_TOKENS) || HANDOFF_TOKENS)
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
    for (const stored of this.store.loadChats()) {
      const e = entryOf(stored as StoredRecord)
      this.chats.set(e.chat.id, e)
    }
    // Our own chats are not "Elsewhere".
    this.bridge.setExcludeSessionIds(() => this.sessionIds())
    this.bridge.setExtraWorkerIds(() => this.workerIdsOfChats())
    // Outside sessions are listed with Hydra Desk's marks on them.
    this.bridge.setSessionMeta((list) => this.sessionMeta.apply(list), () => this.sessionMeta.pinnedIds())
  }

  // Reads

  /** Every chat, newest activity first. */
  list(o: { archived?: boolean } = {}): ChatSummary[] {
    const all = [...this.chats.values()].map((e) => ({ ...e.chat }))
    const list = o.archived ? all : all.filter((c) => !c.archived)
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): ChatSummary {
    return { ...this.entry(id).chat }
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

  private dropItemsBody(id: string): void {
    const hit = this.itemsBodies.get(id)
    if (!hit) return
    this.itemsBodies.delete(id)
    this.itemsBodyBytes -= hit.body.length
  }

  listItems(id: string): TranscriptItem[] {
    const e = this.entry(id)
    // A CliMayte chat: its worker's transcript, with the lines Hydra Desk wrote (a move, a failure) in time order.
    if (e.chat.workerId !== undefined) return this.deskItems(e)
    const live = e.runtime?.running === true
    const items = this.store.loadItems(id).map((item) => {
      // A request stored 'pending' that no running runtime waits on was left by a process that died (a
      // hard stop, a crash): nothing can answer it, so it is expired, on disk and in every window.
      let done = settled(item)
      if (done !== item && e.runtime?.isPending(item.id)) done = item
      // So is a task still 'running' with no runtime running: its session ended (a restart, a crash), and the task with it.
      if (!live) done = endedTask(done)
      if (done === item) return item
      this.store.appendItem(id, done)
      this.emitEvent({ type: 'item.upsert', chatId: id, item: done })
      return done
    })
    if (!live && this.clearTasks(e)) this.changed(e.chat)
    return items
  }

  /** A CliMayte chat's whole transcript from its Desk file (chats/<id>.jsonl), oldest first, without touching any account folder. */
  private deskItems(e: Entry): TranscriptItem[] {
    const items = this.store.loadItems(e.chat.id).sort((a, b) => a.ts - b.ts)
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
    return e.sent?.length ? [...items, ...e.sent.map((s) => withNamedFiles(s, mediaCache(this.store.home)))] : items
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
      this.emitEvent({ type: 'chat.upsert', chat: { ...e.chat } })
      imported.push(row.id)
    }
    if (imported.length) this.store.saveChats(this.stored())
    return { imported, already }
  }

  sessionIds(): string[] {
    return [...this.chats.values()].flatMap((e) => [...(e.pastSessions ?? []), ...(e.chat.sessionId ? [e.chat.sessionId] : [])])
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
      title: req.title?.trim() || (prompt ? titleFrom(prompt) : NEW_TITLE),
      cwd,
      account,
      accountAuto: auto,
      model: worker ? WORKER_MODEL : req.model === undefined ? normalizeModel(settings.defaultModel) : normalizeModel(req.model),
      effort: req.effort === undefined ? settings.defaultEffort : req.effort,
      permissionMode: req.permissionMode ?? settings.defaultPermissionMode,
      delegateToCliMayte: req.delegateToCliMayte ?? settings.delegateToCliMayte,
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
      const tried: string[] = []
      let account: AccountRef | null = null
      for (let n = 1; n <= TITLE_TRIES; n++) {
        // No other account to try: the same one again (a slow answer, a passing error).
        account = (await this.titleAccount(chat, tried)) ?? account ?? { ...DEFAULT_ACCOUNT }
        tried.push(account.id)
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
  private async titleAccount(chat: ChatSummary, tried: string[]): Promise<AccountRef | null> {
    if (chat.account.configDir && !tried.includes(chat.account.id)) return chat.account
    const next = pickHealthy(await this.bridge.listAccounts().catch(() => []), tried)
    return next ? accountRef(next) : null
  }

  async send(id: string, text: string, images?: ImageRef[], opts: SendOptions = {}): Promise<{ queued: boolean }> {
    const e = this.entry(id)
    if (!text.trim() && !images?.length) throw new ChatError(400, 'text is required')
    e.lastAsk = text
    // A chat opened empty is named by its first message, as one opened with it is.
    if (!opts.noTitle && !e.titled && e.chat.title === NEW_TITLE && text.trim()) {
      e.chat.title = titleFrom(text)
      this.changed(e.chat)
      this.autoTitle(e, text)
    }
    if (e.chat.workerId !== undefined) return this.sendToWorker(e, text, images, opts)
    // Awaited only when there is something to wait for: a new chat's first send starts its process at once.
    if (e.moving) {
      while (e.moving) await e.moving
      if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)
    }
    // Sent again by hand while the move was sending it already (the owner saw the limit line): once is enough.
    if (e.runtime?.takeReplayed(text, images)) {
      this.systemLine(id, 'move-dup', 'info', `That message is already being sent again on ${accountName(e.chat.account)} after the move, so it was not sent twice.`)
      return { queued: false }
    }
    if (!e.runtime?.running) {
      // A cold start is a new process: the tasks the last one started ended with it.
      if (this.endTasks(e)) this.changed(e.chat)
      const seeding = this.seedResume(e)
      const cannot = seeding ? await seeding : null
      if (this.chats.get(id) !== e) throw new ChatError(404, `no chat ${id}`)
      if (cannot) throw new ChatError(409, cannot)
    }
    if (opts.onlyIfReady && busy(e.chat)) throw new ChatBusyError()
    e.moved = undefined // a new message starts its own tries
    this.timings.sdkSent(e.chat, e.runtime?.running === true)
    return this.runtimeOf(e).send(text, images?.length ? images : undefined, opts.messageId)
  }

  /**
   * The warm start (SPEC "Speed (timings)"): the owner began typing in a closed SDK chat, so its process starts
   * now and its start, hooks and MCP servers are over by the time the message is sent. A chat that is running,
   * a worker's, or one whose session cannot resume is left as it is.
   */
  async warm(id: string): Promise<{ started: boolean }> {
    const e = this.entry(id)
    if (e.chat.workerId !== undefined || e.runtime?.running || e.chat.archived || e.moving) return { started: false }
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
  private async sendToWorker(e: Entry, text: string, images: ImageRef[] | undefined, opts: SendOptions): Promise<{ queued: boolean }> {
    // A worker takes text: each picture is saved in the media cache and named by a line
    // `[Image: source: <path>]` (the form Claude Code uses, so the model opens it with Read).
    const shown = images?.length ? images.map((img) => toStoredImage(img, mediaCache(this.store.home))) : undefined
    // The stand-in keeps what the person typed: the worker's copy reads with its picture lines shown as pictures.
    const said = text
    if (images?.length) text =answersWithPictures({ m: text }, { m: images }, mediaCache(this.store.home)).m!
    while (e.starting) await e.starting
    const chat = e.chat
    if (this.chats.get(chat.id) !== e) throw new ChatError(404, `no chat ${chat.id}`)
    if (opts.onlyIfReady && busy(chat)) throw new ChatBusyError()
    let queued = busy(chat)
    // The message shows at once: the worker's JSONL has it only once its CLI runs and the poll reads it.
    const ts = this.now()
    const standIn: UserItem = { kind: 'user', id: `desk-sent:${ts}:${randomUUID()}`, ts, text: said, ...(shown ? { images: shown } : {}), ...(queued ? { queued } : {}) }
    ;(e.sent ??= []).push(standIn)
    this.emitEvent({ type: 'item.upsert', chatId: chat.id, item: withNamedFiles(standIn, mediaCache(this.store.home)) })
    const sentAt = this.now()
    let sent: { urgent: boolean; stoppedFor: boolean }
    try {
      sent = await this.dispatchToWorker(e, text, queued, opts)
    } catch (err) {
      this.dropStandIn(e, standIn)
      // Never a 404: the chat exists, and the send queue reads a 404 as a deleted chat.
      throw new ChatError(502,`CliMayte did not take the message: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.chats.get(chat.id) !== e) return { queued }
    this.timings.workerSent(chat, this.now() - sentAt)
    e.workerLive = true
    const held = await this.settleHeld(e, standIn, text, queued, sent, opts)
    queued = held.queued
    if (held.gone) return { queued }
    if (!queued) {
      chat.status = 'starting'
      chat.activity = 'Queued'
      chat.turnStartedAt = this.now()
      chat.lastError = null
    }
    chat.updatedAt = this.now()
    this.changed(chat)
    void this.syncWorkers(chat.id)
    return { queued }
  }

  /**
   * The message to the chat's worker, or the worker started with it. `urgent`: sent as AgentHydra's urgent message;
   * `stoppedFor`: that stopped the running turn for it.
   */
  private async dispatchToWorker(e: Entry, text: string, queued: boolean, opts: SendOptions): Promise<{ urgent: boolean; stoppedFor: boolean }> {
    const chat = e.chat
    if (!chat.workerId) {
      await this.startWorkerFor(e, text)
      return { urgent: false, stoppedFor: false }
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
    const stoppedFor = await this.bridge.sendToWorker(chat.workerId, text, moved ? chat.cwd : undefined, urgent, chatAddOns(chat.cwd, chat.delegateToCliMayte, { id: chat.id, base: this.deskUrl() }))
    this.setWorkerCwd(e, chat.cwd)
    return { urgent, stoppedFor }
  }

  private async startWorkerFor(e: Entry, text: string): Promise<void> {
    const chat = e.chat
    let started!: () => void
    e.starting = new Promise<void>((r) => (started = r))
    try {
      const connectors = connectorsPending()
      if (connectors) await connectors
      const w = await this.bridge.startWorker({ prompt: text, cwd: chat.cwd, title: chat.title, group: WORKER_GROUP, desk: chatAddOns(chat.cwd, chat.delegateToCliMayte, { id: chat.id, base: this.deskUrl() }) })
      e.workerCwd = chat.cwd
      chat.workerId = w.id
      chat.sessionId = w.sessionId
    } finally {
      e.starting = undefined
      started()
    }
  }

  /**
   * A worker takes nothing mid-turn, so CliMayte held it until the whole task ends; a plain send goes now, as Send now
   * on its bubble would (Jacob, 2026-10-05: "every single message, even if I don't have add to queue, always does
   * stinking add to queue"). If that fails it stays held, and the bubble's Send now can try again. `gone`: the chat
   * was deleted meanwhile.
   */
  private async settleHeld(
    e: Entry,
    standIn: UserItem,
    text: string,
    queued: boolean,
    sent: { urgent: boolean; stoppedFor: boolean },
    opts: SendOptions,
  ): Promise<{ queued: boolean; gone: boolean }> {
    const chat = e.chat
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
    if (e.chat.workerId) {
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
    if (!e.runtime?.running || e.chat.queuedCount === 0) return { ok: true, stopped: false, message: 'Nothing was stopped: the message had already gone on.' }
    await e.runtime.interrupt()
    return { ok: true, stopped: true }
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
    return r
  }

  /** A held message's stand-in once its turn was stopped for it: no longer queued, it is the turn starting now. */
  private unqueue(e: Entry, standIn: UserItem | undefined): void {
    const i = standIn && e.sent ? e.sent.indexOf(standIn) : -1
    if (i < 0) return
    const { queued: _q, ...sent } = standIn!
    e.sent![i] = sent
    this.emitEvent({ type: 'item.upsert', chatId: e.chat.id, item: sent })
  }

  async interrupt(id: string): Promise<void> {
    const e = this.entry(id)
    if (e.chat.workerId) {
      // Stopping a worker cancels it; the next message revives it in the same session.
      await this.bridge.cancelWorker(e.chat.workerId).catch(() => {})
      await this.syncWorkers(id)
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
    if (p.title !== undefined) {
      chat.title = p.title.trim().slice(0, 200)
      e.titled = true
    }
    if (p.pinned !== undefined) chat.pinned = p.pinned
    if (p.archived !== undefined) chat.archived = p.archived
    if (p.group !== undefined) chat.group = p.group
    // Put in another folder by hand: the next turn resumes the session there (seedResume / the worker's next send).
    const relocated = p.cwd !== undefined && p.cwd.toLowerCase() !== chat.cwd.toLowerCase()
    if (p.cwd !== undefined) {
      chat.cwd = p.cwd
      e.cwdPending = undefined
    }
    if (p.delegateToCliMayte !== undefined) chat.delegateToCliMayte = p.delegateToCliMayte
    // An account takes effect at the next runtime start (buildOptions reads chat.account); see below.
    if (resolved) {
      chat.account = resolved.account
      chat.accountAuto = resolved.auto
    }
    if (p.unread === false) {
      if (e.runtime) e.runtime.markViewed()
      else chat.unread = false
    } else if (p.unread === true) chat.unread = true
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
    // The process keeps the login it started under: it ends once its turn is over (a limited or idle
    // one at once), so the next send starts under the chosen account and resumes the session there.
    if (live && (relocated || (live.startedAs && live.startedAs.id !== chat.account.id))) await live.closeWhenIdle()
    chat.updatedAt = this.now()
    this.changed(chat)
    this.accountNote(id, resolved?.note ?? null)
    return { ...chat }
  }

  /** Drops the chat from Hydra Desk (its runtime closed, its history file removed). */
  async delete(id: string): Promise<void> {
    const e = this.entry(id)
    this.chats.delete(id)
    const rt = e.runtime
    e.runtime = null
    if (rt) await rt.close().catch(() => {})
    // Its worker goes too while it still runs; a finished one stays in CliMayte's list.
    if (e.chat.workerId && e.workerLive !== false) await this.bridge.cancelWorker(e.chat.workerId).catch(() => {})
    this.store.deleteChat(id)
    this.dropItemsBody(id)
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
    if (e.starting) throw new ChatError(409, 'This chat is starting its worker: undo once it has started.')
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
   * `at` too the fork leaves out that message of the owner's and all after it (forkBefore).
   */
  async importSession(req: ImportSessionRequest): Promise<ChatSummary> {
    const adopted = () => (req.fork ? undefined : [...this.chats.values()].find((e) => e.chat.sessionId === req.sessionId))
    const existing = adopted()
    if (existing) return { ...existing.chat }

    const outside = await this.outsideSession(req.sessionId)
    const rawCwd = req.cwd ?? outside?.cwd
    if (!rawCwd) throw new ChatError(400, `cwd is required: AgentHydra does not know the folder of session ${req.sessionId}`)
    const cwd = checkCwd(rawCwd)
    const { account, auto, note } = await this.importAccount(req.configDir)
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
      sessionId: req.fork ? null : req.sessionId,
      forkedFrom: req.fork && cut?.cut !== null ? req.sessionId : null,
      group: meta?.group ?? null,
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
    // Only a Claude Code session resumes; the rest are read-only. One AgentHydra does not know is let
    // through: its send refuses it when no folder here has it.
    if (outside && outside.source !== 'desktop' && outside.source !== 'cli') {
      throw new ChatError(400, `This ${READ_ONLY_SOURCES[outside.source]} session is read-only: only Claude Desktop and terminal sessions can be continued in Hydra Desk.`)
    }
    return outside
  }

  /** The account an imported session continues on: the one asked for, else the default one, never the bare ~/.claude login. */
  private async importAccount(configDir: string | null | undefined): Promise<{ account: AccountRef; auto: boolean; note: string | null }> {
    const { account, auto, note } =
      configDir === undefined ? await this.resolveAccount(this.settingsOf().defaultAccountId) : { account: await this.accountForConfigDir(configDir), auto: false, note: null }
    // Never landed on unasked: the default ~/.claude login's own CLI token expires, so its resume would fail.
    if (configDir === undefined && account.id === DEFAULT_ACCOUNT.id) {
      throw new ChatError(409, 'Choose the account to continue this session on: Hydra Desk does not choose one.')
    }
    return { account, auto, note }
  }

  private async externalItemsOf(sessionId: string): Promise<{ items: TranscriptItem[]; error: string | null }> {
    try {
      return { items: await this.bridge.externalItems(sessionId), error: null }
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
    const entries = [...this.chats.values()].filter((e) => e.chat.workerId && (only ? e.chat.id === only : e.workerLive !== false))
    if (!entries.length) return
    const from = this.now()
    const raw = await this.bridge.workersByIds(entries.map((e) => e.chat.workerId as string))
    const byId = new Map(raw.map((w) => [w.id, w]))
    for (const e of entries) {
      const w = byId.get(e.chat.workerId as string)
      if (w && this.chats.get(e.chat.id) === e) await this.applyWorker(e, w)
      // One worker's read at a time: a click's request and the timers run between two workers, not after the whole pass.
      await new Promise((done) => setImmediate(done))
      if (this.closing) return
    }
    this.timings.poll(this.now() - from)
  }

  /** The chat as its worker stands: status, account (a move is said in the transcript), model, transcript. */
  private async applyWorker(e: Entry, w: AhWorker): Promise<void> {
    const chat = e.chat
    const before = { ...chat }
    const was = chat.status
    // Moved to another account, or continued in a fresh session: the process that ran the old session is gone,
    // and the background tasks it started with it (their notices never come).
    const moved = !!w.accountId && w.accountId !== chat.account.id && chat.account.id !== CLIMAYTE_ACCOUNT.id
    const freshSession = !!before.sessionId && !!w.sessionId && w.sessionId !== before.sessionId
    if (moved || freshSession) this.endTasks(e)
    if (w.accountId && w.accountId !== chat.account.id) this.applyWorkerAccount(e, w)
    const next = this.applyWorkerStatus(e, w, was)

    // Read the live JSONL(s), then append to the Desk file only what is new or changed; push just those. The
    // Desk file is read once, for what it already holds (emitted), not on every poll.
    if (!e.emitted) this.deskItems(e)
    const rescan = e.readAccount !== w.accountId
    const writing = w.sessionId && w.accountId ? { sessionId: w.sessionId, accountId: w.accountId } : undefined
    const items = await this.bridge.workerItems([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])], chat.cwd, { rescan, writing })
    // Deleted meanwhile, or Undo let this worker go.
    if (this.chats.get(chat.id) !== e || chat.workerId !== w.id) return
    e.readAccount = w.accountId
    const newReply = this.syncWorkerItems(e, items)
    this.timings.workerSeen(chat, { running: w.status === 'running' || w.status === 'checking', active: e.workerLive === true, newReply, ok: next.status !== 'error' })
    // A finished worker's process is gone, and every background task it started with it.
    if (!e.workerLive) this.endTasks(e)
    this.adoptWorkerCwd(e, w)
    // A worker's turn ended in another folder: the sidebar follows once the move holds (the next send passes the new folder to the worker, see SPEC "A chat moves folders").
    if (w.sessionId && LIVE_STATUSES.has(was) && !LIVE_STATUSES.has(next.status)) {
      this.noteCwd(e, this.workerFile(e, w.sessionId, w.accountId ?? null))
    }
    // A finished worker is not polled again: what remembers its items is let go (the Desk file seeds it again).
    if (!e.workerLive) {
      e.emitted = undefined
      e.workerSeen = undefined
      e.cwdFile = undefined
    }
    if (!chatDiffers(before, chat)) return
    chat.updatedAt = Math.max(chat.updatedAt, w.updatedAt || 0)
    this.changed(chat)
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
    this.systemLine(chat.id, 'cwd', 'info', `Moved this chat to ${target}.`)
    this.changed(chat)
  }

  private setWorkerCwd(e: Entry, cwd: string): void {
    if (e.workerCwd !== undefined && sameFolder(e.workerCwd, cwd)) return
    e.workerCwd = cwd
    this.store.saveChats(this.stored())
  }

  /** The worker runs on another account than the chat says: the chat follows, and a move is said in the transcript. */
  private applyWorkerAccount(e: Entry, w: AhWorker): void {
    const chat = e.chat
    const from = chat.account.id === CLIMAYTE_ACCOUNT.id ? null : chat.account
    chat.account = workerAccount(w)
    if (!from) return
    this.timings.workerMoved(chat, `${accountName(from)}>${accountName(chat.account)}`)
    if (e.lastFailure) this.failures.recovered(e.lastFailure, chat.account.id)
    this.systemLine(chat.id, 'moved', 'info', `CliMayte moved this chat from ${from.label} to ${chat.account.label}.`)
  }

  private applyWorkerStatus(e: Entry, w: AhWorker, was: ChatSummary['status']): ReturnType<typeof workerChatStatus> {
    const chat = e.chat
    const next = workerChatStatus(w)
    chat.status = next.status
    chat.activity = next.activity
    chat.waiting = next.waiting
    chat.lastError = next.status === 'error' ? (w.error ?? 'The worker failed.') : null
    if (chat.lastError && (was !== 'error' || chat.lastError !== e.workerErrorSeen)) this.fail(e, { message: chat.lastError, fallback: 'worker_failed' })
    e.workerErrorSeen = chat.lastError
    if (LIVE_STATUSES.has(next.status)) chat.turnStartedAt ??= this.now()
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
      const sig = signature(item)
      if (emitted.get(item.id) === sig) continue
      // The ended session's JSONL still says 'running': the settled item stays.
      if (item.kind === 'task' && item.status === 'running' && e.ended?.has(item.id)) continue
      if (!emitted.has(item.id) && (item.kind === 'assistant_text' || item.kind === 'thinking' || item.kind === 'tool_use')) newReply = true
      emitted.set(item.id, sig)
      if (item.kind === 'user' && e.sent?.length) {
        const i = standInFor(e.sent, item)
        if (i >= 0) this.dropStandIn(e, e.sent[i]!)
      }
      this.store.appendItem(chat.id, item)
      this.emitEvent({ type: 'item.upsert', chatId: chat.id, item })
      this.noteTask(e, item)
    }
    return newReply
  }

  /** The worker's session file: the one found last time while the session and account are the same and it is still there, else searched for. */
  private workerFile(e: Entry, sessionId: string, account: string | null): string | null {
    const hit = e.cwdFile
    if (hit && hit.sessionId === sessionId && hit.account === account && existsSync(hit.file)) return hit.file
    const file = findSessionJsonl(sessionId, this.bridge.sessionRoots(), e.chat.cwd)
    e.cwdFile = file ? { sessionId, account, file } : undefined
    return file
  }

  /** Sets climayteActive and adds the workers now matched to the chat to workerIds; true when workerIds grew. */
  private matchWorkers(chat: ChatSummary, workers: CliMayteWorker[]): boolean {
    const mine = workersOfChat(workers, chat)
    chat.climayteActive = mine.filter((w) => w.active).length
    const ids = chat.workerIds ?? []
    const fresh = mine.map((w) => w.id).filter((id) => !ids.includes(id))
    if (!fresh.length) return false
    chat.workerIds = [...ids, ...fresh]
    return true
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
        if (grew) this.emitEvent({ type: 'chat.upsert', chat: { ...chat } })
        continue
      }
      // The background work of a chat that already replied finished: unread again, so it is seen as done
      // even if it was read while the work ran.
      const finished = n === 0 && before > 0 && (chat.status === 'idle' || chat.status === 'stopped' || chat.status === 'closed')
      if (finished) {
        chat.unread = true
        dirty = true
      }
      this.emitEvent({ type: 'chat.upsert', chat: { ...chat } })
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
    await this.syncing?.catch(() => {})
    await Promise.all([...this.chats.values()].map((e) => (o.chats ? e.runtime?.close() : e.runtime?.shutdown())?.catch(() => {})))
    releaseHosts(this.store.home)
    this.store.saveChats(this.stored())
    this.store.flush()
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
      onFailure: (f) => {
        const cur = this.chats.get(chatId)
        if (cur) this.fail(cur, f)
      },
      onLimited: (window, signIn) => this.carryToAnotherAccount(chatId, signIn === true, window),
    })
    return e.runtime
  }

  /**
   * An SDK chat's turn ended: if its session's own transcript says the process is now in another folder
   * (the model cd'd out), the chat moves there. The process runs in the old folder, so it ends at once (the
   * chat is idle) and the next send starts in the new one, resuming the same session (seedResume puts the
   * transcript under the new folder).
   */
  private checkMoved(chatId: string): void {
    const e = this.chats.get(chatId)
    if (!e?.chat.sessionId || e.chat.workerId !== undefined) return
    const root = this.root((e.runtime?.startedAs ?? e.chat.account).configDir)
    if (this.noteCwd(e, findSessionJsonl(e.chat.sessionId, [root, ...this.bridge.sessionRoots()], e.chat.cwd))) void e.runtime?.closeWhenIdle()
  }

  /**
   * A turn ended: moves the chat to the folder `file` (its session's transcript) says it ended in, when that
   * is a folder a chat can live in outside its own (movedOutOf) AND either the owner's message asked for that
   * move or the previous turn also ended there and this one began there (its first line's cwd). Otherwise the
   * folder is only remembered as pending. Moving: stored cwd, one muted line, the sidebar update.
   */
  private noteCwd(e: Entry, file: string | null): boolean {
    const pending = e.cwdPending
    const ask = e.lastAsk
    e.cwdPending = undefined
    e.lastAsk = undefined
    if (!file) return false
    let observed: string | null
    let size: number
    try {
      observed = lastCwd(file)
      size = statSync(file).size
    } catch {
      return false
    }
    const target = movedOutOf(e.chat.cwd, observed)
    if (!target) return false
    let held = false
    if (pending && pending.file === file && pending.target.toLowerCase() === target.toLowerCase()) {
      try {
        const began = firstCwdFrom(file, pending.offset)
        held = began !== null && resolve(began).toLowerCase() === target.toLowerCase()
      } catch {
        held = false
      }
    }
    if (!held && !askedToMove(ask, target)) {
      e.cwdPending = { target, file, offset: size }
      return false
    }
    e.chat.cwd = target
    this.systemLine(e.chat.id, 'cwd', 'info', `Moved this chat to ${target}.`)
    this.changed(e.chat)
    return true
  }

  /**
   * An SDK chat's turn failed on its account (login dead or usage limit): the session is copied into
   * another healthy account's folder and the unanswered messages are sent again there, once, with a muted
   * line saying so. At most MAX_MOVES accounts per message; then the runtime's own error stays. Answers
   * synchronously whether a move was taken on (the runtime then does not notify a stop); the move itself
   * runs after. Accounts and their health are AgentHydra's word (listAccounts), never a token or credential.
   */
  private carryToAnotherAccount(chatId: string, signIn: boolean, window: string | null): boolean {
    const e = this.chats.get(chatId)
    const rt = e?.runtime
    if (!e || !rt || e.chat.workerId !== undefined) return false
    const tried = (e.moved ??= [e.chat.account.id])
    if (!tried.includes(e.chat.account.id)) tried.push(e.chat.account.id)
    if (tried.length > MAX_MOVES) return false
    let done!: () => void
    e.moving = new Promise<void>((r) => (done = r))
    void this.moveChat(e, rt, signIn, window)
      .catch((err) => this.moveFailed(e, rt, `Could not move this chat to another account: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        e.moving = undefined
        done()
      })
    return true
  }

  private async moveChat(e: Entry, rt: ChatRuntime, signIn: boolean, window: string | null): Promise<void> {
    const chat = e.chat
    const tried = e.moved ?? []
    const from = chat.account
    const accounts = await this.bridge.listAccounts().catch(() => [])
    const next = pickHealthy(accounts, tried)
    if (!next) {
      this.moveFailed(e, rt, `${accountName(from)} ${signIn ? 'is signed out' : 'hit its limit'} and no other signed-in account has room (tried ${tried.map((id) => accountName(accounts.find((a) => a.id === id) ?? from)).join(', ')}).`)
      return
    }
    const { cut, sends } = rt.carrySends()
    const big = this.bigSession(e)
    tried.push(next.id)
    chat.account = accountRef(next)
    chat.accountAuto = true
    // A big session is not copied: the chat starts a fresh one from the handoff, so there is nothing slow to wait for.
    const out: QueuedInput[] = big ? [this.handoffSend(e, big, signIn ? 'signed out' : window ? `${window} limit` : 'usage limit', sends)] : []
    // Said before the session copy, which can take a while on a long chat.
    this.systemLine(chat.id, 'moved', 'info', `Moved from ${accountName(from)} (${signIn ? 'signed out' : window ? `${window} limit` : 'limit reached'}) to ${accountName(chat.account)}.`)
    if (big) this.systemLine(chat.id, 'handoff', 'info', `The session had grown to about ${Math.round(big.tokens / 1000)}k tokens, so it continues as a fresh session from a condensed handoff instead of a copy. This chat keeps the whole record.`)
    this.changed(chat)
    if (!big) {
      const cannot = await this.seedResume(e)
      if (cannot) {
        this.moveFailed(e, rt, cannot)
        return
      }
      // A turn that had replied is told to go on, once; its message would only ask it to start over.
      out.push(...(cut ? [{ text: CONTINUE_TEXT }, ...sends] : sends))
    }
    if (e.lastFailure) this.failures.recovered(e.lastFailure, chat.account.id)
    await rt.close()
    if (this.chats.get(chat.id) !== e) return
    this.changed(chat)
    rt.replay(out)
  }

  /** The session the chat leaves and its size, when it is too big to copy and resume on another account; else null. */
  private bigSession(e: Entry): { sessionId: string; tokens: number } | null {
    const sessionId = e.chat.sessionId
    if (!sessionId) return null
    const ranIn = ranInOf(e)
    const file = findSessionJsonl(sessionId, [...(ranIn === undefined ? [] : [this.root(ranIn)]), ...this.bridge.sessionRoots()], e.chat.cwd)
    const tokens = file ? sessionTokens(file) : null
    return tokens !== null && tokens > this.handoffTokens ? { sessionId, tokens } : null
  }

  /**
   * The chat leaves its big session for a fresh one (no resume): the old session joins pastSessions and the
   * first message is the condensed handoff built from the chat file, with the sends the old session had not
   * answered after it.
   */
  private handoffSend(e: Entry, big: { sessionId: string; tokens: number }, why: string, sends: QueuedInput[]): QueuedInput {
    const chat = e.chat
    const text = buildHandoff({
      chatId: chat.id,
      title: chat.title,
      cwd: chat.cwd,
      items: this.store.loadItems(chat.id),
      sessions: [big.sessionId, ...(e.pastSessions ?? []).slice().reverse()],
      tokens: big.tokens,
      why,
      deskUrl: this.deskUrl(),
    })
    e.pastSessions = [...(e.pastSessions ?? []), big.sessionId]
    chat.sessionId = null
    chat.forkedFrom = null
    e.forkAt = undefined
    const images = sends.flatMap((s) => s.images ?? [])
    const pending = sends.length ? `\n\n## The owner's messages the old session had not answered yet\n${sends.map((s) => s.text).join('\n\n')}` : ''
    return images.length ? { text: text + pending, images } : { text: text + pending }
  }

  /** The move could not be made: the chat keeps the error state, said once and notified. */
  private moveFailed(e: Entry, rt: ChatRuntime, text: string): void {
    const chat = e.chat
    this.systemLine(chat.id, 'move-failed', 'warn', text)
    this.fail(e, { message: text, cause: 'move_failed' })
    rt.rearmLimit()
    chat.lastError = text
    this.emitEvent({ type: 'notify', chatId: chat.id, reason: 'error', title: chat.title, body: text })
    this.changed(chat)
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
      this.store.saveChats(this.stored())
      this.matchWorkers(e.chat, this.bridge.lastWorkers())
      this.emitEvent({ type: 'chat.upsert', chat: { ...e.chat } })
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

  private answer(id: string, kind: string, requestId: string, fn: (rt: ChatRuntime) => void): void {
    const e = this.entry(id)
    if (!e.runtime) throw new ChatError(404, `no pending ${kind} request ${requestId}: the chat is not running`)
    try {
      fn(e.runtime)
    } catch (err) {
      // A form answer its fields refuse is the caller's to fix; anything else means no such open request.
      if (err instanceof ElicitationAnswerError || err instanceof QuestionPictureError) throw new ChatError(400, err.message)
      throw new ChatError(404, err instanceof Error ? err.message : String(err))
    }
  }

  private changed(chat: ChatSummary): void {
    this.store.saveChats(this.stored())
    this.emitEvent({ type: 'chat.upsert', chat: { ...chat } })
  }

  private stored(): ChatSummary[] {
    return [...this.chats.values()].map((e) => {
      if (!e.forkAt && e.ranIn === undefined && !e.pastSessions && e.workerCwd === undefined) return e.chat
      const record: StoredRecord = { ...e.chat }
      if (e.forkAt) record.forkAt = e.forkAt
      if (e.ranIn !== undefined) record.ranIn = e.ranIn
      if (e.pastSessions) record.pastSessions = e.pastSessions
      if (e.workerCwd !== undefined) record.workerCwd = e.workerCwd
      return record
    })
  }

  /** The account an SDK chat (an import, a fork, a chat from before CliMayte ran them) runs on: the one
   *  named, refused while signed out (it could only fail). Hydra Desk places nothing: 'auto' is the
   *  default login. */
  private async resolveAccount(accountId: string): Promise<ResolvedAccount> {
    if (!accountId || accountId === 'auto' || accountId === DEFAULT_ACCOUNT.id) return { account: { ...DEFAULT_ACCOUNT }, auto: false, note: null }
    const accounts = await this.bridge.listAccounts().catch(() => [])
    const a = accounts.find((x) => x.id === accountId)
    if (!a) throw new ChatError(400, `unknown account ${accountId}: AgentHydra lists ${accounts.map((x) => x.id).join(', ') || 'no accounts'}`)
    if (!a.signedIn) throw new ChatError(409, `${a.label} is signed out`)
    return { account: accountRef(a), auto: false, note: null }
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
    this.emitEvent({ type: 'item.removed', chatId: e.chat.id, itemId: item.id })
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
    if (!configDir) return { ...DEFAULT_ACCOUNT }
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

/** The config folder the chat's process last ran under: the runtime's this run, else the stored one. */
function ranInOf(e: Entry): string | null | undefined {
  const last = e.runtime?.startedAs
  return last ? last.configDir : e.ranIn
}

function accountRef(a: AccountRef): AccountRef {
  const ref: AccountRef = { id: a.id, label: a.label, configDir: a.configDir }
  if (a.number !== undefined) ref.number = a.number
  return ref
}

const LIVE_STATUSES = new Set<ChatSummary['status']>(['starting', 'working', 'needs_you'])

/** The account a worker runs on now, as a chat shows it ('#68'). */
function workerAccount(w: AhWorker): AccountRef {
  const label = workerAccountLabel(w) ?? (w.accountId as string)
  const num = /^#(\d+)$/.exec(label)
  return { id: w.accountId as string, label, configDir: null, ...(num ? { number: Number(num[1]) } : {}) }
}

/** A CliMayte worker's status as a chat's: queued and waiting are starting, running and checking are working. A waiting
 *  worker's activity is CliMayte's reason ("Every eligible account is at its usage limit ...; the first frees up at
 *  ..."), so the chat says what it waits for instead of "Starting…" for half an hour. */
export function workerChatStatus(w: Pick<AhWorker, 'status' | 'lastActivity' | 'waitUntil' | 'notBefore'> & { error?: string | null }): {
  status: ChatSummary['status']
  activity: string | null
  waiting: ChatWait | null
} {
  switch (w.status) {
    case 'queued': {
      // In line, no account picked yet: the chat is waiting, not booting. A hold time, when AgentHydra gives one, is when.
      const until = typeof w.notBefore === 'number' && w.notBefore > 0 ? w.notBefore : null
      return { status: 'starting', activity: 'Queued', waiting: { reason: 'In line for an account.', until } }
    }
    case 'waiting': {
      const reason = plainReason(w.error) || 'Waiting for an account.'
      const until = w.waitUntil ? Date.parse(w.waitUntil) : Number.NaN
      return {
        status: 'starting',
        activity: !w.error ? 'Waiting for an account' : /^waiting\b/i.test(w.error) ? w.error : `Waiting for an account: ${w.error}`,
        waiting: { reason, until: Number.isFinite(until) ? until : null },
      }
    }
    case 'running':
      return { status: 'working', activity: w.lastActivity, waiting: null }
    case 'checking':
      return { status: 'working', activity: 'Running its check', waiting: null }
    case 'failed':
      return { status: 'error', activity: null, waiting: null }
    case 'cancelled':
      return { status: 'stopped', activity: null, waiting: null }
    default:
      return { status: 'idle', activity: null, waiting: null }
  }
}

/** CliMayte's reason for a wait as the window shows it: one line, no account addresses. */
function plainReason(error: string | null | undefined): string {
  return (error ?? '').replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, 'an account').replace(/\s+/g, ' ').trim()
}

const forkTitle = (title: string): string => `${title} (fork)`

/** Where a fork at one of the owner's messages resumes (findCut). */
interface Cut {
  sessionId: string
  /** The entry before the message; null when it opened the session (the fork starts fresh). */
  cut: string | null
  /** The config folder of the file it was found in (null = the default ~/.claude): the fork's first start copies the session from there. */
  configDir: string | null
}

const CUT_NOT_FOUND = 'Could not find this message in its session file, so there is no telling where the fork would start.'
const UNDO_NOT_FOUND = 'Could not find this message in its session file, so there is no telling where the chat would go back to.'

/** A saved record as the manager holds it: a fork's cut, the folder it last ran in and its past sessions off the summary. */
function entryOf(stored: StoredRecord): Entry {
  const { forkAt, ranIn, pastSessions, workerCwd, ...chat } = stored
  return {
    chat,
    runtime: null,
    query: null,
    forkAt: typeof forkAt === 'string' ? forkAt : undefined,
    ranIn: typeof ranIn === 'string' || ranIn === null ? ranIn : undefined,
    pastSessions: Array.isArray(pastSessions) ? pastSessions.filter((x): x is string => typeof x === 'string') : undefined,
    workerCwd: typeof workerCwd === 'string' ? workerCwd : undefined,
  }
}

/** Copies the pictures a Desk file names (/api/media/<sha256>.<ext>, content-addressed) that `to` does not have. */
function copyMedia(text: string, from: string, to: string): void {
  const names = new Set([...text.matchAll(/\/api\/media\/([0-9a-f]{64}\.[a-z0-9]+)/g)].map((m) => m[1]!))
  if (!names.size) return
  mkdirSync(to, { recursive: true })
  for (const name of names) {
    const src = join(from, name)
    if (existsSync(src) && !existsSync(join(to, name))) copyFileSync(src, join(to, name))
  }
}

/** A request item no runtime can answer any more (copied into a fork, or left by a dead process) is expired. */
function settled(item: TranscriptItem): TranscriptItem {
  if ((item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan' || item.kind === 'elicitation') && item.state === 'pending') return { ...item, state: 'expired' }
  return item
}

/** What a task item settled by Hydra Desk says: the session that ran it is gone, so is the task. */
export const TASK_SESSION_ENDED = 'Stopped: the session that started it ended.'

/**
 * A task still 'running' whose session ended, settled 'stopped' with TASK_SESSION_ENDED; `at` (when the end was
 * seen) gives its duration. A long-lived one (a local server, long-lived.ts) is left as it is, and so is the rest.
 */
export function endedTask(item: TranscriptItem, at?: number): TranscriptItem {
  if (item.kind !== 'task' || item.status !== 'running' || isLongLived(item)) return item
  return { ...item, status: 'stopped', summary: TASK_SESSION_ENDED, ...(at !== undefined ? { durationMs: Math.max(0, at - item.ts) } : {}) }
}

const sameFolder = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

const isFolder = (p: string): boolean => existsSync(p) && statSync(p).isDirectory()

export function checkCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new ChatError(400, `cwd must be an absolute path, got ${JSON.stringify(cwd)}`)
  const full = resolve(cwd)
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new ChatError(400, `the folder ${full} does not exist`)
  return full
}

// Input validation for the routes: each returns the parsed body or throws ChatError(400) with the reason.

export type Json = Record<string, unknown>

export function obj(body: unknown): Json {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError(400, 'the body must be a JSON object')
  return body as Json
}

export function optString(b: Json, key: string): string | undefined {
  const v = b[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new ChatError(400, `${key} must be a string`)
  return v
}

export function optBool(b: Json, key: string): boolean | undefined {
  const v = b[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ChatError(400, `${key} must be true or false`)
  return v
}

function optNullableString(b: Json, key: string): string | null | undefined {
  const v = b[key]
  if (v === undefined || v === null) return v as null | undefined
  if (typeof v !== 'string') throw new ChatError(400, `${key} must be a string or null`)
  return v
}

function optEffort(b: Json): Effort | null | undefined {
  const v = b.effort
  if (v === undefined || v === null) return v as null | undefined
  if (!EFFORTS.includes(v as Effort)) throw new ChatError(400, `effort must be one of ${EFFORTS.join(', ')} or null`)
  return v as Effort
}

function optMode(b: Json): PermissionMode | undefined {
  const v = b.permissionMode
  if (v === undefined) return undefined
  if (!MODES.includes(v as PermissionMode)) throw new ChatError(400, `permissionMode must be one of ${MODES.join(', ')}`)
  return v as PermissionMode
}

function optImages(b: Json): ImageRef[] | undefined {
  const v = b.images
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ChatError(400, 'images must be an array')
  return v.map((img, i) => {
    if (!img || typeof img !== 'object') throw new ChatError(400, `images[${i}] must be an object`)
    const o = img as Json
    if (typeof o.mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(o.mediaType))
      throw new ChatError(400, `images[${i}].mediaType must be image/png, image/jpeg, image/gif or image/webp`)
    if (o.dataBase64 !== undefined && typeof o.dataBase64 !== 'string') throw new ChatError(400, `images[${i}].dataBase64 must be a string`)
    const ref: ImageRef = { mediaType: o.mediaType }
    if (typeof o.dataBase64 === 'string') ref.dataBase64 = o.dataBase64
    if (typeof o.name === 'string') ref.name = o.name
    return ref
  })
}

export function parseCreate(body: unknown): CreateChatRequest {
  const b = obj(body)
  const cwd = optString(b, 'cwd')
  if (!cwd?.trim()) throw new ChatError(400, 'cwd is required')
  const req: CreateChatRequest = { cwd }
  const prompt = optString(b, 'prompt')
  if (prompt !== undefined) req.prompt = prompt
  const images = optImages(b)
  if (images) req.images = images
  const title = optString(b, 'title')
  if (title !== undefined) req.title = title
  const accountId = optString(b, 'accountId')
  if (accountId !== undefined) req.accountId = accountId
  const model = optNullableString(b, 'model')
  if (model !== undefined) req.model = model
  const effort = optEffort(b)
  if (effort !== undefined) req.effort = effort
  const mode = optMode(b)
  if (mode) req.permissionMode = mode
  const delegate = optBool(b, 'delegateToCliMayte')
  if (delegate !== undefined) req.delegateToCliMayte = delegate
  return req
}

export function parseSend(body: unknown): { text: string; images?: ImageRef[] } {
  const b = obj(body)
  const text = optString(b, 'text') ?? ''
  const images = optImages(b)
  if (!text.trim() && !images?.length) throw new ChatError(400, 'text is required')
  return images ? { text, images } : { text }
}

export function parsePermission(body: unknown): PermissionDecision {
  const b = obj(body)
  if (b.decision !== 'allow' && b.decision !== 'session' && b.decision !== 'always' && b.decision !== 'deny')
    throw new ChatError(400, 'decision must be allow, session, always or deny')
  const d: PermissionDecision = { decision: b.decision }
  const message = optString(b, 'message')
  if (message !== undefined) d.message = message
  return d
}

export function parseQuestion(body: unknown): QuestionAnswer {
  const b = obj(body)
  const skip = optBool(b, 'skip')
  if (skip) return { skip: true }
  const answers = b.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ChatError(400, 'answers (question -> answer) or skip: true is required')
  for (const [k, v] of Object.entries(answers)) if (typeof v !== 'string') throw new ChatError(400, `the answer to ${JSON.stringify(k)} must be a string`)
  const out: QuestionAnswer = { answers: answers as Record<string, string> }
  const pictures = b.images
  if (pictures !== undefined) {
    if (!pictures || typeof pictures !== 'object' || Array.isArray(pictures)) throw new ChatError(400, 'images (question -> pictures) must be an object')
    out.images = {}
    for (const [k, v] of Object.entries(pictures)) out.images[k] = optImages({ images: v }) ?? []
  }
  return out
}

export function parsePlan(body: unknown): PlanDecision {
  const b = obj(body)
  const approve = optBool(b, 'approve')
  if (approve === undefined) throw new ChatError(400, 'approve (true or false) is required')
  const d: PlanDecision = { approve }
  const feedback = optString(b, 'feedback')
  if (feedback !== undefined) d.feedback = feedback
  const mode = optMode(b)
  if (mode) d.mode = mode
  return d
}

/** The shape only: the values are checked against the request's own form fields when it is answered. */
export function parseElicitation(body: unknown): ElicitationAnswer {
  const b = obj(body)
  if (b.action !== 'accept' && b.action !== 'decline') throw new ChatError(400, 'action must be accept or decline')
  const a: ElicitationAnswer = { action: b.action }
  if (b.values === undefined) return a
  if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new ChatError(400, 'values must be an object (field name -> value)')
  a.values = b.values as ElicitationAnswer['values']
  return a
}

const GROUP_MAX = 60

/** A sidebar group name: trimmed, 1-60 chars, or null (back to the folder's group). */
function optGroup(b: Json): string | null | undefined {
  const v = optNullableString(b, 'group')
  if (v === undefined || v === null) return v
  const name = v.trim()
  if (!name || name.length > GROUP_MAX) throw new ChatError(400, `group must be 1-${GROUP_MAX} characters or null`)
  return name
}

const PATCH_KEYS = ['title', 'pinned', 'archived', 'unread', 'model', 'effort', 'permissionMode', 'delegateToCliMayte', 'accountId', 'group', 'cwd']

/** POST /api/chats/import-desk: `ids`, the chats to copy (every one when absent). */
export function parseImportDesk(body: unknown): { ids?: string[] } {
  const b = body === undefined || body === null ? {} : obj(body)
  if (b.ids === undefined) return {}
  if (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== 'string')) throw new ChatError(400, 'ids must be a list of chat ids')
  return { ids: b.ids as string[] }
}

export function parsePatch(body: unknown): ChatPatch {
  const b = obj(body)
  const unknown = Object.keys(b).filter((k) => !PATCH_KEYS.includes(k))
  if (unknown.length) throw new ChatError(400, `cannot change ${unknown.join(', ')}; a patch takes ${PATCH_KEYS.join(', ')}`)
  const p: ChatPatch = {}
  const title = optString(b, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new ChatError(400, 'title cannot be empty')
    p.title = title
  }
  for (const k of ['pinned', 'archived', 'unread', 'delegateToCliMayte'] as const) {
    const v = optBool(b, k)
    if (v !== undefined) p[k] = v
  }
  const model = optNullableString(b, 'model')
  if (model !== undefined) p.model = model
  const effort = optEffort(b)
  if (effort !== undefined) p.effort = effort
  const mode = optMode(b)
  if (mode) p.permissionMode = mode
  const accountId = optString(b, 'accountId')
  if (accountId !== undefined) {
    if (!accountId.trim()) throw new ChatError(400, 'accountId cannot be empty')
    p.accountId = accountId
  }
  const group = optGroup(b)
  if (group !== undefined) p.group = group
  const cwd = optString(b, 'cwd')
  if (cwd !== undefined) {
    if (isUncOrDevicePath(cwd)) throw new ChatError(400, `cwd must be a local folder, not a share or device path: ${JSON.stringify(cwd)}`)
    p.cwd = checkCwd(cwd)
  }
  return p
}

const META_KEYS = ['title', 'pinned', 'archived', 'unread', 'group']

/** The marks on an outside session; a null or empty title goes back to the session's own. */
export function parseSessionMeta(body: unknown): SessionMetaPatch {
  const b = obj(body)
  const unknown = Object.keys(b).filter((k) => !META_KEYS.includes(k))
  if (unknown.length) throw new ChatError(400, `cannot change ${unknown.join(', ')}; the marks are ${META_KEYS.join(', ')}`)
  const p: SessionMetaPatch = {}
  const title = optNullableString(b, 'title')
  if (title !== undefined) p.title = title?.trim().slice(0, 200) || null
  for (const k of ['pinned', 'archived', 'unread'] as const) {
    const v = optBool(b, k)
    if (v !== undefined) p[k] = v
  }
  const group = optGroup(b)
  if (group !== undefined) p.group = group
  return p
}

export function parseImport(body: unknown): ImportSessionRequest {
  const b = obj(body)
  const sessionId = optString(b, 'sessionId')
  if (!sessionId?.trim()) throw new ChatError(400, 'sessionId is required')
  const req: ImportSessionRequest = { sessionId: sessionId.trim() }
  const cwd = optString(b, 'cwd')
  if (cwd !== undefined) req.cwd = cwd
  const configDir = optNullableString(b, 'configDir')
  if (configDir !== undefined) req.configDir = configDir
  const title = optString(b, 'title')
  if (title !== undefined) req.title = title
  const fork = optBool(b, 'fork')
  if (fork !== undefined) req.fork = fork
  const at = optString(b, 'at')
  if (at?.trim()) req.at = at.trim()
  return req
}

/** Send now's request: the bubble's item id, when one is given. */
export function parseSendNow(body: unknown): SendNowRequest {
  const itemId = optString(obj(body), 'itemId')
  return itemId?.trim() ? { itemId: itemId.trim() } : {}
}

/** A fork's request: an empty body forks the whole chat. */
export function parseFork(body: unknown): ForkChatRequest {
  const at = optString(obj(body), 'at')
  return at?.trim() ? { at: at.trim() } : {}
}

/** Undo's request: the owner's message the chat goes back to before. */
export function parseRewind(body: unknown): RewindChatRequest {
  const at = optString(obj(body), 'at')?.trim()
  if (!at) throw new ChatError(400, 'at (the id of your message to undo) is required')
  return { at }
}
