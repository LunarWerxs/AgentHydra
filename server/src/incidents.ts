// server/src/incidents.ts — durable failure incidents with signature dedup, ack and resolve.
//
// Ported from NousResearch/hermes-agent cron/incidents.py (MIT, Copyright (c) Nous Research).
// Adapted for AgentHydra.
//
// WHY THIS EXISTS. Queue runs already have a status ('failed') and dispatch.ts already records the
// failure as a run event, but nothing groups repeats together. Twenty overnight runs that all die on
// the same misconfigured MCP server today produce twenty identical "run failed" moments and zero
// memory that it is ONE problem — every failed status looks equally urgent, so a genuinely new
// failure is buried in the noise of a familiar one that already got investigated. This module groups
// failures into incidents keyed by (scope, key, error signature): the same scope + key failing with
// the same normalized error bumps a counter instead of minting a fresh alert. Lifecycle:
// open -> acked -> resolved. A RESOLVED incident whose signature recurs REOPENS (back to open) rather
// than staying closed, because "fixed" that breaks again is not the same story as "still broken";
// a scope/key pair whose error TEXT changes mints a brand-new incident, because a different failure
// is a different problem even on the same run target.
//
// DEPARTURE FROM THE PYTHON SOURCE, and why: hermes's cron incidents are keyed by a stable job_id
// (a recurring cron job), so its error signature only needs whitespace+case normalization — the same
// job re-fails with near-identical text. AgentHydra's queue items are one-shot: the "job" that
// repeats is the (scope, key) pair — usually a project directory — but the STDERR TAIL attached to
// each failure carries volatile noise a cron job's error rarely does (timestamps, pids, temp paths,
// request ids). Without stripping that noise, "the same problem" would mint a new incident every
// single time just because the clock ticked, defeating the whole point of dedup. So signature
// computation here adds a placeholder pass (signatureText, below) on top of the ported
// normalize/redact/classify functions, which are otherwise a faithful, line-for-line port.

import { db } from './db'
import { sendOsNotification } from './notify-os'
import { getNotificationSettings, smtpPassword } from './notify-settings'
import { sendMail } from './notify-smtp'
import { redactSecrets } from './secrets'
// Incident/IncidentState are DEFINED in types.ts (Bun-free), not here — see that file's comment on
// why, right above them. Re-exported so every existing caller of this module keeps working.
import { INCIDENT_STATES, type Incident, type IncidentState } from './types'

export type { Incident, IncidentState }
export { INCIDENT_STATES }

/** A stored error is bounded so one giant stack trace can't bloat the incidents table forever. */
const MAX_ERROR_CHARS = 500
/** Only the head of the (already normalized) error feeds the signature — a long shared prefix with a
 *  divergent tail (e.g. a stack trace whose top frame is the same but whose tail varies by call site)
 *  should still dedup. */
const MAX_SIGNATURE_ERROR_CHARS = 200

// --- normalization, redaction, classification (ported from _normalize_error / _redact_error /
// --- _classify_failure_type) --------------------------------------------------------------------

/** Whitespace-collapsed, lowercased error text. Used both for classification (which needs "429" and
 *  "timeout" intact) and as the base for signatureText's stronger normalization below. */
