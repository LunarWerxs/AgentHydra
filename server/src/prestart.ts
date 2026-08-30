// server/src/prestart.ts - THE PRE-START CHECK (owner directive, 2026-08-30): "before the
// orchestrator does anything... go through all the chats and determine what should be done...
// determine the status of every chat... what it should do next for every chat. From a big
// picture standpoint." Plus the census that has to come first: "identify how many open
// sessions there are or instances... then identify all of the chats across those. Before
// starting its pre-check."
//
// READ-ONLY on purpose: a pre-start CHECK reports; the deeds go through the same act/sweep
// machinery as always, so there is exactly one place a verdict becomes a deed.
//
// THE SANITY RAIL (owner, verbatim): "if it only sees one instance open. then it's wrong.
// Because I pretty much never only have one." One (or zero) open instances is not a state of
// the world - it is a symptom of broken instance detection (the --user-data-dir blind spot
// class of bug), and a census that starts wrong poisons every decision after it. plausible:
// false means STOP and investigate detection before acting on anything.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { suppressedChats } from './breaker'
import { isGenericChatTitle } from './chat-title'
import { type Collision, liveCollisions } from './collisions'
import { type HandoffAdvice, handoffCandidates } from './context-size'
import { db } from './db'
import { pendingDeliveries } from './deliveries'
import { type FleetInstanceEntry, fleetInstances } from './fleet-instances'
import { type FleetUsageEntry, fleetUsage } from './fleet-usage'
import { type SweepDeps, type SweepReport, sweepGateActions } from './gate-sweep'
import { type Hold, listHolds } from './holds'
import { fleetHealth, type InstanceHealth, unusableInstances } from './instance-health'
import { sessionMetaMap } from './instance-sessions'
import { readLiveRegistry } from './live-registry'
import { pathKey } from './path-key'

const norm = (p: string) => pathKey(p, true)

export interface PrestartChatStep {
  sessionId: string
  title: string | null
  instance: string | null
  step:
    | 'archive'
    | 'surface-and-deliver'
    | 'judge-then-act'
    | 'wait-for-reset'
    | 'leave-alone'
    | 'investigate'
  why: string
}

export interface PrestartReport {
  instances: {
    total: number
    openCount: number
    open: Array<{
      num: number
      name: string
      label: string | null
      plan: string | null
      weeklyPct: number | null
      sessionPct: number | null
      usageStale: boolean
    }>
  }
  sanity: { plausible: boolean; why: string }
  /** The full pure-report sweep (caps 0/0): every visible chat, gated, nothing touched. */
  chats: SweepReport
  /** A sweep that THREW is reported beside the (empty) report - never instead of the census. */
  sweepError: string | null
  /** The big-picture answer per chat that needs anything: what to do next, in order. */
  nextSteps: PrestartChatStep[]
  junk: {
    /** Done-marked lineages still visible in a sidebar AND not live: retired work to archive. */
    supersededVisible: Array<{ sessionId: string; title: string | null; instance: string }>
    /** Naming-law violations: visible chats with no real name - rename or review. */
    genericTitled: Array<{ sessionId: string; title: string | null; instance: string }>
    /** CONTRADICTIONS: done-marked (retired lineage) yet a LIVE process is running it right
     *  now. The timestamps tell the story (owner-decoded 2026-08-30, when all three of the
     *  first live run's entries turned out to be FALSE marks from a migration that never
     *  completed): 'revived-after-mark' = someone deliberately resumed it after retirement;
     *  'marked-while-live' = the mark landed on a chat that never even stopped. Either way
     *  the mark is usually the lie - READ THE CHAT'S TAIL, then clear the mark via
     *  POST /api/sessions/:id/done {done:false}. Never archive under the running writer. */
    liveButDoneMarked: Array<{
      sessionId: string
      title: string | null
      instance: string
      markedAt: string | null
      liveSince: string | null
      story: 'revived-after-mark' | 'marked-while-live' | 'unknown'
    }>
    /** Visible entries whose TRUE transcript id is unrecorded: the marks table and the live
     *  registry are keyed by that id, so neither junk lookup can be trusted for these -
     *  counted honestly instead of silently passing both checks. */
    identityUnresolvedCount: number
  }
  /** Chats whose context is nearly full: hand them off to a fresh thread while they can still
   *  summarise themselves, instead of waiting for the wall mid-task. Report-only. */
  handoffSoon: HandoffAdvice[]
  /** Live chats sharing one working tree - they can overwrite each other, and a resume prompt
   *  to one may tell it to commit what another is still writing. Report-only: two chats in
   *  one repo is often deliberate, so this informs routing rather than blocking anything. */
  collisions: Collision[]
  /** Actions the circuit breaker is currently holding back, so a suppressed loop is visible
   *  rather than looking like nothing needed doing. */
  suppressed: Array<{ kind: string; sessionId: string; attempts: number; retryAfter: string }>
  /** Chats the owner has taken OFF automation (holds.ts). Listed every pass on purpose: a
   *  hold that becomes invisible becomes permanent, and then a chat quietly stops being
   *  worked without anyone remembering why. */
  holds: Array<{ sessionId: string; reason: string; heldAt: string }>
  /** INSTANCES THAT CANNOT DO WORK, with the reason (instance-health.ts). Said ONCE per account
   *  here rather than discovered one failed chat at a time: a wedged app, a damaged profile and a
   *  signed-out app all used to surface as the same guess. 'Closed' is never listed - a closed
   *  app is this fleet's resting state, not a fault. */
  unusableInstances: InstanceHealth[]
  /** Prompts staged by past surfacings that NOBODY has delivered yet (deliveries.ts) -
   *  each one is a dormant chat waiting on a sender. Deliver these first. */
  pendingDeliveries: Array<{
    sessionId: string
    prompt: string
    instanceRef: string | null
    stagedAt: string
  }>
  tookMs: number
}

