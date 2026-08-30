// server/src/courier.ts - THE COURIER: the sanctioned deliverer for the delivery ledger, and
// the named replacement for the banned relay (owner, 2026-08-28: never commandeer his working
// chats; "you'll find other ways" - this is the other way). A surfaced chat's staged prompt
// needs a SENDER; this is the daemon's own hands.
//
// ⛔ THE SCHEDULER TRANSPORT WAS DEMOLISHED, not disabled (2026-08-30). The first cut armed a
// one-shot task in the app's own scheduler and let the app fire a session that would relay.
// The task DOES fire (proven) - but the session it spawns is flagged UNATTENDED and
// `ccd_session_mgmt send_message` refuses there verbatim: "This tool is unavailable in
// unattended sessions (scheduled-task runs and remote-dispatched trees)." So that transport
// can never deliver into an existing chat, and every line that served it is gone - including
// the quit/register/relaunch app CYCLING, which was risk paid for nothing, and the
// desktop-tasks.ts module itself (deleted: no caller remained, and code kept for a
// hypothetical future consumer is exactly what the standing rules forbid - git has it if the
// "start fresh work in a dormant instance" feature is ever actually built).
//
// THE TRANSPORT THAT WORKS, proven end to end on the real fleet: drive the target chat's own
// composer through UI Automation (ui-deliver.ts) - select the chat, PROVE its conversation is
// on screen, type, Send. A dormant chat answered with zero clicks and no human.
//
// THE SPLIT OF LABOR:
//   gate-actions  stages a prompt when it surfaces a chat (deliveries.ts).
//   courier       delivers pending rows through the composer, then leaves the row alone -
//                 the ledger's own receipt logic settles it from transcript movement.
//
// Rails, each from a banked burn:
//   - GRACE: a row younger than COURIER_GRACE_MS is left alone. The AI that surfaced the chat
//     was handed the same prompt and usually delivers it in seconds; the courier is the
//     fallback, not a race - delivering early is how you get a duplicate.
//   - AIM: ui-deliver refuses unless the caller proves the target's own conversation is on
//     screen (courier-deliver.ts derives that proof from the chat's first user turn). A row
//     that cannot be aimed stays pending and is reported; it is NEVER sent on a guess. This is
//     the rail whose absence got v1's UI injection deleted.
//   - A signed-out instance is never touched (its chats are not reachable and its account
//     state is not ours to disturb).
//   - Act-mode passes run inside the process-wide act lock, so a delivery can never interleave
//     with a gate deed driving the same app's UI.
//   - A per-pass CAP, so one tick can never spray the fleet.

import {
  type CourierDeliverDeps,
  type CourierDeliveryAttempt,
  deliverPendingRows,
  distinctInstances,
} from './courier-deliver'
import { type DeliveryRow, deliverableDeliveries } from './deliveries'
import { type FleetInstanceEntry, fleetInstances } from './fleet-instances'
import { withActSerialized } from './gate-actions'
import { pathKey } from './path-key'
import { desktopHomeFor } from './session-launch'

/** A pending row younger than this is not delivered yet: the surfacing caller was handed the
 *  same prompt and usually delivers it natively within seconds. */
export const COURIER_GRACE_MS = 5 * 60_000
/** Most deliveries one pass will attempt. Each drives a real app's UI. */
export const COURIER_MAX_PER_PASS = 5

export interface CourierRow {
  sessionId: string
  prompt: string
  stagedAt: number
  instanceRef: string
}

export interface CourierReport {
  /** true = this pass only PLANNED; nothing was typed anywhere. */
  dryRun: boolean
  /** What would be / was delivered, per row. */
  attempts: CourierDeliveryAttempt[]
  /** Rows deliberately left for LATER by this pass (a fresh surfacing still inside its grace
   *  window, mostly). Not to be confused with an attempt whose outcome is 'on-hold', which is
   *  the owner taking that chat off automation entirely (holds.ts). */
  held: Array<{ sessionId: string; reason: string }>
  /** Pending rows no courier can carry at all. */
  unroutable: Array<{ sessionId: string; instanceRef: string | null; reason: string }>
  /** How many DISTINCT apps this pass touched. */
  instancesTouched: number
  checkedAt: string
}

export interface CourierDeps {
  nowMs?: number
  pending?: () => Pick<DeliveryRow, 'session_id' | 'prompt' | 'instance_ref' | 'staged_at'>[]
  instancesList?: () => Promise<FleetInstanceEntry[]>
  homeFor?: (sessionId: string) => Promise<string | null>
  /** The delivery step (courier-deliver.ts); seam for tests. */
  deliverRows?: typeof deliverPendingRows
  /** Extra deps handed straight to the delivery step. */
  deliverDeps?: CourierDeliverDeps
  /** The process-wide act serializer; every act-mode pass runs inside it. */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>
  max?: number
}

