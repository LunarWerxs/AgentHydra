// The babysitter's judgment (shared/babysitter.ts says what it is for). Pure: the plugin (plugins/72-babysitter.ts)
// reads Desk's chats, the outside sessions and the send queue, this decides, and the plugin sends.
//
// WHICH CHATS. A Desk chat whose status is 'limited' (the engine could not carry it to another account), and a Claude
// Desktop or CLI session whose transcript ends at a usage-limit notice nothing followed (ExternalSession.limit, from
// AgentHydra's limit_stop). The index behind an outside session reaches back a day, and a weekly limit can last
// longer, so a stop once seen is remembered until its session moves on (its last activity passes the stop) or leaves
// the list; Codex, CliMayte workers (CliMayte waits for an account itself) and the other PC's chats are left out.
//
// WHEN. Once its limit has reset (the reset the notice or the engine named, plus a minute for the window to roll), or
// five hours after the stop when none was named, which is as long as the window lasts. A Desk chat on auto also goes
// as soon as some signed-in account has room: the engine moves it there.
//
// HOW MANY TIMES. Each continue counts. A chat that then works and stops again well after (QUICK_MS) starts its count
// again; one that stops at once after MAX_TRIES continues in a row is left to a person. A continue the chat has not
// moved on from within SETTLE_MS counts as not taken and is sent again.

import type { AccountInfo, ChatSummary, ExternalSession } from '@shared/protocol'
import type { BabysitterChat, BabysitterChatState, BabysitterSource } from '@shared/babysitter'
import { BABYSITTER_FROM } from '@shared/babysitter'

/** A limit window's longest span: an unnamed reset is looked at this long after the stop. */
export const FIVE_HOURS_MS = 5 * 60 * 60_000
/** Wait this long past a named reset before continuing, for the window to roll over. */
export const RESET_BUFFER_MS = 60_000
/** A stop this soon after a continue means the continue did no real work. */
export const QUICK_MS = 10 * 60_000
/** A continue that has not moved its chat within this long is taken as not delivered. */
export const SETTLE_MS = 10 * 60_000
/** Continues in a row that each stopped again at once before the chat is left to a person. */
export const MAX_TRIES = 3
/** A chat with no stop and nothing sent for this long is forgotten. */
export const FORGET_MS = 24 * 60 * 60_000
/** An outside session whose last activity is this far past its stop has moved on. */
const MOVED_ON_MS = 60_000

/** One stopped chat as the babysitter remembers it between looks. */
export interface Tracked {
  title: string
  cwd: string
  source: BabysitterSource
  account: string
  session: string | null
  notice: string | null
  /** The stop it is at, ms; null once the chat moved on (kept for its count). */
  stoppedAt: number | null
  resetsAt: number | null
  tries: number
  lastResumeAt: number | null
  /** The stop it gave up on, so a later stop is looked at afresh. */
  gaveUpOn: number | null
  state: BabysitterChatState
  reason: string
}

export type Memory = Record<string, Tracked>

/** What one look read. A null list did not load: the chats it would have held are neither judged nor forgotten. */
export interface Look {
  own: ChatSummary[] | null
  outside: ExternalSession[] | null
  accounts: AccountInfo[] | null
  /** Desk chats a message already waits for in the send queue: the queue takes those up itself. */
  queued: ReadonlySet<string>
  now: number
}

export type Act = { id: string; kind: 'resume'; text: string } | { id: string; kind: 'give-up' }

export interface Decision {
  memory: Memory
  acts: Act[]
  /** When a waiting chat falls due next, ms, or null. */
  nextDueAt: number | null
}

