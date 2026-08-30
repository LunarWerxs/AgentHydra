// server/src/gate-sweep.ts - THE SWEEP (owner-authorized 2026-08-30: "you can work on
// whatever you recommend next"): gate every visible desktop chat and act on the verdicts,
// within caps, in one call. This is the fleet-scale half of the gate law - the per-chat act
// (gate-actions.ts) stays the only place a verdict becomes a deed; the sweep only decides
// WHICH chats get acted on and in what order.
//
// Design rules:
//   - Acts run SEQUENTIALLY, and every act also holds the process-wide act lock, so two
//     overlapping sweeps (or a sweep plus a direct act, or the monitor's landing) can never
//     drive the app's UIA menus or Electron's single-instance import at the same moment.
//   - CAPS make restraint expressible: maxSurface defaults to 3 (booting/importing is heavy),
//     maxArchive defaults to unlimited (the owner's stated wish, reversible, click-verified).
//     Explicit 0s turn that lane into a pure report - no separate dry-run concept to drift.
//     usage-limit crashes act only when maxSurface > 0, so 0/0 is a genuinely pure report.
//   - The needs-input-review lane is NEVER auto-acted: the sweep packages the evidence and the
//     CALLER (the one AI step) judges each, then acts per chat with its decision.
//   - session_ids PRESENT means exactly those - an empty list sweeps NOTHING (review-confirmed:
//     a caller-built empty filter must not detonate into a fleet-wide sweep). Omitted means
//     fleet-wide: every non-archived chat in every desktop store.
//   - A DEADLINE bounds the wall clock (a fleet of boots and UIA clicks is minutes, and the
//     HTTP caller deserves an answer): candidates past it are listed as unswept, never
//     silently dropped.

import { type ChatGate, type CrashKind, chatGate } from './chat-gate'
import { actOnGate, type GateActionDeps, type GateActionResult } from './gate-actions'
import { sessionMetaMap } from './instance-sessions'

export interface SweepDeps extends GateActionDeps {
  /** The visible-chat index; seamed for fixtures. */
  meta?: () => Map<
    string,
    {
      archived: boolean
      title: string | null
      instance: string
      path: string
      cliSessionId: string | null
    }
  >
  /** The per-chat act; seamed so sweep tests pin dispatch and caps, not the act itself. */
  act?: typeof actOnGate
}

export interface SweepRow {
  sessionId: string
  title: string | null
  instance: string | null
  state: ChatGate['state']
  crashedKind: CrashKind | null
  lane: string | null
  /** What happened; 'over-cap' = would have acted but the cap was spent; 'report-only' = the
   *  lane's cap is 0 so nothing was queried or done. */
  action: GateActionResult['action'] | 'over-cap' | 'report-only'
  why: string
  /** For surfaced rows: where the chat sits dormant, and the EXACT prompt the caller must
   *  deliver through the app's native message channel to make the resume real. */
  surfacedIn?: { ref: string; num: number }
  openedInstance?: boolean
  prompt?: string
  promptDelivery?: string
  resumeAt?: string | null
}

export interface NeedsJudgmentRow {
  sessionId: string
  title: string | null
  instance: string | null
  doneClaim: string
  endsWithQuestion: boolean
  /** The evidence for the autonomy judgment - never re-derive it from the transcript. */
  lastAssistantText: string
}

export interface SweepReport {
  scanned: number
  leftAlone: number
  acted: { archived: number; surfaced: number }
  caps: { maxArchive: number; maxSurface: number }
  archiveRows: SweepRow[]
  crashedRows: SweepRow[]
  waitForReset: SweepRow[]
  /** The ONE AI step, packaged per chat: judge each, then chat_act it with the decision. */
  needsJudgment: NeedsJudgmentRow[]
  /** Chats with no transcript anywhere - listed, never guessed about. */
  ungated: Array<{ sessionId: string; title: string | null; instance: string | null }>
  /** Candidates the deadline cut off - listed, never silently dropped. */
  unswept: Array<{ sessionId: string; title: string | null; instance: string | null }>
  deadlineHit: boolean
  /** Set by a BOUNDED copy of this report (the sweep loop's status keeps at most 100 rows per
   *  lane) - flagged so a cut can never read as complete coverage. */
  rowsTruncated?: boolean
}