export interface PrestartDeps extends SweepDeps {
  instancesList?: () => Promise<FleetInstanceEntry[]>
  usageList?: () => FleetUsageEntry[]
  sweep?: typeof sweepGateActions
  /** Done-marked session ids with WHEN each mark landed (ms) - the when is what separates a
   *  false mark from a real one when a live process contradicts it. */
  doneMarked?: () => Map<string, number>
  /** Live session ids with each process's start time (ms). */
  liveMap?: () => Map<string, number>
  collisions?: () => Collision[]
  handoff?: () => HandoffAdvice[]
  suppressed?: () => Array<{
    kind: string
    sessionId: string
    attempts: number
    retryAfter: string
  }>
  holds?: () => Hold[]
  health?: () => InstanceHealth[]
  deliveries?: () => Array<{
    session_id: string
    prompt: string
    instance_ref: string | null
    staged_at: number
  }>
}

/** The marks table's updated_at is epoch-millis from the done route but ISO from older
 *  writers - parse either, never trust one format. */
function parseWhen(v: string): number {
  const n = Number(v)
  if (Number.isFinite(n) && n > 1e12) return n
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 0
}

function realDoneMarked(): Map<string, number> {
  try {
    const rows = db
      .query<{ session_id: string; updated_at: string }, []>(
        'select session_id, updated_at from session_marks where done = 1',
      )
      .all()
    return new Map(rows.map((r) => [r.session_id, parseWhen(r.updated_at)]))
  } catch {
    return new Map()
  }
}

function realLiveMap(): Map<string, number> {
  try {
    const entries = readLiveRegistry(join(homedir(), '.claude'))
    return new Map(entries.map((s) => [s.sessionId, s.startedAt]))
  } catch {
    return new Map()
  }
}

