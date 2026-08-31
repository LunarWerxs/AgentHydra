// server/src/courier-deliver.ts - THE COURIER'S HANDS: work the delivery ledger's pending
// rows by typing each staged prompt into its own chat through the app's composer
// (ui-deliver.ts), then let the ledger's own receipt logic settle the row.
//
// WHY THIS AND NOT THE SCHEDULER (measured 2026-08-30, both live): the app's scheduler DOES
// fire an externally-written task - but the session it spawns is flagged UNATTENDED, and
// `ccd_session_mgmt send_message` refuses there verbatim ("This tool is unavailable in
// unattended sessions (scheduled-task runs and remote-dispatched trees)"). So a scheduled run
// can START work in an instance; it can never deliver INTO an existing chat. Driving the
// composer of the target chat itself is the one channel that reaches a specific dormant chat,
// and it is proven end to end: a dormant chat answered with zero clicks and no human.
//
// THE AIM PROOF IS NOT OPTIONAL. ui-deliver refuses unless the caller names text that must be
// visible in the target's own conversation, so we derive `verifyText` from THAT session's
// transcript - its own words. A row whose verify text cannot be derived is left pending and
// reported, never delivered on a guess: the whole reason v1's UI injection was deleted is
// that it typed into whatever happened to be in front of it.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type BreakerVerdict, checkBreaker, clearAttempts, noteAttempt } from './breaker'
import { type DeliveryRow, pendingDeliveries } from './deliveries'
import { type Hold, isHeld } from './holds'
import { findDesktopChat } from './instance-sessions'
import { findTranscriptById } from './live-registry'
import { pathKey } from './path-key'
import { type DeliverResult, uiDeliverToChat } from './ui-deliver'

/** How much transcript tail to read when deriving the aim proof. */
const TAIL_BYTES = 256 * 1024
/** The aim snippet: long enough to be unique to this chat, short enough to survive the app's
 *  own rendering (the conversation pane exposes message text as accessible names). */
const VERIFY_MIN = 24
const VERIFY_MAX = 60

/** How many aim candidates to hand the actuator. Each rejected candidate costs one UIA pass
 *  (~seconds) and types nothing, so a short ladder is cheap; an endless one would be a stall. */
const MAX_CANDIDATES = 3
/** Machinery-written prompts that are IDENTICAL across chats (the crashed-lane resume notice).
 *  Using one as the aim proof would let the actuator "verify" against a DIFFERENT chat that
 *  received the same boilerplate - the exact compact-summary trap, one layer up. */
const BOILERPLATE_PREFIXES = ['[agenthydra]']

/**
 * Snippets of THIS session's own conversation, for ui-deliver's on-screen aim check -
 * NEWEST eligible user turn first. Empty when nothing usable is found: the caller must then
 * leave the row pending rather than aim at nothing.
 *
 * Newest-first is measured, not aesthetic (2026-08-31): the conversation pane opens scrolled
 * to the BOTTOM, so on any long chat the first user turn is far above the viewport and the
 * old first-turn rule made the actuator refuse every long-running chat on this fleet - the
 * two chats that most needed rescuing were exactly the two it could not aim at. The ladder
 * keeps the short-chat case working (its oldest turn is still on screen AND still in the
 * tail buffer) because a wrong-chat refusal types nothing, so trying the next candidate is
 * free. The transcript TAIL is read for the same reason: on a transcript bigger than the
 * buffer, the head holds turns the pane cannot possibly be showing.
 */
export function deriveVerifyCandidates(transcriptPath: string): string[] {
  let text: string
  try {
    const size = statSync(transcriptPath).size
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES))
    const fd = openSync(transcriptPath, 'r')
    try {
      readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length))
    } finally {
      closeSync(fd)
    }
    text = buf.toString('utf8')
  } catch {
    return []
  }
  const inOrder: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{') || !t.includes('"user"')) continue
    try {
      const rec = JSON.parse(t) as {
        type?: string
        isCompactSummary?: boolean
        message?: { content?: unknown }
      }
      if (rec.type !== 'user') continue
      // A COMPACTION SUMMARY IS NOT THIS CHAT'S OWN WORDS. Claude Code writes the synthetic
      // "This session is being continued from a previous conversation..." preamble as a user
      // record flagged isCompactSummary, and ~8% of sessions carry one. Its opening sentence
      // is IDENTICAL across every such chat, so using it as the aim proof would let the
      // actuator "verify" itself against a completely different conversation and type there
      // (review-confirmed must-fix). Skip it and keep looking for a real turn.
      if (rec.isCompactSummary === true) continue
      const content = rec.message?.content
      let s: string | null = null
      if (typeof content === 'string') s = content
      else if (Array.isArray(content)) {
        const first = content.find(
          (b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
        )
        s = first?.text ?? null
      }
      if (!s) continue
      // One line, collapsed - the accessible name the app renders is a single string.
      const flat = s.replace(/\s+/g, ' ').trim()
      if (flat.length < VERIFY_MIN) continue
      // Same cross-chat trap as the compact summary, machinery-made: the resume notice is a
      // code constant delivered to every crashed chat, so it proves nothing about WHICH one.
      if (BOILERPLATE_PREFIXES.some((p) => flat.startsWith(p))) continue
      inOrder.push(flat.slice(0, VERIFY_MAX))
    } catch {
      // A truncated or half-written line - skip it, never guess.
    }
  }
  const seen = new Set<string>()
  const newestFirst: string[] = []
  for (let i = inOrder.length - 1; i >= 0 && newestFirst.length < MAX_CANDIDATES; i--) {
    const c = inOrder[i] as string
    if (seen.has(c)) continue
    seen.add(c)
    newestFirst.push(c)
  }
  return newestFirst
}