export interface SweepOpts {
  /** PRESENT = exactly these transcript session ids (empty = sweep nothing). Omitted =
   *  fleet-wide. */
  sessionIds?: string[]
  /** 0 = report-only for that lane. Defaults: archive unlimited, surface 3. */
  maxArchive?: number
  maxSurface?: number
  /** Wall-clock bound; candidates past it land in `unswept`. Default 4 minutes. */
  deadlineMs?: number
}

/** The route's body contract, pure and pinned by tests (same reasoning as parseActInput):
 *  a malformed cap must ERROR, never silently become the most permissive default. */
export function parseSweepInput(
  body: Record<string, unknown>,
): { ok: true; opts: SweepOpts } | { ok: false; error: string } {
  const opts: SweepOpts = {}
  if (body.session_ids !== undefined) {
    if (!Array.isArray(body.session_ids) || body.session_ids.some((x) => typeof x !== 'string'))
      return { ok: false, error: 'session_ids must be an array of strings' }
    opts.sessionIds = (body.session_ids as string[]).map((s) => s.trim()).filter(Boolean)
  }
  for (const [key, field] of [
    ['max_archive', 'maxArchive'],
    ['max_surface', 'maxSurface'],
  ] as const) {
    const v = body[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      return { ok: false, error: `${key} must be a number >= 0` }
    opts[field] = Math.floor(v)
  }
  return { ok: true, opts }
}

export async function sweepGateActions(
  opts: SweepOpts = {},
  deps: SweepDeps = {},
): Promise<SweepReport> {
  const gate = deps.gate ?? chatGate
  const act = deps.act ?? actOnGate
  const meta = deps.meta ?? sessionMetaMap
  const now = deps.now ?? Date.now
  const maxArchive = opts.maxArchive ?? Number.POSITIVE_INFINITY
  const maxSurface = opts.maxSurface ?? 3
  const deadline = now() + (opts.deadlineMs ?? 240_000)

  interface Candidate {
    sessionId: string
    title: string | null
    instance: string | null
  }
  let candidates: Candidate[]
  if (opts.sessionIds) {
    // PRESENT means exactly these - an empty list sweeps nothing (see the header).
    candidates = opts.sessionIds.map((id) => ({ sessionId: id, title: null, instance: null }))
  } else {
    // Every non-archived chat in every desktop store, once each: the map is keyed by BOTH the
    // filename id and the cliSessionId, so two keys can name one chat - dedup on the metadata
    // file AND on the resolved transcript id (one chat imported into two instances is two
    // files but one transcript; acting on it twice would double-spend caps and double-click).
    const seenPaths = new Set<string>()
    const seenIds = new Set<string>()
    candidates = []
    for (const [key, m] of meta()) {
      if (m.archived) continue
      const dedup = m.path || key
      if (seenPaths.has(dedup)) continue
      seenPaths.add(dedup)
      const sessionId = m.cliSessionId ?? key
      if (seenIds.has(sessionId)) continue
      seenIds.add(sessionId)
      candidates.push({ sessionId, title: m.title, instance: m.instance })
    }
  }

  const report: SweepReport = {
    scanned: candidates.length,
    leftAlone: 0,
    acted: { archived: 0, surfaced: 0 },
    caps: { maxArchive, maxSurface },
    archiveRows: [],
    crashedRows: [],
    waitForReset: [],
    needsJudgment: [],
    ungated: [],
    unswept: [],
    deadlineHit: false,
  }

  /** A row for a chat the sweep did NOT act on: the outer gate is the only truth available. */
  const gateRow = (
    c: Candidate,
    g: ChatGate,
    action: SweepRow['action'],
    why: string,
  ): SweepRow => ({
    sessionId: c.sessionId,
    title: c.title,
    instance: c.instance,
    state: g.state,
    crashedKind: g.crashed?.kind ?? null,
    lane: g.finished?.lane ?? null,
    action,
    why,
  })

  /** A row for an ACTED chat: built from the act's OWN result - actOnGate re-gates, and its
   *  echo is the verdict that authorized the deed (review-confirmed: echoing the sweep's
   *  earlier snapshot produced self-contradictory rows when the state moved between). */
  const actedRow = (c: Candidate, r: GateActionResult): SweepRow => ({
    sessionId: c.sessionId,
    title: c.title,
    instance: c.instance,
    state: r.gate.state,
    crashedKind: r.gate.crashedKind,
    lane: r.gate.lane,
    action: r.action,
    why: r.why,
    ...(r.instance ? { surfacedIn: r.instance } : {}),
    ...(r.openedInstance !== undefined ? { openedInstance: r.openedInstance } : {}),
    ...(r.prompt ? { prompt: r.prompt, promptDelivery: r.promptDelivery } : {}),
    ...(r.resumeAt !== undefined ? { resumeAt: r.resumeAt } : {}),
  })

  /** The act vanished (no transcript at act time): reported, never silently dropped. */
  const goneRow = (c: Candidate, g: ChatGate): SweepRow =>
    gateRow(c, g, 'parked', 'the act returned nothing - the transcript vanished mid-sweep')

  // SEQUENTIAL on purpose - see the header.
  for (const [i, c] of candidates.entries()) {
    if (now() >= deadline) {
      report.deadlineHit = true
      report.unswept = candidates.slice(i)
      break
    }
    const g = gate(c.sessionId)
    if (!g) {
      report.ungated.push({ sessionId: c.sessionId, title: c.title, instance: c.instance })
      continue
    }
    if (g.state === 'running' || (g.state === 'finished' && g.finished?.lane === 'human')) {
      report.leftAlone++
      continue
    }
    if (g.state === 'finished' && g.finished?.lane === 'archive-candidate') {
      if (report.acted.archived >= maxArchive) {
        report.archiveRows.push(
          gateRow(
            c,
            g,
            maxArchive === 0 ? 'report-only' : 'over-cap',
            maxArchive === 0
              ? 'archive lane is report-only (cap 0)'
              : `would archive, but the sweep's archive cap (${maxArchive}) is spent`,
          ),
        )
        continue
      }
      const r = await act(c.sessionId, {}, deps)
      if (!r) {
        report.archiveRows.push(goneRow(c, g))
        continue
      }
      if (r.action === 'archived') report.acted.archived++
      report.archiveRows.push(actedRow(c, r))
      continue
    }
    if (g.state === 'finished' && g.finished?.lane === 'needs-input-review') {
      report.needsJudgment.push({
        sessionId: c.sessionId,
        title: c.title,
        instance: c.instance,
        doneClaim: g.finished.doneClaim,
        endsWithQuestion: g.finished.endsWithQuestion,
        lastAssistantText: g.finished.lastAssistantText,
      })
      continue
    }
    // crashed
    if (g.crashed?.kind === 'usage-limit') {
      // Ties to the surface cap's 0 so 0/0 is a genuinely pure report (review-confirmed).
      if (maxSurface === 0) {
        report.waitForReset.push(
          gateRow(c, g, 'report-only', 'crashed at the usage wall; report-only (surface cap 0)'),
        )
        continue
      }
      const r = await act(c.sessionId, {}, deps)
      report.waitForReset.push(r ? actedRow(c, r) : goneRow(c, g))
      continue
    }
    if (report.acted.surfaced >= maxSurface) {
      report.crashedRows.push(
        gateRow(
          c,
          g,
          maxSurface === 0 ? 'report-only' : 'over-cap',
          maxSurface === 0
            ? 'surface lane is report-only (cap 0)'
            : `would surface for resume, but the sweep's surface cap (${maxSurface}) is spent`,
        ),
      )
      continue
    }
    const r = await act(c.sessionId, {}, deps)
    if (!r) {
      report.crashedRows.push(goneRow(c, g))
      continue
    }
    if (r.action === 'surfaced') report.acted.surfaced++
    report.crashedRows.push(actedRow(c, r))
  }
  return report
}