/** The message that continues a stopped chat; Desk shows it as a note from the babysitter. */
export function continueText(): string {
  return `[${BABYSITTER_FROM}] Not from the user.\nYour account's usage limit stopped your last turn, and the limit has reset. Continue the task exactly where you left off. Do not redo steps that are already finished.`
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** A Desk chat's account's reset: the later of its windows that are full, or null when none is. */
function accountReset(accounts: readonly AccountInfo[] | null, id: string): number | null {
  const a = accounts?.find((x) => x.id === id)
  if (!a) return null
  const full = [
    (a.fiveHourPct ?? 0) >= 100 ? a.fiveHourResetsAt : null,
    (a.weeklyPct ?? 0) >= 100 ? a.weeklyResetsAt : null,
  ].filter((t): t is number => t !== null)
  return full.length ? Math.max(...full) : null
}

/** Some signed-in account under both limits: a Desk chat on auto is moved there by the engine (chat-manager pickHealthy). */
function someRoom(accounts: readonly AccountInfo[] | null): boolean {
  return (accounts ?? []).some((a) => a.signedIn && (a.fiveHourPct ?? 0) < 100 && (a.weeklyPct ?? 0) < 100)
}

interface Stop {
  id: string
  base: Omit<Tracked, 'stoppedAt' | 'tries' | 'lastResumeAt' | 'gaveUpOn' | 'state' | 'reason'>
  stoppedAt: number
  /** Due now whatever the reset says (a Desk chat on auto with an account that has room). */
  roomNow: boolean
}

/** This look's stops. */
function stopsOf(look: Look, memory: Memory): Stop[] {
  const stops: Stop[] = []
  for (const c of look.own ?? []) {
    if (c.archived || c.status !== 'limited') continue
    // A Desk chat records no moment for its stop: the first look that saw it limited keeps the one it saw, unless the
    // chat changed after both that stop and the last continue (it ran and stopped again between two looks, or a person
    // sent in it or moved it to another account, which also lets a chat given up on be looked at afresh).
    const prior = memory[c.id]
    const again = prior?.stoppedAt != null && c.updatedAt > Math.max(prior.stoppedAt, prior.lastResumeAt ?? 0)
    const known = again ? null : prior?.stoppedAt
    stops.push({
      id: c.id,
      base: {
        title: c.title,
        cwd: c.cwd,
        source: 'desk',
        account: c.account.label,
        session: c.sessionId,
        notice: c.lastError,
        resetsAt: c.limitResetsAt ?? accountReset(look.accounts, c.account.id),
      },
      stoppedAt: known ?? c.updatedAt,
      roomNow: c.accountAuto && someRoom(look.accounts),
    })
  }
  for (const s of look.outside ?? []) {
    if ((s.source !== 'desktop' && s.source !== 'cli') || s.archived || s.fromPc) continue
    const kept = memory[s.id]
    const limit =
      s.limit ??
      // The index row aged out; the stop stands while the session has not moved on from it.
      (kept?.stoppedAt != null && (s.lastActivityAt ?? 0) <= kept.stoppedAt + MOVED_ON_MS
        ? { notice: kept.notice ?? '', at: kept.stoppedAt, resetsAt: kept.resetsAt }
        : null)
    if (!limit) continue
    stops.push({
      id: s.id,
      base: { title: s.title, cwd: s.cwd ?? '', source: s.source, account: s.instance ?? '', session: s.id, notice: limit.notice || null, resetsAt: limit.resetsAt },
      stoppedAt: limit.at,
      roomNow: false,
    })
  }
  return stops
}

/** This look's judgment over every stopped chat, the acts to carry out, and the memory for the next look. */
export function decide(look: Look, memory: Memory): Decision {
  const { now } = look
  const next: Memory = {}
  const acts: Act[] = []
  let nextDueAt: number | null = null
  const stops = stopsOf(look, memory)
  const stopped = new Set(stops.map((s) => s.id))

  for (const stop of stops) {
    const prior = memory[stop.id]
    let tries = prior?.tries ?? 0
    const lastResumeAt = prior?.lastResumeAt ?? null
    // A new stop well after the last continue: the chat did real work in between, so its count starts again.
    if (prior?.stoppedAt !== stop.stoppedAt && lastResumeAt !== null && stop.stoppedAt - lastResumeAt >= QUICK_MS) tries = 0
    const t: Tracked = { ...stop.base, stoppedAt: stop.stoppedAt, tries, lastResumeAt, gaveUpOn: prior?.gaveUpOn ?? null, state: 'waiting', reason: '' }
    next[stop.id] = t

    if (t.gaveUpOn === stop.stoppedAt) {
      Object.assign(t, { state: 'gave-up', reason: prior?.reason ?? `continued ${tries} times in a row and it stopped again each time: left to a person` })
      continue
    }
    if (lastResumeAt !== null && lastResumeAt >= stop.stoppedAt && now - lastResumeAt < SETTLE_MS) {
      Object.assign(t, { state: 'resumed', reason: `continued at ${time(lastResumeAt)}; waiting for it to move` })
      continue
    }
    if (stop.base.source === 'cli') {
      Object.assign(t, { state: 'no-engine', reason: 'a terminal session: only its own terminal can continue it' })
      continue
    }
    const dueAt = stop.roomNow ? now : (stop.base.resetsAt ?? stop.stoppedAt + FIVE_HOURS_MS) + RESET_BUFFER_MS
    if (now < dueAt) {
      nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt)
      Object.assign(t, {
        state: 'waiting',
        reason: stop.base.resetsAt !== null ? `its limit resets at ${time(stop.base.resetsAt)}` : `no reset was named; looked at again at ${time(dueAt)}`,
      })
      continue
    }
    if (stop.base.source === 'desk' && look.queued.has(stop.id)) {
      Object.assign(t, { state: 'waiting', reason: 'a message already waits for it in the send queue' })
      continue
    }
    if (tries >= MAX_TRIES) {
      Object.assign(t, { state: 'gave-up', gaveUpOn: stop.stoppedAt, reason: `continued ${tries} times in a row and it stopped again each time: left to a person` })
      acts.push({ id: stop.id, kind: 'give-up' })
      continue
    }
    // Carried out by the plugin, which records how it went (carried()).
    Object.assign(t, { reason: 'its limit has reset: continuing it' })
    acts.push({ id: stop.id, kind: 'resume', text: continueText() })
  }

  // The chats no longer at a stop. One a list that did not load would have held is kept as it was. One that moved on
  // is kept, off the list, while a continue is recent enough to tell a quick stop again; the rest are forgotten.
  for (const [id, t] of Object.entries(memory)) {
    if (stopped.has(id)) continue
    if ((t.source === 'desk' && look.own === null) || (t.source !== 'desk' && look.outside === null)) next[id] = t
    else if (t.lastResumeAt !== null && now - t.lastResumeAt < FORGET_MS) next[id] = { ...t, stoppedAt: null, state: 'resumed', reason: 'moved on' }
  }
  return { memory: next, acts, nextDueAt }
}

