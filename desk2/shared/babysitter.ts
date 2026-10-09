// The babysitter (owner, 2026-10-08: "every five minutes ... check if ... Claude hit its limit while there were
// threads running ... how many? Which ones? When does it reset? ... when the limit is lifted ... go resume all of the
// paused ones"). Every EVERY_MS it looks at Desk's own chats and the Claude Desktop and CLI sessions AgentHydra
// knows, lists each one a usage limit stopped mid-work, and once that limit has reset it continues the chat: a Desk
// chat through Desk's send queue, an outside one over its own input channel (never typed into a window). No model is
// asked and no account is touched to look. The server keeps it (server/src/plugins/72-babysitter.ts, deciding in
// server/src/babysitter/decide.ts); GET /api/babysitter answers what it saw last, Settings > Babysitter draws it, and
// AgentHydra's MCP tool `babysitter` reads the same answer. Plain types only.

/** How often it looks. A reset it knows of is also looked at as soon as it passes. */
export const BABYSITTER_EVERY_MS = 5 * 60_000

/** Who its messages are from: Desk shows a message that opens "[<from>] Not from the user." as a note from it. */
export const BABYSITTER_FROM = 'AgentHydra · babysitter'

/** Which app runs a stopped chat: Desk itself, or an outside session (ExternalSession.source). */
export type BabysitterSource = 'desk' | 'desktop' | 'cli'

/**
 * Where a stopped chat stands:
 * waiting   its limit has not reset yet
 * resumed   continued after its reset; waiting for the chat to move
 * no-engine its limit reset, but nothing runs the chat to take a message (its app is closed); looked at again
 * gave-up   it stopped again right after each of the last MAX_TRIES continues: left to a person
 * failed    the last continue was refused; looked at again
 */
export type BabysitterChatState = 'waiting' | 'resumed' | 'no-engine' | 'gave-up' | 'failed'

export interface BabysitterChat {
  id: string // a Desk chat id, or an outside session's id
  session: string | null // its Claude session id, when known
  title: string
  cwd: string
  source: BabysitterSource
  account: string // the account's label (Desk) or instance (outside)
  stoppedAt: number // when the limit stopped it, ms
  notice: string | null // the CLI's own words, e.g. "You've hit your session limit · resets 11:40pm (America/Chicago)"
  /** When its limit resets, ms; null when nothing said (it is then looked at five hours after the stop). */
  resetsAt: number | null
  state: BabysitterChatState
  reason: string
  /** Continues sent since it last did real work (a stop well after the last continue). */
  tries: number
}

/** One account a limit stopped chats on. */
export interface BabysitterAccount {
  account: string
  stopped: number
  /** The soonest reset among its stopped chats, ms, or null when none is known. */
  resetsAt: number | null
  firstStoppedAt: number
}

export interface BabysitterAct {
  at: number
  id: string
  title: string
  account: string
  source: BabysitterSource
  did: 'resumed' | 'gave-up' | 'failed' | 'no-engine'
  detail: string
}

/** GET /api/babysitter. */
export interface BabysitterStatus {
  enabled: boolean
  everyMs: number
  checkedAt: number | null
  /** When it looks next (sooner than everyMs when a known reset passes first). It looks while off too, sending nothing. */
  nextCheckAt: number | null
  /** The chats a usage limit stopped, soonest reset first. */
  stopped: BabysitterChat[]
  /** The same chats by account, soonest reset first. */
  accounts: BabysitterAccount[]
  /** What it did, newest first. */
  acts: BabysitterAct[]
  /** Why the last look saw less than everything (Desk's chats or AgentHydra's sessions did not load), or null. */
  error: string | null
}

/** POST /api/babysitter: turn it on or off (saved in Settings), and/or look now. */
export interface BabysitterRequest {
  enabled?: boolean
  check?: boolean
}
