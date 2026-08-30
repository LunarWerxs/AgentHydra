// server/src/gate-actions.ts - PIECE 9 of the orchestrator rebuild (owner-ordered, 2026-08-30):
// ACT on the gate's verdict. "yes gate verdicts should be acted on" - so this module is the one
// place a verdict becomes a deed, and it re-runs the gate itself rather than trusting any
// caller-supplied state (the gate law cannot be satisfied by assertion).
//
// The deeds, by stated rule:
//   running            -> left alone (long quiet can be background work; nothing touches it).
//   finished/human     -> left alone (a person deliberately interrupted it - their move).
//   archive-candidate  -> the archive flag is written everywhere the chat exists, with the
//                         running-app durability caveat reported honestly, never hidden.
//   crashed            -> SURFACED: the chat is made ready in a running desktop app (its own
//                         home, or a landing instance for a homeless chat), dormant, and the
//                         result carries the resume prompt the CALLER must deliver through the
//                         app's native message channel - the measured wake path (2026-08-26:
//                         messaging a dormant imported chat boots its engine in the app; the
//                         daemon deliberately has no messaging channel of its own).
//   crashed/usage-limit-> waits for its reset instead; resuming into the wall re-hits it.
//   needs-input-review -> the ONE AI step in the design: the caller reads the gate's evidence
//                         and answers the judgment - autonomous (with the answer text, the
//                         owner's stated preference) or human. The server only executes the
//                         judgment; it never makes it.
//
// THE OVERFLOW RULE (owner, 2026-08-30, hard-coded at 85 by his word): load balancing may open
// a CLOSED signed-in instance only when every OPEN candidate has provably exceeded the safe
// threshold on either the 5-hour or the weekly window. Proof means a FRESH reading - automation
// must not boot apps on a stale number or a guess. The rule lives in monitor.ts beside the
// picker (closedLandingEligible / pickLandingInstance) so the auto-resume landing path and this
// module cannot drift apart on it.

import { type ChatGate, type ChatGateDeps, type CrashKind, chatGate } from './chat-gate'
import { resolveAutomatedTitle } from './chat-title'
import { openInstance } from './core/instances'
import { stageDelivery } from './deliveries'
import { type FleetInstanceEntry, fleetInstances, planRank } from './fleet-instances'
import { type FleetUsageEntry, fleetUsage, LANDING_OVERFLOW_PCT } from './fleet-usage'
import { instanceRefForSession } from './instance-sessions'
import {
  closedLandingEligible,
  pickLandingInstance,
  saturatedNow,
  underLandingThreshold,
} from './monitor'
import { pathKey } from './path-key'
import {
  archiveDesktopChat,
  desktopHomeFor,
  importSessionToDesktop,
  isSessionSuperseded,
  liveSessionEntry,
} from './session-launch'
import { type UiArchiveOutcome, uiArchiveChat } from './ui-archive'

export type GateActionKind =
  | 'left-alone'
  | 'archived'
  | 'surfaced'
  | 'wait-for-reset'
  | 'left-for-human'
  | 'parked'

export interface GateActionInput {
  /** The needs-input-review judgment, made by the CALLER (the one AI step). */
  decision?: 'autonomous' | 'human'
  /** With decision 'autonomous': the answer text to deliver to the chat. */
  answer?: string
}

export interface GateActionResult {
  sessionId: string
  /** The verdict that authorized the deed - always the gate's own, never a caller's claim. */
  gate: { state: ChatGate['state']; crashedKind: CrashKind | null; lane: string | null }
  action: GateActionKind
  why: string
  /** For 'surfaced': where the chat now sits, dormant. */
  instance?: { ref: string; num: number }
  /** A closed instance was booted to receive it, under the overflow rule. */
  openedInstance?: boolean
  /** For 'surfaced': what the caller must now deliver to make the resume real. */
  prompt?: string
  promptDelivery?: 'deliver-natively-via-the-app-message-channel'
  /** For 'archived': how many profiles carried the chat, and whether the flag is durable now. */
  archived?: { profiles: number; durable: boolean }
  /** For 'wait-for-reset': the earliest known reset for the account, when the cache knows it. */
  resumeAt?: string | null
}

/** The act route's body contract, pure so the validation itself is pinned by tests (the HTTP
 *  layer has no harness; a weakened guard here would otherwise fail silently as a 200-parked). */
