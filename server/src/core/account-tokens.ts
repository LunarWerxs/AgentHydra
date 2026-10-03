// server/src/core/account-tokens.ts — how many tokens each ACCOUNT has run on this PC, for the CLI
// and desktop tables' Tokens column (owner, 2026-10-03: tokens are tracked on the account logged
// in, not on the instance; log an instance out to another account and the row shows that account's
// tokens, not the instance's).
//
// WHERE THE TOKENS COME FROM
//  * CLI instances: `<configDir>/projects/**/*.jsonl`, everything that instance's `claude` ran,
//    CliMayte's workers included.
//  * Desktop instances: Claude Desktop's Claude Code chats write their transcripts to the SHARED
//    store (`CLAUDE_PROJECTS_ROOT`), not to the profile (docs/CLAUDE-CONFIG-LAYOUT.md). What ties a
//    transcript to a profile is the chat record the app files under
//    `claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json` (its `cliSessionId`, and the ids
//    it rolled through): the folder it sits in IS the account that was signed in when the chat was
//    written (the app shows only the signed-in account's folder), so the record names the account
//    exactly. A transcript no chat record points at (a deleted chat, a plain CLI run on the default
//    login) belongs to no desktop instance and is not counted. A chat moved between profiles is
//    credited whole to the account of its newest non-archived record.
//
// WHICH ACCOUNT A CLI MESSAGE IS CREDITED TO. The account signed in to that instance when the
// message was written. A CLI instance keeps no record of past logins, so each sweep notes who holds
// it now (`account-holders.json`, uuids only) and the message's own timestamp picks the holder in
// force then. MESSAGES FROM BEFORE ANY RECORDED LOGIN go to the first account ever recorded for the
// instance (the first entry starts at 0): on the day this was added that is the account the
// instance holds, and an instance's transcripts were nearly all written under its one login. If the
// first thing recorded is "signed out", older messages are credited to nobody. A switch is noticed
// at the next sweep (at most a minute while the app is open), so a message written between the real
// switch and that sweep still goes to the old holder: the known error. A signed-out gap that ends
// in the SAME account (an unreadable file, a login veto that cleared) is dropped, not recorded.
//
// A transcript holds one line per streamed block, and every line of one reply repeats that reply's
// usage, so the count is ONE usage per message id (the last one written), never one per line.
// Counting lines read 2.2 times too high on a real orchestrator chat (2026-10-01).
//
// Served stale-while-revalidate: routes answer from memory and a sweep older than a minute starts
// another in the background. A sweep re-reads only transcripts whose size or mtime moved (a first
// one read ~600 MB across ten instances in 1.3 s, 2026-10-01); everything else is a stat.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE_PROJECTS_ROOT } from '../config'
import type { AccountTokens, TokenParts, UsageSnapshot } from '../types'
import { collectChatsAsync, lineageIdsOf } from './chat-store-scan'
import { listCliInstances } from './cli-instances'
import { accountHoldersFile, accountTokensCacheFile, appDataDir } from './paths'

const REFRESH_AFTER_MS = 60_000
const FIVE_HOURS_MS = 5 * 3_600_000
const WEEK_MS = 7 * 24 * 3_600_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Flat message rows, `STRIDE` numbers each: time (ms), input, output, cache read, cache write. */
const STRIDE = 5

/** One transcript's messages: one usage per message id, the last one written. `fallbackTs` stamps a
 *  line that carries no timestamp (the file's own mtime). */
export function messagesInTranscript(text: string, fallbackTs: number): number[] {
  const byMessage = new Map<string, number[]>()
  let unnamed = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry: {
      type?: string
      timestamp?: string
      message?: { id?: string; usage?: Record<string, unknown> }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry?.message?.usage
    if (entry?.type !== 'assistant' || !usage) continue
    const ts = Date.parse(entry.timestamp ?? '')
    byMessage.set(entry.message?.id ?? `line-${unnamed++}`, [
      Number.isFinite(ts) ? ts : fallbackTs,
      Number(usage.input_tokens) || 0,
      Number(usage.output_tokens) || 0,
      Number(usage.cache_read_input_tokens) || 0,
      Number(usage.cache_creation_input_tokens) || 0,
    ])
  }
  return [...byMessage.values()].flat()
}

// --- who held each CLI instance, and since when -----------------------------------------------

interface Holder {
  uuid: string | null
  since: number
}
type Holders = Record<string, Holder[]>

