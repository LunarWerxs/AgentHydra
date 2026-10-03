// POST /api/sessions/:id/reassert-title - the title watch for a move that landed through
// /import-desktop (migrate_chat), 2026-10-03.
//
// /migrate fires reassertChatTitle itself after a hot landing; the Python mover lands through
// /import-desktop and asks for the same watch here afterwards. The watch is keyed by the session
// id and aimed at the target named, and it never starts for a chat the target does not hold or
// for a generic name. The watcher itself is faked; nothing here touches a profile.

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const realLaunch = { ...(await import('../src/session-launch')) }
const SID = '11111111-2222-4333-8444-555555555555'
const TARGET = 'C:\\instances\\target'
let landed: { archived: boolean; path: string } | null
let watched: string[]

mock.module('../src/session-launch', () => ({
  ...realLaunch,
  renderedInStore: () => landed,
  reassertChatTitle: async (dir: string, id: string, title: string) => {
    watched.push(`${dir}|${id}|${title}`)
    return 0
  },
}))
afterAll(() => {
  mock.module('../src/session-launch', () => realLaunch)
})

const { app } = await import('../src/http-app')
await import('../src/routes/desktop-sessions')
const http = new Hono().route('/', app)

beforeEach(() => {
  watched = []
  landed = { archived: false, path: `${TARGET}\\claude-code-sessions\\a\\o\\local_${SID}.json` }
})

async function reassert(body: Record<string, unknown>) {
  const r = await http.request(`/api/sessions/${SID}/reassert-title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

test('a landed chat gets the title watch, keyed by its id and aimed at the target', async () => {
  const r = await reassert({ instance_ref: `desktop:${TARGET}`, title: ' Logos for products ' })
  expect(r).toEqual({ status: 200, body: { ok: true, watching: true } })
  expect(watched).toEqual([`${TARGET}|${SID}|Logos for products`])
})

test('a chat the target does not hold is refused and nothing is watched', async () => {
  landed = null
  const r = await reassert({ instance_ref: `desktop:${TARGET}`, title: 'Logos for products' })
  expect(r.status).toBe(409)
  expect(watched).toEqual([])
})

test('a generic or missing title, or no desktop target, is refused before any watch', async () => {
  for (const body of [
    { instance_ref: `desktop:${TARGET}`, title: 'General coding session' },
    { instance_ref: `desktop:${TARGET}` },
    { title: 'Logos for products' },
  ])
    expect((await reassert(body)).status).toBe(400)
  expect(watched).toEqual([])
})
