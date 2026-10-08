// Analytics toolkit ingest for Claude transcripts (docs/ANALYTICS-PLAN.md §4.6, piece 5): every
// transcript under every CLI instance's config dir and the shared store the default login and the
// desktop app write to, tailed by byte offset through ingest_cursor, one usage_event per model call.
//
//  * Parsing is usage-tokens.ts's accumulateUsageLine and nothing else. It runs on ONE line at a time
//    with no `seen` map, so each line yields that request's complete usage; the store's INSERT OR REPLACE
//    on `claude:<message id>` is what dedupes the several lines Claude Code writes per reply (last write
//    wins, exactly as the `seen` map's "output grew" rule ends up).
//  * ACCOUNT is the one account-tokens.ts credits. A CLI instance: the holder of its config dir at the
//    message's own time (account-holders.json, holderAt). A desktop chat: the account folder its chat
//    record sits in, whatever the time. Anything else in the shared store (a plain `claude` run on the
//    default login): the account signed in to the default dir now (no history is kept for it).
//    account-tokens counts none of that last group, so the parity check reports it apart.
//  * INSTANCE `cli:<id>`, `desktop:<profile dir name>` or `default`. SOURCE `climayte` when the session
//    is an attempt of CliMayte's (corch/workers.json, corch/done/*.json), else `desktop` / `cli`.
//    `agent` is `subagent` for `<session>/subagents/*.jsonl`, whose session is the parent's.
//  * CURSOR rules (same as account-tokens): a file that only grew is read from the saved offset, a
//    shrunk one from 0, an unfinished last line waits (the offset stops at the last newline).
//    A rewrite that keeps or grows the size is not noticed; transcripts are append-only.
//  * THE 35-DAY WINDOW. A call older than the raw window goes straight to usage_hour and the session
//    ledger (store.settleOld, additive, in the same transaction as the file's cursor), with no raw row.
//    Re-reading a file from 0 (a shrink) skips those calls: their ids are in settled_claim.
//  * A session moved between config dirs (a CliMayte handoff copies the transcript) has the same message
//    ids in both. Files go OLDEST first and the first to claim an id keeps it (raw calls by their
//    usage_event row, old calls by settled_claim), so the account that ran the call is the one credited;
//    account-tokens, counting per file, credits the copy's account too.
//  * GENTLE. The first sweep reads tens of GB. Files go oldest first, in READ_CHUNK pieces, each piece
//    followed by a yield to the event loop; the read rate is capped (maxBytesPerSec) and the store is
//    committed every FLUSH_BYTES, so a restart continues at the last commit.
import { createHash } from 'node:crypto'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { CLAUDE_PROJECTS_ROOT } from '../config'
import {
  accountUuidOfClaudeJson,
  holderAt,
  noteHolder,
  readHolders,
  writeHolders,
} from '../core/account-tokens'
import { collectChatsAsync, lineageIdsOf } from '../core/chat-store-scan'
import { listCliInstances } from '../core/cli-instances'
import { POINTER_DIR } from '../instance'
import { pricesAsOf, priceTokens, promptSize } from '../pricing'
import { hswarmAccountId } from '../routes/hswarm'
import { accumulateUsageLine, defaultConfigDir, emptySpend } from '../usage-tokens'
import { sessionAddSql, sessionAggSql } from './schema'
import { CLAUDE_SOURCES, ensureSettledPart, subtractFromHour } from './settled-part'
import {
  eventSlices,
  hourSlices,
  hourStart,
  type IngestCursor,
  type KitStore,
  RAW_RETENTION_DAYS,
  type UsageEventInput,
  WRITE_SLICE,
  yieldLoop,
} from './store'

/**
 * Bump to make every cursor read its file again (a parser fix that changes what is extracted). The next
 * sweep also drops the part of Claude's old store that the transcripts still on disk give (upgradeClaudeStore),
 * so the re-read cannot double it; history whose transcript is gone stays. Version 3 is the first that keeps
 * settled_part, so the upgrade to it is the one that cannot tell what a gone transcript gave (a legacy store).
 */
export const CLAUDE_INGEST_VERSION = 3

/** Bytes read per step; each step ends in a yield to the event loop. */
const READ_CHUNK = 2 * 1024 * 1024
/** Rows per page when a table is walked or deleted from in pieces. */
const PAGE = 100
/** Sessions per transaction when a tagged upgrade takes their settled part back (each session is up to a few hundred hour rows). */
const TAKE_BACK_PAGE = 25
/** The store is committed (and the cursor saved) after this many bytes of one file. */
const FLUSH_BYTES = 64 * 1024 * 1024
/**
 * The first sweep's read-rate cap. Measured on this PC: uncapped, one core reads and parses about
 * 95 MB/s (2.2 GB of one day's files in 23 s), so 40 MB/s keeps the daemon at under half a core while
 * it works; the capped run averaged 38 MB/s (13.5 GB in 6 min), so the ~26 GB takes about 11 minutes,
 * once. The disk sees well under a tenth of an SSD's sequential rate.
 */
