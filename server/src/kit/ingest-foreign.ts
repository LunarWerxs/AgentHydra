// Analytics toolkit ingest for the providers that are not Claude: Codex, OpenCode, DSH and Hermes
// (docs/ANALYTICS-PLAN.md §4.6, piece 6). It turns what usage-foreign.ts's readers see into
// usage_event rows in the KitStore and remembers, per source file, how far it got (ingest_cursor), so
// a second sweep reads only what is new. Nothing here is wired into the daemon's boot.
//
// GRANULARITY, per provider, is whatever the provider's own record allows:
//  * Codex: one event per counted turn (a delta of the running total), id `codex:<rollout>:<n>`. The
//    ordinal, not a byte offset, is the id, so two rollouts that replay the same session counter (the
//    live and archived copies of one file, or a copy packed into `archived_sessions/_packed/*.zip`)
//    upsert onto each other instead of adding. A SUBAGENT rollout keeps a counter of its own (measured
//    2026-10-09: a parent that ended at 89.9M had four subagents that spent 134M between them, none of it
//    in the parent's counter), so its turns count, as agent `subagent`. Only the parent history it copied
//    at the spawn is skipped: the lines before `subagent_history_start_ordinal`, or, in a rollout from
//    before Codex wrote that field, the lines stamped with the spawn's own timestamp.
//  * DSH: one event per assistant message that reported usage, id `dsh:<session>:<row>`.
//  * OpenCode: one event per model call, id `opencode:<tool>:<part>`: each `step-finish` part carries its
//    own step's tokens and cost, placed at the part's own time. (The session row's totals, which the first
//    version took as ONE call at the session's last write, made 3,443 calls in a week read as 6.)
//  * Hermes: one event per (session, model), placed at the session's newest use: below the per-model
//    aggregate it keeps no per-call clock.
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
  weighTurnCounts,
} from '../usage-foreign'
import { hswarmLedgerPath, ingestHswarm } from './ingest-hswarm'
import { type KitStore, type UsageEventInput, yieldLoop } from './store'
import { type ZipEntry, zipEntries, zipEntryStream } from './zip-entries'

/** Bump to make every cursor read its file again (a parser fix that changes what is extracted).
 *  2: subagent rollouts count (their skip states are read again) and OpenCode is read per call. */
export const FOREIGN_INGEST_VERSION = 2

/** Packed-rollout bytes (uncompressed) one sweep reads at most: ~10 GB of history is taken over many
 *  sweeps instead of holding one for minutes. Each entry finishes once started; its cursor marks it read. */
const PACKED_BYTES_PER_SWEEP = 512 * 1024 * 1024