/** The memory after one act was carried out: `ok`, or refused for want of anything running the chat, or failed. */
export function carried(t: Tracked, outcome: 'ok' | 'no-engine' | 'failed', detail: string, now: number): Tracked {
  if (outcome === 'ok') return { ...t, tries: t.tries + 1, lastResumeAt: now, state: 'resumed', reason: `continued at ${time(now)}; waiting for it to move` }
  if (outcome === 'no-engine') return { ...t, state: 'no-engine', reason: `its limit has reset, but nothing runs it to take a message (${detail}); looked at again` }
  return { ...t, tries: t.tries + 1, state: 'failed', reason: `the continue was refused: ${detail}` }
}

/** The stopped chats as GET /api/babysitter shows them, soonest reset first. */
export function shown(memory: Memory): BabysitterChat[] {
  return Object.entries(memory)
    .filter(([, t]) => t.stoppedAt !== null)
    .map(([id, t]) => ({
      id,
      session: t.session,
      title: t.title,
      cwd: t.cwd,
      source: t.source,
      account: t.account,
      stoppedAt: t.stoppedAt as number,
      notice: t.notice,
      resetsAt: t.resetsAt,
      state: t.state,
      reason: t.reason,
      tries: t.tries,
    }))
    .sort((a, b) => (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY) || a.stoppedAt - b.stoppedAt)
}
