/**
 * The HTTP surface. Order matters: the loopback CSRF guard fronts the local path, the auth gate
 * fronts every /api/* route, and the static SPA is mounted last.
 *
 * What a caller can DO here is deliberately tiny: read what the Python dashboard already answers,
 * read the switch, and throw the switch. Every other act stays in the toolbox's own rails.
 */
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { type Context, Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import {
  authMiddleware,
  handleComplete,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  isRemoteRequest,
  OAuthCallbackUnavailableError,
  readSession,
} from './auth.ts'
import {
  authEnforced,
  DAEMON_URL,
  ownerConfigured,
  type RemoteConfig,
  redactConfig,
  saveConfig,
} from './config.ts'
import { dashboardData, dashboardUp } from './dashboard.ts'
import { getOAuthCallback, getOAuthCallbackStatus, getRemoteStatus } from './remote.ts'
import { arm, disarm, trayStatus } from './switch.ts'

export interface AppDeps {
  version: string
  /** Absolute path of web/dist; absent (dev) means no static serving. */
  webDist?: string
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true // a real browser always sends Host; no Host is a non-browser client
  const h = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/** Origins allowed to call the API besides our own - the Vite dev server, opted in explicitly. */
const DEV_ORIGINS = new Set(
  (process.env.ORCH_DEV_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

/**
 * Cross-site guard for the OPEN loopback path: reject a browser request whose provenance says
 * something other than this app sent it. Skipped for tunnel traffic, which legitimately carries
 * a public Host and is gated by the session cookie instead.
 *
 * ⛔ PORT-BLIND IS NOT GOOD ENOUGH HERE, and that is not pedantry. The web's "site" does not
 * include the port, so a page on http://localhost:3000 - any dev server, any local tool with a
 * web UI, anything the owner happens to have open - sends `sec-fetch-site: same-site`, not
 * cross-site, and an Origin whose HOST is plain `localhost`. The first version of this guard
 * stripped the port before comparing, so both checks passed and that page could POST
 * /api/switch/arm as a CORS-simple request: the reply is unreadable to it, but the side effect
 * lands and this machine's fleet automation is armed by a web page. Found by audit, 2026-09-03.
 * So: an Origin must match ours EXACTLY, port included, and only `same-origin` or `none` is an
 * acceptable Sec-Fetch-Site. A request with neither header is a non-browser client (curl, the
 * tray, an MCP tool) and is still allowed - the threat here is specifically the browser.
 */
function loopbackGuard(c: Context): Response | null {
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return c.json({ error: `refused: sec-fetch-site is '${site}'` }, 403)
  }
  const origin = c.req.header('origin')
  if (origin) {
    let ours: string
    try {
      ours = new URL(c.req.url).origin
    } catch {
      ours = ''
    }
    if (origin !== ours && !DEV_ORIGINS.has(origin)) {
      return c.json({ error: 'cross-origin request refused' }, 403)
    }
  }
  if (!isLoopbackHost(c.req.header('host')))
    return c.json({ error: 'non-loopback host refused' }, 403)
  return null
}

async function daemonHealth(): Promise<{ ok: boolean; version: string | null; url: string }> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/health`, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) return { ok: false, version: null, url: DAEMON_URL }
    const body = (await res.json()) as { version?: string }
    return { ok: true, version: body.version ?? null, url: DAEMON_URL }
  } catch {
    return { ok: false, version: null, url: DAEMON_URL }
  }
}

export function buildApp(cfg: RemoteConfig, deps: AppDeps): Hono {
  const app = new Hono()

  app.use('/api/*', async (c, next) => {
    if (!isRemoteRequest(c)) {
      const refused = loopbackGuard(c)
      if (refused) return refused
    }
    await next()
  })
  app.use('/api/*', authMiddleware(cfg))

  app.get('/api/health', (c) =>
    c.json({ ok: true, service: 'orchestrator-remote', version: deps.version }),
  )

  // ── auth ──────────────────────────────────────────────────────────────────
  app.get('/api/auth/status', (c) => {
    const enforced = authEnforced(cfg)
    const remote = isRemoteRequest(c)
    const session = enforced ? readSession(c, cfg.oauth!) : null
    return c.json({
      authEnforced: enforced,
      remote,
      // Loopback is open: the same machine already reaches the Python dashboard unauthenticated.
      authenticated: remote ? !!session : true,
      owner: session?.name || session?.email || session?.sub || null,
      ownerPicture: session?.picture || null,
      ownerClaimed: ownerConfigured(cfg),
      oauthCallback: getOAuthCallbackStatus(cfg, publicOriginOf(c)),
    })
  })
  app.get('/api/auth/me', (c) => {
    const s = authEnforced(cfg) ? readSession(c, cfg.oauth!) : null
    return c.json({
      ok: true,
      sub: s?.sub ?? null,
      name: s?.name ?? null,
      email: s?.email ?? null,
      picture: s?.picture ?? null,
    })
  })
  app.post('/api/auth/logout', (c) => handleLogout(c))
  app.post('/api/auth/logout-all', (c) => handleLogoutAll(c))

  const authOpts = { onOwnerClaimed: () => saveConfig(cfg) }
  const loginOpts = {
    ...authOpts,
    resolveRedirect: async (origin: string) => {
      const callback = getOAuthCallback(cfg, origin)
      if (!callback) {
        const status = getOAuthCallbackStatus(cfg, origin)
        throw new OAuthCallbackUnavailableError(
          status === 'failed' || status === 'incompatible' ? status : 'temporary',
        )
      }
      return callback
    },
  }
  const oauthGuard = (h: (c: Context) => Promise<Response>) => (c: Context) =>
    authEnforced(cfg) ? h(c) : c.text('Sign-in is not configured for this gateway.', 404)
  app.get(
    '/oauth/login',
    oauthGuard((c) => handleLogin(c, cfg.oauth!, loginOpts)),
  )
  app.get(
    '/oauth/finish',
    oauthGuard((c) => handleComplete(c, cfg.oauth!, authOpts)),
  )
  app.get(
    '/oauth/callback',
    oauthGuard((c) => handleComplete(c, cfg.oauth!, authOpts)),
  )

  // ── status + data ─────────────────────────────────────────────────────────
  app.get('/api/status', async (c) => {
    const [daemon, dashboard] = await Promise.all([daemonHealth(), dashboardUp()])
    return c.json({
      version: deps.version,
      remote: getRemoteStatus(),
      config: redactConfig(cfg),
      switch: trayStatus(),
      daemon,
      dashboard: { ok: dashboard },
    })
  })
  app.get('/api/data/:name', async (c) => {
    const { status, body } = await dashboardData(c.req.param('name'))
    return c.json(body as Record<string, unknown>, status as 200)
  })

  // ── the switch ────────────────────────────────────────────────────────────
  app.get('/api/switch', (c) => c.json(trayStatus()))
  app.post('/api/switch/arm', async (c) => {
    const result = await arm()
    return c.json({ ...result, switch: trayStatus() }, result.ok ? 200 : 502)
  })
  app.post('/api/switch/disarm', async (c) => {
    const result = await disarm()
    return c.json({ ...result, switch: trayStatus() }, result.ok ? 200 : 502)
  })

  // The relay's forwarding page appends /s/<token> for share links; this gateway has none.
  app.get('/s/*', (c) => c.redirect('/'))

  // ── the SPA ───────────────────────────────────────────────────────────────
  if (deps.webDist && existsSync(deps.webDist)) {
    const root = relative(process.cwd(), deps.webDist).replaceAll('\\', '/') || '.'
    app.use('/assets/*', serveStatic({ root }))
    // A stale hashed chunk must 404, never fall through to index.html (wrong MIME -> module load error).
    app.get('/assets/*', (c) => c.notFound())
    app.use('/*', serveStatic({ root }))
    app.get('/*', serveStatic({ path: `${root}/index.html` }))
  } else {
    app.get('/', (c) =>
      c.text(
        'Orchestrator remote gateway is up, but web/dist has not been built: run `bun run remote:build`.',
        200,
      ),
    )
  }
  return app
}

function publicOriginOf(c: Context): string {
  const u = new URL(c.req.url)
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '')
  u.protocol = `${proto}:`
  return u.origin
}