export interface ForeignSources {
  /** Rollout roots (`sessions/`, `archived_sessions/`) with the instance that owns them, if any. */
  codex: Array<{ root: string; instance: string | null }>
  opencode: Array<{ dbPath: string; tool: string }>
  hermes: Array<{ dbPath: string; profile: string | null }>
  dsh: Array<{ home: string; instance: string }>
  /** HSwarm ledger files (ingest-hswarm.ts). */
  hswarm?: string[]
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
  return { codex, opencode, hermes, dsh, hswarm: [hswarmLedgerPath()] }
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
  let packedBudget = PACKED_BYTES_PER_SWEEP
  for (const r of sources.codex) {
    for (const path of codexRollouts(r.root)) {
      const src = fileRollout(path)
      if (src) done('codex', path, await ingestCodexRollout(store, src, r.instance, opts, touched))
    }
    for (const src of packedRollouts(r.root)) {
      if (packedBudget <= 0) break // the rest waits for the next sweep
      const n = await ingestCodexRollout(store, src, r.instance, opts, touched)
      if (n !== null) packedBudget -= src.stat.size
      done('codex', src.key, n)
    }
  }
  await reconcileCodex(store, touched, opts)
  for (const o of sources.opencode) done('opencode', o.dbPath, await ingestOpenCode(store, o, opts))
  for (const h of sources.hermes) done('hermes', h.dbPath, await ingestHermes(store, h, opts))
  for (const d of sources.dsh)
    for (const s of listDshSessions(d.home)) {
      done('dsh', s.path, await ingestDshSession(store, s, d.instance, opts))
      await yieldLoop()
    }
  for (const p of sources.hswarm ?? [])
    done('hswarm', p, await ingestHswarm(store, p, { pc: opts.pc }))
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

/** list_usd for one call; null when the model has no price. `promptTokens` is that call's prompt
 *  when `c` is ONE request (it picks a tiered model's rates); a running total leaves it 0, the
 *  short-prompt tier. */
function listUsd(model: string, c: Counts, at: number, promptTokens = 0): number | null {
  const spend = {
    ...emptyModelSpend(),
    input: c.input,
    cacheRead: c.cacheRead,
    cacheCreation5m: c.cacheWrite,
    output: c.output,
    turns: 1,
  }
  const p = priceTokens({ [model]: spend }, at, promptTokens)
  return p.unpriced.length > 0 ? null : p.costUsd
}

async function flush(store: KitStore, events: UsageEventInput[]): Promise<void> {
  await store.upsertEventsAsync(events)
}

// An OpenCode or Hermes event is a session's running TOTAL, rewritten by id on every change. Once its row is
// older than the raw window the prune folds it into the rollups and deletes it, so a session that resumes would
// write its full total again on top of what is settled. Per cumulative id the total last written is kept in
// meta (`cum:`), and a row that is gone since then moves it to the base (`cumbase:`): the new row holds only
// what came after it.
const CUM_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'reasoning',
  'list_usd',
  'billed_usd',
  'weighted',
] as const
type CumField = (typeof CUM_FIELDS)[number]
type CumTotals = Partial<Record<CumField, number | null>>
const CUM_SLICE = 500

const parseTotals = (v: string | null): CumTotals | null => {
  if (v === null) return null
  try {
    return JSON.parse(v) as CumTotals
  } catch {
    return null
  }
}

