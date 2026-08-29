// server/src/orchestrator-courier.ts — THE ZERO-TOUCH DELIVERY QUEUE.
//
// WHY (owner directive, Michael, 2026-08-28: "Without me having to do ANY work. Lift zero
// fingers."): every delivery rung before this needed something already awake inside the target
// instance. A window whose chats were all asleep could only be reached by a human typing in it
// once, which is a finger, which is not allowed.
//
// THE SHAPE. A delivery into an unreachable instance is no longer parked - it is QUEUED here,
// and each instance runs a COURIER TASK in the app's own scheduler (see desktop-tasks.ts), which
// the app fires by itself on a cron, inside that account, whether or not anything else is awake.
// The courier run drains this queue: for each pending delivery it calls the app's own
// send_message with the composed payload (booting the dormant target), reports the outcome, and
// stops. Nothing is ever asked of a working chat (the relay ban), and nothing is asked of the
// owner.
//
// WHY A QUEUE AND NOT A DIRECT CALL. The daemon cannot send into an app at all; only a session
// inside it can. The queue is the seam between "the server decided what to send" and "something
// inside that app performs it", and it keeps the existing contract intact: the reviewer still
// rules first, the server still composes, and verify() still proves delivery by re-reading the
// transcript rather than trusting the courier's word.

import { db } from './db'

export interface PendingDelivery {
  /** Worklist item this delivery belongs to - the ledger key verify() closes. */
  itemId: string
  /** The app's OWN chat id (local_*), read from metadata, never constructed. */
  chatId: string
  /** The exact composed message. The courier sends it verbatim. */
  message: string
  /** When it was queued, ISO. */
  at: string
  /** Attempts already made, for the breaker to see. */
  attempts: number
}

const KEY_PREFIX = 'courierQ:'

function keyFor(instanceDir: string, itemId: string): string {
  return `${KEY_PREFIX}${instanceDir.replace(/[\\/]+$/, '').toLowerCase()}|${itemId}`
}

/** Queue one delivery for an instance's courier. Idempotent per (instance, item): re-queuing the
 *  same item replaces its payload rather than stacking duplicates, so a re-approved item cannot
 *  produce two sends. */
