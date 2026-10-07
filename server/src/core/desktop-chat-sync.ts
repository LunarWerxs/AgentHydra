// server/src/core/desktop-chat-sync.ts — share the owner's visible Claude Desktop chats between their
// PCs through the login sync's store (cloud/login-sync-worker), compressed and encrypted, remembering
// which PC each chat came from (owner, 2026-10-02: "sync all desktop instance chats/threads ...
// Compressed. To save on data. Making sure. We keep track of which computer it came from.").
// The contract with this PC's side (desktop-chat-local.ts) is desktop-chat-types.ts.
//
// STORE LAYOUT. A chat RECORD row at the desktop record's id: the record, its session, project,
// account, org, archive flag, origin PC, and the transcript stream's agreed length {bytes, chunks},
// sealed by chat-sync-codec.ts; its plain `meta` holds no title and no path. The TRANSCRIPT is
// append-only chunks under the SESSION id (a chat moved between profiles keeps its session, and both
// records share one stream); no row exists at a session id. Whoever appends writes its chunks first
// and then the record, by compare-and-swap, so a record never points past chunks that exist.
//
// VIEW ONLY (owner, 2026-10-05: "I don't want them to actually sync back and forth. I just want to
// view the ones running on his computer, and he can view the ones running on mine ... so that we can
// get stats, know what's running"). Only the PC a chat started on ever writes it to the store. Another
// PC's chats come down into the viewer folder (REMOTE_CHATS_DIR), which the session list reads, and
// never into ~/.claude or a Claude Desktop chat list, so nothing here can continue them and send turns
// back. A chat an earlier version took into ~/.claude (and most into this PC's chat list) is taken back
// out: its desktop copies archived and its transcript moved into the viewer (kept where it is if
// someone here went on in it).
//
// HYDRA DESK'S CHATS ride along (owner, 2026-10-07: the cloud list should show "all chats between both of
// our computers"; a PC whose owner works in Hydra Desk shared almost nothing, since its chats have no
// desktop record). desktop-chat-local.ts lists them beside the desktop records, view only like them; one
// idle over a week that was never shared is held back (`holdBack`), so the store's room goes to what runs.
//
// A PASS sends what this PC started that the store lacks, then takes what the other PCs started that
// this PC lacks. Chats archived before they were ever shared are never sent (the owner's PC holds
// thousands of archived chats, about 17 GB). A transcript is only ever read in windows ending at a
// newline, at most 64 MB per pass in all, and only up to its last complete line.
//
// THE STORE IS KEPT SMALL. A chat archived three days ago leaves it (row and transcript); every PC keeps
// its own copy, and neither sends it again, even unarchived: the other PC's agreed position no longer
// matches a fresh stream. The Worker refuses chunks past its room for chats (400 MB by default, under
// D1's 500 MB free-plan database the logins share), which the dialog reports as such.
//
// The state file keeps, per chat, what the last pass agreed with the store, so the next pass can tell
// who changed what. Failures are the chat sync's own: the caller keeps them apart from the logins'.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config'
import { cutChunks, openChunk, openRecord, sealRecord, shareableEnd } from './chat-sync-codec'
import type { ChatIo, ChatSyncRow, LocalChat } from './desktop-chat-types'
import { MIRROR_FRESH_MS } from './login-sync-mirror'

/** Where this PC keeps what each chat agreed with the store (cli-login-sync.ts runs the passes). */
export const CHATS_STATE_PATH = join(CONFIG_DIR, 'desktop-chat-sync.json')

/** Raw transcript bytes one pass reads in all; the rest goes on the next pass. */
export const PASS_READ_MAX = 64 * 1024 * 1024
/** A shared chat still being written in goes up at most this often. Each send is several D1 writes,
 *  and a chat a session is working in grows on nearly every 30 s pass: 2026-10-03 measured 513 chat
 *  sends in 45 minutes. Its new turns still go one pass after it stops growing. */
export const CHAT_PUSH_EVERY_MS = 5 * 60_000
/** Whatever the chat is doing, two sends of it are at least this far apart (a chat that grows, stops
 *  for one pass and grows again would otherwise go up about every minute: each send is a few D1 writes
 *  and a read of the changes on every other PC). The last change still goes up once it has passed. */
export const CHAT_MIN_GAP_MS = 2 * 60_000
/** A record with no store row whose first chunk the store refused as taken waits this long to try again:
 *  what would let it through (the other record sharing its session gone) is rare. */