/**
 * One courier pass over the ledger: resolve each pending row to a reachable instance, hold
 * anything inside its grace window, and deliver the rest through the composer actuator.
 * `act: false` computes the same lanes and types nothing.
 *
 * pendingDeliveries() reconciles the ledger first by construction, so a row that was already
 * delivered can never be delivered twice here.
 */
export async function courierPass(
  opts: { act: boolean },
  deps: CourierDeps = {},
): Promise<CourierReport> {
  if (opts.act) {
    const serialize = deps.serialize ?? withActSerialized
    return serialize(() => courierPassInner(opts, deps))
  }
  return courierPassInner(opts, deps)
}

async function courierPassInner(
  opts: { act: boolean },
  deps: CourierDeps = {},
): Promise<CourierReport> {
  const now = deps.nowMs ?? Date.now()
  // pending AND deaf: the composer transport reaches a "deaf" chat (it drives the app, which
  // runs the turn), and a just-surfaced chat is reconciled deaf almost immediately because
  // its own import parks a phantom live process. See deliverableDeliveries.
  const pending = (deps.pending ?? deliverableDeliveries)()
  const instances = await (deps.instancesList ?? fleetInstances)()
  const homeFor = deps.homeFor ?? desktopHomeFor
  const max = deps.max ?? COURIER_MAX_PER_PASS

  const byDir = new Map<string, FleetInstanceEntry>()
  for (const i of instances) byDir.set(pathKey(i.dir, true), i)

  const unroutable: CourierReport['unroutable'] = []
  const held: CourierReport['held'] = []
  const deliverable: CourierRow[] = []

  for (const row of pending) {
    let ref = row.instance_ref
    if (!ref) {
      // Staged without a home - resolve it now, the same both-shapes lookup every
      // surface-purity guard uses. Still nothing = honestly stuck.
      const home = await homeFor(row.session_id).catch(() => null)
      ref = home ? `desktop:${home}` : null
    }
    if (!ref) {
      unroutable.push({
        sessionId: row.session_id,
        instanceRef: row.instance_ref,
        reason: 'no desktop home found for this session - nothing to deliver into',
      })
      continue
    }
    if (!ref.startsWith('desktop:')) {
      unroutable.push({
        sessionId: row.session_id,
        instanceRef: row.instance_ref,
        reason: `'${ref}' is not a desktop instance - the courier drives a desktop app's composer`,
      })
      continue
    }
    const entry = byDir.get(pathKey(ref.slice('desktop:'.length), true))
    if (!entry) {
      unroutable.push({
        sessionId: row.session_id,
        instanceRef: ref,
        reason: 'instance not in the fleet list - stale ref or removed instance',
      })
      continue
    }
    if (!entry.signedIn) {
      unroutable.push({
        sessionId: row.session_id,
        instanceRef: ref,
        reason: `instance #${entry.num} (${entry.name}) is signed out - its chats are not reachable`,
      })
      continue
    }
    if (!entry.isRunning) {
      // The composer needs a live window. Opening an app unattended is a visible act, so the
      // courier reports it and waits for the app to be up rather than launching it mid-pass.
      held.push({
        sessionId: row.session_id,
        reason: `instance #${entry.num} (${entry.name}) is closed - the composer needs a running app; delivery waits for it to open`,
      })
      continue
    }
    if (now - row.staged_at < COURIER_GRACE_MS) {
      held.push({
        sessionId: row.session_id,
        reason: `staged less than ${COURIER_GRACE_MS / 60_000}min ago - the AI that surfaced it usually delivers first; the courier is the fallback`,
      })
      continue
    }
    deliverable.push({
      sessionId: row.session_id,
      prompt: row.prompt,
      stagedAt: row.staged_at,
      instanceRef: ref,
    })
  }

  let attempts: CourierDeliveryAttempt[] = []
  if (deliverable.length > 0) {
    if (opts.act) {
      attempts = await (deps.deliverRows ?? deliverPendingRows)({
        ...deps.deliverDeps,
        pending: () =>
          deliverable.map((r) => ({
            session_id: r.sessionId,
            prompt: r.prompt,
            instance_ref: r.instanceRef,
            staged_at: r.stagedAt,
          })),
        max,
      })
    } else {
      // Plan mode names exactly what WOULD be attempted, and types nothing.
      attempts = deliverable.slice(0, max).map((r) => ({
        sessionId: r.sessionId,
        title: null,
        instanceDir: r.instanceRef.slice('desktop:'.length),
        outcome: 'planned' as CourierDeliveryAttempt['outcome'],
        detail: 'would be delivered through the composer actuator',
      }))
    }
  }

  return {
    dryRun: !opts.act,
    attempts,
    held,
    unroutable,
    instancesTouched: distinctInstances(attempts),
    checkedAt: new Date(now).toISOString(),
  }
}
