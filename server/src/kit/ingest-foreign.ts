// Analytics toolkit ingest for the providers that are not Claude: Codex, OpenCode, DSH and Hermes
// (docs/ANALYTICS-PLAN.md §4.6, piece 6). It turns what usage-foreign.ts's readers see into
// usage_event rows in the KitStore and remembers, per source file, how far it got (ingest_cursor), so
// a second sweep reads only what is new. Nothing here is wired into the daemon's boot.
//
// GRANULARITY, per provider, is whatever the provider's own record allows:
//  * Codex: one event per counted turn (a delta of the running total), id `codex:<rollout>:<n>`. The
//    ordinal, not a byte offset, is the id, so two rollouts that replay the same session counter (the
//    live and archived copies of one file) upsert onto each other instead of adding. Subagent
//    rollouts are skipped for the same reason analytics.ts takes the largest rollout: they replay the
//    session-wide counter.
//  * DSH: one event per assistant message that reported usage, id `dsh:<session>:<row>`.
//  * OpenCode: one event per SESSION. Its session row is already totalled and carries no per-call
//    clock, so the session's own last-write time places it, exactly as analytics.ts does.
//  * Hermes: one event per (session, model), placed at the session's newest use, for the same reason.
// `billed_usd` is only ever OpenCode's own cost. Everything else is list-priced through pricing.ts.
import { Database } from 'bun:sqlite'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { extraRootsWithFormat } from '../agent-catalog'
import { DSH_HOME, OPENCODE_DB_PATH } from '../config'
import { codexInstanceStores } from '../core/codex-instances'
import { dshInstanceStores } from '../core/dsh-instances'
import { listDshSessions, readDshUsage } from '../dsh-sessions'
import { listHermesSessions, listHermesStores, readHermesUsage } from '../hermes-sessions'
import { pricesAsOf, priceTokens } from '../pricing'
import { codexRolloutIdentity } from '../transcript'
import {
  type CodexReaderState,
  CodexUsageReader,
  emptyModelSpend,
  openCodeModelName,
  openCodeSpend,
  weighTurnCounts,
} from '../usage-foreign'
import type { KitStore, UsageEventInput } from './store'

/** Bump to make every cursor read its file again (a parser fix that changes what is extracted). */
export const FOREIGN_INGEST_VERSION = 1
const BATCH = 5000

export interface ForeignSources {
  /** Rollout roots (`sessions/`, `archived_sessions/`) with the instance that owns them, if any. */
  codex: Array<{ root: string; instance: string | null }>
  opencode: Array<{ dbPath: string; tool: string }>
  hermes: Array<{ dbPath: string; profile: string | null }>
  dsh: Array<{ home: string; instance: string }>
}

export interface ForeignIngestOptions {
  /** Machine id stamped on every event. */
  pc?: string | null
  /** Called with the number of events written per source as each file finishes. */
  onFile?: (source: string, path: string, events: number) => void
}

export interface ForeignIngestSummary {
  files: number
  skipped: number
  events: Record<string, number>
}

/** Every store this machine has, found the same way the session indexer finds them. */
export function discoverForeignSources(): ForeignSources {
  const codex: ForeignSources['codex'] = []
  for (const s of codexInstanceStores()) {
    codex.push({ root: join(s.codexHome, 'sessions'), instance: s.ref })
    codex.push({ root: join(s.codexHome, 'archived_sessions'), instance: s.ref })
  }
  for (const r of extraRootsWithFormat('codex')) codex.push({ root: r.root, instance: null })

  const opencode: ForeignSources['opencode'] = [{ dbPath: OPENCODE_DB_PATH, tool: 'opencode' }]
  for (const r of extraRootsWithFormat('opencode'))
    if (r.tool.dbName) opencode.push({ dbPath: join(r.root, r.tool.dbName), tool: r.tool.id })

  const hermes: ForeignSources['hermes'] = []
  for (const r of extraRootsWithFormat('hermes'))
    if (r.tool.dbName)
      for (const s of listHermesStores(r.root, r.tool.dbName))
        hermes.push({ dbPath: s.dbPath, profile: s.profile })

  const dsh = dshInstanceStores().map((home) => ({
    home,
    instance: home === DSH_HOME ? 'dsh:default' : `dsh:${basename(home)}`,
  }))
  return { codex, opencode, hermes, dsh }
}