const STOPPED_RETRY_MS = 60 * 60_000
/** One read window. A line longer than this grows the window until it ends. */
const WINDOW = 8 * 1024 * 1024
/** How long an archived chat stays in the store, so the other PC takes the archive first (owner,
 *  2026-10-03: "A chat archived for three days is deleted from the server"). */
export const ARCHIVED_KEEP_MS = 3 * 24 * 3600_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_ROUTES =
  'this store’s Worker has no chat routes yet: redeploy cloud/login-sync-worker/worker.js'

type RowState = ChatSyncRow['state']
type Reply = { status: number; json: any }
type Origin = { pc: string; name: string }

/** What this PC knows of one chat between passes. */
interface ChatState {
  sessionId: string
  title: string | null
  /** The row version this PC last saw and handled; 0 while its first share is unfinished. */
  version: number
  /** Agreed stream length: transcript bytes and the next chunk seq. */
  bytes: number
  chunks: number
  /** What the store holds (the record's stream) when last seen. */
  stored: number
  /** Chunks this PC wrote whose record is not written yet: where the next send resumes. */
  up: { bytes: number; chunks: number } | null
  origin: Origin
  /** Hash of the title and archive state last sent. */
  sent: string | null
  /** Another PC's chat whose transcript is in the viewer: every one taken since 2026-10-05. One
   *  without it was taken by an earlier version into ~/.claude (and most into this PC's chat list),
   *  and is taken back out first (ChatLocal.retire). */
  viewer?: boolean
  /** Another PC's chat: whether that PC has it archived. */
  archived?: boolean
  state: RowState
  note: string | null
  /** A `waiting` that is worth another try on the next pass. */
  retry: boolean
  /** When the chat last changed in the store (epoch ms). */
  at: number | null
  /** When this PC last sent it (epoch ms, this PC's clock), and the local size the last pass saw. */
  pushedAt?: number
  seen?: number
  /** When its first chunk was last refused as already stored (a record with no store row whose
   *  session another record already shares): it is not offered again for STOPPED_RETRY_MS. */
  stoppedAt?: number
  /** Left the store (archived three days): never sent again, not listed. */
  gone?: boolean
}

interface StateFile {
  pc: string
  chats: Record<string, ChatState>
}

interface StoreRow {
  id: string
  version: number
  /** Plain: kind, session id, the PC it started on, stream bytes, archived. */
  meta: { k?: string; s?: string; pc?: string; b?: number; a?: number } | null
  updatedAt?: number
}

/** The record sealed into a row. */
interface Sealed {
  record: Record<string, unknown>
  sessionId: string
  project: string
  account: string
  org: string
  archived: boolean
  origin: Origin
  stream: { bytes: number; chunks: number }
}

function chatFailure(what: string, r: Reply): Error {
  if (r.status === 404) return new Error(NO_ROUTES)
  if (r.status === 507)
    return new Error(
      `The sync store has no more room for chats (${Math.round((r.json?.room ?? 0) / 1048576)} MB). A chat archived for three days leaves it; logins keep syncing.`,
    )
  if (r.status === 409)
    return new Error(`${what}: changed in the store meanwhile; next pass retries.`)
  return new Error(
    `${what}: the store answered ${r.status}${r.json?.error ? ` (${r.json.error})` : ''}.`,
  )
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

function readState(statePath: string): StateFile | null {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8')) as StateFile
    return s && typeof s.pc === 'string' && s.chats && typeof s.chats === 'object' ? s : null
  } catch {
    return null
  }
}

function writeState(statePath: string, s: StateFile): void {
  mkdirSync(dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(s))
  renameSync(tmp, statePath)
}

/** The chats the dialog lists, from the state file alone. */
export function chatSyncRows(statePath: string): ChatSyncRow[] {
  const s = readState(statePath)
  if (!s) return []
  return Object.entries(s.chats)
    .filter(([, c]) => c.version > 0 && !c.gone)
    .map(([id, c]) => ({
      id,
      sessionId: c.sessionId,
      title: c.title,
      origin: c.origin,
      fromHere: c.origin.pc === s.pc,
      bytes: c.stored,
      state: c.state,
      note: c.note,
      at: c.at,
    }))
}

/** Another PC's chat as that PC shows it. */
export interface ElsewhereChat {
  /** The name of the PC it started on. */
  pc: string
  title: string | null
  archived: boolean
}