function readHolders(): Holders {
  try {
    const file = accountHoldersFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeHolders(holders: Holders): void {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = accountHoldersFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(holders, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best effort: the change is noticed again at the next sweep.
  }
}

/** The account a CLI config folder is signed in as (its `.claude.json` oauthAccount), null when
 *  signed out or unreadable. Identity only, never a token. */
export function cliAccountUuid(configDir: string, loggedIn: boolean): string | null {
  if (!loggedIn) return null // logging out removes the credentials but leaves oauthAccount behind
  try {
    const uuid = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))?.oauthAccount
      ?.accountUuid
    return typeof uuid === 'string' && UUID.test(uuid) ? uuid.toLowerCase() : null
  } catch {
    return null
  }
}

/** Apply "this instance holds `uuid` at `now`" to its history; true when the history changed. */
export function noteHolder(history: Holder[], uuid: string | null, now: number): boolean {
  const last = history[history.length - 1]
  if (!last) {
    history.push({ uuid, since: 0 }) // from before any recorded login: see the header
    return true
  }
  if (last.uuid === uuid) return false
  const before = history[history.length - 2]
  if (last.uuid === null && before && before.uuid === uuid) {
    history.pop() // a signed-out blink that ended in the same account
    return true
  }
  history.push({ uuid, since: now })
  return true
}

/** The account holding the instance at `ts`: the last entry that began at or before it. */
export function holderAt(history: Holder[], ts: number): string | null {
  let who: string | null = null
  for (const h of history) {
    if (h.since > ts) break
    who = h.uuid
  }
  return who
}

// --- transcripts, read once per change ---------------------------------------------------------

/** A window never reaches further back than a week, so only the last RECENT_MS of a transcript is
 *  kept message by message; older messages are folded into one sum per account when the file is
 *  read. Without this a sweep sorted millions of rows (30 s on a PC with 26 GB of transcripts). The
 *  fold is safe because holder history only ever grows at its end: a message older than a week
 *  never changes hands. */
const RECENT_MS = 8 * 24 * 3_600_000

/** Sums key `''` for "whichever account owns the file" (a desktop transcript): the owner can change
 *  with the chat record, a CLI message's holder cannot. */
const OWNER = ''

interface FileEntry {
  mtimeMs: number
  size: number
  /** Messages older than RECENT_MS at read time: input, output, cache read, cache write per holder. */
  old: Record<string, number[]>
  /** The rest, flat rows (see STRIDE), holder not yet applied. */
  recent: number[]
}
const cliFiles = new Map<string, FileEntry>()
const desktopFiles = new Map<string, FileEntry>()
let cacheDirty = false

async function transcriptsUnder(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await transcriptsUnder(path)))
    else if (e.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/** The file's entry, re-read only when its size or mtime moved. `holder` names the account a message
 *  at that time belongs to (null: nobody); `OWNER` marks "the file's owner". */
async function entryOf(
  files: Map<string, FileEntry>,
  path: string,
  holder: (ts: number) => string | null,
): Promise<FileEntry | null> {
  try {
    const s = await stat(path)
    const known = files.get(path)
    if (known && known.mtimeMs === s.mtimeMs && known.size === s.size) return known
    const messages = messagesInTranscript(await Bun.file(path).text(), s.mtimeMs)
    const horizon = Date.now() - RECENT_MS
    const entry: FileEntry = { mtimeMs: s.mtimeMs, size: s.size, old: {}, recent: [] }
    for (let i = 0; i < messages.length; i += STRIDE) {
      const ts = messages[i] as number
      if (ts >= horizon) {
        for (let k = 0; k < STRIDE; k++) entry.recent.push(messages[i + k] as number)
        continue
      }
      const who = holder(ts)
      if (who === null) continue
      const sum = entry.old[who] ?? [0, 0, 0, 0]
      entry.old[who] = sum
      for (let k = 0; k < 4; k++) sum[k] = (sum[k] as number) + (messages[i + 1 + k] as number)
    }
    files.set(path, entry)
    cacheDirty = true
    return entry
  } catch {
    // Gone or locked since the folder was listed; the next sweep reads it again.
    return null
  }
}

// What was read survives a restart: reading tens of gigabytes of transcripts again costs minutes.
const CACHE_VERSION = 1
function loadCache(): void {
  try {
    const file = accountTokensCacheFile()
    if (!existsSync(file)) return
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw?.version !== CACHE_VERSION) return
    for (const [path, e] of Object.entries(raw.cli ?? {})) cliFiles.set(path, e as FileEntry)
    for (const [path, e] of Object.entries(raw.desktop ?? {}))
      desktopFiles.set(path, e as FileEntry)
  } catch {
    // Unreadable cache: everything is read again.
  }
}
function saveCache(): void {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = accountTokensCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        version: CACHE_VERSION,
        cli: Object.fromEntries(cliFiles),
        desktop: Object.fromEntries(desktopFiles),
      }),
      { mode: 0o600 },
    )
    renameSync(tmp, file)
    cacheDirty = false
  } catch {
    // Best effort.
  }
}