export const DEFAULT_MAX_BYTES_PER_SEC = 40 * 1024 * 1024
const DAY_MS = 86_400_000
const QUIET_MS = 3_600_000
const STAT_WORKERS = 32

/** Who a transcript belongs to; `accountAt` returns an account uuid (null: nobody). */
export interface ClaudeFileOwner {
  instance: string
  source: 'cli' | 'desktop'
  accountAt: (ts: number) => string | null
}

/** A `projects` folder to sweep. `owner` is asked once per session id; null skips that session. */
export interface ClaudeRoot {
  dir: string
  owner: (sessionId: string) => ClaudeFileOwner | null
}

/** One CliMayte attempt: when it started and the config dir it ran in (null: not recorded). */
export interface AttemptRun {
  startedAt: number
  configDir: string | null
}

export interface ClaudeIngestOptions {
  pc?: string | null
  /** Session ids that belong to a CliMayte attempt. */
  climayte?: ReadonlySet<string>
  /** Who ran each CliMayte session, by when (climayteAttemptRuns): the copy that ran a call claims it. */
  attempts?: ReadonlyMap<string, readonly AttemptRun[]>
  /** Read-rate cap in bytes per second (Infinity: none). */
  maxBytesPerSec?: number
  /** False: a file already read and untouched for an hour is not even stat'd (the warm sweeps). */
  fullPass?: boolean
  now?: number
  /** Skip files last modified before this (epoch ms): seeds recent history first. */
  minMtimeMs?: number
  /** Called after each file with the bytes it read and the events it produced. */
  onFile?: (path: string, bytes: number, events: number) => void
}

export interface ClaudeIngestSummary {
  /** Files with new bytes that were read. */
  files: number
  /** Files looked at and found unchanged. */
  unchanged: number
  bytes: number
  /** usage_event rows written (raw window). */
  events: number
  /** Calls older than the raw window, added to usage_hour only. */
  hourly: number
}

// --- discovery ---------------------------------------------------------------------------------

/** The account each `.claude.json` named when last read, revalidated by its size and mtime. */
const accountFiles = new Map<string, { mtimeMs: number; size: number; uuid: string | null }>()

/** The account a config folder is signed in as, read without blocking and only when its file changed. */
async function accountUuidOf(configDir: string): Promise<string | null> {
  const path = join(configDir, '.claude.json')
  try {
    const st = await stat(path)
    const hit = accountFiles.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.uuid
    const uuid = accountUuidOfClaudeJson(await readFile(path, 'utf8'))
    accountFiles.set(path, { mtimeMs: st.mtimeMs, size: st.size, uuid })
    return uuid
  } catch {
    accountFiles.delete(path)
    return null
  }
}

/**
 * Every sweep target on this PC: each CLI instance's `projects`, and the shared store. Each sweep first records
 * who holds every CLI instance now (account-holders.json), so a re-login between two sweeps is attributed from
 * the moment it is seen, not frozen at the daemon's boot; the work is a stat per instance, a read only when its
 * `.claude.json` changed, and a turn of the event loop between instances.
 */
export async function discoverClaudeRoots(): Promise<ClaudeRoot[]> {
  const roots: ClaudeRoot[] = []
  const holders = readHolders()
  let holdersChanged = false
  const at = Date.now()
  for (const inst of listCliInstances()) {
    const history = holders[inst.configDir] ?? []
    holders[inst.configDir] = history
    const uuid = inst.loggedIn ? await accountUuidOf(inst.configDir) : null
    if (noteHolder(history, uuid, at)) holdersChanged = true
    const owner: ClaudeFileOwner = {
      instance: `cli:${inst.id}`,
      source: 'cli',
      accountAt: (ts) => holderAt(history, ts),
    }
    roots.push({ dir: join(inst.configDir, 'projects'), owner: () => owner })
    await yieldLoop()
  }
  if (holdersChanged) writeHolders(holders)

  // The shared store: desktop chats write here. A chat record names the profile and the account (the
  // folder it is filed in); the newest non-archived record wins, as in account-tokens.
  const chats = new Map<string, { rank: string; owner: ClaudeFileOwner }>()
  let seen = 0
  for (const c of await collectChatsAsync()) {
    if (++seen % 300 === 0) await yieldLoop()
    if (!c.accountUuid) continue
    const uuid = c.accountUuid.toLowerCase()
    const owner: ClaudeFileOwner = {
      instance: `desktop:${c.instance}`,
      source: 'desktop',
      accountAt: () => uuid,
    }
    const rank = `${c.archived ? 0 : 1}|${c.metaMtime ?? ''}`
    for (const id of lineageIdsOf(c))
      if (rank >= (chats.get(id)?.rank ?? '')) chats.set(id, { rank, owner })
  }
  const defaultUuid = await accountUuidOf(defaultConfigDir())
  const fallback: ClaudeFileOwner = {
    instance: 'default',
    source: 'cli',
    accountAt: () => defaultUuid,
  }
  roots.push({ dir: CLAUDE_PROJECTS_ROOT, owner: (sid) => chats.get(sid)?.owner ?? fallback })
  return roots
}