let elsewhere: {
  path: string
  mtimeMs: number
  size: number
  map: Map<string, ElsewhereChat>
} | null = null

/** Session id -> another PC's chat, for every chat this PC took from another one, those gone from the
 *  store included (the viewer keeps them; the Sessions list marks them). Re-read only when the state
 *  file changes. */
export function chatsFromElsewhere(
  statePath: string = CHATS_STATE_PATH,
): Map<string, ElsewhereChat> {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(statePath)
  } catch {
    return new Map()
  }
  const hit = elsewhere
  if (hit && hit.path === statePath && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
    return hit.map
  const map = new Map<string, ElsewhereChat>()
  const s = readState(statePath)
  for (const c of s ? Object.values(s.chats) : [])
    if (c.origin.pc !== s?.pc)
      map.set(c.sessionId, { pc: c.origin.name, title: c.title, archived: c.archived === true })
  elsewhere = { path: statePath, mtimeMs: st.mtimeMs, size: st.size, map }
  return map
}

const titleOf = (record: Record<string, unknown>): string | null =>
  typeof record.title === 'string' ? record.title : null

/** A fingerprint of what a record shows: its title and whether it is archived. */
const shown = (record: Record<string, unknown>, archived: boolean): string =>
  createHash('sha256')
    .update(JSON.stringify([titleOf(record), archived]))
    .digest('hex')