// --- the sweep: credit every message to an account ---------------------------------------------

/** One account's tokens: everything older than the recent rows as a sum, the recent messages in
 *  time order with running sums so any window is two lookups. */
interface Ledger {
  old: number[]
  ts: Float64Array
  /** `cum[k][i]` = sum of part k over recent messages 0..i-1 (length n + 1). */
  cum: Float64Array[]
}

const ledgers = new Map<string, Ledger>()
let sweptAt = 0
let sweeping: Promise<void> | null = null
let cacheLoaded = false

function ledgerOf(old: number[], rows: number[]): Ledger {
  const n = rows.length / STRIDE
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (rows[a * STRIDE] as number) - (rows[b * STRIDE] as number),
  )
  const ts = new Float64Array(n)
  const cum = [0, 1, 2, 3].map(() => new Float64Array(n + 1))
  order.forEach((src, i) => {
    ts[i] = rows[src * STRIDE] as number
    for (let k = 0; k < 4; k++)
      (cum[k] as Float64Array)[i + 1] =
        ((cum[k] as Float64Array)[i] as number) + (rows[src * STRIDE + 1 + k] as number)
  })
  return { old, ts, cum }
}

async function sweep(): Promise<void> {
  if (!cacheLoaded) {
    cacheLoaded = true
    loadCache()
  }
  const seenCli = new Set<string>()
  const seenDesktop = new Set<string>()
  const olds = new Map<string, number[]>()
  const recents = new Map<string, number[]>()
  const creditOld = (uuid: string, sum: number[]) => {
    const into = olds.get(uuid) ?? [0, 0, 0, 0]
    for (let k = 0; k < 4; k++) into[k] = (into[k] as number) + (sum[k] as number)
    olds.set(uuid, into)
  }
  const creditRecent = (uuid: string, rows: number[], from: number) => {
    const into = recents.get(uuid) ?? []
    for (let k = 0; k < STRIDE; k++) into.push(rows[from + k] as number)
    recents.set(uuid, into)
  }

  // CLI instances: the message's own time picks the holder.
  const holders = readHolders()
  let holdersChanged = false
  const now = Date.now()
  for (const inst of listCliInstances()) {
    const history = holders[inst.configDir] ?? []
    holders[inst.configDir] = history
    holdersChanged =
      noteHolder(history, cliAccountUuid(inst.configDir, inst.loggedIn), now) || holdersChanged
    for (const path of await transcriptsUnder(join(inst.configDir, 'projects'))) {
      seenCli.add(path)
      const entry = await entryOf(cliFiles, path, (ts) => holderAt(history, ts))
      if (!entry) continue
      for (const [who, sum] of Object.entries(entry.old)) creditOld(who, sum)
      for (let i = 0; i < entry.recent.length; i += STRIDE) {
        const who = holderAt(history, entry.recent[i] as number)
        if (who) creditRecent(who, entry.recent, i)
      }
    }
  }
  if (holdersChanged) writeHolders(holders)

  // Desktop chats: the transcript's session id names the chat record, whose folder names the account.
  const accountOf = new Map<string, string>()
  const newest = new Map<string, string>()
  for (const c of await collectChatsAsync()) {
    if (!c.accountUuid || !UUID.test(c.accountUuid)) continue
    for (const id of lineageIdsOf(c)) {
      const rank = `${c.archived ? 0 : 1}|${c.metaMtime ?? ''}`
      if (rank >= (newest.get(id) ?? '')) {
        newest.set(id, rank)
        accountOf.set(id, c.accountUuid.toLowerCase())
      }
    }
  }
  if (accountOf.size) {
    for (const path of await transcriptsUnder(CLAUDE_PROJECTS_ROOT)) {
      // `<project>/<session>.jsonl`, or `<project>/<session>/subagents/<agent>.jsonl`.
      const parts = path.slice(CLAUDE_PROJECTS_ROOT.length).split(/[\\/]/)
      const sid = parts.map((p) => p.replace(/\.jsonl$/, '')).find((p) => accountOf.has(p))
      if (!sid) continue // not a desktop chat's: nothing is read for it
      seenDesktop.add(path)
      const entry = await entryOf(desktopFiles, path, () => OWNER)
      if (!entry) continue
      const owner = accountOf.get(sid) as string
      for (const sum of Object.values(entry.old)) creditOld(owner, sum)
      for (let i = 0; i < entry.recent.length; i += STRIDE) creditRecent(owner, entry.recent, i)
    }
  }

  ledgers.clear()
  for (const uuid of new Set([...olds.keys(), ...recents.keys()]))
    ledgers.set(uuid, ledgerOf(olds.get(uuid) ?? [0, 0, 0, 0], recents.get(uuid) ?? []))
  for (const [files, seen] of [
    [cliFiles, seenCli],
    [desktopFiles, seenDesktop],
  ] as const)
    for (const path of files.keys())
      if (!seen.has(path)) {
        files.delete(path)
        cacheDirty = true
      }
  if (cacheDirty) saveCache()
  sweptAt = Date.now()
}