/** Writes cumulative events as the part of each total that is not settled already (see above). */
async function flushCumulative(store: KitStore, events: UsageEventInput[]): Promise<void> {
  const exists = store.db.prepare('select 1 from usage_event where id = ?')
  for (let i = 0; i < events.length; i += CUM_SLICE) {
    const out: UsageEventInput[] = []
    const metas: [string, string][] = []
    for (const ev of events.slice(i, i + CUM_SLICE)) {
      const total: CumTotals = {}
      for (const f of CUM_FIELDS) total[f] = ev[f] ?? null
      let base = parseTotals(store.getMeta(`cumbase:${ev.id}`))
      const written = parseTotals(store.getMeta(`cum:${ev.id}`))
      if (written && !exists.get(ev.id)) {
        base = written // the row was pruned into the rollups with exactly this total
        metas.push([`cumbase:${ev.id}`, JSON.stringify(written)])
      }
      metas.push([`cum:${ev.id}`, JSON.stringify(total)])
      if (!base) {
        out.push(ev)
        continue
      }
      const delta: UsageEventInput = { ...ev }
      for (const f of CUM_FIELDS) {
        const b = base[f]
        const t = total[f]
        if (typeof b !== 'number' || typeof t !== 'number') continue
        delta[f] = Math.max(0, t - b)
      }
      out.push(delta)
    }
    await store.upsertEventsAsync(out)
    store.db.transaction(() => {
      for (const [k, v] of metas) store.setMeta(k, v)
    })()
  }
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

/** Where a subagent rollout's own history starts. The lines before it are the parent's, copied at the
 *  spawn: they move the running total and count nothing. `until` is Codex's own ordinal (a line index,
 *  the header being 0); a rollout written before Codex had it stamps every copied line with `spawnTs`. */
interface CopiedPrefix {
  until: number | null
  spawnTs: string | null
}

interface CodexFileState {
  session: string
  /** Set on a subagent rollout. */
  copy?: CopiedPrefix
  /** Lines read so far, the header included: the next line's index. */
  line?: number
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

const ROLLOUT_NAME = /(^|[\\/])rollout-[^\\/]*\.jsonl$/

/** Files under `root` whose relative path matches `name`; [] when the root is missing or unreadable. */
function filesUnder(root: string, name: RegExp): string[] {
  if (!existsSync(root)) return []
  try {
    return (readdirSync(root, { recursive: true }) as string[])
      .filter((rel) => name.test(rel))
      .map((rel) => join(root, rel))
  } catch {
    return []
  }
}

const codexRollouts = (root: string): string[] => filesUnder(root, ROLLOUT_NAME)

type Lines = AsyncGenerator<{ text: string; end: number }>

/** One rollout to read: a file, or an entry of a packed zip, keyed `<zip>!<entry>`. */
interface RolloutSource {
  key: string
  stat: { size: number; mtime: number }
  lines: (offset: number) => Lines
}

function fileRollout(path: string): RolloutSource | null {
  const st = stat(path)
  return st && { key: path, stat: st, lines: (offset) => linesFrom(path, offset) }
}

/** An entry is immutable while its zip is: its size is the uncompressed size, its mtime the zip's. */
function packedRollout(zip: string, e: ZipEntry, zipMtime: number): RolloutSource {
  return {
    key: `${zip}!${e.name}`,
    stat: { size: e.size, mtime: zipMtime },
    lines: (offset) => packedLines(zip, e, offset),
  }
}

async function* packedLines(zip: string, e: ZipEntry, offset: number): Lines {
  const bytes = zipEntryStream(zip, e)
  if (!bytes) return
  for await (const line of splitLines(bytes, 0)) if (line.end > offset) yield line
}

/** Rollouts packed into zips under `root` (Codex homes keep them in archived_sessions/_packed). */
function packedRollouts(root: string): RolloutSource[] {
  const out: RolloutSource[] = []
  for (const zip of filesUnder(root, /\.zip$/i)) {
    const st = stat(zip)
    if (!st) continue
    for (const e of zipEntries(zip))
      if (ROLLOUT_NAME.test(e.name)) out.push(packedRollout(zip, e, st.mtime))
  }
  return out
}

/** The rollout a saved key names (reconcileCodex reads a pruned winner again by it). */
function rolloutByKey(key: string): RolloutSource | null {
  const packed = /^(.*\.zip)!(.+)$/i.exec(key)
  if (!packed) return fileRollout(key)
  const [, zip = '', name] = packed
  const st = stat(zip)
  const e = st && zipEntries(zip).find((x) => x.name === name)
  return st && e ? packedRollout(zip, e, st.mtime) : null
}

/** Complete lines from `offset`, each with the byte offset just past it. A trailing line without its
 *  newline is a write in progress and is left for the next sweep. */
function linesFrom(path: string, offset: number): Lines {
  return splitLines(createReadStream(path, { start: offset }), offset)
}

/** A byte stream that starts at `offset`, cut into complete lines. */
async function* splitLines(chunks: AsyncIterable<Buffer>, offset: number): Lines {
  let carry: Buffer = Buffer.alloc(0)
  let pos = offset
  for await (const chunk of chunks) {
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
    agent: st.copy ? 'subagent' : 'main',
    agent_id: st.copy ? (st.ref ?? null) : null,
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

/** Where a rollout's read picks up: the saved offset and state, or the top with none when either is
 *  missing, from an older version, or past the end of the file. */
function codexResume(
  store: KitStore,
  path: string,
  cur: ReturnType<KitStore['getCursor']>,
  size: number,
): { offset: number; state: CodexFileState | null } {
  const raw = store.getMeta(stateKey(path))
  const offset = cur && cur.version === FOREIGN_INGEST_VERSION && raw ? cur.offset : 0
  const state = raw && offset > 0 ? (JSON.parse(raw) as CodexFileState) : null
  if (offset > size) return { offset: 0, state: null }
  return { offset, state }
}

/** One rollout's read so far: what CodexFileState saves, plus the events still to write. */
interface CodexRun {
  session: string
  copy?: CopiedPrefix
  line: number
  total: number
  n: number
  pending: CodexPending[]
  lastTs: number
  events: UsageEventInput[]
}

/** Only these lines move the counter or name the model: the rest, most of a rollout's bytes, are never parsed. */
const COUNTED = /"(token_count|turn_context)"/

function parseLine(text: string): unknown {
  const t = text.trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function copiedPrefix(header: unknown): CopiedPrefix {
  const h = header as { timestamp?: unknown; payload?: Record<string, unknown> } | null
  const until = h?.payload?.subagent_history_start_ordinal
  return {
    until: typeof until === 'number' ? until : null,
    spawnTs: typeof h?.timestamp === 'string' ? h.timestamp : null,
  }
}

/** Whether the line at index `line` belongs to a subagent's copy of its parent's history. */
function isCopied(copy: CopiedPrefix | undefined, line: number, ev: unknown): boolean {
  if (!copy) return false
  if (copy.until !== null) return line < copy.until
  return copy.spawnTs !== null && (ev as { timestamp?: unknown }).timestamp === copy.spawnTs
}

/** The rollout's first parsed line names its session (the rollout key is the fallback) and says whether
 *  it is a subagent's. */
function readIdentity(run: CodexRun, ev: unknown, ref: string): void {
  const ident = codexRolloutIdentity(ev, ref)
  run.session = ident.sessionId
  if (ident.isSubagent) run.copy = copiedPrefix(ev)
}

/** One parsed line: the turn it closes becomes an event, and turns that waited for a model get theirs.
 *  A line of a subagent's copied prefix only moves the running total. */
function codexLine(
  run: CodexRun,
  reader: CodexUsageReader,
  ev: unknown,
  ref: string,
  instance: string | null,
  pc: string | null,
  copied: boolean,
): void {
  const turn = reader.push(ev)
  if (copied) return
  const model = reader.state().model
  const shell: CodexFileState = {
    session: run.session,
    copy: run.copy,
    ref,
    n: run.n,
    reader: reader.state(),
    pending: run.pending,
  }
  if (turn) {
    run.total += turn.input + turn.cacheRead + turn.cacheWrite + turn.output
    const t: CodexPending = {
      n: run.n++,
      ts: turn.ts ?? run.lastTs,
      input: turn.input,
      cacheRead: turn.cacheRead,
      cacheWrite: turn.cacheWrite,
      output: turn.output,
    }
    run.lastTs = t.ts
    shell.n = run.n
    if (model) run.events.push(codexEvent(shell, t, model, instance, pc))
    else {
      run.pending.push(t)
      // `codex` is not a model any price table knows: the turn counts, unpriced, until named.
      run.events.push(codexEvent(shell, t, 'codex', instance, pc))
    }
  }
  if (model && run.pending.length) {
    for (const t of run.pending) run.events.push(codexEvent(shell, t, model, instance, pc))
    run.pending = []
  }
}

/** Returns events written, or null when the rollout was unchanged. */
async function ingestCodexRollout(
  store: KitStore,
  src: RolloutSource,
  instance: string | null,
  opts: ForeignIngestOptions,
  touched: Set<string>,
): Promise<number | null> {
  const { key, stat: st0 } = src
  const cur = store.getCursor(key)
  if (cursorUnchanged(cur, st0.size, st0.mtime)) return null

  const { offset, state } = codexResume(store, key, cur, st0.size)
  const pc = opts.pc ?? null
  const reader = new CodexUsageReader(state?.reader)
  const ref = rolloutKey(key)
  const run: CodexRun = {
    session: state?.session ?? '',
    copy: state?.copy,
    line: state?.line ?? 0,
    total: state?.total ?? 0,
    n: state?.n ?? 0,
    pending: state?.pending ?? [],
    lastTs: st0.mtime,
    events: [],
  }
  let end = offset

  for await (const l of src.lines(offset)) {
    end = l.end
    const index = run.line++
    const ev = !run.session || COUNTED.test(l.text) ? parseLine(l.text) : null
    if (ev === null) continue
    if (!run.session) readIdentity(run, ev, ref)
    codexLine(run, reader, ev, ref, instance, pc, isCopied(run.copy, index, ev))
  }

  const { session, copy, line, total, n, pending, events } = run
  if (!session) {
    // Empty or header-less file: nothing to attribute yet, look again when it grows.
    store.setCursor({ path: key, ...st0, offset: 0, version: FOREIGN_INGEST_VERSION })
    return 0
  }
  await flush(store, events)
  const next: CodexFileState = {
    session,
    copy,
    line,
    ref,
    total,
    n,
    reader: reader.state(),
    pending,
  }
  store.setMeta(stateKey(key), JSON.stringify(next))
  // A subagent's counter is its own: it never competes with its session's main rollouts (reconcileCodex).
  if (!copy) store.setMeta(totalKey(session, ref), String(total))
  store.setMeta(pathKey(ref), key)
  if (instance) store.setMeta(`codex_inst:${ref}`, instance)
  touched.add(session)
  store.setCursor({ path: key, ...st0, offset: end, version: FOREIGN_INGEST_VERSION })
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
      const src = rolloutByKey(path)
      if (src) await ingestCodexRollout(store, src, inst, opts, again)
    }
  }
  if (oldest !== Infinity) await store.rollupAsync(oldest)
}

// ---- DSH ----

async function ingestDshSession(
  store: KitStore,
  s: { session_id: string; path: string; last_activity_at: number },
  instance: string,
  opts: ForeignIngestOptions,
): Promise<number | null> {
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
      // One DSH assistant message is one request.
      list_usd: listUsd(model, c, ts, c.input + c.cacheRead + c.cacheWrite),
      price_ver: PRICE_VER(),
      weighted: weighTurnCounts(model, c),
    })
  }
  await flush(store, events)
  store.setCursor({
    path: s.path,
    ...st,
    offset: rows.length,
    version: FOREIGN_INGEST_VERSION,
  })
  return events.length
}