function normalize(error: string): string {
  return String(error ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** normalize() plus placeholder substitution for the volatile substrings a queue run's stderr tail
 *  carries that a stable cron job_id's error text does not (see the module header). Applied ONLY to
 *  the text that feeds the signature hash — never to the text classification reads, or "429" would
 *  vanish before _classify_failure_type's own \b429\b pattern ever saw it. */
function signatureText(error: string): string {
  let t = normalize(error)
  // Windows absolute / UNC paths (case-insensitive already handled by normalize's lowercase).
  t = t.replace(/[a-z]:[\\/][^\s"'()<>]*/g, '<path>')
  t = t.replace(/\\\\[^\s"'()<>]+/g, '<path>')
  // Unix absolute paths.
  t = t.replace(/\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>')
  // ISO-ish timestamps (2026-09-04T12:34:56.789Z / "2026-09-04 12:34:56").
  t = t.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/g, '<ts>')
  // Bare HH:MM:SS (log-line clock stamps).
  t = t.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<ts>')
  // UUIDs (session ids, request ids).
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
  // Long hex runs: hashes, pids-in-hex, token-shaped strings.
  t = t.replace(/\b(?:0x)?[0-9a-f]{6,}\b/g, '<hex>')
  // Whatever plain digits are left: pids, line numbers, ports, byte counts.
  t = t.replace(/\b\d+\b/g, '<num>')
  return t.replace(/\s+/g, ' ').trim()
}

/** Redact secrets (best-effort; never throws) then bound the length. Uses the same high-confidence
 *  patterns the transcript/context-pack export already redacts with, so an incident's stored error
 *  can never leak a token-shaped string even though it is copied verbatim from a run's stderr. */
function redactError(error: string): string {
  const text = String(error ?? '')
  const { text: redacted } = redactSecrets(text)
  return redacted.slice(0, MAX_ERROR_CHARS)
}

/** (kind, pattern) pairs, checked in order; the first match wins. A pattern wrapped in `\b...\b`
 *  is matched as a regex; everything else is a plain substring test. Ported verbatim from
 *  _FAILURE_TYPE_ORDER. */
const FAILURE_TYPE_ORDER: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['rate_limit', ['\\b429\\b', 'rate limit', 'usage limit', 'quota']],
  ['timeout', ['timeout', 'timed out']],
  ['auth', ['\\b401\\b', 'unauthorized', 'authentication', 'auth']],
  ['delivery', ['delivery', 'deliver', 'delivering']],
  ['config', ['config', 'configuration', 'validation']],
  ['script', ['script', 'no_agent']],
  ['agent', ['agent', 'model', 'provider', 'inference']],
]

/** Classify a failure from error-text keywords; 'unknown' is the default. */
export function classifyFailureType(error: string): string {
  const text = normalize(error)
  if (!text) return 'unknown'
  for (const [kind, patterns] of FAILURE_TYPE_ORDER) {
    for (const p of patterns) {
      if (p.startsWith('\\b') && p.endsWith('\\b')) {
        if (new RegExp(p).test(text)) return kind
      } else if (text.includes(p)) {
        return kind
      }
    }
  }
  return 'unknown'
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Buffer.from(digest).toString('hex')
}

/** Dedup key: stable for the same (scope, key) + the same normalized-and-placeholdered error prefix. */
async function errorSignature(scope: string, key: string, error: string): Promise<string> {
  const normalized = signatureText(error).slice(0, MAX_SIGNATURE_ERROR_CHARS)
  const hex = await sha256Hex(`${scope}${key}${normalized}`)
  return hex.slice(0, 12)
}

function slug(s: string): string {
  return (
    s
      .replace(/[^a-z0-9]+/gi, '')
      .slice(0, 16)
      .toLowerCase() || 'x'
  )
}

async function incidentId(scope: string, key: string, sig: string): Promise<string> {
  const keyHash = (await sha256Hex(key)).slice(0, 8)
  return `${slug(scope)}_${keyHash}_${sig}`
}

// The `create table if not exists incidents` schema itself lives in db.ts, next to every other
// table (see its "additive migrations" block) rather than here, so importing this module never
// creates a second, later place a fresh install's schema gets assembled from — db.ts already owns
// that and incidents.ts already imports db.ts for the connection, so the reverse import would cycle.

// --- CRUD (ported from upsert_incident / ack_incident / list_incidents / get_incident /
// --- count_incidents) -----------------------------------------------------------------------

export interface RecordIncidentOptions {
  scope: string
  key: string
  error: string
  failureType?: string
  outputFile?: string | null
}

export interface RecordIncidentResult {
  id: string
  /** No existing (scope, key, signature) row — a brand-new incident. */
  isNew: boolean
  /** An existing row for this signature was 'resolved' and this occurrence reopened it. */
  reopened: boolean
  /** Occurrences on this incident after this call, including this one. */
  count: number
}

/**
 * Record (or refresh) the incident for (scope, key) + error; returns the incident id plus whether
 * this call created it, reopened it, or simply bumped an existing open/acked row's count.
 *
 * An existing row for the signature refreshes last_seen_at/error/output_file and increments count.
 * A 'resolved' row whose signature recurs REOPENS: state back to 'open', acked_at/resolved_at
 * cleared, so it shows up in the open list again exactly like a fresh failure. A CHANGED error text
 * (different normalized signature) mints a new incident id rather than reusing this one — see the
 * module header.
 */
export async function recordIncident(opts: RecordIncidentOptions): Promise<RecordIncidentResult> {
  const scope = String(opts.scope || '')
  const key = String(opts.key || '')
  const sig = await errorSignature(scope, key, opts.error)
  const id = await incidentId(scope, key, sig)
  const storedError = redactError(opts.error)
  const failureType = opts.failureType || classifyFailureType(opts.error)
  const outputFile = opts.outputFile ?? null
  const now = new Date().toISOString()

  const existing = db
    .query<{ state: IncidentState; count: number }, [string]>(
      'select state, count from incidents where id = ?',
    )
    .get(id)

  if (existing) {
    const reopened = existing.state === 'resolved'
    if (reopened) {
      db.query(
        `update incidents
           set last_seen_at = ?, error = ?, output_file = ?, count = count + 1,
               state = 'open', acked_at = null, resolved_at = null
         where id = ?`,
      ).run(now, storedError, outputFile, id)
    } else {
      db.query(
        `update incidents
           set last_seen_at = ?, error = ?, output_file = ?, count = count + 1
         where id = ?`,
      ).run(now, storedError, outputFile, id)
    }
    return { id, isNew: false, reopened, count: existing.count + 1 }
  }

  db.query(
    `insert into incidents
       (id, scope, key, error_sig, state, failure_type, first_seen_at, last_seen_at, count, error, output_file)
     values (?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
  ).run(id, scope, key, sig, failureType, now, now, storedError, outputFile)
  return { id, isNew: true, reopened: false, count: 1 }
}

/** Acknowledge an incident (open -> acked): "seen, still working on it". No-op (false) on a missing
 *  incident, one already acked, or one already resolved — ack never reopens or un-resolves. */
export function ackIncident(id: string): boolean {
  const now = new Date().toISOString()
  const r = db
    .query("update incidents set state = 'acked', acked_at = ? where id = ? and state = 'open'")
    .run(now, id)
  return Number(r.changes ?? 0) > 0
}

/** Resolve an incident (open|acked -> resolved), terminal until a recurrence reopens it via
 *  recordIncident. No-op (false) on a missing or already-resolved incident. */
export function resolveIncident(id: string): boolean {
  const now = new Date().toISOString()
  const r = db
    .query(
      "update incidents set state = 'resolved', resolved_at = ?, acked_at = coalesce(acked_at, ?) where id = ? and state != 'resolved'",
    )
    .run(now, now, id)
  return Number(r.changes ?? 0) > 0
}

function stateFilter(state: IncidentState | undefined): [string, string[]] {
  return state ? [' where state = ?', [state]] : ['', []]
}

/** Every incident, newest-activity first, optionally filtered by state. An unknown state string
 *  (never one of INCIDENT_STATES) returns an empty list rather than throwing. */
export function listIncidents(state?: IncidentState): Incident[] {
  if (state !== undefined && !INCIDENT_STATES.includes(state)) return []
  const [where, params] = stateFilter(state)
  return db
    .query<Incident, string[]>(
      `select * from incidents${where} order by last_seen_at desc, id desc`,
    )
    .all(...params)
}

export function getIncident(id: string): Incident | null {
  return db.query<Incident, [string]>('select * from incidents where id = ?').get(id) ?? null
}

export function countIncidents(state?: IncidentState): number {
  if (state !== undefined && !INCIDENT_STATES.includes(state)) return 0
  const [where, params] = stateFilter(state)
  const row = db
    .query<{ n: number }, string[]>(`select count(*) as n from incidents${where}`)
    .get(...params)
  return Number(row?.n ?? 0)
}

// --- notification (incident-aware wrapper over notify-os / notify-smtp) ----------------------

/** The user-facing copy for one incident, shared by the desktop toast and the email subject/body. */
function incidentMessage(
  result: RecordIncidentResult,
  opts: RecordIncidentOptions,
): {
  title: string
  body: string
} {
  const verb = result.reopened ? 'reopened' : 'new'
  return {
    title: `AgentHydra: ${verb} incident (${opts.scope})`,
    body: `${opts.key}\n${redactError(opts.error)}`,
  }
}

/**
 * Whether this recordIncident() outcome is worth paging a human about: the first occurrence, or a
 * reopen (the incident was believed fixed and is not). Every occurrence in between — a repeat of an
 * already-open-or-acked incident — is a deliberate no-op here even though recordIncident still
 * bumped its count. This is the exact dedup/suppression the codebase gap names: without it, twenty
 * overnight runs failing identically would page the same way twenty times. Pure and side-effect
 * free, so the decision is testable without touching a real notification channel.
 */
export function shouldNotifyIncident(result: RecordIncidentResult): boolean {
  return result.isNew || result.reopened
}

/**
 * Deliver a notification for one recordIncident() call, over the same OS + email channels reset
 * notifications already use — gated by shouldNotifyIncident, above.
 *
 * Never throws — same best-effort contract as sendOsNotification/sendMail; a failed channel is
 * reported in the result rather than raised.
 */
export async function deliverIncidentNotification(
  result: RecordIncidentResult,
  opts: RecordIncidentOptions,
): Promise<{
  desktop: { attempted: boolean; ok: boolean }
  email: { attempted: boolean; ok: boolean }
}> {
  const out = {
    desktop: { attempted: false, ok: false },
    email: { attempted: false, ok: false },
  }
  if (!shouldNotifyIncident(result)) return out // suppressed repeat

  const settings = getNotificationSettings()
  if (!settings.notifyEnabled) return out
  const { title, body } = incidentMessage(result, opts)

  if (settings.notifyDesktop) {
    out.desktop.attempted = true
    const r = await sendOsNotification({ title, body, sticky: settings.notifyPersistent })
    out.desktop.ok = r.ok
  }

  if (settings.notifyEmail && settings.notifySmtpHost && settings.notifyEmailTo) {
    out.email.attempted = true
    const r = await sendMail(
      {
        host: settings.notifySmtpHost,
        port: settings.notifySmtpPort,
        secure: settings.notifySmtpSecure,
        user: settings.notifySmtpUser,
        pass: smtpPassword(),
      },
      {
        from: settings.notifyEmailFrom || settings.notifySmtpUser || settings.notifyEmailTo,
        to: settings.notifyEmailTo,
        subject: title,
        text: `${body}\n\nIncident ${result.id} (${opts.scope}), occurrence #${result.count}.\n\n— AgentHydra`,
      },
    )
    out.email.ok = r.ok
  }

  return out
}
