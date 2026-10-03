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
import { type FleetInstanceEntry, fleetInstances } from '../fleet-instances'
import { getHSwarmStatus, hswarmHome } from '../hswarm'
import { app } from '../http-app'

export interface HSwarmAccountRef {
  num: number
  label: string
  kind: 'desktop' | 'cli'
}

/** The id hswarm prints for an account: hswarm/accounts.py account_id. */
export function hswarmAccountId(uuid: string): string {
  return `acct-${createHash('sha256').update(uuid, 'utf8').digest('hex').slice(0, 8)}`
}

export interface HSwarmAccountSources {
  desktop: Array<Pick<FleetInstanceEntry, 'num' | 'name' | 'label' | 'loginUuid' | 'account'>>
  cli: Array<{ num: number; name: string; configDir: string }>
  /** The account uuid of a CLI config folder (its .claude.json oauthAccount), or null. */
  cliUuid: (configDir: string) => string | null
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

/** acct id -> the instance signed in as it. Desktop instances win over a CLI one for the same account
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
  return out
}

app.get('/api/hswarm-accounts', async (c) => {
  try {
    const desktop = await fleetInstances()
    return c.json(hswarmAccountMap({ desktop, cli: listCliInstances(), cliUuid: cliAccountUuid }))
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
