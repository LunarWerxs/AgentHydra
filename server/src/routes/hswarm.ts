/**
 * HydraSwarm proxy routes: /api/hswarm/* and /api/hswarm-status.
 *
 * `/api/hswarm/*` forwards to the local hswarm server on 127.0.0.1:<port>, passing through
 * method, body, query, status and JSON.
 * `/api/hswarm-status` returns {running, port, pid, lastError}.
 * `/api/hswarm-accounts` returns {"acct-xxxxxxxx": {num, label, kind}} so the stats view can name the
 * account ids hswarm reports (first 8 hex of sha256 over the account uuid, hswarm/accounts.py).
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listCliInstances } from '../core/cli-instances'
import { readKnownAccounts } from '../core/known-accounts'
import { readLoginHistory } from '../core/login-history'
import { type FleetInstanceEntry, fleetInstances } from '../fleet-instances'
import { getHSwarmStatus, hswarmHome } from '../hswarm'
import { app } from '../http-app'

export interface HSwarmAccountRef {
  /** Absent for a former account no instance is known to have run on. */
  num?: number
  label: string
  kind?: 'desktop' | 'cli'
  /** Not signed in anywhere right now: named from the known-accounts store or a profile's login history. */
  former?: true
}

/** The id hswarm prints for an account: hswarm/accounts.py account_id. */
export function hswarmAccountId(uuid: string): string {
  return `acct-${createHash('sha256').update(uuid, 'utf8').digest('hex').slice(0, 8)}`
}

export interface HSwarmAccountSources {
  desktop: Array<
    Pick<FleetInstanceEntry, 'num' | 'name' | 'label' | 'loginUuid' | 'account'> & { dir?: string }
  >
  cli: Array<{ num: number; name: string; configDir: string }>
  /** The account uuid of a CLI config folder (its .claude.json oauthAccount), or null. */
  cliUuid: (configDir: string) => string | null
  /** Every account uuid ever remembered, with its display name (known-accounts store). */
  known?: Record<string, { name?: string | null; email?: string | null }>
  /** Accounts a desktop profile folder has been signed into, with when each was last busy there (ISO). */
  pastLogins?: (dir: string) => Array<{ accountUuid: string; lastSeenAt: string | null }>
}

function cliAccountUuid(configDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
    const uuid = raw?.oauthAccount?.accountUuid
    return typeof uuid === 'string' && uuid ? uuid : null
  } catch {
    return null
  }
}

/** acct id -> the instance signed in as it, then (`former: true`) accounts only known from the past. Desktop instances win over a CLI one for the same account
 *  (they are listed first), and the lowest number wins within a kind. */
export function hswarmAccountMap(src: HSwarmAccountSources): Record<string, HSwarmAccountRef> {
  const out: Record<string, HSwarmAccountRef> = {}
  const add = (uuid: string | null | undefined, ref: HSwarmAccountRef) => {
    if (!uuid) return
    const id = hswarmAccountId(uuid)
    if (!out[id]) out[id] = ref
  }
  for (const d of [...src.desktop].sort((a, b) => a.num - b.num)) {
    add(d.account?.accountUuid ?? d.loginUuid, {
      num: d.num,
      label: d.label || d.name,
      kind: 'desktop',
    })
  }
  for (const c of [...src.cli].sort((a, b) => a.num - b.num)) {
    add(src.cliUuid(c.configDir), { num: c.num, label: c.name, kind: 'cli' })
  }

  // Fallback tier: signed-out or moved accounts. Never overrides a current login (`out[id]` is set).
  const last = new Map<string, { num: number; label: string; at: string }>()
  for (const d of src.desktop) {
    if (!d.dir || !src.pastLogins) continue
    for (const p of src.pastLogins(d.dir)) {
      const at = p.lastSeenAt ?? ''
      const prev = last.get(p.accountUuid)
      if (!prev || at > prev.at || (at === prev.at && d.num < prev.num)) {
        last.set(p.accountUuid, { num: d.num, label: d.label || d.name, at })
      }
    }
  }
  const knownName = (uuid: string) => {
    const k = src.known?.[uuid]
    return k?.name || k?.email || ''
  }
  for (const uuid of new Set([...Object.keys(src.known ?? {}), ...last.keys()])) {
    const id = hswarmAccountId(uuid)
    if (out[id]) continue
    const where = last.get(uuid)
    const label = knownName(uuid) || where?.label
    if (!label) continue
    out[id] = where
      ? { num: where.num, label, kind: 'desktop', former: true }
      : { label, former: true }
  }
  return out
}