const climayteFiles = new Map<
  string,
  { mtimeMs: number; size: number; runs: { id: string; run: AttemptRun }[] }
>()

/** Every CliMayte attempt: in-flight work in workers.json, finished work in done/*.json, by session id.
 *  Each file is parsed again only when its size or mtime moves. */
export async function climayteAttemptRuns(
  corchDir: string = join(POINTER_DIR, 'corch'),
): Promise<Map<string, AttemptRun[]>> {
  const out = new Map<string, AttemptRun[]>()
  const paths = [join(corchDir, 'workers.json')]
  try {
    for (const n of await readdir(join(corchDir, 'done')))
      if (n.endsWith('.json')) paths.push(join(corchDir, 'done', n))
  } catch {
    // no finished work yet
  }
  const live = new Set(paths)
  for (const p of paths) {
    try {
      for (const { id, run } of await fileAttemptRuns(p)) {
        const list = out.get(id) ?? []
        list.push(run)
        out.set(id, list)
      }
    } catch {
      // missing or half-written: the next sweep reads it again
    }
  }
  for (const p of climayteFiles.keys()) if (!live.has(p)) climayteFiles.delete(p)
  for (const list of out.values()) list.sort((x, y) => x.startedAt - y.startedAt)
  return out
}

/** One corch file's attempts, parsed again only when its size or mtime moved. */
async function fileAttemptRuns(p: string): Promise<{ id: string; run: AttemptRun }[]> {
  const st = await stat(p)
  let rec = climayteFiles.get(p)
  if (!rec || rec.mtimeMs !== st.mtimeMs || rec.size !== st.size) {
    rec = { mtimeMs: st.mtimeMs, size: st.size, runs: attemptRunsIn(await readFile(p, 'utf8')) }
    climayteFiles.set(p, rec)
  }
  return rec.runs
}

/** workers.json lists `workers`; a done/*.json file is one worker. A worker's attempts are under `attempts`. */
function attemptRunsIn(text: string): { id: string; run: AttemptRun }[] {
  const parsed = JSON.parse(text)
  const runs: { id: string; run: AttemptRun }[] = []
  for (const w of Array.isArray(parsed?.workers) ? parsed.workers : [parsed])
    for (const a of Array.isArray(w?.attempts) ? w.attempts : [])
      if (typeof a?.sessionId === 'string' && a.sessionId)
        runs.push({ id: a.sessionId, run: attemptRun(a) })
  return runs
}

function attemptRun(a: { startedAt?: unknown; account?: { configDir?: unknown } }): AttemptRun {
  return {
    startedAt: typeof a.startedAt === 'number' ? a.startedAt : 0,
    configDir:
      typeof a.account?.configDir === 'string' && a.account.configDir ? a.account.configDir : null,
  }
}

/** Session ids of every CliMayte attempt. */
export async function climayteSessionIds(
  corchDir: string = join(POINTER_DIR, 'corch'),
): Promise<Set<string>> {
  return new Set((await climayteAttemptRuns(corchDir)).keys())
}

// --- one line -> one event -----------------------------------------------------------------------

const MESSAGE_ID = /"id":"(msg_[A-Za-z0-9_-]+)"/
const REQUEST_ID = /"requestId":"([^"]+)"/

/** The event for one transcript line, or null when the line is not a model call that spent tokens. */
export function claudeLineEvent(
  line: string,
  fallbackTs: number,
  ctx: {
    session: string
    agent: 'main' | 'subagent'
    /** The sub-agent file's id (`agent` is `subagent`), else null. */
    agentId?: string | null
    owner: ClaudeFileOwner
    source: string
    /** Who ran the call, when records say: `other` (a copy of the session in another dir ran it), else not. */
    ran?: (ts: number) => 'self' | 'other' | 'unknown'
    pc: string | null
    priceVer: string
    accountId: (uuid: string | null) => string | null
  },
): UsageEventInput | null {
  const spend = emptySpend()
  const stamp = accumulateUsageLine(spend, line, 0)
  if (spend.turns === 0 || spend.raw === 0) return null
  const ts = stamp ?? fallbackTs
  const model = Object.keys(spend.byModel)[0] as string
  const m = spend.byModel[model]
  if (!m) return null
  const msg = MESSAGE_ID.exec(line)?.[1] ?? REQUEST_ID.exec(line)?.[1]
  const id = `claude:${msg ?? `h${createHash('sha1').update(line).digest('hex').slice(0, 20)}`}`
  // One line is one request: its own prompt picks a tiered model's rates (Haiku 5.5 over 100k).
  const priced = priceTokens({ [model]: m }, ts, promptSize(m))
  return {
    id,
    ts,
    pc: ctx.pc,
    account: ctx.accountId(ctx.owner.accountAt(ts)),
    instance: ctx.owner.instance,
    session: ctx.session,
    agent: ctx.agent,
    agent_id: ctx.agentId ?? null,
    source: ctx.source,
    model,
    provider: 'anthropic',
    input: m.input,
    output: m.output,
    cache_read: m.cacheRead,
    cache_write_5m: m.cacheCreation5m,
    cache_write_1h: m.cacheCreation1h,
    list_usd: priced.unpriced.length > 0 ? null : priced.costUsd,
    price_ver: ctx.priceVer,
    weighted: spend.weighted,
  }
}