/** The single best aim snippet (the newest eligible turn), or null. Kept for callers and
 *  tests that need one string; the courier itself walks the full ladder. */
export function deriveVerifyText(transcriptPath: string): string | null {
  return deriveVerifyCandidates(transcriptPath)[0] ?? null
}

export interface CourierDeliveryAttempt {
  sessionId: string
  title: string | null
  instanceDir: string | null
  outcome:
    | DeliverResult['outcome']
    | 'no-title'
    | 'no-aim-proof'
    | 'no-home'
    | 'planned'
    | 'recently-sent'
    | 'on-hold'
    | 'suppressed'
  detail: string
}

/**
 * THE POST-SEND COOLDOWN, and why it is not optional.
 *
 * A row leaves 'pending'/'deaf' only when reconcile sees a transcript record NEWER than
 * staged_at - but the app writes that record seconds AFTER Send is invoked. In that window
 * the row still reads deliverable, so the next pass (the 5-minute timer, or a manual run)
 * would select the same chat and type the same prompt AGAIN. In-memory is the right scope:
 * every act-mode pass runs in this one process, behind the same act lock.
 */
const RECENTLY_SENT_MS = 3 * 60_000
const recentlySent = new Map<string, number>()

/** Exported for tests: forget the cooldown (a fresh daemon has no memory of it either). */
export function clearRecentlySent(): void {
  recentlySent.clear()
}

export interface CourierDeliverDeps {
  pending?: () => Pick<DeliveryRow, 'session_id' | 'prompt' | 'instance_ref' | 'staged_at'>[]
  /** Rendered title + instance for a session (the app's own view). */
  chatOf?: (sessionId: string) => { title: string | null; instance: string } | null
  transcriptOf?: (sessionId: string) => string | null
  deliver?: typeof uiDeliverToChat
  /** Cap per pass, so one sweep can never spray a fleet. */
  max?: number
  /** Clock seam for the post-send cooldown. */
  nowMs?: () => number
  /** Per-chat automation opt-out (holds.ts); seamed for tests. */
  heldSession?: (sessionId: string) => Hold | null
  /** Circuit breaker seams (breaker.ts). */
  breaker?: (sessionId: string, nowMs: number) => BreakerVerdict
  note?: (sessionId: string, nowMs: number) => void
}

/**
 * Deliver every pending row we can aim at. Sequential on purpose: each delivery drives one
 * app's UI, and two at once in the same instance would race the composer.
 */
