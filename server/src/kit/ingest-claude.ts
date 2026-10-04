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
//  * THE 35-DAY WINDOW. A call older than the raw window goes straight to usage_hour (store.addToHourly,
//    additive, in the same transaction as the file's cursor). Re-reading a file from 0 after a shrink
//    or a version bump skips those rows, which were counted the first time.
//  * A session moved between config dirs (a CliMayte handoff copies the transcript) has the same message
//    ids in both. Files go OLDEST first and the first to claim an id keeps it, so the account that ran
//    the call is the one credited; account-tokens, counting per file, credits the copy's account too.
//  * GENTLE. The first sweep reads tens of GB. Files go oldest first, in READ_CHUNK pieces, each piece
//    followed by a yield to the event loop; the read rate is capped (maxBytesPerSec) and the store is
//    committed every FLUSH_BYTES, so a restart continues at the last commit.
import { createHash } from 'node:crypto'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { CLAUDE_PROJECTS_ROOT } from '../config'
import { cliAccountUuid, holderAt, readHolders } from '../core/account-tokens'
import { collectChatsAsync, lineageIdsOf } from '../core/chat-store-scan'
import { listCliInstances } from '../core/cli-instances'
import { POINTER_DIR } from '../instance'
import { pricesAsOf, priceTokens } from '../pricing'
import { hswarmAccountId } from '../routes/hswarm'
import { accumulateUsageLine, defaultConfigDir, emptySpend } from '../usage-tokens'
import { hourStart, type KitStore, RAW_RETENTION_DAYS, type UsageEventInput } from './store'

/** Bump to make every cursor read its file again (a parser fix that changes what is extracted). */
export const CLAUDE_INGEST_VERSION = 1

/** Bytes read per step; each step ends in a yield to the event loop. */
const READ_CHUNK = 4 * 1024 * 1024
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

