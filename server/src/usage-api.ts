// server/src/usage-api.ts — the FAST path for reading quota: talk to the usage endpoint directly.
//
// WHY this exists. The original probe shelled out to `claude -p "/usage"`, which is the only route
// the CLI documents. It works, but it pays for a full Claude Code boot (the shipped `claude` is a
// ~250 MB Bun-compiled binary): measured 9.2 s per check on this machine, every time, per instance.
// With five instances that is the whole "refresh all" wall-clock.
//
// The CLI's `/usage` screen is itself just a GET against a plain REST endpoint (`fetchUtilization`
// in the CLI bundle → `GET /api/oauth/usage`, Bearer-authenticated with the same OAuth access token
// we already resolve for dispatch). Calling it ourselves is the same read, minus the process:
// measured 169–424 ms, i.e. ~25-50x faster, and it does not spawn anything.
//
// It is also STRICTLY MORE INFORMATION than the text screen:
//   - `resets_at` is a real ISO-8601 timestamp, so the auto-resume monitor can schedule against it
//     exactly instead of re-parsing a yearless human string like "Jul 19, 3:59am" (see parseResetTime).
//   - `severity` is computed server-side (normal | warning | critical), so "how bad is this" is not
//     a threshold we have to invent locally.
//   - the per-model weekly sub-limit carries its display name in `scope.model.display_name`.
//
// Value-blind, same as usage.ts: a token goes in, only parsed numbers come out. The token is never
// persisted, logged, or returned. The CLI spawn remains the FALLBACK (see usage.ts checkUsage) for
// the cases this path cannot serve: no token in hand, or a token the server rejects (401) — the CLI
// can refresh its own credentials, we deliberately do not (rotating the user's refresh token out
// from under their real login is not ours to do).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageLimit, UsageSnapshot } from './types'

/** The endpoint the CLI's own `/usage` screen reads (verified against the shipped CLI, 2026-07-14). */
export const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Sent by the CLI on its OAuth-authenticated calls; harmless if the server stops requiring it. */
const OAUTH_BETA = 'oauth-2025-04-20'
/** The API version header the CLI sends alongside it. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Identify as Claude Code. THIS IS NOT COSMETIC.
 *
 * `/api/oauth/usage` rate-limits PER USER-AGENT, and a generic/absent UA is bucketed into a tiny,
 * sticky 429 bucket; only the real `claude-code/<version>` UA gets the normal allowance. Discovered
 * the hard way in the Connections usage service (services/usage/lambda/src/usage-api/providers.ts),
 * which hits this same endpoint in production. Omitting this would show up here as usage checks
 * mysteriously 429ing after a while, which matters much more now that the background sweep polls on
 * a timer rather than only on a user click.
 */
const CLAUDE_USER_AGENT_FALLBACK = 'claude-code/2.1.80'

/**
 * ⛔ AND THE VERSION IN IT HAS TO BE A REAL, CURRENT ONE.
 *
 * Pinning a literal here was the bug the paragraph above predicted and did not prevent: the string
 * sat at 2.1.80 while the installed CLI moved to 2.1.245, and a `claude-code/<version>` that no
 * longer exists is not "the real UA" - it lands in the same sticky bucket a generic one does.
 * Symptom (owner, 2026-09-07): the usage endpoint answering HTTP 429 for hours, so Refresh did
 * nothing on an account that was signed in perfectly fine, and the UI could only say "no usage
 * numbers".
 *
 * Read from the installed CLI's own package.json, once, and memoized - so it tracks every update
 * with nothing to remember. The literal above remains only as the answer when that read fails.
 */
let cachedUserAgent: string | null = null
function claudeUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent
  try {
    const pkg = join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'package.json',
    )
    const version = JSON.parse(readFileSync(pkg, 'utf8'))?.version
    cachedUserAgent =
      typeof version === 'string' && version.trim()
        ? `claude-code/${version.trim()}`
        : CLAUDE_USER_AGENT_FALLBACK
  } catch {
    cachedUserAgent = CLAUDE_USER_AGENT_FALLBACK
  }
  return cachedUserAgent
}

export type UsageApiResult =
  | { ok: true; snapshot: UsageSnapshot }
  /** `status` is the HTTP status, or 0 when the request never completed (network error/timeout).
   *  `retryAfterSec` is present only on a 429 that told us when to come back. */
  | { ok: false; status: number; error: string; retryAfterSec?: number }

/** `Retry-After` is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3). Returns whole seconds
 *  in the future, or null for absent/garbage/past values - a bad header must not become a countdown
 *  to a moment that already passed. */
function parseRetryAfter(header: string | null): number | null {
  if (!header?.trim()) return null
  const raw = header.trim()
  const asSeconds = Number(raw)
  if (Number.isFinite(asSeconds)) return asSeconds > 0 ? Math.round(asSeconds) : null
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  const secs = Math.round((at - Date.now()) / 1000)
  return secs > 0 ? secs : null
}

// --- response shape (only the fields we read) --------------------------------

/** One entry of the response's `limits[]` — the same list the CLI renders its `/usage` screen from. */
interface ApiLimit {
  /** 'session' (the 5-hour window) | 'weekly_all' | 'weekly_scoped' (a per-model sub-limit). */
  kind?: string
  percent?: number
  /** Server-computed: 'normal' | 'warning' | 'critical'. */
  severity?: string
  /** ISO-8601, or null when the window has not started (a 0% session has no reset yet). */
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
}

