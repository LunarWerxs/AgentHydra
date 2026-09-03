/**
 * Relay client - publishes "here is my current address" to the RepoYeti relay Worker
 * (RepoYeti/app/relay/worker.js). Vendored from RepoYeti's src/relay.ts.
 *
 * WHY: a Quick Tunnel re-hosts itself on every start. The relay gives this gateway one permanent
 * URL (`<relay>/r/<id>`) that forwards to wherever it currently lives, AND it is the registered
 * OAuth callback: Connections returns the browser to `<relay>/oauth/callback`, which reads the
 * relay id out of the signed `state` and bounces `code`+`state` to `<currentOrigin>/oauth/finish`.
 *
 * IDENTITY: an Ed25519 keypair generated once and kept in state/remote/config.json. The public
 * half registers on first announce; every later announce is signed, so only this machine can move
 * its own address. Only (id, origin, ts, signature, publicKey) is ever sent.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto'
import type { RelayIdentity } from './config.ts'

export const OAUTH_CALLBACK_CAPABILITY = 'oauth-callback-v1'

const b64url = (b: Buffer): string => b.toString('base64url')

export function createRelayIdentity(): RelayIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    id: randomBytes(16).toString('hex'),
    publicKey: b64url(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    privateKey: b64url(privateKey.export({ format: 'der', type: 'pkcs8' })),
  }
}

export function publicKeyFor(privateKeyB64: string): string {
  const priv = createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = createPublicKey(priv as unknown as Parameters<typeof createPublicKey>[0]).export({
    format: 'der',
    type: 'spki',
  }) as Buffer
  return b64url(spki.subarray(-32))
}

/** The exact bytes both sides sign over; field order is fixed here AND in the Worker. */
export function announcePayload(id: string, origin: string, ts: number): Buffer {
  return Buffer.from(`${id}\n${origin}\n${ts}`, 'utf8')
}

export function signAnnounce(identity: RelayIdentity, origin: string, ts: number): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  })
  return b64url(sign(null, announcePayload(identity.id, origin, ts), key))
}

export interface AnnounceResult {
  ok: boolean
  url?: string
  capabilities?: readonly string[]
  error?: string
}

/** Tell the relay where we are now. Best-effort: every failure is reported, never thrown. */
export async function announce(
  relayUrl: string,
  identity: RelayIdentity,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnnounceResult> {
  const base = relayUrl.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, error: 'no relay configured' }
  let clean: string
  try {
    const u = new URL(origin)
    if (u.protocol !== 'https:') return { ok: false, error: 'origin must be https' }
    clean = u.origin
  } catch {
    return { ok: false, error: 'origin is not a URL' }
  }
  const ts = Date.now()
  try {
    const res = await fetchImpl(`${base}/announce`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signAnnounce(identity, clean, ts),
      },
      body: JSON.stringify({ id: identity.id, origin: clean, ts, publicKey: identity.publicKey }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      url?: string
      capabilities?: unknown
      error?: string
    }
    if (!res.ok || !body.ok)
      return { ok: false, error: body.error ?? `relay returned ${res.status}` }
    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((x): x is string => typeof x === 'string')
      : undefined
    return {
      ok: true,
      url: body.url ?? `${base}/r/${identity.id}`,
      ...(capabilities ? { capabilities } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