// ---- OpenCode ----

/** One model call: a `step-finish` part, which carries that step's own tokens and cost. */
interface OpenCodeStep {
  id: string
  session_id: string
  ts: number
  model: string | null
  provider: string | null
  input: number | null
  output: number | null
  reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  cost: number | null
}

// Parts are read past the last rowid taken: a step-finish part is written once, when its step ends, and
// the rowid search never touches the older parts' blobs (the store holds GBs of them). A first read goes a
// page of rowids at a time with a loop turn between: one query over every part held the daemon for 2 s.
const OPENCODE_PAGE = 2000
const OPENCODE_STEPS = `select p.id, p.session_id, p.time_created as ts,
    json_extract(m.data, '$.modelID') as model, json_extract(m.data, '$.providerID') as provider,
    json_extract(p.data, '$.tokens.input') as input, json_extract(p.data, '$.tokens.output') as output,
    json_extract(p.data, '$.tokens.reasoning') as reasoning,
    json_extract(p.data, '$.tokens.cache.read') as cache_read,
    json_extract(p.data, '$.tokens.cache.write') as cache_write, json_extract(p.data, '$.cost') as cost
  from part p left join message m on m.id = p.message_id
  where p.rowid > ? and p.rowid <= ? and json_extract(p.data, '$.type') = 'step-finish'
  order by p.rowid`