export function parseActInput(
  body: Record<string, unknown>,
): { ok: true; input: GateActionInput } | { ok: false; error: string } {
  const d = body.decision
  if (d != null && d !== 'autonomous' && d !== 'human')
    return { ok: false, error: "decision must be 'autonomous' or 'human'" }
  return {
    ok: true,
    input: {
      decision: d === 'autonomous' || d === 'human' ? d : undefined,
      answer: typeof body.answer === 'string' ? body.answer.slice(0, 8000) : undefined,
    },
  }
}

/** The deterministic resume prompt for a crashed chat - a code constant like the migrate
 *  notice, not caller prose, so every automated resume says the same honest thing. */
export function resumeNotice(kind: CrashKind): string {
  return (
    `[agenthydra] Gate verdict: crashed (${kind}) - this chat stopped without finishing its ` +
    'last turn. Resume exactly where it left off and finish the turn; if the work is already ' +
    'complete, say so and stop.'
  )
}

/** Every outside-world read/write behind one seam, so fixtures can drive every branch without
 *  touching the developer's real fleet (the same discipline as MonitorDeps / ChatGateDeps). */
export interface GateActionDeps {
  gate?: (sessionId: string, deps?: ChatGateDeps) => ChatGate | null
  instances?: () => Promise<FleetInstanceEntry[]>
  usage?: () => FleetUsageEntry[]
  archive?: typeof archiveDesktopChat
  importSession?: typeof importSessionToDesktop
  open?: (dir: string) => Promise<{ ok: boolean }>
  resolveTitle?: typeof resolveAutomatedTitle
  superseded?: typeof isSessionSuperseded
  home?: typeof desktopHomeFor
  /** The running-app UI archive click (ui-archive.ts) - seamed because it drives real UIA. */
  uiArchive?: (profileDir: string, sessionId: string) => Promise<UiArchiveOutcome>
  /** Is the session live RIGHT NOW (an alive-pid registry entry)? The TOCTOU rail's read. */
  liveNow?: (sessionId: string) => boolean
  /** The delivery ledger's stager (deliveries.ts) - every surfaced prompt is tracked. */
  stage?: typeof stageDelivery
  pinnedRefFor?: (sessionId: string) => string | null
  /** How long to wait for a just-opened instance to reach running. */
  openWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function real(deps: GateActionDeps) {
  return {
    gate: deps.gate ?? chatGate,
    instances: deps.instances ?? (() => fleetInstances()),
    usage: deps.usage ?? (() => fleetUsage()),
    archive: deps.archive ?? archiveDesktopChat,
    importSession: deps.importSession ?? importSessionToDesktop,
    open: deps.open ?? ((dir: string) => openInstance(dir)),
    resolveTitle: deps.resolveTitle ?? resolveAutomatedTitle,
    superseded: deps.superseded ?? isSessionSuperseded,
    home: deps.home ?? desktopHomeFor,
    uiArchive: deps.uiArchive ?? uiArchiveChat,
    liveNow: deps.liveNow ?? ((sid: string) => liveSessionEntry(sid) !== null),
    stage: deps.stage ?? stageDelivery,
    pinnedRefFor: deps.pinnedRefFor ?? instanceRefForSession,
    openWaitMs: deps.openWaitMs ?? 45_000,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  }
}

/** Refs (and dirs) compare under the one path key; the 'desktop:' scheme folds harmlessly. */
const norm = (p: string) => pathKey(p, true)

/** Boot a closed instance and wait until the fleet list reports it running, so the import that
 *  follows targets a live single-instance lock instead of racing the app's own startup. */
async function openAndAwait(
  entry: { ref: string; num: number; dir: string },
  d: ReturnType<typeof real>,
): Promise<{ ok: boolean; reason?: string }> {
  const opened = await d.open(entry.dir).catch(() => ({ ok: false }))
  if (!opened.ok) return { ok: false, reason: `could not open instance #${entry.num}` }
  const deadline = d.now() + d.openWaitMs
  for (;;) {
    const running = (await d.instances()).some(
      (i) => i.isRunning && norm(i.ref) === norm(entry.ref),
    )
    if (running) return { ok: true }
    if (d.now() >= deadline) {
      return {
        ok: false,
        reason: `opened instance #${entry.num} but it did not reach running within ${Math.round(d.openWaitMs / 1000)}s`,
      }
    }
    await d.sleep(1000)
  }
}

export type LandingOutcome =
  | { ok: true; instance: { ref: string; num: number }; openedInstance: boolean }
  | { ok: false; reason: string }

/**
 * Land a HOMELESS chat in a desktop instance: naming law first (fail before booting anything),
 * then the picker - which may name a CLOSED instance only under the owner's 85% overflow rule -
 * then the boot-and-wait when it did, then the import. One definition, shared with the
 * auto-resume monitor's landing path so the two cannot diverge on where chats go.
 */
export async function landSessionInDesktop(opts: {
  sessionId: string
  pinnedRef: string | null
  /** A better name the caller already holds (e.g. a queue row title); the transcript-derived
   *  name backs it up. Naming law: no real name, no landing. */
  fallbackTitle?: string | null
  /** Instances the picker must not choose - the load-balancing path excludes the saturated
   *  home it is migrating AWAY from. */
  excludeRefs?: string[]
  /** Refuse a target that is itself provably at/over the threshold (saturatedNow) - moving
   *  work hot-to-hot buys nothing. */
  requireUnsaturated?: boolean
  deps?: GateActionDeps
}): Promise<LandingOutcome> {
  const d = real(opts.deps ?? {})
  // Eligibility first (pure, no side effects), THEN the naming law, THEN any boot: a caller
  // hears about the real blocker - no instance - before being sent off to rename a chat that
  // could not land anyway, and nothing boots or imports until both checks pass.
  const [allInstances, usage] = [await d.instances(), d.usage()]
  const excluded = new Set((opts.excludeRefs ?? []).map(norm))
  const instances = allInstances.filter((i) => !excluded.has(norm(i.ref)))
  const usageRows = usage.map((u) => ({
    ref: u.ref,
    weeklyPct: u.weeklyPct,
    sessionPct: u.sessionPct,
    stale: u.stale,
    ageMins: u.ageMins,
  }))
  const target = pickLandingInstance(
    opts.pinnedRef,
    instances.map((i) => ({
      ref: i.ref,
      num: i.num,
      isRunning: i.isRunning,
      signedIn: i.signedIn,
      // The owner's tier order (2026-08-30): highest plan first, then lowest usage.
      planRank: planRank(i.account?.planLabel ?? null),
    })),
    usageRows,
  )
  if (!target)
    return {
      ok: false,
      reason:
        'no eligible instance: no running signed-in instance to land in, and no closed ' +
        'signed-in instance the overflow rule would allow opening',
    }
  if (opts.requireUnsaturated && !target.mustOpen) {
    // Migrating onto a RUNNING account demands POSITIVE proof of headroom: a fresh reading
    // with both windows under the line. Unknown or stale is not "cool" (review-confirmed:
    // a missing reading passed as unsaturated and licensed migrating onto an unverified
    // account). A mustOpen target needs no re-check here - the picker only offers closed
    // candidates that already passed underLandingThreshold, the owner's proof standard for
    // opening an app.
    const tu = usageRows.find((u) => norm(u.ref) === norm(target.ref))
    const provenCool =
      !!tu &&
      !tu.stale &&
      (tu.weeklyPct ?? 101) < LANDING_OVERFLOW_PCT &&
      (tu.sessionPct ?? 101) < LANDING_OVERFLOW_PCT
    if (!provenCool)
      return {
        ok: false,
        reason: `the best available instance is not fresh-proven under ${LANDING_OVERFLOW_PCT}% on both windows - migration demands positive proof of headroom`,
      }
  }
  const title = await d.resolveTitle(opts.sessionId, opts.fallbackTitle ?? null)
  if (title === null)
    return {
      ok: false,
      reason: 'no real name available for this chat (naming law); name it, then retry',
    }
  const entry = instances.find((i) => norm(i.ref) === norm(target.ref))
  if (!entry) return { ok: false, reason: 'picked instance vanished between list and landing' }
  if (target.mustOpen) {
    const booted = await openAndAwait(entry, d)
    if (!booted.ok) return { ok: false, reason: booted.reason ?? 'open failed' }
  }
  const imported = await d.importSession({
    sessionId: opts.sessionId,
    instanceDir: entry.dir,
    title,
  })
  if (!imported.ok)
    return {
      ok: false,
      reason: `could not land in instance #${entry.num}: ${imported.reason ?? 'unknown'}`,
    }
  return {
    ok: true,
    instance: { ref: entry.ref, num: entry.num },
    openedInstance: target.mustOpen,
  }
}

/** ONE deed at a time, process-wide (review-confirmed): concurrent acts - two sweeps, a sweep
 *  plus a direct act, the monitor's landing - can drive the app's UIA menus or Electron's
 *  single-instance import twice at once for the same chat. Every mutating entry point queues
 *  here; landSessionInDesktop itself stays unlocked because it always runs UNDER this lock. */
let actLock: Promise<void> = Promise.resolve()
let actBusyCount = 0

/** Is any deed queued or executing RIGHT NOW? Auto-update's busy check reads this so a
 *  daemon relaunch never lands mid-UIA-click or mid-instance-boot (review-confirmed). */
export function isActBusy(): boolean {
  return actBusyCount > 0
}

export function withActSerialized<T>(fn: () => Promise<T>): Promise<T> {
  actBusyCount++
  const run = actLock.then(fn)
  actLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run.finally(() => {
    actBusyCount--
  })
}

/**
 * The act call. Returns null when the session has no transcript (mirror of the gate's own
 * honesty: what cannot be gated cannot be acted on). Serialized process-wide - see
 * {@link withActSerialized}.
 */
export function actOnGate(
  sessionId: string,
  input: GateActionInput = {},
  deps: GateActionDeps = {},
): Promise<GateActionResult | null> {
  return withActSerialized(() => actOnGateInner(sessionId, input, deps))
}

async function actOnGateInner(
  sessionId: string,
  input: GateActionInput = {},
  deps: GateActionDeps = {},
): Promise<GateActionResult | null> {
  const d = real(deps)
  const g = d.gate(sessionId)
  if (!g) return null
  const gateEcho = {
    state: g.state,
    crashedKind: g.crashed?.kind ?? null,
    lane: g.finished?.lane ?? null,
  }
  const res = (
    action: GateActionKind,
    why: string,
    extra: Partial<GateActionResult> = {},
  ): GateActionResult => ({ sessionId, gate: gateEcho, action, why, ...extra })

  if (g.state === 'running')
    return res(
      'left-alone',
      `running (pid ${g.live?.pid}) - the rule is leave it alone; a long quiet can be background work`,
    )

  if (g.state === 'finished' && g.finished) {
    const fin = g.finished
    if (fin.lane === 'human')
      return res(
        'left-alone',
        "a person deliberately interrupted it - their move, not automation's",
      )

    if (fin.lane === 'archive-candidate') {
      const r = await d.archive(sessionId, true)
      if (!r.ok)
        return res(
          'left-alone',
          'recap says done and nothing is asked, but no desktop entry exists to archive - ' +
            'the transcript is already at rest',
        )
      // A hit under a RUNNING app needs the app's own click to leave the sidebar now - and
      // that includes an UNCHANGED hit (flag already on disk but the app still rendering it),
      // so a re-act settles the row instead of reporting durable over a visible chat. A
      // profile the fleet list does NOT manage - above all the DEFAULT %APPDATA% install,
      // which never carries --user-data-dir and is therefore invisible to instance discovery
      // (review-confirmed) - gets the click attempt too: the tool itself answers whether that
      // app is running, and a closed one settles honestly via the disk flag.
      const instances = await d.instances()
      const clickProfiles = [...new Set(r.hits.map((h) => h.profile))].filter((p) => {
        const managed = instances.find((i) => norm(i.dir) === norm(p))
        return managed ? managed.isRunning : true
      })
      if (clickProfiles.length === 0)
        return res(
          'archived',
          'archive flag written and durable (no running app holds this chat in memory)',
          { archived: { profiles: r.hits.length, durable: true } },
        )
      // The TOCTOU rail (review-confirmed): between the gate's verdict and the click, a
      // person can resume the chat - a live process means someone may be using it RIGHT NOW,
      // and clicking Archive under them is exactly the wrong-chat class of harm. The flag
      // write is reversible; the click waits.
      if (d.liveNow(sessionId))
        return res(
          'archived',
          'archive flag written, but the session became LIVE mid-act - the UI click was ' +
            'skipped (a person may be using it); act again once it settles',
          { archived: { profiles: r.hits.length, durable: false } },
        )
      // Owner ruling 2026-08-30 ("I will defer to your recommendation and say yes"): the
      // server itself retires the row through the running app's own UI, so the chat leaves
      // the sidebar now instead of at some future restart. ui-archive.ts holds the safety
      // rails (real disk title, disk-unique title, verified by id after).
      const clicks = await Promise.all(clickProfiles.map((p) => d.uiArchive(p, sessionId)))
      const durable = clicks.every((c) => c.verified)
      return res(
        'archived',
        durable
          ? clicks.some((c) => c.clicked)
            ? "archive flag written AND the running app's own Archive was clicked (verified " +
              'by id on disk) - the chat is gone from the sidebar now'
            : 'already retired - archived by id on disk with no rendered row remaining'
          : 'archive flag written; the UI click did not complete (' +
              `${clicks
                .map((c) => c.reason)
                .filter(Boolean)
                .join('; ')}) - the chat leaves the sidebar at that instance's next restart`,
        { archived: { profiles: r.hits.length, durable } },
      )
    }

    // needs-input-review: the caller's judgment, or instructions for making it.
    if (!input.decision)
      return res(
        'parked',
        'this lane requires the autonomy judgment (the ONE AI step in the design): read ' +
          'lastAssistantText from the gate; if the answer is determinable without the owner - ' +
          'his stated preference - act again with decision:"autonomous" and the answer text; ' +
          'if it genuinely needs the owner, act again with decision:"human"',
      )
    if (input.decision === 'human')
      return res(
        'left-for-human',
        'judged to need the owner - left exactly where it is, per the stated rule',
      )
    const answer = (input.answer ?? '').trim()
    if (!answer) return res('parked', 'decision:"autonomous" requires the answer text to deliver')
    return surfaceForMessage(sessionId, answer, gateEcho, d)
  }

  // crashed - superseded outranks EVERY crash kind (review-confirmed: the usage-limit lane
  // skipped it and promised a resumeAt for a lineage whose successor owns the work).
  if (d.superseded(sessionId))
    return res(
      'parked',
      'superseded: this session is done-marked (handed off/migrated) - its successor owns the work',
    )
  const kind = g.crashed?.kind ?? 'error'
  if (kind === 'usage-limit') {
    const resumeAt = await resetTimeFor(sessionId, d)
    return res(
      'wait-for-reset',
      `stopped by the usage wall${
        resumeAt ? `; the window resets ${resumeAt}` : '; reset time unknown to the usage cache'
      } - resuming before then just re-hits it. The auto-resume monitor schedules post-reset ` +
        'resumes when enabled.',
      { resumeAt },
    )
  }
  return surfaceForMessage(sessionId, resumeNotice(kind), gateEcho, d)
}

/** The earliest known reset for the account this chat runs on, from the usage cache. */
async function resetTimeFor(sessionId: string, d: ReturnType<typeof real>): Promise<string | null> {
  let ref = d.pinnedRefFor(sessionId)
  if (!ref) {
    const home = await d.home(sessionId).catch(() => null)
    if (home) ref = `desktop:${home}`
  }
  if (!ref) return null
  const u = d.usage().find((row) => norm(row.ref) === norm(ref))
  if (!u) return null
  // The BINDING window decides (review-confirmed the first cut wrong here): a weekly-capped
  // account's 5-hour reset is a lie - it arrives in hours while the wall stands for days. A
  // pegged weekly reports the weekly reset, a pegged session the session reset; only when the
  // cache reads neither as pegged (it can lag the crash) does best-known fall through.
  if ((u.weeklyPct ?? 0) >= 100) return u.weeklyResetsAt ?? null
  if ((u.sessionPct ?? 0) >= 100) return u.sessionResetsAt ?? null
  return u.sessionResetsAt ?? u.weeklyResetsAt ?? null
}

/**
 * Make a chat READY to receive a message: re-imported dormant into its own home instance (the
 * revive path the migrate route proved), or landed in a picked instance when homeless. A closed
 * HOME may be booted only under the same overflow rule as landing - a chat's pin does not
 * outrank the owner's 85% line on who may open apps.
 */
async function surfaceForMessage(
  sessionId: string,
  prompt: string,
  gateEcho: GateActionResult['gate'],
  d: ReturnType<typeof real>,
): Promise<GateActionResult> {
  const res = (
    action: GateActionKind,
    why: string,
    extra: Partial<GateActionResult> = {},
  ): GateActionResult => ({ sessionId, gate: gateEcho, action, why, ...extra })
  if (d.superseded(sessionId))
    return res(
      'parked',
      'superseded: this session is done-marked (handed off/migrated) - its successor owns the work',
    )
  const surfacedWhy = (num: number, opened: boolean) =>
    `${opened ? `opened instance #${num} (overflow rule: every open account is at/over ${LANDING_OVERFLOW_PCT}%) and ` : ''}` +
    `the chat now sits dormant in instance #${num}'s app - deliver the prompt through the ` +
    "app's native message channel to boot it (the daemon has no messaging channel of its own)"
  /** Every surfaced result also STAGES its prompt in the delivery ledger, so an undelivered
   *  prompt is a visible pending row instead of a silent loss (deliveries.ts). */
  const surfaced = (why: string, extra: Partial<GateActionResult>): GateActionResult => {
    d.stage({
      sessionId,
      prompt,
      instanceRef: extra.instance?.ref ?? null,
    })
    return res('surfaced', why, extra)
  }

  const home = await d.home(sessionId).catch(() => null)
  if (home) {
    const instances = await d.instances()
    const inst = instances.find((i) => norm(i.dir) === norm(home))
    if (!inst)
      return res('parked', 'its desktop home is not a managed instance - nothing safe to do')
    // A signed-out home cannot run the chat - booting or importing into it would put work in an
    // app with no login (review-confirmed hole: the landing picker filters signedIn, and the
    // home path must hold the same line).
    if (!inst.signedIn)
      return res(
        'parked',
        `its home instance #${inst.num} is ${inst.isRunning ? 'running but ' : ''}signed out - sign it in or order a migration`,
      )
    const title = await d.resolveTitle(sessionId, null)
    if (title === null)
      return res(
        'parked',
        'no real name available for this chat (naming law); name it, then act again',
      )
    if (!inst.isRunning) {
      const running = instances.filter((i) => i.isRunning && i.signedIn)
      const usageRows = d.usage().map((u) => ({
        ref: u.ref,
        weeklyPct: u.weeklyPct,
        sessionPct: u.sessionPct,
        stale: u.stale,
        ageMins: u.ageMins,
      }))
      const mayOpen = closedLandingEligible(
        running.map((i) => ({ ref: i.ref })),
        usageRows,
      )
      if (!mayOpen)
        return res(
          'parked',
          `its home instance #${inst.num} is closed, and the open accounts still have headroom ` +
            `below the ${LANDING_OVERFLOW_PCT}% overflow threshold - automation may not boot an ` +
            'app (owner rule 2026-08-30); open it yourself or order a migration',
        )
      // "Just make sure that it is underneath our threshold" (owner, 2026-08-30): the account
      // being OPENED must itself have a known reading under the line - booting a home that is
      // already past 85% (or has no reading at all) just hits the wall it was fleeing.
      if (!underLandingThreshold(usageRows.find((u) => norm(u.ref) === norm(inst.ref))))
        return res(
          'parked',
          `its home instance #${inst.num} is closed and its own cached usage is at/over the ` +
            `${LANDING_OVERFLOW_PCT}% threshold (or unknown) - booting it would just hit the ` +
            'wall; order a migration instead',
        )
      const booted = await openAndAwait(inst, d)
      if (!booted.ok) return res('parked', booted.reason ?? 'open failed')
      const imported = await d.importSession({ sessionId, instanceDir: inst.dir, title })
      if (!imported.ok)
        return res(
          'parked',
          `could not surface in its home instance #${inst.num}: ${imported.reason ?? 'unknown'}`,
        )
      return surfaced(surfacedWhy(inst.num, true), {
        instance: { ref: inst.ref, num: inst.num },
        openedInstance: true,
        prompt,
        promptDelivery: 'deliver-natively-via-the-app-message-channel',
      })
    }
    // THE LOAD-BALANCING ORDER (owner, standing since the account-capabilities session; wired
    // 2026-08-30): a chat must not resurface onto a home that is PROVABLY at/over the 85%
    // threshold right now while a cooler account can take it. LAND FIRST, FLAG SECOND
    // (review-confirmed: the first cut flagged the source before landing, and every failure
    // shape - a lost flag write, a thrown landing, a failed restore - either hid the chat
    // from every sidebar or overclaimed a migration). With this order nothing is ever flagged
    // until the new home EXISTS; a failed or thrown landing falls through to surfacing at
    // home with zero cleanup owed; and a source flag that fails to stick is REPORTED, never
    // papered over. Stale or unknown home usage stays home - no migration on a guess - and so
    // does a fleet with no fresh-proven-cool taker (hot-to-hot or hot-to-unknown buys nothing).
    const homeUsage = d.usage().find((u) => norm(u.ref) === norm(inst.ref))
    const homeRow = homeUsage && {
      ref: homeUsage.ref,
      weeklyPct: homeUsage.weeklyPct,
      sessionPct: homeUsage.sessionPct,
      stale: homeUsage.stale,
      ageMins: homeUsage.ageMins,
    }
    if (saturatedNow(homeRow || undefined)) {
      let landed: LandingOutcome
      try {
        landed = await landSessionInDesktop({
          sessionId,
          pinnedRef: null,
          deps: dToDeps(d),
          excludeRefs: [inst.ref],
          requireUnsaturated: true,
        })
      } catch (err) {
        landed = {
          ok: false,
          reason: `the landing threw (${err instanceof Error ? err.message : String(err)})`,
        }
      }
      if (landed.ok) {
        const flagged = await d.archive(sessionId, true).catch(() => ({ ok: false }) as const)
        return surfaced(
          `migrated off its saturated home instance #${inst.num} (at/over ${LANDING_OVERFLOW_PCT}% - the load-balancing order)` +
            `${flagged.ok ? '' : ' - WARNING: the source entries could not be flagged archived, so the chat may render in both sidebars; re-act once it settles'} - ` +
            surfacedWhy(landed.instance.num, landed.openedInstance),
          {
            instance: landed.instance,
            openedInstance: landed.openedInstance,
            prompt,
            promptDelivery: 'deliver-natively-via-the-app-message-channel',
          },
        )
      }
      // No fresh-proven-cool taker: nothing was flagged, so simply surface at home - a hot
      // home that is running still beats a chat nobody can see.
      const stayed = await d.importSession({ sessionId, instanceDir: inst.dir, title })
      if (!stayed.ok)
        return res(
          'parked',
          `its home instance #${inst.num} is saturated and no cooler account could take it (${landed.reason}); surfacing at home also failed: ${stayed.reason ?? 'unknown'}`,
        )
      return surfaced(
        `home instance #${inst.num} is at/over ${LANDING_OVERFLOW_PCT}% but no cooler account could take the chat (${landed.reason}) - ` +
          surfacedWhy(inst.num, false),
        {
          instance: { ref: inst.ref, num: inst.num },
          openedInstance: false,
          prompt,
          promptDelivery: 'deliver-natively-via-the-app-message-channel',
        },
      )
    }
    const imported = await d.importSession({ sessionId, instanceDir: inst.dir, title })
    if (!imported.ok)
      return res(
        'parked',
        `could not surface in its home instance #${inst.num}: ${imported.reason ?? 'unknown'}`,
      )
    return surfaced(surfacedWhy(inst.num, false), {
      instance: { ref: inst.ref, num: inst.num },
      openedInstance: false,
      prompt,
      promptDelivery: 'deliver-natively-via-the-app-message-channel',
    })
  }

  const landed = await landSessionInDesktop({
    sessionId,
    pinnedRef: d.pinnedRefFor(sessionId),
    deps: { ...dToDeps(d) },
  })
  if (!landed.ok) return res('parked', landed.reason)
  return surfaced(surfacedWhy(landed.instance.num, landed.openedInstance), {
    instance: landed.instance,
    openedInstance: landed.openedInstance,
    prompt,
    promptDelivery: 'deliver-natively-via-the-app-message-channel',
  })
}

/** Hand the already-resolved dep set back down to landSessionInDesktop unchanged. */
function dToDeps(d: ReturnType<typeof real>): GateActionDeps {
  return {
    gate: d.gate,
    instances: d.instances,
    usage: d.usage,
    archive: d.archive,
    importSession: d.importSession,
    open: d.open,
    resolveTitle: d.resolveTitle,
    superseded: d.superseded,
    home: d.home,
    uiArchive: d.uiArchive,
    liveNow: d.liveNow,
    stage: d.stage,
    pinnedRefFor: d.pinnedRefFor,
    openWaitMs: d.openWaitMs,
    sleep: d.sleep,
    now: d.now,
  }
}