// --- files -------------------------------------------------------------------------------------

interface Candidate {
  path: string
  session: string
  agent: 'main' | 'subagent'
  agentId: string | null
  owner: ClaudeFileOwner
  rootDir: string
}

/** One folder as last listed: its mtime, its subfolders and the transcripts in it that are ours. */
interface DirNode {
  mtimeMs: number
  dirs: string[]
  files: {
    path: string
    session: string
    agent: 'main' | 'subagent'
    agentId: string | null
  }[]
}

/**
 * What a store's sweeps remember between passes: every folder's listing and every cursor. Walking 12k
 * folders and loading 63k cursors costs seconds, so a warm pass reuses both; a folder is listed again
 * only when its mtime moved (a file created or removed in it; on Windows a file that merely grows does
 * not move it, which is why recently written files are stat'd every pass and every file every Nth).
 */
interface SweepMemory {
  epoch: number
  cursors: Map<string, IngestCursor>
  loaded: Set<string>
  trees: Map<string, Map<string, DirNode>>
}
const memories = new WeakMap<KitStore, SweepMemory>()

function memoryOf(store: KitStore): SweepMemory {
  let m = memories.get(store)
  if (!m || m.epoch !== store.cursorEpoch) {
    m = { epoch: store.cursorEpoch, cursors: new Map(), loaded: new Set(), trees: new Map() }
    memories.set(store, m)
  }
  return m
}

/** Every cursor under `dir`, read a page at a time into the memory (once per store and root). */
async function loadCursors(store: KitStore, mem: SweepMemory, dir: string): Promise<void> {
  if (mem.loaded.has(dir)) return
  const page = store.db.prepare(
    'select * from ingest_cursor where path >= $lo and path < $hi order by path limit 300',
  )
  const hi = `${dir}￿`
  for (let lo = dir; ; ) {
    const rows = page.all({ $lo: lo, $hi: hi }) as IngestCursor[]
    for (const r of rows) mem.cursors.set(r.path, r)
    if (rows.length < 300) break
    lo = (rows[rows.length - 1] as IngestCursor).path
    await yieldLoop()
  }
  mem.loaded.add(dir)
}

async function pool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(STAT_WORKERS, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T)
    }),
  )
}

/**
 * The folder tree under `root`, level by level. A folder whose mtime is what the previous listing saw is
 * not listed again unless `relist` is set. The mtime is read BEFORE the listing, so a file created while
 * it runs moves the mtime past the one saved and is caught by the next pass.
 */
async function walkRoot(
  root: string,
  old: Map<string, DirNode> | undefined,
  relist: boolean,
): Promise<Map<string, DirNode>> {
  const tree = new Map<string, DirNode>()
  for (let level = [root]; level.length > 0; ) {
    const next: string[] = []
    await pool(level, async (dir) => {
      const node = await dirNode(root, dir, old, relist)
      if (!node) return
      tree.set(dir, node)
      for (const d of node.dirs) next.push(d)
    })
    level = next
  }
  return tree
}

/** One folder's node: the previous listing while its mtime holds (and no `relist`), else a new one; null when it is gone. */
async function dirNode(
  root: string,
  dir: string,
  old: Map<string, DirNode> | undefined,
  relist: boolean,
): Promise<DirNode | null> {
  const st = await stat(dir).catch(() => null)
  if (!st) return null
  const mtimeMs = Math.floor(st.mtimeMs)
  const node = old?.get(dir)
  if (node && !relist && node.mtimeMs === mtimeMs) return node
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const fresh: DirNode = { mtimeMs, dirs: [], files: [] }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) fresh.dirs.push(p)
    else if (e.name.endsWith('.jsonl')) {
      const c = classify(root, p)
      if (c) fresh.files.push({ path: p, ...c })
    }
  }
  return fresh
}

/**
 * `<project>/<session>.jsonl` or `<project>/<session>/subagents/<agent>.jsonl`. Anything else is not ours.
 * A sub-agent's id is its file's path under `subagents/` without the extension (`<agent>`; a file nested in
 * a folder, such as a workflow's, keeps the folders so two files never share an id).
 */
