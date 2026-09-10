// server/tests/session-message-peer-only.test.ts — the mid-turn rail, enforced where the
// channel is actually chosen.
//
// The bug this pins (found 2026-09-07, reproduced 09-09 and 09-10). courier.py's rail 4 says a
// chat whose turn is IN FLIGHT is never interrupted FOR THE COMPOSER ROUTE, because the peer
// channel enqueues natively and drains after the turn. The courier could not express that: it
// had to decide before the daemon picked a channel, so it refused every live chat outright and
// a chat in a continuous work loop never received its reply at all. The courier now sends
// `peer_only` for a mid-turn chat, and THIS is where it has to mean something: on a session
// with no peer pipe the route otherwise falls through to the composer, which TYPES.
//
// Routes are exercised through the real registration on a PRIVATE Hono copied from the shared
// app (see queue-patch-guard.test.ts for why the copy matters). Every collaborator the handler
// reaches for is mocked, so nothing here touches a real app, a real pipe, or PowerShell.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const HOME = 'c:\\i\\temp1'
const SID = 'peeronly-1111-2222-3333-444455556666'

// ⛔ THE REAL EXPORTS, CAPTURED BEFORE ANY FAKE IS INSTALLED, AND PUT BACK IN afterAll
// (scripts/checks/test-stub-outlives-its-file.mjs rule 2). `bun test` runs every file in ONE
// process and mock.module applies to the WHOLE run - mock.restore() does not undo it - so a fake
// left installed here lands on whichever file happens to run next, and the failure surfaces
// there rather than in the file that caused it. Captured BEFORE, never after: mock.module
// rewrites the live bindings of a namespace that was already imported, so a copy taken after the
// fake IS the fake, and "restoring" it would reinstall the mock forever.
const realLiveRegistry = { ...(await import('../src/live-registry')) }
const realInstanceSessions = { ...(await import('../src/instance-sessions')) }
const realSessionLaunch = { ...(await import('../src/session-launch')) }
const realCoreInstances = { ...(await import('../src/core/instances')) }
const realPeerMessage = { ...(await import('../src/peer-message')) }

// Mocks must be installed BEFORE the route module is imported: findTranscriptById is a static
// import in the handler's module, and the rest are dynamic imports resolved at request time.
// Each fake spreads the real namespace first, so a collaborator this test does not care about
// keeps its real implementation instead of becoming undefined.
mock.module('../src/live-registry', () => ({
  ...realLiveRegistry,
  findTranscriptById: () => null,
}))
mock.module('../src/instance-sessions', () => ({
  ...realInstanceSessions,
  findDesktopChat: () => ({ title: 'A working chat' }),
}))
mock.module('../src/session-launch', () => ({
  ...realSessionLaunch,
  desktopHomeFor: async () => HOME,
  liveSessionEntry: () => null,
}))
mock.module('../src/core/instances', () => ({
  ...realCoreInstances,
  listInstances: async () => [{ name: 'temp1', dir: HOME, isRunning: true }],
}))
// 'not-live' is the case under test: a session with NO peer pipe, which is exactly when the
// route would otherwise downgrade to the composer.
const peerCalls: string[] = []
mock.module('../src/peer-message', () => ({
  ...realPeerMessage,
  deliverPeerMessage: async (sessionId: string) => {
    peerCalls.push(sessionId)
    return { ok: false, reason: 'not-live' }
  },
}))

afterAll(() => {
  mock.module('../src/live-registry', () => realLiveRegistry)
  mock.module('../src/instance-sessions', () => realInstanceSessions)
  mock.module('../src/session-launch', () => realSessionLaunch)
  mock.module('../src/core/instances', () => realCoreInstances)
  mock.module('../src/peer-message', () => realPeerMessage)
})

const { app } = await import('../src/http-app')
await import('../src/routes/session-message')
const http = new Hono().route('/', app)

async function post(body: Record<string, unknown>) {
  const res = await http.request(`/api/sessions/${SID}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  peerCalls.length = 0
})

test('peer_only on a session with no pipe REFUSES instead of typing', async () => {
  const { status, body } = await post({ text: 'carry on', peer_only: true })
  expect(status).toBe(409)
  expect(body.delivered).toBe(false)
  expect(body.route).toBe('peer')
  expect(String(body.error)).toContain('peer_only')
  // the peer channel was still tried first - peer_only forbids the FALLBACK, not the attempt
  expect(peerCalls).toEqual([SID])
})

test('the refusal says why, so a caller can tell "not now" from "went wrong"', async () => {
  const { body } = await post({ text: 'carry on', peer_only: true })
  expect(String(body.detail)).toContain('refusing to interrupt a live turn')
  expect(String(body.detail)).toContain('idle')
})

test('WITHOUT peer_only the same session still falls through to the composer path', async () => {
  // The guard must be opt-in: a dormant or crashed chat has no pipe either, and the composer
  // is the only route that can BOOT it - breaking that would make every revive impossible.
  // With no transcript and no verify_text the composer path refuses at its OWN rail (the
  // wrong-chat guard), which proves the request got past the peer_only gate without typing.
  const { status, body } = await post({ text: 'carry on' })
  expect(status).toBe(422)
  expect(String(body.error)).toContain('no verify snippet derivable')
})

test('peer_only is not honoured as a truthy string - only a real boolean opts in', async () => {
  // A JSON body is caller-supplied; a stray "false" or "0" must not silently arm a refusal.
  const { status } = await post({ text: 'carry on', peer_only: 'false' })
  expect(status).toBe(422)
})
