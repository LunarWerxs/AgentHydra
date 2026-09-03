import { describe, expect, test } from 'bun:test'
import { CONNECTIONS_OAUTH, type RemoteConfig } from '../src/config.ts'
import { OAUTH_CALLBACK_CAPABILITY } from '../src/relay.ts'
import {
  getOAuthCallback,
  getOAuthCallbackStatus,
  getRemoteStatus,
  isQuickTunnelOrigin,
  publishRemoteRoutes,
} from '../src/remote.ts'

function cfg(): RemoteConfig {
  return { oauth: { ...CONNECTIONS_OAUTH } }
}

const fakeRelay = (
  answer: { ok: boolean; capabilities?: string[]; error?: string },
  status = 200,
): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input)
    expect(url).toBe('https://app.repoyeti.com/announce')
    return new Response(JSON.stringify({ ...answer, url: 'https://app.repoyeti.com/r/abc' }), {
      status,
    })
  }) as unknown as typeof fetch

describe('quick-tunnel origins', () => {
  test('only https *.trycloudflare.com counts', () => {
    expect(isQuickTunnelOrigin('https://blue-fox-cat.trycloudflare.com')).toBe(true)
    expect(isQuickTunnelOrigin('http://blue-fox-cat.trycloudflare.com')).toBe(false)
    expect(isQuickTunnelOrigin('https://orch.example.com')).toBe(false)
    expect(isQuickTunnelOrigin('not a url')).toBe(false)
  })

  test('a stable origin completes on its own /oauth/callback, no relay needed', () => {
    const c = cfg()
    expect(getOAuthCallback(c, 'http://127.0.0.1:7790')).toEqual({
      redirectUri: 'http://127.0.0.1:7790/oauth/callback',
    })
    expect(getOAuthCallback(c, 'https://orch.example.com')).toEqual({
      redirectUri: 'https://orch.example.com/oauth/callback',
    })
    expect(getOAuthCallbackStatus(c, 'https://orch.example.com')).toBe('ready')
  })
})

describe('publishRemoteRoutes', () => {
  test('a quick tunnel is login-ready only after the relay confirms the callback capability', async () => {
    const c = cfg()
    const origin = 'https://blue-fox-cat.trycloudflare.com'
    expect(getOAuthCallback(c, origin)).toBeNull()
    expect(getOAuthCallbackStatus(c, origin)).toBe('pending')

    await publishRemoteRoutes(
      c,
      origin,
      fakeRelay({ ok: true, capabilities: [OAUTH_CALLBACK_CAPABILITY] }),
      [],
    )
    expect(getOAuthCallbackStatus(c, origin)).toBe('ready')
    expect(getOAuthCallback(c, origin)).toEqual({
      redirectUri: CONNECTIONS_OAUTH.redirectUri,
      relayId: c.relay!.identity!.id,
    })
    const s = getRemoteStatus()
    expect(s.stableUrl).toBe('https://app.repoyeti.com/r/abc')
    expect(s.relayError).toBeNull()
    // The identity was minted and persisted onto the config.
    expect(c.relay?.identity?.id).toMatch(/^[a-f0-9]{32}$/)
  })

  test('a relay without the capability is incompatible, never ready', async () => {
    const c = cfg()
    const origin = 'https://red-owl.trycloudflare.com'
    await publishRemoteRoutes(c, origin, fakeRelay({ ok: true, capabilities: [] }), [])
    expect(getOAuthCallbackStatus(c, origin)).toBe('incompatible')
    expect(getOAuthCallback(c, origin)).toBeNull()
  })

  test("a failing relay ends failed after the retry ladder, with the relay's reason", async () => {
    const c = cfg()
    const origin = 'https://green-elk.trycloudflare.com'
    let calls = 0
    const failing: typeof fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ ok: false, error: 'bad signature' }), { status: 403 })
    }) as unknown as typeof fetch
    await publishRemoteRoutes(c, origin, failing, [0, 0])
    expect(calls).toBe(3)
    expect(getOAuthCallbackStatus(c, origin)).toBe('failed')
    expect(getRemoteStatus().relayError).toBe('bad signature')
    expect(getRemoteStatus().stableUrl).toBeNull()
  })

  test('an origin the relay never heard of stays pending, whatever was announced before', async () => {
    const c = cfg()
    await publishRemoteRoutes(
      c,
      'https://one.trycloudflare.com',
      fakeRelay({ ok: true, capabilities: [OAUTH_CALLBACK_CAPABILITY] }),
      [],
    )
    expect(getOAuthCallbackStatus(c, 'https://two.trycloudflare.com')).toBe('pending')
    expect(getOAuthCallback(c, 'https://two.trycloudflare.com')).toBeNull()
  })
})
