// server/src/orchestrator.ts — the attention watcher (docs/ORCHESTRATOR.md).
//
// THE SHAPE. Ten chats across five desktop instances finish one by one, print their recap, and
// sit waiting for the same sentence ("Resume working on whatever you recommend next"). This module
// is the deterministic half of automating that babysitting: a 60-second pass over what is already
// on disk that decides WHAT NEEDS ATTENTION, published as a feed. The judgment half — actually
// talking to a live chat — belongs to an interactive "reviewer" session running /orchestrate,
// because peer messaging is only available to interactive sessions (measured 2026-08-25: a
// headless dispatched run has no ListAgents/SendMessage; a live one delivers cross-instance in
// seconds). So the daemon watches, the reviewer speaks, and this file must NEVER try to speak:
// no Anthropic calls, no messaging, no dispatching, no touching repos.
//
// WHAT IT READS, all local, all already there:
//   · ~/.claude/sessions/<pid>.json — the CLI's live-session registry: peer name (the SendMessage
//     address), transcript sessionId, cwd, pid. The deterministic bridge between the messaging
//     world and the transcript world. Entries whose pid is gone are ignored.
//   · The session's transcript tail — quietness (file mtime), what ended the last turn (the same
//     classifyEnding the sessions list trusts), the last assistant text (the recap the reviewer
//     judges from), context tokens (last assistant usage), spawn_task chips, the last real human
//     message (a recent one pauses orchestration of that chat — the human outranks everything).
//   · usage-cache.json — the usage sweep's snapshots. Read only; this module never probes quota.
//   · git status of live-session cwds — dirty-for-how-long, branch, unpushed count.
//
// FEED DISCIPLINE. Every item has a stable key and an ack row (orchestrator_acks): the reviewer
// acks what it acts on, and the item stays suppressed until the cooldown passes — except a
// session item whose transcript has MOVED since the ack re-arms on its own, because new activity
// then new idleness is a new situation, not a repeat of the old one. Without that rule a nudged
// chat that finishes its next task inside the cooldown would sit invisible, which is the exact
// failure this whole feature exists to end.
//
// OFF by default, like the auto-resume monitor and for the same reason: it looks at everything
// you are doing on a timer, and that should be a choice.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Text import: bundled into compiled builds, so a packaged AgentHydra can still install the
// command on a machine that has no checkout and no docs/ directory.
import ORCHESTRATE_COMMAND from '../../docs/orchestrate-command.md' with { type: 'text' }
import { listInstances } from './core/instances'
import { db, getSetting, setSetting } from './db'
import { instanceRefForSession } from './instance-sessions'
import { classifyEnding, type SessionEnding } from './session-ending'
import type {
  AttentionItem,
  OrchestratorInstance,
  OrchestratorSettings,
  OrchestratorView,
  UsageSnapshot,
} from './types'
import { allCachedUsage } from './usage-cache'
import { desktopKey } from './usage-service'

// --- settings ---------------------------------------------------------------

