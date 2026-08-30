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
import { type FleetInstanceEntry, fleetInstances } from './fleet-instances'
import { type FleetUsageEntry, fleetUsage, LANDING_OVERFLOW_PCT } from './fleet-usage'
import { instanceRefForSession } from './instance-sessions'
import { closedLandingEligible, pickLandingInstance } from './monitor'
import { pathKey } from './path-key'
import {
  archiveDesktopChat,
  desktopHomeFor,
  importSessionToDesktop,
  isSessionSuperseded,
} from './session-launch'

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
  deps?: GateActionDeps
}): Promise<LandingOutcome> {
  const d = real(opts.deps ?? {})
  // Eligibility first (pure, no side effects), THEN the naming law, THEN any boot: a caller
  // hears about the real blocker - no instance - before being sent off to rename a chat that
  // could not land anyway, and nothing boots or imports until both checks pass.
  const [instances, usage] = [await d.instances(), d.usage()]
  const target = pickLandingInstance(
    opts.pinnedRef,
    instances.map((i) => ({
      ref: i.ref,
      num: i.num,
      isRunning: i.isRunning,
      signedIn: i.signedIn,
    })),
    usage.map((u) => ({
      ref: u.ref,
      weeklyPct: u.weeklyPct,
      sessionPct: u.sessionPct,
      stale: u.stale,
    })),
  )
  if (!target)
    return {
      ok: false,
      reason:
        'no eligible instance: no running signed-in instance to land in, and no closed ' +
        'signed-in instance the overflow rule would allow opening',
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

/**
 * The act call. Returns null when the session has no transcript (mirror of the gate's own
 * honesty: what cannot be gated cannot be acted on).
 */
export async function actOnGate(
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
      const underRunning = r.hits.some((h) => h.changed && h.wasRunning)
      return res(
        'archived',
        underRunning
          ? 'archive flag written, but a RUNNING app holds its chat list in memory - the chat ' +
              "leaves the sidebar at that instance's next restart (misc/Manage-DesktopChat.ps1 " +
              "retires it immediately through the app's own UI)"
          : 'archive flag written and durable (no running app holds this chat in memory)',
        { archived: { profiles: r.hits.length, durable: !underRunning } },
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

  // crashed
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
      const mayOpen = closedLandingEligible(
        running.map((i) => ({ ref: i.ref })),
        d.usage().map((u) => ({
          ref: u.ref,
          weeklyPct: u.weeklyPct,
          sessionPct: u.sessionPct,
          stale: u.stale,
        })),
      )
      if (!mayOpen)
        return res(
          'parked',
          `its home instance #${inst.num} is closed, and the open accounts still have headroom ` +
            `below the ${LANDING_OVERFLOW_PCT}% overflow threshold - automation may not boot an ` +
            'app (owner rule 2026-08-30); open it yourself or order a migration',
        )
      const booted = await openAndAwait(inst, d)
      if (!booted.ok) return res('parked', booted.reason ?? 'open failed')
      const imported = await d.importSession({ sessionId, instanceDir: inst.dir, title })
      if (!imported.ok)
        return res(
          'parked',
          `could not surface in its home instance #${inst.num}: ${imported.reason ?? 'unknown'}`,
        )
      return res('surfaced', surfacedWhy(inst.num, true), {
        instance: { ref: inst.ref, num: inst.num },
        openedInstance: true,
        prompt,
        promptDelivery: 'deliver-natively-via-the-app-message-channel',
      })
    }
    const imported = await d.importSession({ sessionId, instanceDir: inst.dir, title })
    if (!imported.ok)
      return res(
        'parked',
        `could not surface in its home instance #${inst.num}: ${imported.reason ?? 'unknown'}`,
      )
    return res('surfaced', surfacedWhy(inst.num, false), {
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
  return res('surfaced', surfacedWhy(landed.instance.num, landed.openedInstance), {
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
    pinnedRefFor: d.pinnedRefFor,
    openWaitMs: d.openWaitMs,
    sleep: d.sleep,
    now: d.now,
  }
}