/** One sweep over every source. Only bytes (or rows) that arrived since the last sweep are read. */
export async function ingestForeign(
  store: KitStore,
  sources: ForeignSources,
  opts: ForeignIngestOptions = {},
): Promise<ForeignIngestSummary> {
  const sum: ForeignIngestSummary = { files: 0, skipped: 0, events: {} }
  const done = (source: string, path: string, n: number | null) => {
    if (n === null) {
      sum.skipped++
      return
    }
    sum.files++
    sum.events[source] = (sum.events[source] ?? 0) + n
    opts.onFile?.(source, path, n)
  }
  const touched = new Set<string>()
  for (const r of sources.codex)
    for (const path of codexRollouts(r.root))
      done('codex', path, await ingestCodexFile(store, path, r.instance, opts, touched))
  await reconcileCodex(store, touched, opts)
  for (const o of sources.opencode) done('opencode', o.dbPath, ingestOpenCode(store, o, opts))
  for (const h of sources.hermes) done('hermes', h.dbPath, ingestHermes(store, h, opts))
  for (const d of sources.dsh)
    for (const s of listDshSessions(d.home))
      done('dsh', s.path, ingestDshSession(store, s, d.instance, opts))
  return sum
}

// ---- shared ----

const PRICE_VER = () => pricesAsOf()

interface Counts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** list_usd for one call; null when the model has no price. */
function listUsd(model: string, c: Counts, at: number): number | null {
  const spend = {
    ...emptyModelSpend(),
    input: c.input,
    cacheRead: c.cacheRead,
    cacheCreation5m: c.cacheWrite,
    output: c.output,
    turns: 1,
  }
  const p = priceTokens({ [model]: spend }, at)
  return p.unpriced.length > 0 ? null : p.costUsd
}

function flush(store: KitStore, events: UsageEventInput[]): void {
  for (let i = 0; i < events.length; i += BATCH) store.upsertEvents(events.slice(i, i + BATCH))
}

const cursorUnchanged = (
  c: ReturnType<KitStore['getCursor']>,
  size: number,
  mtime: number,
): boolean => !!c && c.version === FOREIGN_INGEST_VERSION && c.size === size && c.mtime === mtime

function stat(path: string): { size: number; mtime: number } | null {
  try {
    const s = statSync(path)
    return { size: s.size, mtime: Math.floor(s.mtimeMs) }
  } catch {
    return null
  }
}

/** A SQLite store's change stamp: the file plus its write-ahead log, which holds the newest rows. */
function dbStamp(path: string): { size: number; mtime: number } | null {
  const main = stat(path)
  if (!main) return null
  const wal = stat(`${path}-wal`)
  return {
    size: main.size + (wal?.size ?? 0),
    mtime: Math.max(main.mtime, wal?.mtime ?? 0),
  }
}

// ---- Codex ----

interface CodexPending extends Counts {
  n: number
  ts: number
}

interface CodexFileState {
  skip?: boolean
  session: string
  /** The rollout's own key (see rolloutKey): the id and `ref` of every event it wrote. */
  ref?: string
  /** Everything counted so far, all kinds: how one rollout of a session is ranked against another. */
  total?: number
  /** Turns counted so far: the next turn's ordinal. */
  n: number
  reader: CodexReaderState
  /** Turns that spent before the rollout named a model. They are written under a placeholder model
   *  and rewritten once one is announced, so the spend is never missing and never mis-attributed
   *  for good. */
  pending: CodexPending[]
}

function codexRollouts(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return (readdirSync(root, { recursive: true }) as string[])
      .filter((rel) => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(rel))
      .map((rel) => join(root, rel))
  } catch {
    return []
  }
}

/** Complete lines from `offset`, each with the byte offset just past it. A trailing line without its
 *  newline is a write in progress and is left for the next sweep. */
async function* linesFrom(
  path: string,
  offset: number,
): AsyncGenerator<{ text: string; end: number }> {
  let carry: Buffer = Buffer.alloc(0)
  let pos = offset
  for await (const chunk of createReadStream(path, { start: offset })) {
    carry = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    let nl = carry.indexOf(0x0a)
    let from = 0
    while (nl >= 0) {
      pos += nl + 1 - from
      yield { text: carry.toString('utf8', from, nl), end: pos }
      from = nl + 1
      nl = carry.indexOf(0x0a, from)
    }
    carry = carry.subarray(from)
  }
}

function codexEvent(
  st: CodexFileState,
  t: CodexPending,
  model: string,
  instance: string | null,
  pc: string | null,
): UsageEventInput {
  const c: Counts = t
  return {
    id: `codex:${st.ref}:${t.n}`,
    ts: t.ts,
    pc,
    instance,
    session: st.session,
    agent: 'main',
    ref: st.ref,
    source: 'codex',
    model,
    provider: 'openai',
    input: t.input,
    output: t.output,
    cache_read: t.cacheRead,
    cache_write_5m: t.cacheWrite,
    list_usd: listUsd(model, c, t.ts),
    price_ver: PRICE_VER(),
    weighted: weighTurnCounts(model, c),
  }
}

