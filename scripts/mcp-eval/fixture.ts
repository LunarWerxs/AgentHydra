// A frozen daemon for the MCP behavioural eval: a loopback HTTP server that answers the handful of
// /api/* routes the eval's questions need, from one fixed, fictional fleet.
//
// WHY a fixture and not the real daemon: an eval question needs ONE answer that never changes, and
// the real fleet's quota moves every minute. It also keeps the eval read-only by construction:
// every non-GET is refused with 405 and counted, so an agent that reaches for a MUTATES: tool is
// caught in the report instead of acting on anything. Every path the fixture does not know answers
// a JSON 404, which mcp.ts surfaces as an error rather than falling back to reading this machine.
//
// Lives under scripts/, not server/src/: it is eval tooling, never shipped with the daemon.

import type { Incident, UsageAdvice, UsageSnapshot } from '../../server/src/types'

/** config.ts's SERVICE_NAME, spelled out: importing config.ts resolves (and may migrate) the real
 *  data dir at load, which an eval process has no business doing. */
const SERVICE_NAME = 'agenthydra'

/** One row of `/api/instance-numbers`, the shape mcp.ts's ResolvedInstanceRow reads. */
export interface FixtureInstance {
  num: number
  kind: 'desktop' | 'cli' | 'codex'
  handle: string
  ref: string
  name: string
  email: string | null
  plan: string | null
  tier: string | null
  configDir: string
  loggedIn: boolean
  isRunning: boolean | null
}

const at = '2026-01-05T12:00:00.000Z'

/** The fleet. #3 is absent on purpose: numbers are never reused, so a retired gap is realistic. */
export const FIXTURE_INSTANCES: FixtureInstance[] = [
  {
    num: 1,
    kind: 'desktop',
    handle: 'fixture-desktop-work',
    ref: 'desktop:fixture-desktop-work',
    name: 'Work',
    email: 'work@example.com',
    plan: 'Claude Max',
    tier: 'Max 5×',
    configDir: 'fixture-desktop-work',
    loggedIn: true,
    isRunning: true,
  },
  {
    num: 2,
    kind: 'desktop',
    handle: 'fixture-desktop-side',
    ref: 'desktop:fixture-desktop-side',
    name: 'Side',
    email: 'side@example.com',
    plan: 'Claude Pro',
    tier: 'Pro',
    configDir: 'fixture-desktop-side',
    loggedIn: true,
    isRunning: false,
  },
  {
    num: 4,
    kind: 'cli',
    handle: 'fixture-cli-batch',
    ref: 'cli:fixture-cli-batch',
    name: 'Batch',
    email: 'batch@example.com',
    plan: 'Claude Pro',
    tier: 'Pro',
    configDir: 'fixture-cli-batch',
    loggedIn: true,
    isRunning: null,
  },
  {
    num: 5,
    kind: 'codex',
    handle: 'fixture-codex',
    ref: 'codex:fixture-codex',
    name: 'Codex',
    email: 'codex@example.com',
    plan: 'ChatGPT Plus',
    tier: null,
    configDir: 'fixture-codex',
    loggedIn: true,
    isRunning: false,
  },
]

function snapshot(account: string, sessionPct: number, weekPct: number): UsageSnapshot {
  return {
    account,
    session: { pct: sessionPct, resets: 'Jan 5, 5:00pm', resetsAt: '2026-01-05T17:00:00.000Z' },
    weekAll: { pct: weekPct, resets: 'Jan 9, 9:00am', resetsAt: '2026-01-09T09:00:00.000Z' },
    weekModel: null,
    capturedAt: at,
    source: 'api',
  }
}

/** Hand-written rather than usageAdvice(): the fixture must not import daemon modules that touch
 *  the data dir. Only bindingPct is load-bearing (list_usage reads it). */
function advice(weekPct: number): UsageAdvice {
  return {
    severity: weekPct >= 90 ? 'critical' : weekPct >= 80 ? 'warning' : 'normal',
    bindingPct: weekPct,
    shouldOffload: weekPct >= 90,
    safeToFanOut: weekPct < 80,
    advice: `fixture: ${weekPct}% of the weekly all-models cap used`,
  }
}

/** The survey. #2 has the most WEEKLY room but the busiest SESSION window, and #4 the idlest
 *  session: an agent that ranks by the 5-hour % instead of the binding weekly % answers wrong. */
const USAGE = [
  { num: 1, session: 12, week: 82 },
  { num: 2, session: 91, week: 35 },
  { num: 4, session: 4, week: 61 },
]

export const FIXTURE_SURVEY = {
  rows: USAGE.map(({ num, session, week }) => {
    const inst = FIXTURE_INSTANCES.find((i) => i.num === num) as FixtureInstance
    return {
      kind: inst.kind,
      num,
      id: inst.handle,
      label: inst.name,
      result: {
        snapshot: snapshot(inst.email ?? inst.name, session, week),
        cached: false,
        key: inst.handle,
        reason: 'ok',
        advice: advice(week),
      },
      advice: advice(week),
    }
  }),
  deepseek: null,
}

function incident(
  id: string,
  key: string,
  state: Incident['state'],
  count: number,
  error: string,
): Incident {
  return {
    id,
    scope: 'project',
    key,
    error_sig: `sig-${id}`,
    state,
    failure_type: 'exit_nonzero',
    first_seen_at: '2026-01-02T08:00:00.000Z',
    last_seen_at: at,
    acked_at: null,
    resolved_at: state === 'resolved' ? at : null,
    count,
    error,
    output_file: null,
  }
}

export const FIXTURE_INCIDENTS: Incident[] = [
  incident('inc-1', 'billing-api', 'open', 7, 'test suite failed: 3 assertions'),
  incident('inc-2', 'docs-site', 'open', 2, 'build failed: missing asset'),
  incident('inc-3', 'mobile-app', 'resolved', 11, 'lint failed'),
]

export interface FixtureDaemon {
  url: string
  /** Every non-GET the fixture refused, as `METHOD /path`. */
  refused: string[]
  /** Every request the fixture served, as `METHOD /path`. */
  requests: string[]
  stop(): void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function route(path: string, params: URLSearchParams): Response {
  switch (path) {
    case '/api/health':
      return json({ ok: true, service: SERVICE_NAME, version: 'fixture' })
    case '/api/instance-numbers':
      return json(FIXTURE_INSTANCES)
    case '/api/instance-numbers/resolve': {
      const ref = (params.get('ref') ?? '').replace(/^#/, '').trim().toLowerCase()
      const hit = FIXTURE_INSTANCES.find(
        (i) => String(i.num) === ref || i.handle === ref || i.name.toLowerCase() === ref,
      )
      return hit ? json(hit) : json({ error: `no instance matches ${ref}` }, 404)
    }
    case '/api/usage/survey':
      return json(FIXTURE_SURVEY)
    case '/api/incidents': {
      const state = params.get('state')
      return json(state ? FIXTURE_INCIDENTS.filter((i) => i.state === state) : FIXTURE_INCIDENTS)
    }
    default:
      return json({ error: `the eval fixture does not serve ${path}` }, 404)
  }
}

/** Start the fixture on a free loopback port. Stop it when the eval is done. */
export function startFixtureDaemon(): FixtureDaemon {
  const refused: string[] = []
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(`${req.method} ${url.pathname}`)
      if (req.method !== 'GET') {
        refused.push(`${req.method} ${url.pathname}`)
        return json({ error: 'the eval fixture is read-only: eval questions never mutate' }, 405)
      }
      return route(url.pathname, url.searchParams)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    refused,
    requests,
    stop: () => server.stop(true),
  }
}