/** Set once the per-session events are gone: the per-call read replaces them, never adds to them. */
const OPENCODE_PER_CALL = 'opencode_per_call'

/**
 * Once: drop what the per-session ingest wrote (each session's whole total as one call at its last write),
 * raw rows, rollups and session ledger alike, with its cumulative bases. Another PC's imported rows stay.
 * The cursors still carry the old version, so the per-call read that follows starts from the first part.
 */
function dropOpenCodeSessionTotals(store: KitStore): void {
  if (store.getMeta(OPENCODE_PER_CALL)) return
  const db = store.db
  db.transaction(() => {
    db.query(
      "delete from meta where key like 'cum:opencode:%' or key like 'cumbase:opencode:%'",
    ).run()
    db.query("delete from usage_event where source = 'opencode'").run()
    for (const table of ['usage_hour', 'usage_session', 'usage_session_settled'])
      db.query(
        `delete from ${table} where source = 'opencode' and pc not in (select pc from imported_pc)`,
      ).run()
    store.setMeta(OPENCODE_PER_CALL, '1')
  })()
}

/** The steps past rowid `since` and the newest rowid read, or null when the store cannot be read (or predates
 *  the part table). */
async function readOpenCodeSteps(
  dbPath: string,
  since: number,
): Promise<{ steps: OpenCodeStep[]; newest: number } | null> {
  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return null
  }
  try {
    const top = db.query<{ n: number | null }, []>('select max(rowid) as n from part').get()?.n ?? 0
    const page = db.query<OpenCodeStep, [number, number]>(OPENCODE_STEPS)
    const steps: OpenCodeStep[] = []
    for (let lo = since; lo < top; lo += OPENCODE_PAGE) {
      for (const s of page.all(lo, Math.min(top, lo + OPENCODE_PAGE))) steps.push(s)
      await yieldLoop()
    }
    return { steps, newest: Math.max(since, top) }
  } catch {
    return null
  } finally {
    db.close()
  }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function openCodeEvent(s: OpenCodeStep, tool: string, pc: string | null): UsageEventInput | null {
  const c: Counts = {
    input: count(s.input),
    cacheRead: count(s.cache_read),
    cacheWrite: count(s.cache_write),
    output: count(s.output),
  }
  if (c.input + c.cacheRead + c.cacheWrite + c.output === 0) return null // nothing was spent
  const model = openCodeModelName(
    s.model && s.provider ? JSON.stringify({ id: s.model, providerID: s.provider }) : s.model,
  )
  return {
    id: `opencode:${tool}:${s.id}`,
    ts: s.ts,
    pc,
    session: s.session_id,
    agent: 'main',
    source: 'opencode',
    model,
    provider: s.provider || 'opencode',
    input: c.input,
    output: c.output,
    cache_read: c.cacheRead,
    cache_write_5m: c.cacheWrite,
    // A subset of output, kept as its own column, never added to it.
    reasoning: count(s.reasoning),
    list_usd: listUsd(model, c, s.ts, c.input + c.cacheRead + c.cacheWrite),
    // OpenCode's own price of the step, against whatever provider it routed to.
    billed_usd: typeof s.cost === 'number' && Number.isFinite(s.cost) ? s.cost : null,
    price_ver: PRICE_VER(),
    weighted: weighTurnCounts(model, c),
  }
}

