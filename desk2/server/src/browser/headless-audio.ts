// Which chats make sound through the Connections MCP's headless Chrome profiles, and the mute that silences only a
// chat's own pages. Windows only: a helper (audio-helper/) reports each audio session's peak meter; a profile is audible
// while its Chrome's audio service session peaks above zero, and the page that plays is found through the profile's
// .connections-tabs.json ledger (ownership.ts). These are the pure rules, tested on fabricated rows.

import type { ProcRow, AudioRow, ProfileSound, PageSound } from './headless-audio-types'
import { readLedger } from './ownership'

export type { ProcRow, AudioRow, ProfileSound, PageSound }

const AUDIO_SERVICE = '--utility-sub-type=audio.mojom.AudioService'

/** The profile folder a Chrome command line was started with, or null. */
export function userDataDirOf(cmd: string): string | null {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(cmd)
  return m ? (m[1] ?? m[2] ?? null) : null
}

/**
 * Every profile whose Chrome runs an audio service (silent or not), with that service's session pids and the loudest
 * peak among them. A browser process is one with no --type; its audio service is a child of it.
 */
export function profilesOf(rows: AudioRow[], procs: ProcRow[]): ProfileSound[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const peaks = new Map(rows.map((r) => [r.pid, r]))
  const out = new Map<string, ProfileSound>()
  for (const p of procs) {
    if (!p.cmd.includes(AUDIO_SERVICE)) continue
    const browser = byPid.get(p.ppid)
    const dir = browser ? userDataDirOf(browser.cmd) : null
    if (!browser || !dir) continue
    const row = peaks.get(p.pid)
    const profile = out.get(dir) ?? { dir, browserPid: browser.pid, sessionPids: [], peak: 0 }
    profile.sessionPids.push(p.pid)
    profile.peak = Math.max(profile.peak, row?.peak ?? 0)
    out.set(dir, profile)
  }
  return [...out.values()]
}

/** A session id a ledger row names: `mcp:` and `pid:` owners are never a Desk chat's. */
export function isSessionOwner(owner: string): boolean {
  return owner !== '' && !owner.startsWith('mcp:') && !owner.startsWith('pid:')
}

/**
 * The Desk chat a ledger owner belongs to: the chat with that Claude session, or for a CliMayte worker's session the
 * chat that lists the worker. Null when nobody owns it.
 */
export function chatOfOwner(owner: string | undefined, chatOfSession: (sessionId: string) => string | null): string | null {
  if (!owner || !isSessionOwner(owner)) return null
  return chatOfSession(owner)
}

/** Whether a probed page is making sound now: a playing element with volume, or a running AudioContext. */
export function pageIsAudible(p: PageSound): boolean {
  return p.audible > 0 || p.contexts > 0
}

/**
 * What a chat's mute changed, so that unmute restores exactly that. `hold` records a thing this chat silenced; a thing
 * another mute already holds is not recorded twice, and `release` returns only what this chat's mute changed.
 */
export class MuteBook {
  private readonly held = new Map<string, Set<string>>()

  hold(chat: string, thing: string): boolean {
    const set = this.held.get(chat) ?? new Set<string>()
    if (set.has(thing)) return false
    set.add(thing)
    this.held.set(chat, set)
    return true
  }

  release(chat: string): string[] {
    const set = this.held.get(chat)
    this.held.delete(chat)
    return set ? [...set] : []
  }

  holds(chat: string): string[] {
    return [...(this.held.get(chat) ?? [])]
  }
}

/** The owner of each open page of a profile: the Desk chat whose session the ledger names, else null. */
export function pageOwners(
  pageIds: string[],
  dir: string,
  chatOfSession: (sessionId: string) => string | null,
): Map<string, string | null> {
  const ledger = readLedger(dir)
  const out = new Map<string, string | null>()
  for (const id of pageIds) out.set(id, chatOfOwner(ledger.get(id)?.chat, chatOfSession))
  return out
}

/** Whether a profile's ledger names a page of one of these chats (so its pages are checked even when silent). */
export function profileHoldsChats(dir: string, chats: Set<string>, chatOfSession: (sessionId: string) => string | null): boolean {
  if (chats.size === 0) return false
  for (const row of readLedger(dir).values()) {
    const chat = chatOfOwner(row.chat, chatOfSession)
    if (chat && chats.has(chat)) return true
  }
  return false
}