function num(key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(key)
  // Number('') is 0, which is finite — an unset key must mean the fallback, never the min clamp.
  if (!raw.trim()) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function getOrchestratorSettings(): OrchestratorSettings {
  return {
    enabled: getSetting('orch_enabled') === '1',
    tickSecs: num('orch_tick_secs', 60, 30, 600),
    idleQuietSecs: num('orch_idle_quiet_secs', 150, 30, 3600),
    ctxHandoffTokens: num('orch_ctx_handoff_tokens', 700_000, 50_000, 2_000_000),
    softPct: num('orch_soft_pct', 80, 1, 100),
    warnPct: num('orch_warn_pct', 85, 1, 100),
    hardPct: num('orch_hard_pct', 90, 1, 100),
    sessionHighPct: num('orch_session_high_pct', 90, 1, 100),
    resetSoonMins: num('orch_reset_soon_mins', 120, 0, 24 * 60),
    spikePct: num('orch_spike_pct', 5, 1, 100),
    dirtyMins: num('orch_dirty_mins', 60, 1, 7 * 24 * 60),
    nudgeCooldownMins: num('orch_nudge_cooldown_mins', 15, 1, 24 * 60),
    openInstances:
      getSetting('orch_open_instances') === 'when-exhausted' ? 'when-exhausted' : 'never',
    openMinPlan: getSetting('orch_open_min_plan') || 'Max 20',
    reviewerReservePct: num('orch_reviewer_reserve_pct', 75, 1, 100),
    handoffSurface: getSetting('orch_handoff_surface') === 'queue' ? 'queue' : 'terminal',
  }
}

export function setOrchestratorSettings(
  patch: Partial<OrchestratorSettings>,
): OrchestratorSettings {
  if (typeof patch.enabled === 'boolean') setSetting('orch_enabled', patch.enabled ? '1' : '0')
  const clamp = (key: string, v: unknown, min: number, max: number) => {
    if (typeof v === 'number' && Number.isFinite(v))
      setSetting(key, String(Math.min(max, Math.max(min, Math.floor(v)))))
  }
  clamp('orch_tick_secs', patch.tickSecs, 30, 600)
  clamp('orch_idle_quiet_secs', patch.idleQuietSecs, 30, 3600)
  clamp('orch_ctx_handoff_tokens', patch.ctxHandoffTokens, 50_000, 2_000_000)
  clamp('orch_soft_pct', patch.softPct, 1, 100)
  clamp('orch_warn_pct', patch.warnPct, 1, 100)
  clamp('orch_hard_pct', patch.hardPct, 1, 100)
  clamp('orch_session_high_pct', patch.sessionHighPct, 1, 100)
  clamp('orch_reset_soon_mins', patch.resetSoonMins, 0, 24 * 60)
  clamp('orch_spike_pct', patch.spikePct, 1, 100)
  clamp('orch_dirty_mins', patch.dirtyMins, 1, 7 * 24 * 60)
  clamp('orch_nudge_cooldown_mins', patch.nudgeCooldownMins, 1, 24 * 60)
  if (patch.openInstances === 'never' || patch.openInstances === 'when-exhausted')
    setSetting('orch_open_instances', patch.openInstances)
  if (typeof patch.openMinPlan === 'string' && patch.openMinPlan.trim())
    setSetting('orch_open_min_plan', patch.openMinPlan.trim().slice(0, 40))
  clamp('orch_reviewer_reserve_pct', patch.reviewerReservePct, 1, 100)
  if (patch.handoffSurface === 'terminal' || patch.handoffSurface === 'queue')
    setSetting('orch_handoff_surface', patch.handoffSurface)
  return getOrchestratorSettings()
}

// --- tiny persisted KV (dirty-since, usage baselines) -----------------------

function kvGet(key: string): string | null {
  return (
    db
      .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
      .get(key)?.value ?? null
  )
}

function kvSet(key: string, value: string): void {
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString())
}

function kvDelete(key: string): void {
  db.query('delete from orchestrator_kv where key = ?').run(key)
}

// --- acks -------------------------------------------------------------------

export function ackAttention(key: string, action: string, cooldownMins?: number): void {
  const mins = Number.isFinite(cooldownMins)
    ? Math.min(24 * 60, Math.max(1, Math.floor(cooldownMins as number)))
    : getOrchestratorSettings().nudgeCooldownMins
  const now = new Date()
  db.query(
    `insert into orchestrator_acks (key, action, until, acked_at) values (?, ?, ?, ?)
     on conflict(key) do update set action = excluded.action, until = excluded.until, acked_at = excluded.acked_at`,
  ).run(
    key,
    action.slice(0, 200),
    new Date(now.getTime() + mins * 60_000).toISOString(),
    now.toISOString(),
  )
}

interface AckRow {
  key: string
  until: string
  acked_at: string
}

function activeAcks(nowMs: number): Map<string, AckRow> {
  // Prune anything a week past its cooldown while we are here — the table is a working set,
  // not a ledger (the reviewer's own transcript is the ledger of what it did).
  db.query('delete from orchestrator_acks where until < ?').run(
    new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString(),
  )
  const rows = db.query<AckRow, []>('select key, until, acked_at from orchestrator_acks').all()
  const map = new Map<string, AckRow>()
  const now = new Date(nowMs).toISOString()
  for (const r of rows) if (r.until > now) map.set(r.key, r)
  return map
}