// A project folder and a session id become paths on this PC: refuse anything that could leave them.
const safeProject = (p: unknown): p is string =>
  typeof p === 'string' && p !== '' && p !== '.' && p !== '..' && !/[\\/:*?"<>|\0]/.test(p)

function sealedOk(x: any, id: string): x is Sealed {
  return (
    UUID_RE.test(id) &&
    x &&
    typeof x === 'object' &&
    x.record &&
    typeof x.record === 'object' &&
    typeof x.sessionId === 'string' &&
    UUID_RE.test(x.sessionId) &&
    safeProject(x.project) &&
    typeof x.account === 'string' &&
    typeof x.org === 'string' &&
    typeof x.archived === 'boolean' &&
    typeof x.origin?.pc === 'string' &&
    typeof x.origin?.name === 'string' &&
    Number.isInteger(x.stream?.bytes) &&
    x.stream.bytes >= 0 &&
    Number.isInteger(x.stream?.chunks) &&
    x.stream.chunks >= 0
  )
}

/** One chat record with its blob: through the mirror when there is one, which keeps it per version so a
 *  chat that cannot be taken (diverged, waiting) is not downloaded again every pass. */
const getRecord = (io: ChatIo, id: string) =>
  io.mirror ? io.mirror.getItem('chats', id) : io.call('GET', `/v1/chats/${id}`)

async function readRows(io: ChatIo): Promise<Map<string, StoreRow>> {
  let listed: StoreRow[]
  if (io.mirror) {
    await io.mirror.refresh({ tables: ['chats'], maxAgeMs: MIRROR_FRESH_MS })
    const v = io.mirror.view('chats')
    if (!v.ok) throw chatFailure('Reading the chats', v.reply)
    listed = v.rows as StoreRow[]
  } else {
    const list = await io.call('GET', '/v1/chats')
    if (list.status !== 200 || !Array.isArray(list.json?.chats))
      throw chatFailure('Reading the chats', list)
    listed = list.json.chats
  }
  const rows = new Map<string, StoreRow>()
  for (const r of listed) if (r.meta?.k === 'r') rows.set(r.id, r)
  return rows
}

// The key is checked on a row this PC has not handled before, so a PC with the wrong key sends
// nothing sealed under it.
async function openFresh(
  io: ChatIo,
  rows: Map<string, StoreRow>,
  state: StateFile,
): Promise<Map<string, Sealed>> {
  const opened = new Map<string, Sealed>()
  const fresh = [...rows.values()].find((r) => !state.chats[r.id])
  if (!fresh) return opened
  const r = await getRecord(io, fresh.id)
  if (r.status !== 200 || typeof r.json?.blob !== 'string') return opened
  const rec = openRecord(io.key, fresh.id, r.json.blob)
  if (rec === null) throw new Error('A shared chat does not open with this PC’s key.')
  if (sealedOk(rec, fresh.id)) opened.set(fresh.id, rec)
  return opened
}

// One session can be filed under two visible records here (a chat moved between profiles keeps its
// session id). Its one stream goes up through one of them: the one already shared, else the most
// recently active. The other would restart the stream at chunk 0 and stop on 'taken' every pass.
function pickSharers(
  local: LocalChat[],
  rows: Map<string, StoreRow>,
  state: StateFile,
): Map<string, LocalChat> {
  const rank = (c: LocalChat): [number, number] => [
    rows.has(c.id) || (state.chats[c.id]?.version ?? 0) > 0 ? 1 : 0,
    typeof c.record.lastActivityAt === 'number' ? c.record.lastActivityAt : 0,
  ]
  const sharer = new Map<string, LocalChat>()
  for (const c of local) {
    if (c.archived) continue
    const had = sharer.get(c.sessionId)
    const [cs, ca] = rank(c)
    const [hs, ha] = had ? rank(had) : [-1, -1]
    if (!had || cs > hs || (cs === hs && ca > ha)) sharer.set(c.sessionId, c)
  }
  return sharer
}

async function pruneArchived(
  io: ChatIo,
  rows: Map<string, StoreRow>,
  gone: string[],
  now: number,
  fail: (err: unknown) => void,
): Promise<void> {
  for (const row of rows.values()) {
    if (row.meta?.a !== 1 || now - (row.updatedAt ?? now) < ARCHIVED_KEEP_MS) continue
    try {
      const r = await io.call('DELETE', `/v1/chats/${row.id}?version=${row.version}`)
      if (r.status === 200) gone.push(row.id)
      else if (r.status !== 409) throw chatFailure('Removing an archived chat', r)
    } catch (err) {
      fail(err)
    }
  }
}

/** The sessions other PCs started, from the store and from what this PC took: a copy of one here (an
 *  earlier version landed it, or someone imported it) is never sent, so only the PC a chat started on
 *  writes it. */
function foreignSessions(io: ChatIo, state: StateFile, rows: Map<string, StoreRow>): Set<string> {
  const out = new Set<string>()
  for (const r of rows.values())
    if (r.meta?.s && r.meta.pc && r.meta.pc !== io.pc) out.add(r.meta.s)
  for (const c of Object.values(state.chats)) if (c.origin.pc !== io.pc) out.add(c.sessionId)
  return out
}

async function sendAll(
  io: ChatIo,
  state: StateFile,
  rows: Map<string, StoreRow>,
  local: LocalChat[],
  sharer: Map<string, LocalChat>,
  now: number,
  fail: (err: unknown) => void,
): Promise<void> {
  let budget = PASS_READ_MAX
  const foreign = foreignSessions(io, state, rows)
  for (const c of local) {
    if (!UUID_RE.test(c.id) || !UUID_RE.test(c.sessionId)) continue
    if (foreign.has(c.sessionId)) continue
    if (!c.archived && sharer.get(c.sessionId) !== c) continue
    try {
      budget = await sendChat(io, state, rows, c, budget, now)
    } catch (err) {
      fail(err)
    }
  }
}

async function takeAll(
  io: ChatIo,
  state: StateFile,
  rows: Map<string, StoreRow>,
  opened: Awaited<ReturnType<typeof openFresh>>,
  now: number,
  fail: (err: unknown) => void,
): Promise<void> {
  for (const row of rows.values()) {
    const st = state.chats[row.id]
    // This PC's own chat: only this PC writes it, so nothing in the store is taken back.
    if ((st?.origin.pc ?? row.meta?.pc) === io.pc) continue
    if (st && st.version === row.version && !st.retry) continue
    try {
      await takeChat(io, state, row, opened.get(row.id), now)
    } catch (err) {
      fail(err)
    }
  }
}

/** Take every other PC's chat an earlier version put into ~/.claude and this PC's chat list back out,
 *  those gone from the store included. A copy someone here went on in stays, and the viewer starts its
 *  own. */
async function retireLanded(
  io: ChatIo,
  state: StateFile,
  fail: (err: unknown) => void,
): Promise<void> {
  for (const st of Object.values(state.chats)) {
    if (st.origin.pc === io.pc || st.viewer) continue
    try {
      const out = await io.local.retire(st.sessionId, st.bytes)
      if (!out.ok) {
        Object.assign(st, { state: 'waiting', note: out.reason, retry: out.retry })
        continue
      }
      st.viewer = true
      st.retry = st.state === 'waiting'
      if (out.kept) Object.assign(st, { bytes: 0, chunks: 0, version: 0 })
    } catch (err) {
      fail(err)
    }
  }
}

/** One chat pass: send what this PC started that the store lacks, take the chats an earlier version
 *  put into ~/.claude back out, then take what the other PCs started into the viewer. Does all it can,
 *  then throws the first problem. */
/** Returns whether anything moved (the state file changed): the sync loop polls less often when not. */
export async function syncChats(io: ChatIo, now = Date.now()): Promise<boolean> {
  const rows = await readRows(io)
  const loaded = readState(io.statePath)
  const state: StateFile = loaded && loaded.pc === io.pc ? loaded : { pc: io.pc, chats: {} }
  const before = JSON.stringify(state)
  let moved = false
  let problem: Error | null = null
  const fail = (err: unknown) => {
    problem ??= asError(err)
  }
  const opened = await openFresh(io, rows, state)

  const local = io.local.list()
  const sharer = pickSharers(local, rows, state)

  // A chat this PC shared or took whose row is no longer listed left the store.
  const gone = Object.keys(state.chats).filter((id) => state.chats[id].version > 0 && !rows.has(id))

  try {
    await sendAll(io, state, rows, local, sharer, now, fail)
    await retireLanded(io, state, fail)
    await takeAll(io, state, rows, opened, now, fail)

    // A chat archived three days ago leaves the store; each PC keeps its copy.
    await pruneArchived(io, rows, gone, now, fail)
    for (const id of gone) if (state.chats[id]) state.chats[id].gone = true
  } finally {
    if (JSON.stringify(state) !== before) {
      writeState(io.statePath, state)
      moved = true
    }
  }
  if (problem) throw problem
  return moved
}

type SendOutcome = 'done' | 'stopped'

/** Chunks for bytes [from, upTo) of a chat's transcript, windowed on newlines, uploaded in order.
 *  Returns the new agreed position, or 'stopped' when another PC got there first. */
async function uploadBytes(
  io: ChatIo,
  c: LocalChat,
  project: string,
  from: number,
  chunks: number,
  budget: number,
): Promise<{ bytes: number; chunks: number; budget: number; out: SendOutcome }> {
  let pos = from
  let seq = chunks
  let win = WINDOW
  while (pos < c.size && budget > 0) {
    const to = Math.min(pos + Math.min(win, budget), c.size)
    const buf = io.local.read(project, c.sessionId, pos, to)
    const end = shareableEnd(buf)
    if (end === 0) {
      // No newline in this window: a longer line grows it; the file's end (or the budget) stops it.
      if (to >= c.size || win >= budget) break
      win *= 2
      continue
    }
    win = WINDOW
    budget -= buf.length
    for (const ch of cutChunks(io.key, c.sessionId, seq, buf.subarray(0, end))) {
      const r = await io.call('PUT', `/v1/chats/${c.sessionId}/chunks/${ch.seq}`, {
        blob: ch.blob,
        by: io.pc,
      })
      if (r.status === 409 && r.json?.error === 'taken')
        return { bytes: pos, chunks: seq, budget, out: 'stopped' }
      if (r.status !== 200) throw chatFailure('Uploading a chat’s transcript', r)
      pos += ch.length
      seq = ch.seq + 1
    }
  }
  return { bytes: pos, chunks: seq, budget, out: 'done' }
}

/** The chat's state when it may be sent now, else null (not in step, diverged, or not shareable). */
function sendableState(
  io: ChatIo,
  state: StateFile,
  row: StoreRow | undefined,
  c: LocalChat,
): ChatState | null {
  const st = state.chats[c.id]
  if (row) {
    // Only a chat this PC has in step with the store; a read older than its last write waits a pass.
    if (!st || st.version !== row.version || row.meta?.b !== st.bytes) return null
    if (st.state === 'diverged' || st.state === 'waiting') return null
    return st
  }
  if (c.archived || c.holdBack || !c.project) return null
  if (st && st.version > 0) return null
  return st ?? newState(io, c)
}

/** A shared chat that grew since the last pass and went up less than CHAT_PUSH_EVERY_MS ago is
 *  still being written in: it waits. It goes once it stops growing or the interval is up, and never
 *  sooner than CHAT_MIN_GAP_MS after its last send. An archive change, a first share, an unfinished
 *  upload or a backlog still catching up goes at once. Notes the
 *  size seen. */
function stillWriting(st: ChatState, row: StoreRow, c: LocalChat, now: number): boolean {
  const grew = st.seen !== undefined && c.size !== st.seen
  st.seen = c.size
  // A clock set back since the last send makes this negative: send, rather than wait it out.
  const since = st.pushedAt === undefined ? -1 : now - st.pushedAt
  return (
    c.archived === (row.meta?.a === 1) &&
    !st.up &&
    st.state === 'synced' &&
    since >= 0 &&
    (since < CHAT_MIN_GAP_MS || (grew && since < CHAT_PUSH_EVERY_MS))
  )
}

/** Whether the store's copy of a chat this PC started is not what this PC last wrote: the two-way sync
 *  let another PC go on in it (diverged), a PC still on that version wrote to it, or this PC lost its
 *  note of it. A read older than this PC's last write is none of those. */
function writtenElsewhere(st: ChatState | undefined, row: StoreRow): boolean {
  if (!st) return true
  if (st.state === 'diverged' || st.state === 'waiting') return true
  return row.version > st.version || (row.version === st.version && row.meta?.b !== st.bytes)
}

/** Only the PC a chat started on writes it, so a copy written elsewhere starts over: every row of the
 *  session goes (and the transcript with the last of them), and the chat goes up again from byte 0.
 *  False when a row moved meanwhile; the next pass looks again. */
async function startOver(
  io: ChatIo,
  state: StateFile,
  rows: Map<string, StoreRow>,
  c: LocalChat,
): Promise<boolean> {
  for (const row of [...rows.values()]) {
    if (row.id !== c.id && row.meta?.s !== c.sessionId) continue
    const r = await io.call('DELETE', `/v1/chats/${row.id}?version=${row.version}`)
    if (r.status === 409) return false
    if (r.status !== 200) throw chatFailure('Starting a chat’s shared copy over', r)
    rows.delete(row.id)
  }
  state.chats[c.id] = newState(io, c)
  return true
}

/** Send one local chat's new bytes and record. Returns what is left of the pass's read budget. */
async function sendChat(
  io: ChatIo,
  state: StateFile,
  rows: Map<string, StoreRow>,
  c: LocalChat,
  budget: number,
  now: number,
): Promise<number> {
  let row = rows.get(c.id)
  if (row && !c.archived && c.project && writtenElsewhere(state.chats[c.id], row)) {
    if (!(await startOver(io, state, rows, c))) return budget
    row = undefined
  }
  const st = sendableState(io, state, row, c)
  if (!st) return budget
  if (row && stillWriting(st, row, c, now)) return budget
  // A clock set back since makes this negative: try again rather than wait it out.
  const refused = st.stoppedAt === undefined ? -1 : now - st.stoppedAt
  if (!row && refused >= 0 && refused < STOPPED_RETRY_MS) return budget
  const start = st.up ?? { bytes: st.bytes, chunks: st.chunks }
  let at = start
  let out: SendOutcome = 'done'
  if (!c.archived && c.project && c.size > start.bytes) {
    const up = await uploadBytes(io, c, c.project, start.bytes, start.chunks, budget)
    budget = up.budget
    out = up.out
    at = { bytes: up.bytes, chunks: up.chunks }
  }
  const wrote = at.bytes > start.bytes
  if (!row && at.bytes === 0 && out !== 'stopped') return budget // nothing complete to share yet
  if (wrote) st.up = at
  if (out === 'stopped' || !c.project) {
    if (out === 'stopped' && !row) st.stoppedAt = now
    state.chats[c.id] = st
    return budget
  }
  delete st.stoppedAt
  const hash = shown(c.record, c.archived)
  if (row && !wrote && !st.up && hash === st.sent) return budget
  const sealed: Sealed = {
    record: c.record,
    sessionId: c.sessionId,
    project: c.project,
    account: c.account,
    org: c.org,
    archived: c.archived,
    origin: st.origin,
    stream: at,
  }
  const r = await io.call('PUT', `/v1/chats/${c.id}`, {
    version: st.version,
    blob: sealRecord(io.key, c.id, sealed),
    meta: { k: 'r', s: c.sessionId, pc: st.origin.pc, b: at.bytes, a: c.archived ? 1 : 0, at: now },
  })
  state.chats[c.id] = st // on a 409 or failure, chunks written stay noted in `up`
  if (r.status === 409) return budget
  if (r.status !== 200 || !Number.isInteger(r.json?.version))
    throw chatFailure('Uploading a chat', r)
  Object.assign(st, {
    version: r.json.version,
    bytes: at.bytes,
    chunks: at.chunks,
    stored: at.bytes,
    up: null,
    title: titleOf(c.record),
    sent: hash,
    state: c.size > at.bytes && !c.archived && budget <= 0 ? 'sending' : 'synced',
    note: null,
    retry: false,
    at: now,
    pushedAt: now,
    seen: c.size,
  })
  if (row) {
    row.version = st.version
    row.meta = { ...row.meta, b: at.bytes }
  }
  return budget
}

const newState = (io: ChatIo, c: LocalChat): ChatState => ({
  sessionId: c.sessionId,
  title: titleOf(c.record),
  version: 0,
  bytes: 0,
  chunks: 0,
  stored: 0,
  up: null,
  origin: { pc: io.pc, name: io.name },
  sent: null,
  state: 'sending',
  note: null,
  retry: false,
  at: null,
})

/** Take what the store holds for another PC's chat that the viewer lacks: its new transcript bytes,
 *  then its title and archive state. */
async function takeChat(
  io: ChatIo,
  state: StateFile,
  row: StoreRow,
  known: Sealed | undefined,
  now: number,
): Promise<void> {
  let rec = known
  if (!rec) {
    const r = await getRecord(io, row.id)
    if (r.status === 404) return
    if (r.status !== 200 || typeof r.json?.blob !== 'string')
      throw chatFailure('Downloading a chat', r)
    const opened = openRecord(io.key, row.id, r.json.blob)
    if (opened === null) throw new Error('A shared chat does not open with this PC’s key.')
    if (!sealedOk(opened, row.id)) throw new Error('A shared chat is malformed; skipped.')
    rec = opened
  }
  if (rec.origin.pc === io.pc) return
  const prior = state.chats[row.id]
  const st: ChatState = prior ?? {
    sessionId: rec.sessionId,
    title: null,
    version: 0,
    bytes: 0,
    chunks: 0,
    stored: 0,
    up: null,
    origin: rec.origin,
    sent: null,
    viewer: true,
    state: 'receiving',
    note: null,
    retry: false,
    at: null,
  }
  state.chats[row.id] = st
  st.title = titleOf(rec.record)
  st.archived = rec.archived
  st.stored = rec.stream.bytes
  st.at = row.updatedAt ?? now
  // Still in ~/.claude (retireLanded did not get it out yet): the viewer waits for it.
  if (!st.viewer) return
  st.retry = false

  // Only the sync writes the viewer's copy, so one that is not the agreed length (removed, or a store
  // stream shorter than what this PC took) starts over from the first chunk.
  if (io.local.viewSize(rec.project, rec.sessionId) !== st.bytes || rec.stream.bytes < st.bytes)
    Object.assign(st, { bytes: 0, chunks: 0 })
  if (rec.stream.bytes > st.bytes) {
    st.state = 'receiving'
    await receive(io, st, rec)
  }
  if (st.bytes !== rec.stream.bytes) return

  Object.assign(st, {
    chunks: rec.stream.chunks,
    version: row.version,
    state: 'synced',
    note: null,
  })
}

/** Download the chunks from the agreed position up to the record's stream, in order, into the viewer. */
async function receive(io: ChatIo, st: ChatState, rec: Sealed): Promise<void> {
  let from = st.chunks
  while (st.bytes < rec.stream.bytes && from < rec.stream.chunks) {
    const r = await io.call('GET', `/v1/chats/${rec.sessionId}/chunks?from=${from}`)
    if (r.status !== 200 || !Array.isArray(r.json?.chunks))
      throw chatFailure('Downloading a chat’s transcript', r)
    for (const ch of r.json.chunks as Array<{ seq: number; blob: string }>) {
      if (ch.seq !== st.chunks || ch.seq >= rec.stream.chunks) {
        if (ch.seq >= rec.stream.chunks) return
        throw new Error('A chat’s transcript chunks are out of order; skipped.')
      }
      const bytes = openChunk(io.key, rec.sessionId, ch.seq, ch.blob)
      if (!bytes) throw new Error('A chat’s transcript chunk does not open with this PC’s key.')
      if (!io.local.viewWrite(rec.project, rec.sessionId, st.bytes, bytes))
        throw new Error(
          'A chat’s copy changed here while it was being received; next pass retries.',
        )
      st.bytes += bytes.length
      st.chunks = ch.seq + 1
      from = st.chunks
    }
    if (!r.json.more) break
  }
}
