// POST /api/sessions/:id/settle-source - a batch move's second pass (2026-09-26).
//
// A batch lands every chat first (/migrate with defer_settle) and only then retires the old
// copies here, naming as `leaving` exactly the chats that landed. The one thing this route must
// never do is put away the only visible copy of a chat, so it refuses unless the TARGET's own
// store holds the chat unarchived. Every archive route is faked; nothing here touches a profile.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const realLaunch = { ...(await import('../src/session-launch')) }
const realNative = { ...(await import('../src/claude-native-archive')) }
const SID = '11111111-2222-4333-8444-555555555555'
const TARGET = 'C:\\instances\\target'
const SOURCE = 'C:\\instances\\source'
let landed: { archived: boolean; path: string } | null
let calls: string[]

mock.module('../src/session-launch', () => ({
  ...realLaunch,
  renderedInStore: () => landed,
  desktopProfileRoots: () => [SOURCE, TARGET],
  desktopChatCarriers: (_id: string, roots?: string[]) => (roots ?? []).filter((r) => r === SOURCE),
  findChatMetaPath: () => null,
  archiveDesktopChat: async (_id: string, _archived: boolean, roots?: string[]) => {
    calls.push(`flag:${roots?.join(',')}`)
    return {
      ok: true,
      hits: (roots ?? []).map((profile) => ({ profile, wasRunning: false, changed: true })),
    }
  },
}))
mock.module('../src/claude-native-archive', () => ({
  ...realNative,
  tryNativeArchiveChat: async (
    dir: string,
    _id: string,
    opts: { leavingCliSessionIds?: string[] },
  ) => {
    calls.push(`native:${dir}:${(opts.leavingCliSessionIds ?? []).join(',')}`)
    return { kind: 'unavailable', route: 'native', dispatch: 'not-sent', reason: 'not configured' }
  },
}))
afterAll(() => {
  mock.module('../src/session-launch', () => realLaunch)
  mock.module('../src/claude-native-archive', () => realNative)
})

const { app } = await import('../src/http-app')
await import('../src/routes/desktop-sessions')
const http = new Hono().route('/', app)

beforeEach(() => {
  calls = []
  landed = { archived: false, path: `${TARGET}\\claude-code-sessions\\a\\o\\local_${SID}.json` }
})

async function settle(body: Record<string, unknown>) {
  const r = await http.request(`/api/sessions/${SID}/settle-source`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

test('a chat the target does not hold is refused, and nothing is archived anywhere', async () => {
  landed = null
  const r = await settle({ instance_ref: `desktop:${TARGET}` })
  expect(r.status).toBe(409)
  expect(String(r.body.error)).toStartWith('not-landed')
  expect(calls).toEqual([])
})

test('a copy the target holds only ARCHIVED is refused too: that is not a landing', async () => {
  landed = { archived: true, path: 'x' }
  const r = await settle({ instance_ref: `desktop:${TARGET}` })
  expect(r.status).toBe(409)
  expect(calls).toEqual([])
})

test('a landed chat settles its OLD copy only, never the target, reporting per profile', async () => {
  const r = await settle({ instance_ref: `desktop:${TARGET}`, leaving: [SID, 'bbbbbbbb-2222'] })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  // The source is closed here (isRunning reads the live fleet, which has no such dir), so the
  // flag alone settles it; the target is never among the profiles touched.
  expect(calls).toEqual([`flag:${SOURCE}`])
  expect(r.body.sourceStillShown).toEqual([])
  expect((r.body.sourceSettle as Array<{ profile: string }>).map((s) => s.profile)).toEqual([
    SOURCE,
  ])
})

test('instance_ref is required', async () => {
  const r = await settle({})
  expect(r.status).toBe(400)
  expect(calls).toEqual([])
})