const stateKey = (path: string) => `ingest_state:${path}`

/** A rollout's identity: its trailing uuid, else its file name. The live and archived copies of one
 *  rollout share it, so they upsert onto each other. */
function rolloutKey(path: string): string {
  const base = basename(path).replace(/\.jsonl$/, '')
  return base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? base
}

const totalKey = (session: string, ref: string) => `codex_total:${session}:${ref}`
const prunedKey = (session: string, ref: string) => `codex_pruned:${session}:${ref}`
const pathKey = (ref: string) => `codex_path:${ref}`

/** Returns events written, or null when the file was unchanged. */
async function ingestCodexFile(
  store: KitStore,
  path: string,
  instance: string | null,
  opts: ForeignIngestOptions,
  touched: Set<string>,
): Promise<number | null> {
  const st0 = stat(path)
  if (!st0) return null
  const cur = store.getCursor(path)
  if (cursorUnchanged(cur, st0.size, st0.mtime)) return null

  const raw = store.getMeta(stateKey(path))
  let offset = cur && cur.version === FOREIGN_INGEST_VERSION && raw ? cur.offset : 0
  let state: CodexFileState | null = raw && offset > 0 ? (JSON.parse(raw) as CodexFileState) : null
  if (offset > st0.size) {
    offset = 0
    state = null
  }
  if (state?.skip) {
    store.setCursor({ path, ...st0, offset: st0.size, version: FOREIGN_INGEST_VERSION })
    return 0
  }

  const pc = opts.pc ?? null
  const events: UsageEventInput[] = []
  const reader = new CodexUsageReader(state?.reader)
  const ref = rolloutKey(path)
  let session = state?.session ?? ''
  let total = state?.total ?? 0
  let n = state?.n ?? 0
  let pending: CodexPending[] = state?.pending ?? []
  let end = offset
  let lastTs = st0.mtime
  let first = offset === 0

  for await (const line of linesFrom(path, offset)) {
    end = line.end
    const text = line.text.trim()
    if (!text) continue
    let ev: unknown
    try {
      ev = JSON.parse(text)
    } catch {
      continue
    }
    if (first) {
      first = false
      const fallback = basename(path).replace(/\.jsonl$/, '')
      const ident = codexRolloutIdentity(
        ev,
        fallback.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ??
          fallback,
      )
      session = ident.sessionId
      if (ident.isSubagent) {
        const skipState: CodexFileState = {
          skip: true,
          session,
          n: 0,
          reader: reader.state(),
          pending: [],
        }
        store.setMeta(stateKey(path), JSON.stringify(skipState))
        store.setCursor({ path, ...st0, offset: st0.size, version: FOREIGN_INGEST_VERSION })
        return 0
      }
    }
    const turn = reader.push(ev)
    const model = reader.state().model
    const shell: CodexFileState = { session, ref, n, reader: reader.state(), pending }
    if (turn) {
      total += turn.input + turn.cacheRead + turn.cacheWrite + turn.output
      const t: CodexPending = {
        n: n++,
        ts: turn.ts ?? lastTs,
        input: turn.input,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
        output: turn.output,
      }
      lastTs = t.ts
      shell.n = n
      if (model) events.push(codexEvent(shell, t, model, instance, pc))
      else {
        pending.push(t)
        // `codex` is not a model any price table knows: the turn counts, unpriced, until named.
        events.push(codexEvent(shell, t, 'codex', instance, pc))
      }
    }
    if (model && pending.length) {
      for (const t of pending) events.push(codexEvent(shell, t, model, instance, pc))
      pending = []
    }
  }

  if (!session) {
    // Empty or header-less file: nothing to attribute yet, look again when it grows.
    store.setCursor({ path, ...st0, offset: 0, version: FOREIGN_INGEST_VERSION })
    return 0
  }
  flush(store, events)
  const next: CodexFileState = { session, ref, total, n, reader: reader.state(), pending }
  store.setMeta(stateKey(path), JSON.stringify(next))
  store.setMeta(totalKey(session, ref), String(total))
  store.setMeta(pathKey(ref), path)
  if (instance) store.setMeta(`codex_inst:${ref}`, instance)
  touched.add(session)
  store.setCursor({ path, ...st0, offset: end, version: FOREIGN_INGEST_VERSION })
  return events.length
}