export function classify(
  root: string,
  path: string,
): { session: string; agent: 'main' | 'subagent'; agentId: string | null } | null {
  const parts = relative(root, path).split(sep)
  if (parts.length === 2)
    return { session: basename(parts[1] as string, '.jsonl'), agent: 'main', agentId: null }
  if (parts.length >= 4 && parts[2] === 'subagents')
    return {
      session: parts[1] as string,
      agent: 'subagent',
      agentId: parts
        .slice(3)
        .join('/')
        .replace(/\.jsonl$/, ''),
    }
  return null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Read pacing: after `n` bytes, wait until the average rate is back under the cap (a 100 ms burst is free). */
function makeThrottle(maxBytesPerSec: number) {
  let due = 0
  return async (n: number) => {
    if (!Number.isFinite(maxBytesPerSec)) {
      await sleep(0)
      return
    }
    const now = performance.now()
    due = Math.max(due, now) + (n * 1000) / maxBytesPerSec
    await sleep(Math.max(0, due - now - 100))
  }
}

/** Session ids of every transcript that still exists under `roots` (an owner of it is known). */
async function liveSessionIds(roots: readonly ClaudeRoot[]): Promise<string[]> {
  const ids = new Set<string>()
  for (const r of roots) {
    const known = new Map<string, boolean>()
    for (const node of (await walkRoot(r.dir, undefined, true)).values())
      for (const f of node.files) {
        if (!known.has(f.session)) known.set(f.session, r.owner(f.session) !== null)
        if (known.get(f.session)) ids.add(f.session)
      }
    await yieldLoop()
  }
  return [...ids].sort()
}

/**
 * Once per CLAUDE_INGEST_VERSION: forget the part of Claude's old store that the transcripts still on disk give,
 * so it is read again under the current rules, and keep the rest. settled_part says which session and hour each
 * settled call went to, so for every session that still has a transcript the part is taken back out of
 * usage_hour, usage_session_settled and usage_session (the live ledger is re-added from the raw rows), while a
 * session whose transcript is gone keeps its kept-forever history. Every settled claim and every cursor under
 * `roots` goes, so the transcripts are read whole. A store that predates settled_part (no `claude_settled_tags`
 * mark) cannot tell what a gone transcript gave: it is dropped whole, once, as before. Raw rows, HSwarm rows
 * and the foreign sources are not touched. A sweep after it counts each old call once.
 */
export async function upgradeClaudeStore(
  store: KitStore,
  roots: readonly ClaudeRoot[],
  now: number,
): Promise<void> {
  const have = store.getMeta('claude_ingest_version')
  if (have === String(CLAUDE_INGEST_VERSION)) return
  const cut = hourStart(now - RAW_RETENTION_DAYS * DAY_MS)
  const list = CLAUDE_SOURCES.map((s) => `'${s}'`).join(',')
  const db = store.db
  // On a live-size store every step below is millions of rows, so each is a run of short transactions
  // with a turn of the event loop between them. The version is written last and every step can be run
  // again, so a restart half way simply starts over.
  // Fold doomed raw rows first, so nothing below the cut is left half raw, half settled.
  await store.pruneRawAsync(now)
  const tagged =
    store.getMeta('claude_settled_tags') === '1' ||
    !db
      .query(
        `select 1 from usage_session_settled where source in (${list}) union all select 1 from settled_claim limit 1`,
      )
      .get()
  if (tagged) await dropTaggedPart(store, roots)
  else await dropWholePart(store, cut)
  for (;;) {
    const n = db
      .query('delete from settled_claim where h in (select h from settled_claim limit 20000)')
      .run()
    if (n.changes === 0) break
    await yieldLoop()
  }
  for (const r of roots) {
    const drop = db.prepare(
      'delete from ingest_cursor where path in (select path from ingest_cursor where path >= $a and path < $b limit 1000)',
    )
    while (drop.run({ $a: r.dir, $b: `${r.dir}￿` }).changes > 0) await yieldLoop()
  }
  store.cursorEpoch++
  store.setMeta('claude_settled_tags', '1')
  store.setMeta('claude_ingest_version', String(CLAUDE_INGEST_VERSION))
}

/** The live ledger again from the raw rows `where` selects, a slice of time at a time. */
async function readdLedger(store: KitStore, where: string): Promise<void> {
  const db = store.db
  const list = CLAUDE_SOURCES.map((s) => `'${s}'`).join(',')
  const ts = (dir: 'asc' | 'desc') =>
    (
      db.query(`select ts from usage_event order by ts ${dir} limit 1`).get() as {
        ts: number
      } | null
    )?.ts
  const lo = ts('asc')
  const hi = ts('desc')
  if (lo == null || hi == null) return
  const add = db.prepare(
    sessionAddSql(
      'usage_session',
      sessionAggSql(`source in (${list}) and ${where} and ts >= $a and ts < $b`),
    ),
  )
  for (const _ of eventSlices(db, lo, hi + 1, (a, b) => {
    add.run({ $a: a, $b: b })
  }))
    await yieldLoop()
}

/** The legacy upgrade: every Claude row below the raw window, settled or live, goes; the ledger is rebuilt from raw. */
async function dropWholePart(store: KitStore, cut: number): Promise<void> {
  const db = store.db
  const list = CLAUDE_SOURCES.map((s) => `'${s}'`).join(',')
  const oldest = db.query('select min(hour) as h from usage_hour').get() as { h: number | null }
  if (oldest.h !== null) {
    const drop = db.prepare(
      `delete from usage_hour where hour >= $a and hour < $b and source in (${list})`,
    )
    for (const _ of hourSlices(oldest.h, cut, (a, b) => {
      drop.run({ $a: a, $b: b })
    }))
      await yieldLoop()
  }
  for (const table of ['usage_session_settled', 'usage_session']) {
    // The key starts with the session id: delete a run of sessions at a time, walking up the key.
    const page = db.prepare(
      `select session as s from ${table} where session > $lo order by session limit 1 offset ${PAGE - 1}`,
    )
    const drop = db.prepare(
      `delete from ${table} where session > $lo and session <= $hi and source in (${list})`,
    )
    const dropRest = db.prepare(`delete from ${table} where session > $lo and source in (${list})`)
    for (let lo = ''; ; ) {
      const hi = (page.get({ $lo: lo }) as { s: string } | null)?.s
      if (hi === undefined) {
        dropRest.run({ $lo: lo })
        break
      }
      drop.run({ $lo: lo, $hi: hi })
      lo = hi
      await yieldLoop()
    }
    // A session with an empty id sorts below every `> ''` bound.
    db.query(`delete from ${table} where session = '' and source in (${list})`).run()
    await yieldLoop()
  }
  // Nothing says what the old settled calls were; the re-read tags them again.
  db.exec('drop table if exists settled_part')
  ensureSettledPart(db)
  await readdLedger(store, '1')
}

/** The tagged upgrade: only the sessions whose transcript still exists are taken back, from their settled_part. */
async function dropTaggedPart(store: KitStore, roots: readonly ClaudeRoot[]): Promise<void> {
  const db = store.db
  const list = CLAUDE_SOURCES.map((s) => `'${s}'`).join(',')
  const sessions = await liveSessionIds(roots)
  const subtract = subtractFromHour(db)
  const ids = '(select value from json_each($ids))'
  const parts = db.prepare(`select * from settled_part where session in ${ids}`)
  const dropPart = db.prepare(`delete from settled_part where session in ${ids}`)
  const dropSettled = db.prepare(
    `delete from usage_session_settled where session in ${ids} and source in (${list})`,
  )
  const dropLive = db.prepare(
    `delete from usage_session where session in ${ids} and source in (${list})`,
  )
  for (let i = 0; i < sessions.length; i += TAKE_BACK_PAGE) {
    const $ids = JSON.stringify(sessions.slice(i, i + TAKE_BACK_PAGE))
    db.transaction(() => {
      for (const row of parts.all({ $ids }) as Record<string, unknown>[]) subtract(row)
      dropPart.run({ $ids })
      dropSettled.run({ $ids })
      dropLive.run({ $ids })
    })()
    await yieldLoop()
  }
  // Their live ledger again, from the raw rows that remain.
  db.exec('drop table if exists temp.upgrade_sessions')
  db.exec('create temp table upgrade_sessions (session text primary key) without rowid')
  const put = db.prepare('insert or ignore into temp.upgrade_sessions values (?)')
  for (let i = 0; i < sessions.length; i += 500) {
    db.transaction(() => {
      for (const s of sessions.slice(i, i + 500)) put.run(s)
    })()
    await yieldLoop()
  }
  await readdLedger(store, "coalesce(session, '') in (select session from temp.upgrade_sessions)")
  db.exec('drop table if exists temp.upgrade_sessions')
}

/** One sweep over every root. Only bytes that arrived since the last sweep are read. */
export async function ingestClaude(
  store: KitStore,
  roots: readonly ClaudeRoot[],
  opts: ClaudeIngestOptions = {},
): Promise<ClaudeIngestSummary> {
  const sum: ClaudeIngestSummary = { files: 0, unchanged: 0, bytes: 0, events: 0, hourly: 0 }
  const now = opts.now ?? Date.now()
  const fullPass = opts.fullPass ?? true
  const pc = opts.pc ?? null
  const attempts = opts.attempts ?? new Map<string, readonly AttemptRun[]>()
  const climayte = opts.climayte ?? new Set<string>(attempts.keys())
  const rootDirs = new Set(roots.map((r) => norm(r.dir)))
  const throttle = makeThrottle(opts.maxBytesPerSec ?? DEFAULT_MAX_BYTES_PER_SEC)
  const priceVer = pricesAsOf()
  const rawCutoff = hourStart(now - RAW_RETENTION_DAYS * DAY_MS)
  await upgradeClaudeStore(store, roots, now)
  const mem = memoryOf(store)
  const accountId = accountIdLookup()

  // 1. Which files exist, and which have something new.
  const cursors = mem.cursors
  const todo = await candidates(store, mem, roots, { now, fullPass, sum })
  const stats = await statAll(todo)
  const work = changedFiles(todo, stats, cursors, {
    minMtimeMs: opts.minMtimeMs ?? 0,
    attempts,
    sum,
  })

  // 2. Read them, oldest first.
  for (const c of work) {
    const st = stats.get(c.path) as { size: number; mtimeMs: number }
    const start = startOffset(cursors.get(c.path), st)
    const ctx = {
      session: c.session,
      agent: c.agent,
      agentId: c.agentId,
      owner: c.owner,
      source: climayte.has(c.session) ? 'climayte' : c.owner.source,
      ran: ranIn(attempts.get(c.session), c.rootDir, rootDirs),
      pc,
      priceVer,
      accountId,
    }
    try {
      const r = await readFileInto(store, c.path, start, st, ctx, rawCutoff, throttle, (cur) =>
        cursors.set(cur.path, cur),
      )
      sum.files++
      sum.bytes += r.bytes
      sum.events += r.events
      sum.hourly += r.hourly
      opts.onFile?.(c.path, r.bytes, r.events + r.hourly)
    } catch {
      // Gone or locked since it was listed: the next sweep tries again (its cursor did not move).
    }
  }
  return sum
}

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
/** The `projects` folder an attempt ran in, or null when it is not recorded. */
const runDir = (run: AttemptRun | undefined) =>
  run?.configDir ? norm(join(run.configDir, 'projects')) : null

/** Account uuid to HSwarm account id, each uuid worked out once per sweep. */
function accountIdLookup(): (uuid: string | null) => string | null {
  const accountIds = new Map<string, string>()
  return (uuid) => {
    if (!uuid) return null
    const known = accountIds.get(uuid)
    if (known) return known
    const id = hswarmAccountId(uuid)
    accountIds.set(uuid, id)
    return id
  }
}

/** Every transcript under `roots` with an owner, less the ones read and quiet for an hour (unless `fullPass`). */
async function candidates(
  store: KitStore,
  mem: SweepMemory,
  roots: readonly ClaudeRoot[],
  o: { now: number; fullPass: boolean; sum: ClaudeIngestSummary },
): Promise<Candidate[]> {
  const todo: Candidate[] = []
  let seen = 0
  for (const root of roots) {
    await loadCursors(store, mem, root.dir)
    // The first pass over a root, and every full pass, lists every folder again.
    const tree = await walkRoot(root.dir, mem.trees.get(root.dir), o.fullPass)
    mem.trees.set(root.dir, tree)
    const owners = new Map<string, ClaudeFileOwner | null>()
    for (const f of [...tree.values()].flatMap((node) => node.files)) {
      if (++seen % 2000 === 0) await yieldLoop()
      if (!owners.has(f.session)) owners.set(f.session, root.owner(f.session))
      const owner = owners.get(f.session)
      if (!owner) continue
      const cur = mem.cursors.get(f.path)
      if (
        cur &&
        cur.version === CLAUDE_INGEST_VERSION &&
        cur.mtime < o.now - QUIET_MS &&
        !o.fullPass
      )
        o.sum.unchanged++
      else todo.push({ ...f, owner, rootDir: root.dir })
    }
  }
  return todo
}

async function statAll(todo: Candidate[]): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const stats = new Map<string, { size: number; mtimeMs: number }>()
  let next = 0
  await Promise.all(
    Array.from({ length: STAT_WORKERS }, async () => {
      for (; next < todo.length; ) {
        const c = todo[next++] as Candidate
        const st = await stat(c.path).catch(() => null)
        if (st) stats.set(c.path, { size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
      }
    }),
  )
  return stats
}

/** The candidates whose size moved since their cursor, oldest first. */
function changedFiles(
  todo: Candidate[],
  stats: Map<string, { size: number; mtimeMs: number }>,
  cursors: Map<string, IngestCursor>,
  o: {
    minMtimeMs: number
    attempts: ReadonlyMap<string, readonly AttemptRun[]>
    sum: ClaudeIngestSummary
  },
): Candidate[] {
  const ranFirstIn = (c: Candidate) => runDir(o.attempts.get(c.session)?.[0]) === norm(c.rootDir)
  return todo
    .filter((c) => {
      const st = stats.get(c.path)
      if (!st || st.mtimeMs < o.minMtimeMs) return false
      const cur = cursors.get(c.path)
      const same = cur && cur.version === CLAUDE_INGEST_VERSION && cur.size === st.size
      if (same) o.sum.unchanged++
      return !same
    })
    .sort(
      (a, b) =>
        (stats.get(a.path)?.mtimeMs ?? 0) - (stats.get(b.path)?.mtimeMs ?? 0) ||
        // equal mtimes (a copy keeps the original's): the dir the session first ran in goes first, then by path
        Number(ranFirstIn(b)) - Number(ranFirstIn(a)) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
}

/** Where a file's read starts: its cursor's offset, or 0 for a file new to this version or rewritten. */
function startOffset(cur: IngestCursor | undefined, st: { size: number }): number {
  const known = cur && cur.version === CLAUDE_INGEST_VERSION ? cur : null
  const start = known ? known.offset : 0
  // Shrunk (or the offset lies past the end): the file was rewritten, read it whole.
  const reset = known !== null && (st.size < known.size || start > st.size)
  return reset ? 0 : start
}

/** Who ran a CliMayte session's call at a time, by its attempts; undefined for a session with none. */
function ranIn(
  runs: readonly AttemptRun[] | undefined,
  rootDir: string,
  rootDirs: ReadonlySet<string>,
): ((ts: number) => 'self' | 'other' | 'unknown') | undefined {
  if (!runs) return undefined
  return (ts) => {
    // the attempt that was running at `ts` is the latest one started by then
    let run: AttemptRun | undefined
    for (const r of runs) if (r.startedAt <= ts) run = r
    const dir = runDir(run)
    if (!dir) return 'unknown'
    if (dir === norm(rootDir)) return 'self'
    return rootDirs.has(dir) ? 'other' : 'unknown'
  }
}

async function readFileInto(
  store: KitStore,
  path: string,
  start: number,
  st: { size: number; mtimeMs: number },
  ctx: Parameters<typeof claudeLineEvent>[2],
  rawCutoff: number,
  throttle: (n: number) => Promise<void>,
  saved: (cursor: IngestCursor) => void,
): Promise<{ bytes: number; events: number; hourly: number }> {
  const fh = await open(path, 'r')
  const out = { bytes: 0, events: 0, hourly: 0 }
  try {
    let pos = start // next byte to read
    let carry: Buffer = Buffer.alloc(0) // bytes after the last newline read so far
    const batch: Batch = { raw: new Map(), old: new Map() }
    let sinceFlush = 0
    // A session moved to another account's config dir (a CliMayte handoff) leaves its messages in both
    // dirs under the same ids, and only the first dir's account ran them. The first to claim an id keeps
    // it; the same instance and session writing it again replaces it (last write wins).
    const owner = store.db.prepare('select instance, session from usage_event where id = ?')
    // The exception: a call the CliMayte records say THIS dir's attempt ran replaces the other copy's row.
    const ran = new Set<string>()
    const unclaimed = (evs: UsageEventInput[]) =>
      evs.filter((e) => {
        const have = owner.get(e.id) as { instance: string | null; session: string | null } | null
        return (
          !have || ran.has(e.id) || (have.instance === e.instance && have.session === e.session)
        )
      })
    // A commit is a run of short transactions (a flush of 64 MB is some 100k calls), the cursor last: a
    // run cut short re-reads the file from the old cursor, and both writes tolerate seeing a call twice
    // (a raw row is replaced by id, an old call is dropped by its claim).
    const commit = async (offset: number, size: number) => {
      const rows = [...batch.raw.values()]
      const olds = [...batch.old.values()]
      batch.raw = new Map()
      batch.old = new Map()
      sinceFlush = 0
      for (let i = 0; i < rows.length; i += WRITE_SLICE) {
        out.events += store.upsertEvents(unclaimed(rows.slice(i, i + WRITE_SLICE)))
        await yieldLoop()
        await store.rollupSoon() // keeps the oldest stale hour close to now through a long re-read
      }
      out.hourly += await store.settleOldAsync(olds)
      const cursor = {
        path,
        size,
        mtime: st.mtimeMs,
        offset,
        version: CLAUDE_INGEST_VERSION,
      }
      store.setCursor(cursor)
      saved(cursor)
    }
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      out.bytes += bytesRead
      sinceFlush += bytesRead
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead)
      const nl = data.lastIndexOf(0x0a)
      if (nl < 0) {
        carry = Buffer.from(data) // one long line still arriving
      } else {
        await readLines(data.toString('utf8', 0, nl), st.mtimeMs, ctx, rawCutoff, batch, ran)
        carry = Buffer.from(data.subarray(nl + 1))
      }
      if (sinceFlush >= FLUSH_BYTES) await commit(pos - carry.length, pos)
      await throttle(bytesRead)
    }
    await commit(pos - carry.length, pos)
  } finally {
    await fh.close()
  }
  return out
}

/** Calls read since the last commit, by id: raw-window calls and older ones. */
interface Batch {
  raw: Map<string, UsageEventInput>
  old: Map<string, UsageEventInput>
}

/** Complete lines into the batch; `ran` collects the calls this dir's own attempt ran. */
async function readLines(
  text: string,
  fallbackTs: number,
  ctx: Parameters<typeof claudeLineEvent>[2],
  rawCutoff: number,
  batch: Batch,
  ran: Set<string>,
): Promise<void> {
  let t0 = performance.now()
  let n = 0
  for (const line of text.split('\n')) {
    // 2 MB of lines is tens of ms of JSON.parse: hand the loop back every ~15 ms of it.
    if (++n % 64 === 0 && performance.now() - t0 > 15) {
      await new Promise<void>((r) => setImmediate(r))
      t0 = performance.now()
    }
    const ev = claudeLineEvent(line, fallbackTs, ctx)
    if (!ev) continue
    const who = ctx.ran?.(ev.ts)
    if (who === 'other') continue // a copy of the session in another dir ran this call
    if (who === 'self') ran.add(ev.id)
    ;(ev.ts >= rawCutoff ? batch.raw : batch.old).set(ev.id, ev)
  }
}