/** How long one account map is reused. It names accounts for display, and they change only at a
 *  login, while each read lists every instance and reads every login history (0.3 s, 2026-10-08,
 *  and in the boot freeze's profile): the HSwarm view, Home and the MCP session tools all ask. */
const ACCOUNT_MAP_FRESH_MS = 30_000
let accountMap: { at: number; map: Promise<Record<string, HSwarmAccountRef>> } | null = null

async function readAccountMap(): Promise<Record<string, HSwarmAccountRef>> {
  const desktop = await fleetInstances()
  return hswarmAccountMap({
    desktop,
    cli: listCliInstances(),
    cliUuid: cliAccountUuid,
    known: readKnownAccounts(),
    pastLogins: (dir) =>
      readLoginHistory(dir).entries.map((e) => ({
        accountUuid: e.accountUuid,
        lastSeenAt: e.lastSeenAt,
      })),
  })
}

app.get('/api/hswarm-accounts', async (c) => {
  let entry = accountMap
  if (!entry || Date.now() - entry.at >= ACCOUNT_MAP_FRESH_MS) {
    const fresh = { at: Date.now(), map: readAccountMap() }
    accountMap = entry = fresh
    // A failed read is not kept: the next caller tries again.
    fresh.map.catch(() => {
      if (accountMap === fresh) accountMap = null
    })
  }
  try {
    return c.json(await entry.map)
  } catch {
    return c.json({})
  }
})

app.get('/api/hswarm-status', (c) => {
  const status = getHSwarmStatus()
  return c.json({
    running: status.running,
    port: status.port,
    pid: status.pid,
    lastError: status.lastError,
  })
})

app.all('/api/hswarm/*', async (c) => {
  const status = getHSwarmStatus()

  if (!status.running || !status.port) {
    return c.json(
      {
        ok: false,
        error: 'hswarm is not running',
        lastError: status.lastError,
      },
      503 as any,
    )
  }

  const path = c.req.path.replace(/^\/api\/hswarm/, '')
  const url = new URL(`http://127.0.0.1:${status.port}${path}`)

  // Forward query parameters
  for (const [key, value] of new URLSearchParams(c.req.url.split('?')[1]).entries()) {
    url.searchParams.append(key, value)
  }

  const method = c.req.method
  const headers = new Headers(c.req.raw.headers)

  // Remove content-length since we may modify the body, and host/connection headers
  headers.delete('host')
  headers.delete('connection')
  headers.delete('content-length')
  headers.delete('origin')
  headers.delete('cookie')
  headers.delete('x-hswarm-token')
  try {
    const token = readFileSync(join(hswarmHome(), 'console-token'), 'utf8').trim()
    if (token) headers.set('X-Hswarm-Token', token)
  } catch {
    // no token file yet: forward without it
  }

  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    try {
      // Try to read as JSON first
      body = await c.req.text()
    } catch {
      // empty body
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
    })

    // Passed through as bytes with hswarm's own type: re-reading a reply as text relabelled every
    // provider logo text/plain (an SVG one then never drew) and could mangle binary images.
    const out = new Headers()
    for (const h of [
      'content-type',
      'cache-control',
      'content-security-policy',
      'x-content-type-options',
    ]) {
      const v = response.headers.get(h)
      if (v) out.set(h, v)
    }
    return new Response(response.body, { status: response.status, headers: out })
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: 'failed to forward request to hswarm',
        detail: e instanceof Error ? e.message : String(e),
      },
      502 as any,
    )
  }
})
