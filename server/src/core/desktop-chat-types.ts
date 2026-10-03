// server/src/core/desktop-chat-types.ts — the contract between desktop chat sync's two halves
// (owner, 2026-10-02: "sync all desktop instance chats/threads ... Compressed. To save on data.
// Making sure. We keep track of which computer it came from."):
//   desktop-chat-sync.ts   the store side: what to send and fetch through the login sync's store
//                          (cloud/login-sync-worker, `chats` rows and `chat_chunks`), sealed by
//                          chat-sync-codec.ts (zstd, then AES-256-GCM under the sync key).
//   desktop-chat-local.ts  this PC's side: which desktop chats render here, their transcripts,
//                          and landing a chat another PC shared.
// cli-login-sync.ts runs a chat pass beside the logins when the "Sync desktop chats" box is on.

/** One desktop chat on this PC, as the sync sees it. */
export interface LocalChat {
  /** The desktop record's id: its file is `local_<id>.json`. A UUID. */
  id: string
  /** The CLI session its transcript is filed under (`~/.claude/projects/<project>/<sessionId>.jsonl`). */
  sessionId: string
  /** The folder under `~/.claude/projects` that holds the transcript; null when none was found. */
  project: string | null
  /** The `<accountUuid>` and `<orgUuid>` folders under `claude-code-sessions` the record is filed in. */
  account: string
  org: string
  /** The record as the desktop app wrote it (title, cwd, model, isArchived, lastActivityAt, ...). */
  record: Record<string, unknown>
  archived: boolean
  /** The transcript's size in bytes now; 0 when there is none. */
  size: number
}

/** A chat another PC shared, to be shown here. */
export interface IncomingChat {
  id: string
  sessionId: string
  project: string
  account: string
  org: string
  record: Record<string, unknown>
  archived: boolean
  /** The PC it was first shared from: its sync id and its name (hostname). */
  origin: { pc: string; name: string }
}

/** `retry`: worth trying again on a later pass (the profile is closed or busy), not a dead end. */
export type LandOutcome = { ok: true } | { ok: false; reason: string; retry: boolean }

/** This PC's side of the sync (desktop-chat-local.ts; tests pass a fake). */
export interface ChatLocal {
  /** Every chat record in this PC's desktop profiles that renders for the account the profile is
   *  signed into, archived ones included. Records only: no transcript is read. */
  list(): LocalChat[]
  /** Bytes [from, to) of a transcript. */
  read(project: string, sessionId: string, from: number, to: number): Uint8Array
  /** A transcript's size in bytes now; 0 when it is absent. */
  size(project: string, sessionId: string): number
  /** Append to a transcript only while it is exactly `expected` bytes long (absent counts as 0),
   *  creating its folder when needed. False, and nothing written, when the length differs. */
  append(project: string, sessionId: string, expected: number, bytes: Uint8Array): boolean
  /** Show an incoming chat in the desktop profile signed into its account here: create it, or bring
   *  the copy already there up to its title and archive state. Never opens or launches an app. */
  land(chat: IncomingChat): Promise<LandOutcome>
}

/** What the chat pass needs from login sync. */
export interface ChatIo {
  /** One authorised request to the store; `json` is the parsed answer body (null when none). */
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>
  /** The sync's 32-byte key. */
  key: Buffer
  /** This PC's sync id (a UUID) and name. */
  pc: string
  name: string
  local: ChatLocal
  /** The JSON file where the chat pass keeps what it knows per chat between passes. */
  statePath: string
}

/** One synced chat, for the Login sync dialog. */
export interface ChatSyncRow {
  id: string
  sessionId: string
  title: string | null
  /** The PC it came from, and whether that is this one. */
  origin: { pc: string; name: string }
  fromHere: boolean
  /** Transcript bytes the store holds for it. */
  bytes: number
  /** synced: both sides agree. sending / receiving: bytes still on their way. waiting: it cannot
   *  land here yet (`note` says why). diverged: it was continued on two PCs at once, so neither
   *  side's new turns are taken until one is archived. */
  state: 'synced' | 'sending' | 'receiving' | 'waiting' | 'diverged'
  note: string | null
  /** When it last changed in the store (epoch ms). */
  at: number | null
}