/** A session can have several non-subagent rollouts whose counters replay or restart. Like
 *  analytics.ts, only the largest counts: the others' events are removed, and remembered as pruned so
 *  a loser that later becomes the largest is read again from its start. */
async function reconcileCodex(
  store: KitStore,
  touched: Set<string>,
  opts: ForeignIngestOptions,
): Promise<void> {
  const db = store.db
  let oldest = Infinity
  for (const session of touched) {
    for (let round = 0; round < 3; round++) {
      const rows = db
        .query('select key, value from meta where key like ?')
        .all(`${totalKey(session, '')}%`) as { key: string; value: string }[]
      const prefix = totalKey(session, '').length
      const refs = rows
        .map((r) => ({ ref: r.key.slice(prefix), total: Number(r.value) }))
        .sort((a, b) => b.total - a.total || (a.ref < b.ref ? -1 : 1))
      const winner = refs[0]
      if (!winner) break
      let minTs = Infinity
      for (const l of refs.slice(1)) {
        const gone = db
          .query(
            "select min(ts) as t from usage_event where source = 'codex' and session = ? and ref = ?",
          )
          .get(session, l.ref) as { t: number | null }
        if (gone.t !== null) {
          minTs = Math.min(minTs, gone.t)
          db.query(
            "delete from usage_event where source = 'codex' and session = ? and ref = ?",
          ).run(session, l.ref)
        }
        store.setMeta(prunedKey(session, l.ref), '1')
      }
      oldest = Math.min(oldest, minTs)
      if (store.getMeta(prunedKey(session, winner.ref)) === null) break
      // The winner was pruned earlier: its older events are gone, so read it again from the start.
      const path = store.getMeta(pathKey(winner.ref))
      db.query('delete from meta where key = ?').run(prunedKey(session, winner.ref))
      if (!path) break
      db.query('delete from ingest_cursor where path = ?').run(path)
      db.query('delete from meta where key = ?').run(stateKey(path))
      const again = new Set<string>()
      const inst = (store.getMeta(`codex_inst:${winner.ref}`) ?? null) || null
      await ingestCodexFile(store, path, inst, opts, again)
    }
  }
  if (oldest !== Infinity) store.rollup(oldest)
}

// ---- DSH ----

function ingestDshSession(
  store: KitStore,
  s: { session_id: string; path: string; last_activity_at: number },
  instance: string,
  opts: ForeignIngestOptions,
): number | null {
  const st = stat(s.path)
  if (!st) return null
  const cur = store.getCursor(s.path)
  if (cursorUnchanged(cur, st.size, st.mtime)) return null
  const rows = readDshUsage(s.path)
  let from = cur && cur.version === FOREIGN_INGEST_VERSION ? cur.offset : 0
  if (from > rows.length) from = 0
  const events: UsageEventInput[] = []
  for (let i = from; i < rows.length; i++) {
    const r = rows[i] as (typeof rows)[number]
    const model = r.model ?? 'unknown'
    const c: Counts = {
      input: r.tokens_input ?? 0,
      cacheRead: r.tokens_cache_read ?? 0,
      cacheWrite: r.tokens_cache_write ?? 0,
      output: r.tokens_output ?? 0,
    }
    const ts = r.time_ms ?? s.last_activity_at
    const slash = model.indexOf('/')
    events.push({
      id: `dsh:${s.session_id}:${i}`,
      ts,
      pc: opts.pc ?? null,
      instance,
      session: s.session_id,
      agent: 'main',
      source: 'dsh',
      model,
      provider: slash > 0 ? model.slice(0, slash) : 'deepseek',
      input: c.input,
      output: c.output,
      cache_read: c.cacheRead,
      cache_write_5m: c.cacheWrite,
      // A subset of output, kept as its own column, never added to it.
      reasoning: r.tokens_reasoning ?? 0,
      list_usd: listUsd(model, c, ts),
      price_ver: PRICE_VER(),
      weighted: weighTurnCounts(model, c),
    })
  }
  flush(store, events)
  store.setCursor({
    path: s.path,
    ...st,
    offset: rows.length,
    version: FOREIGN_INGEST_VERSION,
  })
  return events.length
}

// ---- OpenCode ----

interface OpenCodeRow {
  id: string
  directory: string | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  cost: number | null
  time_updated: number | null
}

function providerOfOpenCode(raw: string | null): string {
  try {
    const m = JSON.parse(raw ?? '') as { providerID?: unknown }
    if (typeof m.providerID === 'string' && m.providerID) return m.providerID
  } catch {
    // not a JSON blob: the name carries no provider
  }
  return 'opencode'
}