export async function prestartCheck(deps: PrestartDeps = {}): Promise<PrestartReport> {
  const started = Date.now()
  const instancesList = deps.instancesList ?? (() => fleetInstances())
  const usageList = deps.usageList ?? (() => fleetUsage())
  const sweep = deps.sweep ?? sweepGateActions
  const doneMarked = deps.doneMarked ?? realDoneMarked
  const meta = deps.meta ?? sessionMetaMap

  // 1. THE CENSUS FIRST: instances, then the chats across them.
  const instances = await instancesList()
  const usage = usageList()
  const open = instances
    .filter((i) => i.isRunning && i.signedIn)
    .map((i) => {
      const u = usage.find((x) => norm(x.ref) === norm(i.ref))
      return {
        num: i.num,
        name: i.name,
        label: i.label,
        plan: i.account?.planLabel ?? null,
        weeklyPct: u?.weeklyPct ?? null,
        sessionPct: u?.sessionPct ?? null,
        usageStale: u?.stale ?? true,
      }
    })

  // 2. THE SANITY RAIL - before anything downstream is trusted.
  const sanity =
    open.length <= 1
      ? {
          plausible: false,
          why:
            `only ${open.length} open instance(s) detected - the owner practically never runs ` +
            'just one, so instance detection is suspect (the --user-data-dir blind-spot class ' +
            'of bug). STOP: investigate detection before acting on any verdict below.',
        }
      : { plausible: true, why: `${open.length} open instances - a plausible fleet` }

  // 3. Gate EVERY visible chat, pure report (caps 0/0 - the sweep's report-only mode). A
  // throwing sweep must not discard the census and sanity verdict already computed
  // (review-confirmed): the error is reported beside an empty report, never instead of one.
  let chats: SweepReport
  let sweepError: string | null = null
  try {
    chats = await sweep({ maxArchive: 0, maxSurface: 0 }, deps)
  } catch (err) {
    sweepError = err instanceof Error ? err.message : String(err)
    chats = {
      scanned: 0,
      leftAlone: 0,
      acted: { archived: 0, surfaced: 0 },
      caps: { maxArchive: 0, maxSurface: 0 },
      archiveRows: [],
      crashedRows: [],
      waitForReset: [],
      needsJudgment: [],
      stalled: [],
      ungated: [],
      unswept: [],
      deadlineHit: false,
    }
  }

  // 4. The big-picture next step per chat, derived from the gate lanes - stated rules only.
  const nextSteps: PrestartChatStep[] = []
  for (const r of chats.archiveRows)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'archive',
      why: 'finished, recap says done, nothing asked - archive it (chat_sweep or chat_act)',
    })
  for (const r of chats.crashedRows)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'surface-and-deliver',
      why: `crashed (${r.crashedKind ?? 'unknown'}) - act to surface it, then deliver its resume prompt natively`,
    })
  for (const r of chats.waitForReset)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'wait-for-reset',
      why: 'crashed at the usage wall - nothing useful before its reset',
    })
  for (const r of chats.needsJudgment)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'judge-then-act',
      why: 'waiting on an answer - the ONE AI step: judge autonomous-vs-human, then chat_act with the decision',
    })
  for (const r of chats.stalled)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'investigate',
      why: `alive but looks STUCK on '${r.tool}' for ${Math.round(r.quietSecs / 60)}min - open it and look; a live chat is never acted on automatically`,
    })
  for (const r of chats.ungated)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'investigate',
      why: 'visible in a sidebar but no transcript found anywhere - inspect via the dossier',
    })
  // The sweep's deadline can cut candidates off; the owner asked for the status of EVERY
  // chat, so the cut-off ones get explicit rows instead of vanishing (review-confirmed drop).
  for (const r of chats.unswept)
    nextSteps.push({
      sessionId: r.sessionId,
      title: r.title,
      instance: r.instance,
      step: 'investigate',
      why: "the pre-check's sweep deadline cut this chat off before it was gated - re-run prestart, or sweep these ids directly",
    })

  // 5. JUNK: deterministic candidates only - done-marked-but-visible (retired lineages the
  // testing days left behind) and naming-law violations. Reported, never auto-deleted here.
  const marked = doneMarked()
  const liveMap = (deps.liveMap ?? realLiveMap)()
  const supersededVisible: PrestartReport['junk']['supersededVisible'] = []
  const genericTitled: PrestartReport['junk']['genericTitled'] = []
  const liveButDoneMarked: PrestartReport['junk']['liveButDoneMarked'] = []
  let identityUnresolvedCount = 0
  // The SAME two-set dedup the sweep uses (review-confirmed weaker here): first the metadata
  // FILE, then the resolved transcript id - one chat imported into two instances is two files
  // but one identity, and double-listing it means double archive calls downstream.
  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  for (const [key, m] of meta()) {
    if (m.archived) continue
    const dedup = m.path || key
    if (seenPaths.has(dedup)) continue
    seenPaths.add(dedup)
    const sessionId = m.cliSessionId ?? key
    if (seenIds.has(sessionId)) continue
    seenIds.add(sessionId)
    if (m.cliSessionId === null) {
      // The marks table and the live registry are keyed by the TRUE transcript id; without it,
      // neither lookup can be trusted, so this entry is counted honestly instead of silently
      // passing both checks (review-confirmed blindness).
      identityUnresolvedCount++
    } else if (marked.has(sessionId)) {
      // A retired lineage with a LIVE process is a contradiction, not junk. The first live
      // run found three, and the owner decoded all three as FALSE marks from a migration
      // that never completed - so the row carries the decisive timestamps and the story.
      const liveSince = liveMap.get(sessionId)
      if (liveSince !== undefined) {
        const markedAt = marked.get(sessionId) ?? 0
        liveButDoneMarked.push({
          sessionId,
          title: m.title,
          instance: m.instance,
          markedAt: markedAt ? new Date(markedAt).toISOString() : null,
          liveSince: new Date(liveSince).toISOString(),
          story:
            markedAt === 0
              ? 'unknown'
              : liveSince > markedAt
                ? 'revived-after-mark'
                : 'marked-while-live',
        })
      } else supersededVisible.push({ sessionId, title: m.title, instance: m.instance })
    }
    if (isGenericChatTitle(m.title))
      genericTitled.push({ sessionId, title: m.title, instance: m.instance })
  }

  const pending = (deps.deliveries ?? pendingDeliveries)().map((r) => ({
    sessionId: r.session_id,
    prompt: r.prompt,
    instanceRef: r.instance_ref,
    stagedAt: new Date(r.staged_at).toISOString(),
  }))

  return {
    instances: { total: instances.length, openCount: open.length, open },
    sanity,
    chats,
    nextSteps,
    sweepError,
    junk: { supersededVisible, genericTitled, liveButDoneMarked, identityUnresolvedCount },
    // Context pressure is asked of the LIVE chats only: a dormant chat's context is not
    // growing, so warning about it would be noise the reader has to filter every pass.
    // The live registry ALREADY resolved each session's transcript path; re-deriving it with
    // findTranscriptById would rescan the projects tree per chat for an answer we were handed
    // for free (review-confirmed waste).
    handoffSoon: (
      deps.handoff ??
      (() =>
        handoffCandidates(
          readLiveRegistry(join(homedir(), '.claude')).map((s) => ({
            sessionId: s.sessionId,
            transcriptPath: s.transcriptPath,
          })),
        ))
    )(),
    collisions: (deps.collisions ?? liveCollisions)(),
    suppressed: (deps.suppressed ?? suppressedChats)(),
    holds: (deps.holds ?? listHolds)(),
    // Asked of EVERY known instance, not just the open ones: a signed-out or damaged profile is
    // exactly as unusable while the app is closed, and it is the reason a later boot would fail.
    // The responsiveness probe runs once for the whole fleet, not once per instance.
    unusableInstances: unusableInstances(
      (
        deps.health ??
        (() =>
          fleetHealth(
            instances.map((i) => ({
              ref: i.ref,
              num: i.num,
              // `dir`, NEVER `ref`. The ref is 'desktop:<dir>' - a vocabulary, not a path - and
              // passing it made every config.json lookup miss, so the first live run reported all
              // 18 instances as "never signed in", including one that was open and answering.
              instanceDir: i.dir,
              isRunning: i.isRunning,
              pid: i.pid,
              usagePct: usage.find((u) => norm(u.ref) === norm(i.ref))?.weeklyPct ?? null,
            })),
          ))
      )(),
    ),
    pendingDeliveries: pending,
    tookMs: Date.now() - started,
  }
}
