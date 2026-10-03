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
// A PASS sends what this PC holds that the store lacks, then takes what the store holds that this PC
// lacks. Chats archived before they were ever shared are never sent (the owner's PC holds thousands of
// archived chats, about 17 GB). A transcript is only ever read in windows ending at a newline, at most
// 64 MB per pass in all, and only up to its last complete line. A chat continued on two PCs between
// passes is `diverged`: neither side takes or sends its new turns.
//
// THE STORE IS KEPT SMALL. A chat archived three days ago leaves it (row and transcript); every PC keeps
// its own copy, and neither sends it again, even unarchived: the other PC's agreed position no longer
// matches a fresh stream. The Worker refuses chunks past its room for chats (400 MB by default, under
// D1's 500 MB free-plan database the logins share), which the dialog reports as such.
//
// The state file keeps, per chat, what the last pass agreed with the store, so the next pass can tell
// who changed what. Failures are the chat sync's own: the caller keeps them apart from the logins'.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { cutChunks, openChunk, openRecord, sealRecord, shareableEnd } from './chat-sync-codec'
import type { ChatIo, ChatSyncRow, IncomingChat, LocalChat } from './desktop-chat-types'

/** Raw transcript bytes one pass reads in all; the rest goes on the next pass. */
export const PASS_READ_MAX = 64 * 1024 * 1024
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
  /** Hashes of the title and archive state last sent, and last landed here. */
  sent: string | null
  landed: string | null
  state: RowState
  note: string | null
  /** A `waiting` that is worth another try on the next pass. */
  retry: boolean
  /** When the chat last changed in the store (epoch ms). */
  at: number | null
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
  meta: { k?: string; b?: number; a?: number } | null
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

/** One chat pass: send what this PC holds that the store lacks, then take what the store holds that
 *  this PC lacks. Does all it can, then throws the first problem. */
export async function syncChats(io: ChatIo, now = Date.now()): Promise<void> {
  const list = await io.call('GET', '/v1/chats')
  if (list.status !== 200 || !Array.isArray(list.json?.chats))
    throw chatFailure('Reading the chats', list)
  const rows = new Map<string, StoreRow>()
  for (const r of list.json.chats as StoreRow[]) if (r.meta?.k === 'r') rows.set(r.id, r)

  const loaded = readState(io.statePath)
  const state: StateFile = loaded && loaded.pc === io.pc ? loaded : { pc: io.pc, chats: {} }
  const before = JSON.stringify(state)
  const opened = new Map<string, Sealed>()
  let problem: Error | null = null
  const fail = (err: unknown) => {
    problem ??= asError(err)
  }

  // The key is checked on a row this PC has not handled before, so a PC with the wrong key sends
  // nothing sealed under it.
  const fresh = [...rows.values()].find((r) => !state.chats[r.id])
  if (fresh) {
    const r = await io.call('GET', `/v1/chats/${fresh.id}`)
    if (r.status === 200 && typeof r.json?.blob === 'string') {
      const rec = openRecord(io.key, fresh.id, r.json.blob)
      if (rec === null) throw new Error('A shared chat does not open with this PC’s key.')
      if (sealedOk(rec, fresh.id)) opened.set(fresh.id, rec)
    }
  }

  const local = io.local.list()
  const localIds = new Set(local.map((c) => c.id))
  const save = () => {
    const after = JSON.stringify(state)
    if (after !== before) writeState(io.statePath, state)
  }

  // One session can be filed under two visible records here (a chat moved between profiles keeps its
  // session id). Its one stream goes up through one of them: the one already shared, else the most
  // recently active. The other would restart the stream at chunk 0 and stop on 'taken' every pass.
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

  // A chat this PC shared or took whose row is no longer listed left the store.
  const gone = Object.keys(state.chats).filter((id) => state.chats[id].version > 0 && !rows.has(id))

  try {
    // --- send ---
    let budget = PASS_READ_MAX
    for (const c of local) {
      if (!UUID_RE.test(c.id) || !UUID_RE.test(c.sessionId)) continue
      if (!c.archived && sharer.get(c.sessionId) !== c) continue
      try {
        budget = await sendChat(io, state, rows, c, budget, now)
      } catch (err) {
        fail(err)
      }
    }

    // --- take ---
    for (const row of rows.values()) {
      const st = state.chats[row.id]
      if (st && st.version === row.version && !st.retry) continue
      try {
        await takeChat(io, state, row, opened.get(row.id), localIds.has(row.id), now)
      } catch (err) {
        fail(err)
      }
    }

    // --- prune: a chat archived three days ago leaves the store; each PC keeps its copy ---
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
    for (const id of gone) if (state.chats[id]) state.chats[id].gone = true
  } finally {
    save()
  }
  if (problem) throw problem
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

/** Send one local chat's new bytes and record. Returns what is left of the pass's read budget. */
async function sendChat(
  io: ChatIo,
  state: StateFile,
  rows: Map<string, StoreRow>,
  c: LocalChat,
  budget: number,
  now: number,
): Promise<number> {
  const row = rows.get(c.id)
  let st = state.chats[c.id]
  if (row) {
    // Only a chat this PC has in step with the store: someone else's change is taken first.
    if (!st || st.version !== row.version || row.meta?.b !== st.bytes) return budget
    if (st.state === 'diverged' || st.state === 'waiting') return budget
  } else {
    if (c.archived || !c.project) return budget
    if (st && st.version > 0) return budget
    st ??= newState(io, c)
  }
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
  if (!row && at.bytes === 0) return budget // nothing complete to share yet
  if (wrote) st.up = at
  if (out === 'stopped' || !c.project) {
    state.chats[c.id] = st
    return budget
  }
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
  if (r.status === 409) {
    state.chats[c.id] = st // chunks written stay noted in `up`; the next pass re-reads
    return budget
  }
  if (r.status !== 200 || !Number.isInteger(r.json?.version)) {
    state.chats[c.id] = st
    throw chatFailure('Uploading a chat', r)
  }
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
  })
  state.chats[c.id] = st
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
  landed: null,
  state: 'sending',
  note: null,
  retry: false,
  at: null,
})