// --- the live-session registry ----------------------------------------------

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  /** The peer-messaging address (SendMessage target). */
  name: string
  startedAt: number
  transcriptPath: string | null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The CLI's transcript-store encoding of a cwd: every non-alphanumeric character becomes '-'. */
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function transcriptPathFor(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = join(claudeHome, 'projects', projectKeyForCwd(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // The key preserves the cwd's casing as the session recorded it, which is not always the casing
  // in the registry (drive letters wander between 'D:' and 'd:'). The sessionId is globally unique,
  // so a bounded search across project dirs settles it.
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all — reported as unreadable per-session below.
  }
  return null
}

function readLiveRegistry(claudeHome: string): LiveSession[] {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const f of files) {
    try {
      const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof reg?.sessionId !== 'string' || typeof reg?.cwd !== 'string') continue
      if (typeof reg.pid !== 'number' || !pidAlive(reg.pid)) continue
      out.push({
        pid: reg.pid,
        sessionId: reg.sessionId,
        cwd: reg.cwd,
        name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
        startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
        transcriptPath: transcriptPathFor(claudeHome, reg.cwd, reg.sessionId),
      })
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return out
}

// --- transcript tail parsing (pure; exported for tests) ---------------------

export interface ChipInTail {
  id: string
  title: string
  prompt: string
}

export interface TailInfo {
  /** What ended the last meaningful record, per session-ending.ts. */
  ending: SessionEnding | null
  /** Last assistant text (the recap, when there is one). */
  lastAssistantText: string | null
  /** Context tokens at the last assistant event (input + cache read + cache creation). */
  ctxTokens: number | null
  /** The last turn's final assistant record ended on tool_use with nothing after it. */
  midTurn: boolean
  /** A "What I did / Am I 100% done / Do I recommend" recap block is present. */
  recapDetected: boolean
  /** The tail mentions a handoff prompt (the context-rollover protocol's deliverable). */
  handoffDetected: boolean
  /** spawn_task chips offered in the tail window. */
  chips: ChipInTail[]
  /** Last message typed by the actual human (injected/cross-session/tool traffic excluded). */
  lastHumanText: string | null
  /** ISO timestamp of that human message, when the record carried one. */
  lastHumanAt: string | null
  /** No parseable user/assistant record found in the window that was read. */
  unreadable: boolean
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n')
  return ''
}

/** True for user records that were not typed by the human: cross-session mail, task
 *  notifications, command output echoes, tool results, interrupt bookkeeping. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('Another Claude session sent a message') ||
    t.startsWith('<cross-session-message') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('[Request interrupted')
  )
}

export function parseTranscriptTail(raw: string): TailInfo {
  const lines = raw.split('\n').filter((l) => l.trim())
  const info: TailInfo = {
    ending: null,
    lastAssistantText: null,
    ctxTokens: null,
    midTurn: false,
    recapDetected: false,
    handoffDetected: false,
    chips: [],
    lastHumanText: null,
    lastHumanAt: null,
    unreadable: true,
  }
  let isNewestMeaningful = true
  // Newest record last on disk, so walk backwards; the first line of a byte-window is often a
  // truncated JSON line, which the parse guard simply skips.
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: {
      type?: string
      timestamp?: string
      message?: { content?: unknown; usage?: Record<string, number> }
    }
    try {
      ev = JSON.parse(lines[i])
    } catch {
      continue
    }
    const type = ev?.type
    if (type !== 'user' && type !== 'assistant' && type !== 'result') continue
    info.unreadable = false
    const newest = isNewestMeaningful
    isNewestMeaningful = false
    const text = textOf(ev.message?.content)
    if (info.ending === null) {
      const e = classifyEnding(ev, text)
      if (e !== null) info.ending = e
    }
    if (type === 'assistant' && ev.message) {
      const usage = ev.message.usage
      if (info.ctxTokens === null && usage) {
        info.ctxTokens =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0)
      }
      const content = ev.message.content
      if (Array.isArray(content)) {
        for (const b of content as Array<{
          type?: string
          id?: string
          name?: string
          input?: { title?: string; prompt?: string }
        }>) {
          if (b.type === 'tool_use' && /spawn_task$/.test(b.name ?? '')) {
            info.chips.push({
              id: b.id ?? `${i}`,
              title: (b.input?.title ?? '').slice(0, 120),
              prompt: (b.input?.prompt ?? '').slice(0, 1500),
            })
          }
        }
        if (newest && content.some((b) => (b as { type?: string }).type === 'tool_use')) {
          // The newest record overall is an assistant record that ends in a tool call: the runtime
          // is (or was) mid-turn, waiting on that tool. Distinct from "finished and waiting".
          info.midTurn = true
        }
      }
      if (info.lastAssistantText === null) {
        const t = text.trim()
        if (t) info.lastAssistantText = t.slice(-4000)
      }
    } else {
      if (
        newest &&
        type === 'user' &&
        Array.isArray(ev.message?.content) &&
        (ev.message.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
      ) {
        // The newest record is a tool result with no assistant turn after it yet: the runtime is
        // between a tool finishing and the model's next step — also mid-turn.
        info.midTurn = true
      }
      if (type === 'user' && info.lastHumanText === null) {
        const t = text.trim()
        if (t && !isInjectedUserText(t)) {
          info.lastHumanText = t.slice(0, 400)
          info.lastHumanAt = typeof ev.timestamp === 'string' ? ev.timestamp : null
        }
      }
    }
    if (
      info.lastAssistantText !== null &&
      info.lastHumanText !== null &&
      info.ctxTokens !== null &&
      info.ending !== null
    )
      break
  }
  if (info.lastAssistantText) {
    info.recapDetected = /##\s*(What I did|Am I 100% done|Do I recommend)/i.test(
      info.lastAssistantText,
    )
    info.handoffDetected = /handoff prompt/i.test(info.lastAssistantText)
  }
  return info
}

/** Read the last `bytes` of a file. Some transcripts carry multi-megabyte single lines (pasted
 *  logs, giant tool results), so callers escalate the window until a record parses. */
function tailOfFile(path: string, bytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]

function readTailInfo(path: string): TailInfo {
  let info: TailInfo | null = null
  const size = statSync(path).size
  for (const w of TAIL_WINDOWS) {
    info = parseTranscriptTail(tailOfFile(path, w))
    if (!info.unreadable || w >= size) return info
  }
  return info as TailInfo
}

// --- git hygiene ------------------------------------------------------------

export interface GitInfo {
  isRepo: boolean
  branch: string | null
  detached: boolean
  dirtyCount: number
  dirtySample: string[]
  aheadCount: number | null
}

const notARepo = new Set<string>()

async function gitInfoFor(cwd: string): Promise<GitInfo | null> {
  if (notARepo.has(cwd)) return null
  if (!existsSync(cwd)) return null
  const proc = Bun.spawn(['git', '-C', cwd, 'status', '--porcelain=v1', '--branch'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
  })
  const killer = setTimeout(() => proc.kill(), 10_000)
  const [out, code] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])
  clearTimeout(killer)
  if (code !== 0) {
    // Not a work tree (or git absent). Cached for the process lifetime: a directory does not
    // usually become a repo mid-session, and a wrong "no" self-heals on the next daemon start.
    notARepo.add(cwd)
    return null
  }
  const lines = out.split('\n').filter((l: string) => l.length > 0)
  const head = lines[0] ?? ''
  const detached = /^## HEAD \(no branch\)/.test(head)
  const branch = detached ? null : (head.match(/^## ([^.\s]+)/)?.[1] ?? null)
  const ahead = head.match(/ahead (\d+)/)
  const dirty = lines.slice(1)
  return {
    isRepo: true,
    branch,
    detached,
    dirtyCount: dirty.length,
    dirtySample: dirty.slice(0, 5).map((l) => l.trim()),
    aheadCount: ahead ? Number(ahead[1]) : null,
  }
}

// --- usage banding (pure; exported for tests) --------------------------------

export type UsageBand = 'ok' | 'elevated' | 'high' | 'critical'

export function bandForPct(pct: number, s: OrchestratorSettings): UsageBand {
  if (pct >= s.hardPct) return 'critical'
  if (pct >= s.warnPct) return 'high'
  if (pct >= s.softPct) return 'elevated'
  return 'ok'
}

const BAND_RANK: Record<UsageBand, number> = { ok: 0, elevated: 1, high: 2, critical: 3 }

export function resetsSoon(
  resetsAt: string | null | undefined,
  nowMs: number,
  s: OrchestratorSettings,
): boolean {
  if (!resetsAt) return false
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return false
  return t > nowMs - 60_000 && t - nowMs <= s.resetSoonMins * 60_000
}

interface UsagePrev {
  pct: number
  atMs: number
  band: UsageBand
}

/** Compare the usage cache against the previous pass's baselines and produce alert items.
 *  Pure: baselines in, baselines out; the caller persists them. */
export function computeUsageItems(
  cache: Record<string, UsageSnapshot>,
  prev: Record<string, UsagePrev>,
  s: OrchestratorSettings,
  nowMs: number,
  nowIso: string,
): { items: AttentionItem[]; next: Record<string, UsagePrev> } {
  const items: AttentionItem[] = []
  const next: Record<string, UsagePrev> = {}
  for (const [key, snap] of Object.entries(cache)) {
    if (key.startsWith('codex:')) continue // Claude quota only; Codex pacing is not this feature
    const wk = snap.weekAll
    if (!wk || typeof wk.pct !== 'number') continue
    // A reading captured before its own weekly reset describes LAST week — alerting on it is a
    // zombie ("100% critical" from a month-old snapshot of an instance nobody runs anymore).
    // Same for a reading nothing has refreshed in a day: absence of data, not data.
    const capturedMs = Date.parse(snap.capturedAt ?? '')
    if (!Number.isNaN(capturedMs) && nowMs - capturedMs > 24 * 3600 * 1000) continue
    if (wk.resetsAt) {
      const resetMs = Date.parse(wk.resetsAt)
      if (!Number.isNaN(resetMs) && resetMs < nowMs) continue
    }
    const band = bandForPct(wk.pct, s)
    const soon = resetsSoon(wk.resetsAt ?? null, nowMs, s)
    const p = prev[key]
    next[key] = { pct: wk.pct, atMs: nowMs, band }
    const detail: Record<string, unknown> = {
      account: snap.account,
      weeklyPct: wk.pct,
      weeklyResetsAt: wk.resetsAt ?? null,
      sessionPct: snap.session?.pct ?? null,
      band,
      resetsSoon: soon,
      capturedAt: snap.capturedAt,
    }
    // Spike: a jump of ≥ spikePct between two readings within 30 minutes — the "something just
    // launched a billion subtasks" tripwire.
    if (p && nowMs - p.atMs <= 30 * 60_000 && wk.pct - p.pct >= s.spikePct) {
      items.push({
        key: `usage-spike:${key}`,
        kind: 'usage_alert',
        instanceRef: key,
        summary: `usage spike: ${snap.account ?? key} weekly ${p.pct}% -> ${wk.pct}% in ${Math.round((nowMs - p.atMs) / 60_000)}m`,
        detail: { ...detail, spikeFromPct: p.pct },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
    // Band escalation (and standing critical): the reset-soon exemption turns a high reading
    // into a dump target instead of an alarm.
    const escalated = !p || BAND_RANK[band] > BAND_RANK[p.band]
    if (band !== 'ok' && !soon && (escalated || band === 'critical')) {
      items.push({
        key: `usage:${key}:${band}`,
        kind: 'usage_alert',
        instanceRef: key,
        summary: `${snap.account ?? key} weekly at ${wk.pct}% (${band})${
          band === 'critical' ? ' — hard-cutoff territory' : ''
        }`,
        detail: { ...detail, hardCutoff: band === 'critical' },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
  }
  return { items, next }
}

// --- the desktop fleet as a routing table (pure; exported for tests) ---------

/** "Max 20×" out of "tobix <a@b> · Max 20×". Null when the label has no plan suffix. */
export function planOfAccountLabel(account: string | null | undefined): string | null {
  const m = account?.match(/·\s*([^·]+)$/)
  return m ? m[1].trim() : null
}

/**
 * Join the desktop instance list with the usage cache. A RUNNING instance with zero chats is
 * still open capacity — the first live run counted "open accounts" from the session registry
 * and missed exactly that instance, which is why this table exists in the feed at all.
 */
export function buildInstanceRows(
  instances: Array<{ dir: string; name: string; isRunning: boolean }>,
  cache: Record<string, UsageSnapshot>,
  s: OrchestratorSettings,
  nowMs: number,
): OrchestratorInstance[] {
  const rows: OrchestratorInstance[] = instances.map((i) => {
    const ref = desktopKey(i.dir)
    const snap = cache[ref]
    const capturedMs = Date.parse(snap?.capturedAt ?? '')
    const stale = !snap || Number.isNaN(capturedMs) || nowMs - capturedMs > 24 * 3600 * 1000
    const wk = stale ? null : (snap?.weekAll ?? null)
    return {
      ref,
      name: i.name,
      isRunning: i.isRunning,
      account: snap?.account ?? null,
      plan: planOfAccountLabel(snap?.account),
      weeklyPct: wk?.pct ?? null,
      weeklyResetsAt: wk?.resetsAt ?? null,
      sessionPct: stale ? null : (snap?.session?.pct ?? null),
      band: wk && typeof wk.pct === 'number' ? bandForPct(wk.pct, s) : 'unknown',
      resetsSoon: wk ? resetsSoon(wk.resetsAt ?? null, nowMs, s) : false,
      stale,
    }
  })
  // Running first, then most headroom first — the order a router wants to read.
  return rows.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
    return (a.weeklyPct ?? 101) - (b.weeklyPct ?? 101)
  })
}

// --- the pass ---------------------------------------------------------------

export interface OrchestratorDeps {
  nowMs: () => number
  claudeHome: () => string
  registry: (claudeHome: string) => LiveSession[]
  tailInfo: (path: string) => TailInfo
  mtimeMs: (path: string) => number | null
  git: (cwd: string) => Promise<GitInfo | null>
  usage: () => Record<string, UsageSnapshot>
  instanceRef: (sessionId: string) => string | null
  desktopInstances: () => Promise<Array<{ dir: string; name: string; isRunning: boolean }>>
}

const defaultDeps: OrchestratorDeps = {
  nowMs: () => Date.now(),
  claudeHome: () => join(homedir(), '.claude'),
  registry: readLiveRegistry,
  tailInfo: readTailInfo,
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  git: gitInfoFor,
  usage: allCachedUsage,
  instanceRef: instanceRefForSession,
  desktopInstances: async () =>
    (await listInstances()).map((i) => ({
      dir: i.dir,
      name: i.label ?? i.name,
      isRunning: i.isRunning,
    })),
}

interface TickState {
  attention: AttentionItem[]
  instances: OrchestratorInstance[]
  lastTickAt: string | null
  lastTickMs: number | null
  liveSessions: number
  usageAgeSecs: number | null
}

const state: TickState = {
  attention: [],
  instances: [],
  lastTickAt: null,
  lastTickMs: null,
  liveSessions: 0,
  usageAgeSecs: null,
}

/** firstSeenAt/seenCount continuity between passes, keyed by item key (in-memory is right:
 *  "how long has this been pending" resets naturally with the daemon). */
const seen = new Map<string, { firstSeenAt: string; count: number }>()

function withContinuity(items: AttentionItem[]): AttentionItem[] {
  const liveKeys = new Set(items.map((i) => i.key))
  for (const k of [...seen.keys()]) if (!liveKeys.has(k)) seen.delete(k)
  return items.map((i) => {
    const s = seen.get(i.key)
    if (s) {
      s.count += 1
      return { ...i, firstSeenAt: s.firstSeenAt, seenCount: s.count }
    }
    seen.set(i.key, { firstSeenAt: i.firstSeenAt, count: 1 })
    return i
  })
}

export async function runOrchestratorOnce(deps: OrchestratorDeps = defaultDeps): Promise<void> {
  const started = deps.nowMs()
  const s = getOrchestratorSettings()
  const nowIso = new Date(started).toISOString()
  const items: AttentionItem[] = []

  const sessions = deps.registry(deps.claudeHome())
  state.liveSessions = sessions.length

  // -- per-session ------------------------------------------------------------
  const byCwd = new Map<string, { session: LiveSession; quietSecs: number }[]>()
  for (const sess of sessions) {
    if (!sess.transcriptPath) {
      items.push({
        key: `unreadable:${sess.sessionId}`,
        kind: 'errored',
        sessionId: sess.sessionId,
        peerName: sess.name,
        cwd: sess.cwd,
        summary: `live session ${sess.name}: transcript not found on disk`,
        firstSeenAt: nowIso,
        seenCount: 1,
      })
      continue
    }
    const mtime = deps.mtimeMs(sess.transcriptPath)
    if (mtime === null) continue
    const quietSecs = Math.max(0, Math.round((started - mtime) / 1000))
    const list = byCwd.get(sess.cwd) ?? []
    list.push({ session: sess, quietSecs })
    byCwd.set(sess.cwd, list)
    if (quietSecs < s.idleQuietSecs) continue

    let tail: TailInfo
    try {
      tail = deps.tailInfo(sess.transcriptPath)
    } catch {
      continue
    }
    const iref = deps.instanceRef(sess.sessionId)
    const base = {
      sessionId: sess.sessionId,
      peerName: sess.name,
      cwd: sess.cwd,
      instanceRef: iref ?? undefined,
      tailSnippet: tail.lastAssistantText ?? undefined,
      firstSeenAt: nowIso,
      seenCount: 1,
    }
    const detail: Record<string, unknown> = {
      quietSecs,
      ctxTokens: tail.ctxTokens,
      recapDetected: tail.recapDetected,
      handoffDetected: tail.handoffDetected,
      midTurn: tail.midTurn,
      ending: tail.ending,
      lastHumanText: tail.lastHumanText,
      lastHumanAt: tail.lastHumanAt,
      account: iref ? (deps.usage()[iref]?.account ?? null) : null,
      accountWeeklyPct: iref ? (deps.usage()[iref]?.weekAll?.pct ?? null) : null,
    }
    if (tail.unreadable) {
      items.push({
        ...base,
        key: `unreadable:${sess.sessionId}`,
        kind: 'errored',
        summary: `live session ${sess.name}: no parseable record in the transcript tail`,
        detail,
      })
    } else if (tail.ending === 'interrupted') {
      items.push({
        ...base,
        key: `intr:${sess.sessionId}`,
        kind: 'interrupted',
        summary: `${sess.name} was interrupted by the user ${fmtQuiet(quietSecs)} ago`,
        detail,
      })
    } else if (tail.ending === 'usage-limit') {
      items.push({
        ...base,
        key: `limit:${sess.sessionId}`,
        kind: 'limit_stopped',
        summary: `${sess.name} stopped at a usage limit ${fmtQuiet(quietSecs)} ago (auto-resume monitor's jurisdiction)`,
        detail,
      })
    } else if (tail.ending === 'error' || tail.ending === 'refused' || tail.ending === 'overload') {
      items.push({
        ...base,
        key: `err:${sess.sessionId}`,
        kind: 'errored',
        summary: `${sess.name} ended on ${tail.ending} ${fmtQuiet(quietSecs)} ago`,
        detail,
      })
    } else {
      const handoffDue = typeof tail.ctxTokens === 'number' && tail.ctxTokens >= s.ctxHandoffTokens
      items.push({
        ...base,
        key: `idle:${sess.sessionId}`,
        kind: handoffDue ? 'handoff_due' : 'idle_pending',
        summary: `${sess.name} idle ${fmtQuiet(quietSecs)}${
          tail.recapDetected ? ' with a recap' : ''
        }${tail.midTurn ? ' (tail ends mid-tool: likely a background task)' : ''}${
          handoffDue ? ` at ${Math.round((tail.ctxTokens ?? 0) / 1000)}k context — hand off` : ''
        }`,
        detail,
      })
    }
    for (const chip of tail.chips) {
      items.push({
        ...base,
        tailSnippet: undefined,
        key: `chip:${sess.sessionId}:${chip.id}`,
        kind: 'chip',
        summary: `${sess.name} offered a task chip: ${chip.title || '(untitled)'}`,
        detail: { title: chip.title, prompt: chip.prompt },
      })
    }
  }

  // -- git hygiene, one look per distinct cwd ---------------------------------
  for (const [cwd, sess] of byCwd) {
    let g: GitInfo | null = null
    try {
      g = await deps.git(cwd)
    } catch {
      g = null
    }
    if (!g?.isRepo) {
      kvDelete(`dirtySince:${cwd}`)
      continue
    }
    if (g.detached || (g.branch && g.branch !== 'main' && g.branch !== 'master')) {
      items.push({
        key: `branch:${cwd}`,
        kind: 'branch_off_main',
        cwd,
        summary: `${cwd} is on ${g.detached ? 'a detached HEAD' : `branch '${g.branch}'`} — standing rule is main only`,
        detail: { branch: g.branch, detached: g.detached },
        firstSeenAt: nowIso,
        seenCount: 1,
      })
    }
    if (g.dirtyCount > 0) {
      const k = `dirtySince:${cwd}`
      let since = Number(kvGet(k))
      if (!Number.isFinite(since) || since <= 0) {
        since = started
        kvSet(k, String(started))
      }
      const dirtyMins = Math.round((started - since) / 60_000)
      const allIdle = sess.every((x) => x.quietSecs >= s.idleQuietSecs)
      if (dirtyMins >= s.dirtyMins && allIdle) {
        items.push({
          key: `dirty:${cwd}`,
          kind: 'repo_dirty',
          cwd,
          // Address the nudge to the longest-idle session in that cwd — it knows its own diff.
          peerName: sess.sort((a, b) => b.quietSecs - a.quietSecs)[0]?.session.name,
          summary: `${cwd}: ${g.dirtyCount} dirty file(s) for ${dirtyMins}m with all its sessions idle`,
          detail: {
            dirtyCount: g.dirtyCount,
            dirtyMins,
            sample: g.dirtySample,
            branch: g.branch,
            aheadCount: g.aheadCount,
          },
          firstSeenAt: nowIso,
          seenCount: 1,
        })
      }
    } else {
      kvDelete(`dirtySince:${cwd}`)
    }
  }

  // -- usage ------------------------------------------------------------------
  const cache = deps.usage()
  let newestCapture = 0
  for (const snap of Object.values(cache)) {
    const t = Date.parse(snap.capturedAt ?? '')
    if (!Number.isNaN(t) && t > newestCapture) newestCapture = t
  }
  state.usageAgeSecs = newestCapture ? Math.round((started - newestCapture) / 1000) : null
  let prev: Record<string, UsagePrev> = {}
  try {
    prev = JSON.parse(kvGet('usagePrev') ?? '{}')
  } catch {
    prev = {}
  }
  const usage = computeUsageItems(cache, prev, s, started, nowIso)
  kvSet('usagePrev', JSON.stringify(usage.next))
  items.push(...usage.items)

  // -- the desktop fleet as a routing table -----------------------------------
  try {
    state.instances = buildInstanceRows(await deps.desktopInstances(), cache, s, started)
  } catch (err) {
    console.error('[agenthydra] orchestrator instance listing failed:', err)
    state.instances = []
  }

  // -- ack suppression --------------------------------------------------------
  const acks = activeAcks(started)
  const visible = items.filter((i) => {
    const ack = acks.get(i.key)
    if (!ack) return true
    // A session item whose transcript moved after the ack is a NEW situation — re-arm it.
    if (i.sessionId) {
      const sess = sessions.find((x) => x.sessionId === i.sessionId)
      const mtime = sess?.transcriptPath ? deps.mtimeMs(sess.transcriptPath) : null
      if (mtime !== null && mtime > Date.parse(ack.acked_at)) return true
    }
    return false
  })

  state.attention = withContinuity(visible)
  state.lastTickAt = nowIso
  state.lastTickMs = deps.nowMs() - started
}

function fmtQuiet(secs: number): string {
  if (secs < 90) return `${secs}s`
  if (secs < 90 * 60) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export function orchestratorView(): OrchestratorView {
  return {
    settings: getOrchestratorSettings(),
    attention: state.attention,
    instances: state.instances,
    meta: {
      lastTickAt: state.lastTickAt,
      lastTickMs: state.lastTickMs,
      liveSessions: state.liveSessions,
      usageAgeSecs: state.usageAgeSecs,
    },
  }
}

// --- the loop ---------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
let lastRunMs = 0

async function tick(): Promise<void> {
  const s = getOrchestratorSettings()
  if (!s.enabled) return
  const now = Date.now()
  if (now - lastRunMs < s.tickSecs * 1000) return
  if (ticking) return
  ticking = true
  lastRunMs = now
  try {
    await runOrchestratorOnce()
  } catch (err) {
    console.error('[agenthydra] orchestrator tick error:', err)
  } finally {
    ticking = false
  }
}

export function startOrchestrator(): void {
  if (timer) return
  // A fast heartbeat with a due-check inside, so tickSecs edits apply without a daemon restart.
  timer = setInterval(() => void tick(), 15_000)
}

export function stopOrchestrator(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// --- shipping the /orchestrate command --------------------------------------
// The reviewer half is a Claude command file, and a feature the user has to go find a file for
// is not shipped. The daemon carries the command's text (see the top-of-file text import) and
// writes it into ~/.claude/commands itself: on first enable when it is absent, or on the
// explicit install endpoint. A copy the user has edited is never overwritten without force —
// their edits are the newer intent, not drift to correct.

export type CommandInstallOutcome = 'installed' | 'up-to-date' | 'differs' | 'updated'

/** Pure decision: what should happen given what is on disk. Exported for tests. */
export function commandInstallOutcome(
  existing: string | null,
  shipped: string,
  force: boolean,
): CommandInstallOutcome {
  if (existing === null) return 'installed'
  if (existing === shipped) return 'up-to-date'
  return force ? 'updated' : 'differs'
}

export function installOrchestrateCommand(
  force = false,
  commandsDir: string = join(homedir(), '.claude', 'commands'),
): { outcome: CommandInstallOutcome; path: string } {
  const path = join(commandsDir, 'orchestrate.md')
  let existing: string | null = null
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = null
  }
  const outcome = commandInstallOutcome(existing, ORCHESTRATE_COMMAND, force)
  if (outcome === 'installed' || outcome === 'updated') {
    mkdirSync(commandsDir, { recursive: true })
    writeFileSync(path, ORCHESTRATE_COMMAND)
  }
  return { outcome, path }
}