async function ingestOpenCode(
  store: KitStore,
  o: { dbPath: string; tool: string },
  opts: ForeignIngestOptions,
): Promise<number | null> {
  const stamp = dbStamp(o.dbPath)
  if (!stamp) return null
  dropOpenCodeSessionTotals(store)
  const cur = store.getCursor(o.dbPath)
  if (cursorUnchanged(cur, stamp.size, stamp.mtime)) return null
  const since = cur && cur.version === FOREIGN_INGEST_VERSION ? cur.offset : 0
  const read = await readOpenCodeSteps(o.dbPath, since)
  if (!read) return null
  const events: UsageEventInput[] = []
  for (const s of read.steps) {
    const ev = openCodeEvent(s, o.tool, opts.pc ?? null)
    if (ev) events.push(ev)
  }
  await flush(store, events)
  store.setCursor({
    path: o.dbPath,
    ...stamp,
    offset: read.newest,
    version: FOREIGN_INGEST_VERSION,
  })
  return events.length
}

// ---- Hermes ----

async function ingestHermes(
  store: KitStore,
  h: { dbPath: string; profile: string | null },
  opts: ForeignIngestOptions,
): Promise<number | null> {
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
  await flushCumulative(store, events)
  store.setCursor({ path: h.dbPath, ...stamp, offset: newest, version: FOREIGN_INGEST_VERSION })
  return events.length
}