/** Re-read what changed, now (daemon boot, so the first page has numbers). One sweep at a time: a
 *  second caller joins the running one. */
export function refreshAccountTokens(): Promise<void> {
  sweeping ??= sweep()
    .catch(() => {})
    .finally(() => {
      sweeping = null
    })
  return sweeping
}

// --- reading a window --------------------------------------------------------------------------

/** First index whose time is >= `ms`. */
function lowerBound(ts: Float64Array, ms: number): number {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((ts[mid] as number) < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Tokens at or after `ms`; `Number.NEGATIVE_INFINITY` is all time (the old sums included). */
function partsSince(ledger: Ledger | undefined, ms: number): TokenParts {
  const sum = [0, 0, 0, 0]
  if (ledger) {
    const from = lowerBound(ledger.ts, ms)
    for (let k = 0; k < 4; k++) {
      const cum = ledger.cum[k] as Float64Array
      sum[k] =
        (cum[ledger.ts.length] as number) -
        (cum[from] as number) +
        (ms === Number.NEGATIVE_INFINITY ? (ledger.old[k] as number) : 0)
    }
  }
  return {
    input: sum[0] as number,
    output: sum[1] as number,
    cacheRead: sum[2] as number,
    cacheWrite: sum[3] as number,
    total: sum[0]! + sum[1]! + sum[2]! + sum[3]!,
  }
}

/** When the account's CURRENT window began. `resetsAt` is when it ends (its start is one span
 *  earlier); a reset already past means the next window began at or after it, so everything since
 *  `resetsAt` is the current one while that is still within one span. With no usable reset time:
 *  the last `spanMs`. */
export function windowStartMs(
  resetsAt: string | null | undefined,
  spanMs: number,
  now: number,
): number {
  const end = Date.parse(resetsAt ?? '')
  if (!Number.isFinite(end)) return now - spanMs
  if (end > now) return end - spanMs
  return now - end < spanMs ? end : now - spanMs
}

/**
 * One account's tokens in its current 5-hour window, current week and all time on this PC, from
 * the last sweep. `resets` are the account's reset times from its usage reading (ISO), either
 * missing. Null for no account, and until the first sweep has finished.
 */
export function accountTokens(
  accountUuid: string | null | undefined,
  resets: { sessionResetsAt?: string | null; weekResetsAt?: string | null } = {},
  now = Date.now(),
): AccountTokens | null {
  if (Date.now() - sweptAt > REFRESH_AFTER_MS) void refreshAccountTokens()
  if (!accountUuid || sweptAt === 0) return null
  const ledger = ledgers.get(accountUuid.toLowerCase())
  return {
    fiveHour: partsSince(ledger, windowStartMs(resets.sessionResetsAt, FIVE_HOURS_MS, now)),
    week: partsSince(ledger, windowStartMs(resets.weekResetsAt, WEEK_MS, now)),
    total: partsSince(ledger, Number.NEGATIVE_INFINITY),
  }
}

/** The reset times `accountTokens` wants, from a usage reading (null reads as unknown). */
export function resetsOf(snapshot: UsageSnapshot | null | undefined) {
  return {
    sessionResetsAt: snapshot?.session?.resetsAt,
    weekResetsAt: snapshot?.weekAll?.resetsAt,
  }
}