/** Take what the store holds for one chat that this PC lacks: its transcript, then its record. */
async function takeChat(
  io: ChatIo,
  state: StateFile,
  row: StoreRow,
  known: Sealed | undefined,
  localHas: boolean,
  now: number,
): Promise<void> {
  let rec = known
  if (!rec) {
    const r = await io.call('GET', `/v1/chats/${row.id}`)
    if (r.status === 404) return
    if (r.status !== 200 || typeof r.json?.blob !== 'string')
      throw chatFailure('Downloading a chat', r)
    const opened = openRecord(io.key, row.id, r.json.blob)
    if (opened === null) throw new Error('A shared chat does not open with this PC’s key.')
    if (!sealedOk(opened, row.id)) throw new Error('A shared chat is malformed; skipped.')
    rec = opened
  }
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
    landed: null,
    state: 'receiving',
    note: null,
    retry: false,
    at: null,
  }
  state.chats[row.id] = st
  st.title = titleOf(rec.record)
  st.stored = rec.stream.bytes
  st.at = row.updatedAt ?? now
  st.retry = false

  const have = io.local.size(rec.project, rec.sessionId)
  if (rec.stream.bytes > st.bytes) {
    if (have !== st.bytes) {
      // This PC's transcript is not the agreed one and the store holds more: both were continued.
      Object.assign(st, {
        state: 'diverged',
        note: 'Continued on both PCs; neither side’s new turns are taken.',
      })
      return
    }
    st.state = 'receiving'
    await receive(io, st, rec)
  }
  if (st.bytes !== rec.stream.bytes) return

  st.chunks = rec.stream.chunks
  st.version = row.version
  const hash = shown(rec.record, rec.archived)
  st.sent = hash
  if (st.landed === null && localHas) st.landed = hash // already showing here
  if (st.landed === hash) {
    st.state = 'synced'
    st.note = null
    return
  }
  const incoming: IncomingChat = {
    id: row.id,
    sessionId: rec.sessionId,
    project: rec.project,
    account: rec.account,
    org: rec.org,
    record: rec.record,
    archived: rec.archived,
    origin: rec.origin,
  }
  const out = await io.local.land(incoming)
  if (out.ok) {
    Object.assign(st, { landed: hash, state: 'synced', note: null })
  } else {
    Object.assign(st, { state: 'waiting', note: out.reason, retry: out.retry })
  }
}

/** Download and append the chunks from the agreed position up to the record's stream, in order. */
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
      if (!io.local.append(rec.project, rec.sessionId, st.bytes, bytes))
        throw new Error(
          'A chat’s transcript changed here while it was being received; next pass retries.',
        )
      st.bytes += bytes.length
      st.chunks = ch.seq + 1
      from = st.chunks
    }
    if (!r.json.more) break
  }
}