interface ApiResponse {
  limits?: ApiLimit[]
  /** Pre-`limits[]` shape, kept as a fallback: utilization is a 0-100 float. */
  five_hour?: { utilization?: number | null; resets_at?: string | null } | null
  seven_day?: { utilization?: number | null; resets_at?: string | null } | null
}

// --- mapping -----------------------------------------------------------------

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * Render an ISO reset timestamp the way the CLI's `/usage` screen does ("Jul 19, 3:59am"), in the
 * daemon machine's LOCAL time. Exported for the unit test. Returns '' for null/unparseable input,
 * which is exactly what parseUsageOutput yields when a line has no `· resets …` clause — so both
 * paths produce the same `UsageLimit.resets` contract for the UI.
 */
export function formatResetLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hours24 = d.getHours()
  const ampm = hours24 < 12 ? 'am' : 'pm'
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const min = d.getMinutes()
  // The CLI drops ":00" (it prints "3am", not "3:00am"); match that so the two paths look identical.
  const time = min === 0 ? `${hour12}${ampm}` : `${hour12}:${String(min).padStart(2, '0')}${ampm}`
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${time}`
}

function severityOf(raw: string | undefined): UsageLimit['severity'] {
  return raw === 'critical' || raw === 'warning' || raw === 'normal' ? raw : undefined
}

function toLimit(pct: number, resetsAt: string | null | undefined, severity?: string): UsageLimit {
  return {
    pct: Math.round(pct),
    resets: formatResetLocal(resetsAt),
    resetsAt: resetsAt ?? null,
    severity: severityOf(severity),
  }
}

/**
 * Map the endpoint's JSON into the SAME UsageSnapshot the text parser produces, so every consumer
 * (UI, monitor, MCP) is source-agnostic. Prefers `limits[]` (what the CLI renders from); falls back
 * to the older top-level `five_hour`/`seven_day` objects if a server ever omits `limits`.
 *
 * Exported and pure so it is unit-tested against a captured real response.
 */
export function mapUsageApiResponse(
  json: unknown,
  account: string | null = null,
  now = new Date(),
): UsageSnapshot {
  const body = (json ?? {}) as ApiResponse
  const snap: UsageSnapshot = {
    account,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: now.toISOString(),
    source: 'api',
  }

  for (const lim of body.limits ?? []) {
    if (typeof lim?.percent !== 'number') continue
    if (lim.kind === 'session') {
      snap.session = toLimit(lim.percent, lim.resets_at, lim.severity)
    } else if (lim.kind === 'weekly_all') {
      snap.weekAll = toLimit(lim.percent, lim.resets_at, lim.severity)
    } else if (lim.kind === 'weekly_scoped') {
      const label = lim.scope?.model?.display_name?.trim()
      // A scoped weekly limit with no model name is not renderable as "Current week (X)" — skip it
      // rather than invent a label. Keep the FIRST named one (the CLI shows a single sub-limit line).
      if (label && !snap.weekModel) {
        snap.weekModel = { ...toLimit(lim.percent, lim.resets_at, lim.severity), label }
      }
    }
  }

  // Fallback for a response without `limits[]`: the older utilization floats.
  if (!snap.session && typeof body.five_hour?.utilization === 'number') {
    snap.session = toLimit(body.five_hour.utilization, body.five_hour.resets_at)
  }
  if (!snap.weekAll && typeof body.seven_day?.utilization === 'number') {
    snap.weekAll = toLimit(body.seven_day.utilization, body.seven_day.resets_at)
  }
  return snap
}

// --- the live call -----------------------------------------------------------

/**
 * Read one account's quota straight from the usage endpoint with an OAuth access token.
 *
 * Returns `ok:false` (never throws) on any failure, so the caller can fall back to the CLI spawn.
 * A 401 specifically means "this token is expired or not usage-capable" — the caller should treat
 * that as a signal to try another credential, not as "0% used".
 */
export async function fetchUsageApi(opts: {
  /** An OAuth access token (`sk-ant-oat…`). API keys are NOT accepted by this endpoint. */
  token: string
  /** Display label stamped onto the snapshot — the response does not name the account. */
  account?: string | null
  /** Hard cap on the request (default 15s). The measured p50 is well under 500ms. */
  timeoutMs?: number
}): Promise<UsageApiResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
        'user-agent': claudeUserAgent(), // load-bearing for rate limiting — see above
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      // A 429 is the one failure with a KNOWN end, and the server usually says when. Carrying it
      // turns "try again shortly" - which invites exactly the hammering that keeps the bucket hot -
      // into a real number the UI can count down. Seconds per RFC 9110; a date form is also legal,
      // so parse both and ignore anything that yields no sane future instant.
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null
      return {
        ok: false,
        status: res.status,
        error: `usage endpoint returned HTTP ${res.status}`,
        ...(retryAfter === null ? {} : { retryAfterSec: retryAfter }),
      }
    }
    const json = await res.json()
    const snapshot = mapUsageApiResponse(json, opts.account ?? null)
    // A 200 that maps to nothing is not a usable read; make the caller fall back rather than cache
    // an all-null snapshot that the UI would have to render as a bare "—".
    if (!snapshot.session && !snapshot.weekAll && !snapshot.weekModel) {
      return { ok: false, status: res.status, error: 'usage endpoint returned no limits' }
    }
    return { ok: true, snapshot }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
