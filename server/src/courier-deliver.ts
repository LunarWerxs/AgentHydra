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
import { type DeliveryRow, pendingDeliveries } from './deliveries'
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

/**
 * A snippet of THIS session's own conversation, for ui-deliver's on-screen aim check.
 *
 * The FIRST user turn is used, not the newest: it is the most stable thing on screen (a
 * newest-turn snippet can be mid-render, or scrolled out) and it is what the app shows as
 * "Du hast gesagt: ..." in the conversation pane. Null when nothing usable is found - the
 * caller must then leave the row pending rather than aim at nothing.
 */
export function deriveVerifyText(transcriptPath: string): string | null {
  let text: string
  try {
    const size = statSync(transcriptPath).size
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES))
    const fd = openSync(transcriptPath, 'r')
    try {
      readSync(fd, buf, 0, buf.length, 0)
    } finally {
      closeSync(fd)
    }
    text = buf.toString('utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{') || !t.includes('"user"')) continue
    try {
      const rec = JSON.parse(t) as {
        type?: string
        message?: { content?: unknown }
      }
      if (rec.type !== 'user') continue
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
      return flat.slice(0, VERIFY_MAX)
    } catch {
      // A truncated or half-written line - skip it, never guess.
    }
  }
  return null
}

export interface CourierDeliveryAttempt {
  sessionId: string
  title: string | null
  instanceDir: string | null
  outcome: DeliverResult['outcome'] | 'no-title' | 'no-aim-proof' | 'no-home' | 'planned'
  detail: string
}

export interface CourierDeliverDeps {
  pending?: () => Pick<DeliveryRow, 'session_id' | 'prompt' | 'instance_ref' | 'staged_at'>[]
  /** Rendered title + instance for a session (the app's own view). */
  chatOf?: (sessionId: string) => { title: string | null; instance: string } | null
  transcriptOf?: (sessionId: string) => string | null
  deliver?: typeof uiDeliverToChat
  /** Cap per pass, so one sweep can never spray a fleet. */
  max?: number
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

  const out: CourierDeliveryAttempt[] = []
  for (const row of pending) {
    if (out.length >= max) break
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
    const verifyText = path ? deriveVerifyText(path) : null
    if (!verifyText) {
      out.push({
        sessionId: row.session_id,
        title: chat.title,
        instanceDir,
        outcome: 'no-aim-proof',
        detail: "could not derive a snippet of this chat's own conversation - not aiming blind",
      })
      continue
    }
    const r = await deliver({
      instanceDir,
      title: chat.title,
      message: row.prompt,
      verifyText,
    })
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
