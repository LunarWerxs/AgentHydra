// server/tests/desktop-archive-drives-the-app-ui.test.ts - "archive" must MEAN archived, and the
// built-in endpoint must be the thing that makes it so.
//
// POST /api/sessions/:id/desktop-archive wrote the disk flag and, under a RUNNING app, returned a
// note telling the caller the chat was still on screen and to go run misc/Manage-DesktopChat.ps1
// themselves. ui-archive.ts's uiArchiveChat - the server-side version of exactly that click, with
// its own safety rails - had existed since 2026-08-30 and NOTHING called it. Owner ruling,
// 2026-09-17, after cleaning up 17 chats by hand: a built-in that does not do what it says gets
// FIXED; nobody should have to write a one-off script to finish a basic operation.
//
// So these pin the contract, not the plumbing: an archive under a running app DRIVES the app's own
// control; a rail's refusal is reported as the refusal it is, never as success; and unarchive -
// which has no in-app control to drive - clicks nothing and does not claim it tried.
//
// Routes run through their real registration on a PRIVATE Hono copied from the shared app (see
// queue-patch-guard.test.ts for why the copy matters). Every collaborator is mocked: nothing here
// touches a real store, a real instance, or a real sidebar.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const SID = 'archiveui-1111-2222-3333-444455556666'
const PROFILE = 'C:\\instances\\anothuh1'

// ⛔ THE REAL EXPORTS, CAPTURED BEFORE ANY FAKE IS INSTALLED, AND PUT BACK IN afterAll
// (scripts/checks/test-stub-outlives-its-file.mjs rule 2): bun test runs every file in one
// process and mock.module is global for the run.
const realSessionLaunch = { ...(await import('../src/session-launch')) }
const realUiArchive = { ...(await import('../src/ui-archive')) }

type Outcome = { clicked: boolean; verified: boolean; reason?: string }

let uiCalls: Array<{ profile: string; sessionId: string }> = []
let outcome: Outcome = { clicked: true, verified: true }
let hits = [{ profile: PROFILE, wasRunning: true, changed: true }]
let reasserted: string[] = []

mock.module('../src/session-launch', () => ({
  ...realSessionLaunch,
  liveSessionEntry: () => null,
  archiveDesktopChat: async () => ({ ok: true, hits }),
  reassertChatArchive: async (profile: string) => {
    reasserted.push(profile)
    return { ok: true }
  },
}))
mock.module('../src/ui-archive', () => ({
  ...realUiArchive,
  uiArchiveChat: async (profile: string, sessionId: string) => {
    uiCalls.push({ profile, sessionId })
    return outcome
  },
}))

afterAll(() => {
  mock.module('../src/session-launch', () => realSessionLaunch)
  mock.module('../src/ui-archive', () => realUiArchive)
})

const { app } = await import('../src/http-app')
await import('../src/routes/desktop-sessions')
const http = new Hono().route('/', app)

async function post(body: Record<string, unknown> = {}) {
  const res = await http.request(`/api/sessions/${SID}/desktop-archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Scoped, so the route takes the caller's target rather than walking this machine's profiles.
    body: JSON.stringify({ instance_ref: `desktop:${PROFILE}`, ...body }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  uiCalls = []
  reasserted = []
  outcome = { clicked: true, verified: true }
  hits = [{ profile: PROFILE, wasRunning: true, changed: true }]
})

test('a chat archived under a running app is retired through that app, not left on screen', async () => {
  const { status, body } = await post()

  expect(status).toBe(200)
  expect(uiCalls).toEqual([{ profile: PROFILE, sessionId: SID }])
  expect(body.stillOnScreen).toBe(false)
  expect(body.uiArchive).toEqual([{ profile: PROFILE, clicked: true, verified: true }])
  expect(String(body.note)).toContain('no restart needed')
  // The homework is gone: the endpoint does the click, so it never again tells its caller to.
  expect(String(body.note)).not.toContain('Manage-DesktopChat')
})

test("a rail's refusal is reported as a refusal, never as a retired chat", async () => {
  const reason = "2 chats in this profile's store carry the title 'X' and 1 of them is not archived"
  outcome = { clicked: false, verified: false, reason }

  const { body } = await post()

  expect(uiCalls.length).toBe(1)
  expect(body.stillOnScreen).toBe(true)
  expect(String(body.note)).toContain(reason)
})

test('unarchive drives nothing and does not claim it tried', async () => {
  const { body } = await post({ archived: false })

  expect(uiCalls).toEqual([])
  expect(body.uiArchive).toBeUndefined()
  expect(String(body.note)).toContain('STILL HIDDEN')
  expect(String(body.note)).toContain('no in-app control to drive')
})

test('a chat whose app is NOT running needs no click at all', async () => {
  hits = [{ profile: PROFILE, wasRunning: false, changed: true }]

  const { body } = await post()

  expect(uiCalls).toEqual([])
  expect(body.note).toBeUndefined()
  expect(body.ok).toBe(true)
})

test('the durable re-assert watcher still fires alongside the click', async () => {
  await post()
  expect(reasserted).toEqual([PROFILE])
})