export async function deliverPendingRows(
  deps: CourierDeliverDeps = {},
): Promise<CourierDeliveryAttempt[]> {
  const pending = (deps.pending ?? pendingDeliveries)()
  const chatOf =
    deps.chatOf ??
    ((sid: string) => {
      const m = findDesktopChat(sid)
      return m ? { title: m.title, instance: m.instance } : null
    })
  const transcriptOf =
    deps.transcriptOf ?? ((sid: string) => findTranscriptById(join(homedir(), '.claude'), sid))
  const deliver = deps.deliver ?? uiDeliverToChat
  const max = deps.max ?? 5
  const now = deps.nowMs ?? Date.now

  const out: CourierDeliveryAttempt[] = []
  for (const row of pending) {
    if (out.length >= max) break
    // Already sent moments ago? The ledger cannot know yet (the app writes the receipt
    // seconds later), so this is the only thing standing between a slow app and a duplicate.
    // A HELD chat is the owner saying "leave this alone on your own initiative", so the
    // unattended courier does not type into it. He can still deliver by asking directly.
    const hold = (deps.heldSession ?? isHeld)(row.session_id)
    if (hold) {
      out.push({
        sessionId: row.session_id,
        title: null,
        instanceDir: null,
        outcome: 'on-hold',
        detail: `on hold since ${hold.heldAt}: ${hold.reason} - the automation leaves this chat alone (a direct request still works)`,
      })
      continue
    }
    // ⛔ THE ONE ACTUATOR THAT DRIVES REAL UI WAS THE ONE WITH NO ATTEMPT CAP. Archive and
    // surface have been behind the breaker since it was built; delivery was not, and its only
    // anti-repeat guard (recentlySent, below) is stamped on SUCCESS - so every failure outcome
    // left the row fully eligible and the always-on 5-minute courier tick retyped into the same
    // chat forever, with no backoff. Four futile attempts in six hours is enough; a direct
    // request is never blocked, and a delivery that lands clears the count.
    const brake = (deps.breaker ?? ((id: string, at: number) => checkBreaker('deliver', id, at)))(
      row.session_id,
      now(),
    )
    if (brake.suppressed) {
      out.push({
        sessionId: row.session_id,
        title: null,
        instanceDir: null,
        outcome: 'suppressed',
        detail: `${brake.why} (retry allowed after ${brake.retryAfter})`,
      })
      continue
    }
    const sentAt = recentlySent.get(row.session_id)
    if (sentAt !== undefined && now() - sentAt < RECENTLY_SENT_MS) {
      out.push({
        sessionId: row.session_id,
        title: null,
        instanceDir: null,
        outcome: 'recently-sent',
        detail: `delivered ${Math.round((now() - sentAt) / 1000)}s ago - waiting for the transcript receipt rather than sending twice`,
      })
      continue
    }
    const chat = chatOf(row.session_id)
    const instanceDir = row.instance_ref?.startsWith('desktop:')
      ? row.instance_ref.slice('desktop:'.length)
      : (chat?.instance ?? null)
    if (!instanceDir) {
      out.push({
        sessionId: row.session_id,
        title: chat?.title ?? null,
        instanceDir: null,
        outcome: 'no-home',
        detail: 'no desktop instance known for this session',
      })
      continue
    }
    if (!chat?.title) {
      // The app matches rows by their RENDERED name; without one there is nothing to aim at
      // (an imported chat renders 'Untitled' until it is renamed through the app).
      out.push({
        sessionId: row.session_id,
        title: null,
        instanceDir,
        outcome: 'no-title',
        detail: 'no rendered title for this chat - rename it through the app first',
      })
      continue
    }
    const path = transcriptOf(row.session_id)
    const candidates = path ? deriveVerifyCandidates(path) : []
    if (candidates.length === 0) {
      out.push({
        sessionId: row.session_id,
        title: chat.title,
        instanceDir,
        outcome: 'no-aim-proof',
        detail: "could not derive a snippet of this chat's own conversation - not aiming blind",
      })
      continue
    }
    // COUNT THE ATTEMPT BEFORE MAKING IT, so an attempt that hangs or crashes the pass is still
    // on the record. A counter written only on the way out cannot bound the thing it is for.
    ;(deps.note ?? ((id: string, at: number) => noteAttempt('deliver', id, at)))(
      row.session_id,
      now(),
    )
    // Walk the ladder: a wrong-chat refusal PROVED nothing was typed, so the next candidate
    // (an older turn - the pane may be scrolled up, or the newest turn mid-render) is free to
    // try. Any other outcome - delivered, busy, error - ends the walk; those all mean the
    // aim question was settled or the attempt actually engaged the window.
    let r: DeliverResult = {
      ok: false,
      outcome: 'error',
      detail: 'no delivery attempted',
    }
    for (const verifyText of candidates) {
      r = await deliver({
        instanceDir,
        title: chat.title,
        message: row.prompt,
        verifyText,
      })
      if (r.outcome !== 'wrong-chat') break
    }
    // Stamp on SUCCESS only: a refusal typed nothing, so it must stay retryable.
    // A delivery that LANDED also forgets the count - the brake is for futility, not for work
    // that works (same rule as the surface lane).
    if (r.outcome === 'delivered') {
      recentlySent.set(row.session_id, now())
      if (!deps.note) clearAttempts('deliver', row.session_id)
    }
    out.push({
      sessionId: row.session_id,
      title: chat.title,
      instanceDir,
      outcome: r.outcome,
      detail: r.detail,
    })
  }
  return out
}

/** How many DISTINCT instances a set of attempts touched - the caller reports it so a pass
 *  that hammered one app is visibly different from one that spread across the fleet. */
export function distinctInstances(rows: Array<{ instanceDir: string | null }>): number {
  return new Set(rows.map((r) => (r.instanceDir ? pathKey(r.instanceDir, true) : ''))).size
}
