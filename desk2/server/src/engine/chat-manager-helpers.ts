// The module-level helper functions of ChatManager (chat-manager.ts), moved out for its size. None uses `this`.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AccountInfo, AccountRef, ChatSummary, CliMayteWorker, ImportSessionRequest, TranscriptItem } from '@shared/protocol'
import { titleFrom } from '@shared/chat-title'
import { retryItemsOf } from './send-retry'
import { withoutNamedLines } from './system-text'
import { IMPORT_TITLE, type Entry, type RetryPace, type StoredRecord, type UserItem } from './chat-manager-types'

/** A turn runs or is about to: ChatRuntime.send queues a message behind it (the same test). */
export const busy = (c: ChatSummary): boolean => c.status === 'working' || c.status === 'needs_you' || (c.status === 'starting' && c.turnStartedAt !== null)

/** What an item is remembered as in Entry.emitted: a 64-bit hash of its JSON, not the JSON itself. */
export const signature = (item: TranscriptItem): string => String(Bun.hash(JSON.stringify(item)))

/** A short hash of what matching workers to chats reads from the worker list (workersOfChat, activeness). */
export function workersKey(workers: readonly CliMayteWorker[]): string {
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

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The stand-in a worker's own copy of a sent message replaces: the one with its text, else the oldest sent before it
 *  that is not `held` (still being sent again: AgentHydra may not have it, so another message's copy is not its own). */
export function standInFor(sent: UserItem[], real: UserItem, held?: ReadonlySet<string>): number {
  const text = squash(real.text)
  const same = sent.findIndex((s) => text.includes(squash(withoutNamedLines(s.text))))
  return same >= 0 ? same : sent.findIndex((s) => s.ts <= real.ts + 60_000 && !held?.has(s.id))
}

/** Every stand-in a worker's copy replaces: messages that reach a busy CLI together come back as one user record, their
 *  texts joined, so each stand-in whose text it holds goes, each text used once. With none, standInFor's one. */
export function standInsFor(sent: UserItem[], real: UserItem, held?: ReadonlySet<string>): number[] {
  let rest = squash(real.text)
  const out: number[] = []
  sent.forEach((s, i) => {
    const text = squash(withoutNamedLines(s.text))
    const at = rest.indexOf(text)
    if (at < 0 || (out.length && !text)) return
    out.push(i)
    rest = rest.slice(0, at) + rest.slice(at + text.length)
  })
  if (out.length) return out
  const i = standInFor(sent, real, held)
  return i >= 0 ? [i] : []
}

/** An imported session's title. One nobody named (no title, or only its first words) is named from its first message, as a new chat is. */
export function importTitle(req: ImportSessionRequest, items: TranscriptItem[], kept: string | null | undefined, listed: string | undefined): { title: string; generate: boolean; firstAsk: string | undefined } {
  const firstAsk = items.find((i): i is UserItem => i.kind === 'user' && !!i.text.trim())?.text
  const named = !!req.title?.trim() || !!kept?.trim()
  const words = firstAsk ? titleFrom(firstAsk) : null
  const generate = !req.fork && !named && !!firstAsk && (!listed?.trim() || listed.trim() === words)
  const title = req.title?.trim() || listed?.trim() || words || IMPORT_TITLE
  return { title, generate, firstAsk }
}

/** '#126' for a numbered account, else its label. */
export const accountName = (a: AccountRef): string => (a.number !== undefined ? `#${a.number}` : a.label)

/** Doubles the wait before the next try, from firstMs up to maxMs. */
export function retryLater(pace: RetryPace): void {
  pace.wait = Math.min(Math.max(pace.wait * 2, pace.firstMs), pace.maxMs)
}

/** The config folder the chat's process last ran under: the runtime's this run, else the stored one. */
export function ranInOf(e: Entry): string | null | undefined {
  const last = e.runtime?.startedAs
  return last ? last.configDir : e.ranIn
}

export function accountRef(a: AccountRef): AccountRef {
  const ref: AccountRef = { id: a.id, label: a.label, configDir: a.configDir }
  if (a.number !== undefined) ref.number = a.number
  return ref
}

export const forkTitle = (title: string): string => `${title} (fork)`

/** A saved record as the manager holds it: a fork's cut, the folder it last ran in and its past sessions off the summary. */
export function entryOf(stored: StoredRecord): Entry {
  const { forkAt, ranIn, pastSessions, workerCwd, sent, retrying, ...chat } = stored
  return {
    chat,
    runtime: null,
    query: null,
    forkAt: typeof forkAt === 'string' ? forkAt : undefined,
    ranIn: typeof ranIn === 'string' || ranIn === null ? ranIn : undefined,
    pastSessions: Array.isArray(pastSessions) ? pastSessions.filter((x): x is string => typeof x === 'string') : undefined,
    workerCwd: typeof workerCwd === 'string' ? workerCwd : undefined,
    sent: Array.isArray(sent) && sent.length ? (sent as UserItem[]) : undefined,
    retrying: retryItemsOf(retrying),
  }
}

export const sameFolder = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

export const isFolder = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false