export interface ClaudeIngestOptions {
  pc?: string | null
  /** Session ids that belong to a CliMayte attempt. */
  climayte?: ReadonlySet<string>
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

/** Every sweep target on this PC: each CLI instance's `projects`, and the shared store. */
export async function discoverClaudeRoots(): Promise<ClaudeRoot[]> {
  const roots: ClaudeRoot[] = []
  const holders = readHolders()
  for (const inst of listCliInstances()) {
    const history = holders[inst.configDir] ?? []
    const now = cliAccountUuid(inst.configDir, inst.loggedIn)
    const owner: ClaudeFileOwner = {
      instance: `cli:${inst.id}`,
      source: 'cli',
      // A holder history only exists once account-tokens has swept this instance.
      accountAt: history.length ? (ts) => holderAt(history, ts) : () => now,
    }
    roots.push({ dir: join(inst.configDir, 'projects'), owner: () => owner })
  }

  // The shared store: desktop chats write here. A chat record names the profile and the account (the
  // folder it is filed in); the newest non-archived record wins, as in account-tokens.
  const chats = new Map<string, { rank: string; owner: ClaudeFileOwner }>()
  for (const c of await collectChatsAsync()) {
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
  const defaultUuid = cliAccountUuid(defaultConfigDir(), true)
  const fallback: ClaudeFileOwner = {
    instance: 'default',
    source: 'cli',
    accountAt: () => defaultUuid,
  }
  roots.push({ dir: CLAUDE_PROJECTS_ROOT, owner: (sid) => chats.get(sid)?.owner ?? fallback })
  return roots
}

const climayteFiles = new Map<string, { mtimeMs: number; size: number; ids: string[] }>()

/** Session ids of every CliMayte attempt: in-flight work in workers.json, finished work in done/*.json.
 *  Each file is parsed again only when its size or mtime moves. */
export async function climayteSessionIds(
  corchDir: string = join(POINTER_DIR, 'corch'),
): Promise<Set<string>> {
  const out = new Set<string>()
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
      const st = await stat(p)
      let rec = climayteFiles.get(p)
      if (!rec || rec.mtimeMs !== st.mtimeMs || rec.size !== st.size) {
        const parsed = JSON.parse(await readFile(p, 'utf8'))
        const ids: string[] = []
        for (const w of Array.isArray(parsed?.workers) ? parsed.workers : [parsed])
          for (const a of Array.isArray(w?.attempts) ? w.attempts : [])
            if (typeof a?.sessionId === 'string' && a.sessionId) ids.push(a.sessionId)
        rec = { mtimeMs: st.mtimeMs, size: st.size, ids }
        climayteFiles.set(p, rec)
      }
      for (const id of rec.ids) out.add(id)
    } catch {
      // missing or half-written: the next sweep reads it again
    }
  }
  for (const p of climayteFiles.keys()) if (!live.has(p)) climayteFiles.delete(p)
  return out
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
    owner: ClaudeFileOwner
    source: string
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
  const priced = priceTokens({ [model]: m }, ts)
  return {
    id,
    ts,
    pc: ctx.pc,
    account: ctx.accountId(ctx.owner.accountAt(ts)),
    instance: ctx.owner.instance,
    session: ctx.session,
    agent: ctx.agent,
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
  owner: ClaudeFileOwner
}

async function jsonlUnder(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await jsonlUnder(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
}

/** `<project>/<session>.jsonl` or `<project>/<session>/subagents/<agent>.jsonl`. Anything else is not ours. */
function classify(
  root: string,
  path: string,
): { session: string; agent: 'main' | 'subagent' } | null {
  const parts = relative(root, path).split(sep)
  if (parts.length === 2) return { session: basename(parts[1] as string, '.jsonl'), agent: 'main' }
  if (parts.length >= 4 && parts[2] === 'subagents')
    return { session: parts[1] as string, agent: 'subagent' }
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
  const climayte = opts.climayte ?? new Set<string>()
  const throttle = makeThrottle(opts.maxBytesPerSec ?? DEFAULT_MAX_BYTES_PER_SEC)
  const priceVer = pricesAsOf()
  const rawCutoff = hourStart(now - RAW_RETENTION_DAYS * DAY_MS)
  const accountIds = new Map<string, string>()
  const accountId = (uuid: string | null): string | null => {
    if (!uuid) return null
    const known = accountIds.get(uuid)
    if (known) return known
    const id = hswarmAccountId(uuid)
    accountIds.set(uuid, id)
    return id
  }

  // 1. Which files exist, and which have something new.
  const cursors = new Map<string, ReturnType<KitStore['getCursor']>>()
  const candidates: Candidate[] = []
  for (const root of roots) {
    for (const row of store.db
      .query('select * from ingest_cursor where path >= ? and path < ?')
      .all(root.dir, `${root.dir}￿`) as NonNullable<ReturnType<KitStore['getCursor']>>[])
      cursors.set(row.path, row)
    const paths: string[] = []
    await jsonlUnder(root.dir, paths)
    const owners = new Map<string, ClaudeFileOwner | null>()
    for (const path of paths) {
      const c = classify(root.dir, path)
      if (!c) continue
      if (!owners.has(c.session)) owners.set(c.session, root.owner(c.session))
      const owner = owners.get(c.session)
      if (owner) candidates.push({ path, ...c, owner })
    }
  }
  const stats = new Map<string, { size: number; mtimeMs: number }>()
  const todo: Candidate[] = []
  for (const c of candidates) {
    const cur = cursors.get(c.path)
    if (cur && cur.version === CLAUDE_INGEST_VERSION && cur.mtime < now - QUIET_MS && !fullPass)
      sum.unchanged++
    else todo.push(c)
  }
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
  const work = todo
    .filter((c) => {
      const st = stats.get(c.path)
      if (!st || st.mtimeMs < (opts.minMtimeMs ?? 0)) return false
      const cur = cursors.get(c.path)
      const same = cur && cur.version === CLAUDE_INGEST_VERSION && cur.size === st.size
      if (same) sum.unchanged++
      return !same
    })
    .sort((a, b) => (stats.get(a.path)?.mtimeMs ?? 0) - (stats.get(b.path)?.mtimeMs ?? 0))

  // 2. Read them, oldest first.
  for (const c of work) {
    const st = stats.get(c.path) as { size: number; mtimeMs: number }
    const cur = cursors.get(c.path)
    const known = cur && cur.version === CLAUDE_INGEST_VERSION ? cur : null
    let start = known ? known.offset : 0
    // Shrunk (or the offset lies past the end): the file was rewritten, read it whole.
    const reset = known !== null && (st.size < known.size || start > st.size)
    if (reset) start = 0
    // A re-read of a file counted before must not add its old rows to usage_hour a second time.
    const recount = !!cur && (reset || !known)
    const ctx = {
      session: c.session,
      agent: c.agent,
      owner: c.owner,
      source: climayte.has(c.session) ? 'climayte' : c.owner.source,
      pc,
      priceVer,
      accountId,
    }
    try {
      const r = await readFileInto(store, c.path, start, st, ctx, rawCutoff, recount, throttle)
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

async function readFileInto(
  store: KitStore,
  path: string,
  start: number,
  st: { size: number; mtimeMs: number },
  ctx: Parameters<typeof claudeLineEvent>[2],
  rawCutoff: number,
  recount: boolean,
  throttle: (n: number) => Promise<void>,
): Promise<{ bytes: number; events: number; hourly: number }> {
  const fh = await open(path, 'r')
  const out = { bytes: 0, events: 0, hourly: 0 }
  try {
    let pos = start // next byte to read
    let carry: Buffer = Buffer.alloc(0) // bytes after the last newline read so far
    let raw = new Map<string, UsageEventInput>()
    let old = new Map<string, UsageEventInput>()
    let sinceFlush = 0
    // A session moved to another account's config dir (a CliMayte handoff) leaves its messages in both
    // dirs under the same ids, and only the first dir's account ran them. The first to claim an id keeps
    // it; the same instance and session writing it again replaces it (last write wins).
    const owner = store.db.prepare('select instance, session from usage_event where id = ?')
    const unclaimed = (evs: UsageEventInput[]) =>
      evs.filter((e) => {
        const have = owner.get(e.id) as { instance: string | null; session: string | null } | null
        return !have || (have.instance === e.instance && have.session === e.session)
      })
    const commit = (offset: number, size: number) => {
      store.db.transaction(() => {
        out.events += store.upsertEvents(unclaimed([...raw.values()]))
        if (!recount) out.hourly += store.addToHourly([...old.values()])
        store.setCursor({
          path,
          size,
          mtime: st.mtimeMs,
          offset,
          version: CLAUDE_INGEST_VERSION,
        })
      })()
      raw = new Map()
      old = new Map()
      sinceFlush = 0
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
        for (const line of data.toString('utf8', 0, nl).split('\n')) {
          const ev = claudeLineEvent(line, st.mtimeMs, ctx)
          if (ev) (ev.ts >= rawCutoff ? raw : old).set(ev.id, ev)
        }
        carry = Buffer.from(data.subarray(nl + 1))
      }
      if (sinceFlush >= FLUSH_BYTES) commit(pos - carry.length, pos)
      await throttle(bytesRead)
    }
    commit(pos - carry.length, pos)
  } finally {
    await fh.close()
  }
  return out
}