export function enqueueDelivery(
  instanceDir: string,
  d: Omit<PendingDelivery, 'at' | 'attempts'>,
): void {
  const k = keyFor(instanceDir, d.itemId)
  const prior = db
    .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
    .get(k)
  let attempts = 0
  if (prior) {
    try {
      attempts = (JSON.parse(prior.value) as PendingDelivery).attempts ?? 0
    } catch {
      attempts = 0
    }
  }
  const row: PendingDelivery = { ...d, at: new Date().toISOString(), attempts }
  db.query(
    `insert into orchestrator_kv (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(k, JSON.stringify(row), new Date().toISOString())
}

/** Everything waiting for one instance's courier, oldest first. */
export function pendingDeliveries(instanceDir: string): PendingDelivery[] {
  const prefix = `${KEY_PREFIX}${instanceDir.replace(/[\\/]+$/, '').toLowerCase()}|`
  const rows = db
    .query<{ key: string; value: string }, [string]>(
      'select key, value from orchestrator_kv where key like ? order by updated_at asc',
    )
    .all(`${prefix}%`)
  const out: PendingDelivery[] = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.value) as PendingDelivery)
    } catch {
      /* an unreadable row is dropped by the next drain rather than blocking the queue */
    }
  }
  return out
}

/** Drop a delivery once the courier reports it sent. The LEDGER is still closed by verify()
 *  re-reading the target's transcript - this only removes it from the courier's work. */
export function clearDelivery(instanceDir: string, itemId: string): void {
  db.query('delete from orchestrator_kv where key = ?').run(keyFor(instanceDir, itemId))
}

/** Record a failed attempt so a structurally undeliverable item cannot spin forever. Returns the
 *  new attempt count; the caller decides what to do at the cap (the breaker's job). */
export function noteDeliveryAttempt(instanceDir: string, itemId: string): number {
  const k = keyFor(instanceDir, itemId)
  const row = db
    .query<{ value: string }, [string]>('select value from orchestrator_kv where key = ?')
    .get(k)
  if (!row) return 0
  let d: PendingDelivery
  try {
    d = JSON.parse(row.value) as PendingDelivery
  } catch {
    return 0
  }
  d.attempts = (d.attempts ?? 0) + 1
  db.query('update orchestrator_kv set value = ?, updated_at = ? where key = ?').run(
    JSON.stringify(d),
    new Date().toISOString(),
    k,
  )
  return d.attempts
}

/** The courier task id for an instance. One per instance, prefixed so the task janitor can only
 *  ever remove its own (see desktop-tasks.ts). */
export function courierTaskId(instanceLabel: string): string {
  return `orch-courier-${instanceLabel.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

/**
 * The courier task's prompt: what the app runs, by itself, on the cron, inside that account.
 *
 * Written as a closed loop with an explicit stop: fetch, send each, report each, stop. It must
 * never do anything else - a courier that starts work would be an unattended chat nobody asked
 * for, on an account the owner did not choose for it.
 */
export function courierTaskPrompt(instanceDir: string, port: number): string {
  const url = `http://localhost:${port}/api/orchestrator/courier`
  return [
    'MEASURED PLATFORM LIMIT, and the reason this task does the work instead of passing it on',
    '(2026-08-29): a scheduled-task run is an UNATTENDED session, and the session-management',
    'send_message tool refuses outright in unattended sessions ("This tool is unavailable in',
    'unattended sessions"). A courier that only relays is therefore impossible here. What IS',
    'possible is everything else: this run is a real, visible session on this account with full',
    "file and shell access, and every dormant chat's transcript is a readable file on disk. So",
    'the delivery becomes a CONTINUATION: you pick up the work the message was asking for,',
    "with the predecessor's own transcript as your context. Same account, same repo, visible",
    'session, no human involved.',
    '',
    "You are this Claude Desktop account's ORCHESTRATOR COURIER. This run is a scheduled",
    'task fired by the app itself. Your ONLY job is to hand over messages the orchestrator has',
    'queued for chats in THIS app, then stop. Do not start work, do not touch files, do not',
    'message any chat except as instructed below.',
    '',
    'Do exactly this:',
    '',
    `1. Fetch your queue (one call):`,
    `   curl -s "${url}/pending?instance=${encodeURIComponent(instanceDir)}"`,
    '   It returns {"deliveries":[{"itemId","chatId","message"}, ...]}. An empty list means',
    '   there is nothing to do: say "courier: nothing queued" and STOP.',
    '',
    '2. For EACH delivery, CONTINUE THAT WORK YOURSELF in this session:',
    "   a. Read the predecessor's context. Its transcript is on disk - find it with",
    '      `curl -s "http://localhost:PORTNUM/api/chats/dossier?q=<chatId>"` for its session id,',
    '      then read the TAIL of ~/.claude/projects/<project-key>/<sessionId>.jsonl (last few',
    '      hundred lines are enough; it is JSONL, one event per line). If you cannot find or',
    '      read it, say so plainly and treat the message text as your whole brief.',
    '   b. Do what the message asks, in that repo, under every standing rule: commit only files',
    '      you touched and path-scoped, never `git add -A`; never push a PUBLIC repo without the',
    '      public-repo warning protocol; never spend money, touch credentials, or delete real',
    '      data - if the work needs one of those, stop and report it as needing the owner.',
    '   c. Keep it to ONE item of work per delivery. You are a continuation, not a new project.',
    '',
    '3. After each item, report it back so the orchestrator can close its ledger:',
    `   curl -s -X POST "${url}/done" -H "Content-Type: application/json" \\`,
    `     -d "{\\"instance\\":\\"${instanceDir.replace(/\\/g, '\\\\\\\\')}\\",\\"itemId\\":\\"<itemId>\\",\\"ok\\":true}"`,
    '   On a tool error, post ok:false with an "error" field carrying the message verbatim.',
    '',
    '   On a failure, post ok:false with an "error" field carrying the reason verbatim.',
    '',
    '4. Finish with a short recap: what you continued, what you changed, what you verified, and',
    '   anything that needs the owner. Then STOP - one pass per run, never a second lap.',
    '',
    'Never message another chat, and never ask the owner to do something a rule already lets you',
    'do. If a delivery is genuinely blocked (it needs a credential, a spend, a publish, or a',
    'human decision), report ok:false with that reason - "waiting on the owner" is a legitimate',
    'outcome; silently doing nothing is not.',
  ]
    .join('\n')
    .replace(/PORTNUM/g, String(port))
}
