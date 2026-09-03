/**
 * The remote gateway's configuration: where it lives on disk, the OAuth client it presents to
 * Connections, and the tunnel it opens. Everything persistent sits under `state/remote/`, which
 * the repo ignores (`state/` is runtime state, never source).
 *
 * The defaults are enough: a fresh clone gets the registered "Orchestrator" public OAuth client
 * (PKCE, no secret), the RepoYeti relay as the stable callback for a rotating Quick Tunnel, and
 * first-use ownership - the first verified Connections sign-in claims the install and is persisted.
 * A named Cloudflare tunnel (stable hostname on the owner's own zone) is opt-in via `tunnel`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restrictToCurrentUser } from './fs-perms.ts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** Same resolution as scripts/lib/ledgerlib._state_dir(): the env override, else <repo>/state. */
export const STATE_DIR = process.env.ORCHESTRATOR_STATE_DIR
  ? resolve(process.env.ORCHESTRATOR_STATE_DIR)
  : join(REPO_ROOT, 'state')
export const CONFIG_DIR = join(STATE_DIR, 'remote')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export const DEFAULT_PORT = 7790
/** scripts/dashboard.py's port - the read-only data layer this gateway fronts. */
export const DASHBOARD_PORT = 7799
/** The AgentHydra daemon, same env override hydralib honours. */
export const DAEMON_URL = (process.env.AGENTHYDRA_URL ?? 'http://127.0.0.1:7787').replace(
  /\/+$/,
  '',
)

export interface OAuthConfig {
  /** IdP issuer origin, e.g. https://accounts.connections.icu */
  issuer: string
  clientId: string
  /** The EXACT registered redirect URI a Quick Tunnel login must use (the relay's callback). */
  redirectUri: string
  /** Only for a confidential client; the registered Orchestrator client is public (PKCE). */
  clientSecret?: string
  scopes?: string
  /** The owner, locked on first verified sign-in (TOFU). Either field matches. */
  ownerSub?: string
  ownerEmail?: string
}

export interface TunnelConfig {
  /** "quick" forces the free rotating tunnel even when a named one is configured. */
  provider?: 'quick' | 'named'
  /** The stable public host a named tunnel serves, e.g. "orch.example.com". */
  hostname?: string
  /** Named-tunnel connector token. Sensitive - config.json is ACL-restricted for this reason. */
  token?: string
}

/** Ed25519 identity that signs relay announcements. The private half never leaves this disk. */
export interface RelayIdentity {
  id: string
  publicKey: string
  privateKey: string
}

export interface RelayConfig {
  /** Base URL of the relay; empty uses app.repoyeti.com (the OAuth callback lives there too). */
  url?: string
  identity?: RelayIdentity
}

export interface RemoteConfig {
  port?: number
  oauth?: OAuthConfig
  tunnel?: TunnelConfig
  relay?: RelayConfig
}

/**
 * The "Orchestrator" Sign-in-with-Connections app, registered 2026-09-02 through Studio's
 * /v1/oauth-apps (public client, PKCE, scopes openid profile email photo). Its redirect
 * allow-list is both named-tunnel hostnames' /oauth/callback (orch-michael / orch-jacob on
 * lunarwerx.com), the relay callback, and loopback on DEFAULT_PORT; a Quick Tunnel completes
 * through the relay, loopback completes directly on the gateway.
 */
export const CONNECTIONS_OAUTH: OAuthConfig = {
  issuer: 'https://accounts.connections.icu',
  clientId: 'fa219acf42e2f4ccfce5ab7ddda9544c',
  redirectUri: 'https://app.repoyeti.com/oauth/callback',
  scopes: 'openid profile email photo',
}

export const DEFAULT_RELAY_URL = 'https://app.repoyeti.com'

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function loadConfig(): RemoteConfig {
  let stored: RemoteConfig = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RemoteConfig
    } catch (err) {
      console.warn(
        `[orchestrator-remote] ${CONFIG_PATH} is not valid JSON, using defaults: ${String(err)}`,
      )
    }
  }
  return {
    ...stored,
    oauth: { ...CONNECTIONS_OAUTH, ...(stored.oauth ?? {}) },
  }
}

export function saveConfig(cfg: RemoteConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  restrictToCurrentUser(CONFIG_PATH)
}

/** OIDC configured => every tunnel request needs a signed-in owner. Always true with defaults. */
export function authEnforced(cfg: RemoteConfig): boolean {
  return !!(cfg.oauth?.issuer && cfg.oauth.clientId && cfg.oauth.redirectUri)
}

export function ownerConfigured(cfg: RemoteConfig): boolean {
  return !!(cfg.oauth?.ownerSub || cfg.oauth?.ownerEmail)
}

/** Why a tunnel must NOT be opened, or null when it may. A public URL with no auth is the machine on the open internet. */
export function tunnelStartProblem(cfg: RemoteConfig): string | null {
  if (!authEnforced(cfg)) return 'auth'
  return null
}

/** Named-tunnel credentials, or null for the default Quick Tunnel. CF_TUNNEL_TOKEN overrides the file. */
export function namedTunnel(cfg: RemoteConfig): { hostname: string; token: string } | null {
  if (cfg.tunnel?.provider === 'quick') return null
  const hostname = cfg.tunnel?.hostname?.trim()
  const token = (process.env.CF_TUNNEL_TOKEN ?? cfg.tunnel?.token ?? '').trim()
  if (!hostname || !token) return null
  return { hostname, token }
}

export function relayBase(cfg: RemoteConfig): string {
  return (cfg.relay?.url?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, '')
}

/** Key-free projection for /api/status - hostname + token PRESENCE, never a token or a private key. */
export function redactConfig(cfg: RemoteConfig): Record<string, unknown> {
  return {
    port: cfg.port ?? DEFAULT_PORT,
    oauth: cfg.oauth
      ? {
          issuer: cfg.oauth.issuer,
          clientId: cfg.oauth.clientId,
          redirectUri: cfg.oauth.redirectUri,
          ownerClaimed: ownerConfigured(cfg),
        }
      : null,
    tunnel: {
      provider: namedTunnel(cfg) ? 'named' : 'quick',
      hostname: cfg.tunnel?.hostname?.trim() || null,
      hasToken: !!(process.env.CF_TUNNEL_TOKEN ?? cfg.tunnel?.token ?? '').trim(),
    },
    relay: { url: relayBase(cfg), id: cfg.relay?.identity?.id ?? null },
  }
}
