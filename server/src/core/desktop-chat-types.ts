// server/src/core/desktop-chat-types.ts — the contract between desktop chat sync's two halves
// (owner, 2026-10-02: "sync all desktop instance chats/threads ... Compressed. To save on data.
// Making sure. We keep track of which computer it came from."). VIEW ONLY since 2026-10-05 (owner:
// "I don't want them to actually sync back and forth. I just want to view the ones running on his
// computer, and he can view the ones running on mine"): each PC sends only the chats it started, and
// another PC's chats are kept in AgentHydra's viewer folder, never in a Claude Desktop chat list.
//   desktop-chat-sync.ts   the store side: what to send and fetch through the login sync's store
//                          (cloud/login-sync-worker, `chats` rows and `chat_chunks`), sealed by
//                          chat-sync-codec.ts (zstd, then AES-256-GCM under the sync key).
//   desktop-chat-local.ts  this PC's side: which desktop chats render here, their transcripts, the
//                          viewer's copies of other PCs' chats, and taking back out of the chat list
//                          a chat an earlier version landed there.
// cli-login-sync.ts runs a chat pass beside the logins when the "Sync desktop chats" box is on.

import type { StoreMirror } from './login-sync-mirror'

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

/** What became of a chat an earlier version landed in this PC's chat list. `kept`: someone here
 *  went on talking in it, so it is this PC's chat now and stays where it is. `retry`: worth trying
 *  again on a later pass (the app did not confirm the archive, the transcript was open), not a dead end. */
export type RetireOutcome =
  | { ok: true; kept: boolean }
  | { ok: false; reason: string; retry: boolean }

/** This PC's side of the sync (desktop-chat-local.ts; tests pass a fake). */
export interface ChatLocal {
  /** Every chat record in this PC's desktop profiles that renders for the account the profile is
   *  signed into, archived ones included. Records only: no transcript is read. */
  list(): LocalChat[]
  /** Bytes [from, to) of one of this PC's transcripts. */
  read(project: string, sessionId: string, from: number, to: number): Uint8Array
  /** The size of the viewer's copy of another PC's chat; 0 when there is none. */
  viewSize(project: string, sessionId: string): number
  /** Write to the viewer's copy of another PC's chat at byte `at`: 0 starts it over, anything else
   *  appends only while the copy is exactly `at` bytes long. False, and nothing written, otherwise. */
  viewWrite(project: string, sessionId: string, at: number, bytes: Uint8Array): boolean
  /** Take a chat another PC shared back out of this PC's chat list, where an earlier version landed
   *  it: archive every visible desktop copy, then move its transcript (`bytes` long, as the sync wrote
   *  it) into the viewer. A transcript grown past `bytes` was continued here and is kept. */
  retire(sessionId: string, bytes: number): Promise<RetireOutcome>
}

/** What the chat pass needs from login sync. */
export interface ChatIo {
  /** The store mirror of the pass; without one the list route is read directly. */
  mirror?: StoreMirror
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
  /** synced: both sides agree. sending / receiving: bytes still on their way. waiting: a chat an
   *  earlier version landed here is not out of this PC's chat list yet (`note` says why). diverged:
   *  under the two-way sync before 2026-10-05 it was continued on two PCs at once; it stays as it was. */
  state: 'synced' | 'sending' | 'receiving' | 'waiting' | 'diverged'
  note: string | null
  /** When it last changed in the store (epoch ms). */
  at: number | null
}