function ingestOpenCode(
  store: KitStore,
  o: { dbPath: string; tool: string },
  opts: ForeignIngestOptions,
): number | null {
  const stamp = dbStamp(o.dbPath)
  if (!stamp) return null
  const cur = store.getCursor(o.dbPath)
  if (cursorUnchanged(cur, stamp.size, stamp.mtime)) return null
  const since = cur && cur.version === FOREIGN_INGEST_VERSION ? cur.offset : 0

  let db: Database
  try {
    db = new Database(o.dbPath, { readonly: true })
  } catch {
    return null
  }
  let rows: OpenCodeRow[]
  try {
    rows = db
      .query<OpenCodeRow, [number]>(
        `select id, directory, model, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, cost, time_updated
         from session where time_updated > ?`,
      )
      .all(since)
  } catch {
    return null // an older store without these columns
  } finally {
    db.close()
  }

  const events: UsageEventInput[] = []
  let newest = since
  for (const row of rows) {
    if (typeof row.time_updated !== 'number') continue
    newest = Math.max(newest, row.time_updated)
    const spend = openCodeSpend(row)
    const model = openCodeModelName(row.model)
    const m = spend.byModel[model]
    if (!m) continue // no tokens: nothing was spent
    const c: Counts = {
      input: m.input,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheCreation5m,
      output: m.output,
    }
    events.push({
      id: `opencode:${o.tool}:${row.id}`,
      ts: row.time_updated,
      pc: opts.pc ?? null,
      session: row.id,
      agent: 'main',
      source: 'opencode',
      model,
      provider: providerOfOpenCode(row.model),
      input: c.input,
      output: c.output,
      cache_read: c.cacheRead,
      cache_write_5m: c.cacheWrite,
      reasoning: spend.reasoning,
      list_usd: listUsd(model, c, row.time_updated),
      billed_usd: spend.costUsd,
      price_ver: PRICE_VER(),
      weighted: m.weighted,
    })
  }
  flush(store, events)
  store.setCursor({ path: o.dbPath, ...stamp, offset: newest, version: FOREIGN_INGEST_VERSION })
  return events.length
}

// ---- Hermes ----

function ingestHermes(
  store: KitStore,
  h: { dbPath: string; profile: string | null },
  opts: ForeignIngestOptions,
): number | null {
  const stamp = dbStamp(h.dbPath)
  if (!stamp) return null
  const cur = store.getCursor(h.dbPath)
  if (cursorUnchanged(cur, stamp.size, stamp.mtime)) return null
  const since = cur && cur.version === FOREIGN_INGEST_VERSION ? cur.offset : 0

  const events: UsageEventInput[] = []
  let newest = since
  const key = h.profile ?? 'default'
  for (const s of listHermesSessions(h.dbPath, h.profile)) {
    if (s.last_activity_at <= since) continue
    newest = Math.max(newest, s.last_activity_at)
    const rows = readHermesUsage(s.session_id, h.dbPath)
    // The whole session sits at its newest use: below the per-model aggregate there is no clock.
    let at = 0
    for (const r of rows) if (r.last_seen_ms !== null && r.last_seen_ms > at) at = r.last_seen_ms
    if (at === 0) continue
    for (const r of rows) {
      const c: Counts = {
        input: r.input_tokens,
        cacheRead: r.cache_read_tokens,
        cacheWrite: r.cache_write_tokens,
        output: r.output_tokens,
      }
      if (c.input + c.cacheRead + c.cacheWrite + c.output === 0) continue
      const slash = r.model.indexOf('/')
      events.push({
        id: `hermes:${key}:${s.session_id}:${r.model}`,
        ts: at,
        pc: opts.pc ?? null,
        session: s.session_id,
        agent: s.parent_id ? 'subagent' : 'main',
        source: 'hermes',
        model: r.model,
        provider: slash > 0 ? r.model.slice(0, slash) : 'hermes',
        input: c.input,
        output: c.output,
        cache_read: c.cacheRead,
        cache_write_5m: c.cacheWrite,
        reasoning: r.reasoning_tokens,
        list_usd: listUsd(r.model, c, at),
        price_ver: PRICE_VER(),
        weighted: weighTurnCounts(r.model, c),
      })
    }
  }
  flush(store, events)
  store.setCursor({ path: h.dbPath, ...stamp, offset: newest, version: FOREIGN_INGEST_VERSION })
  return events.length
}
