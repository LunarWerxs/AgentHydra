// A REAL ACCOUNT WITH NO CHATS IS AN EMPTY LIST, NOT "NO SUCH ACCOUNT" (2026-09-26).
//
// GET /api/chats answers 404 when the scan saw nothing under the asked-for label, so a typo cannot
// read as "that account is empty". But an account that has never held a chat has no store records
// either, so the scan saw nothing under ITS label too, and the Instances "Chats" dialog answered
// "Couldn't read the chats" for two real, empty accounts while the new count beside "Chats" said 0.
// The route now keeps the 404 for names the registry cannot resolve and answers a resolved one
// with its (empty) list. The resolver and the store read are faked: nothing here scans a real
// profile.

import { afterAll, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const realRef = { ...(await import('../src/core/instance-ref')) }
const realDossier = { ...(await import('../src/chat-dossier')) }
let resolved: unknown = null

mock.module('../src/core/instance-ref', () => ({
  ...realRef,
  resolveInstance: async () => resolved,
}))
mock.module('../src/chat-dossier', () => ({
  ...realDossier,
  // The scan saw one OTHER account and nothing under the one asked for.
  listChats: () => ({
    rows: [],
    total: 0,
    counts: { all: 0, unarchived: 0, archived: 0, live: 0, staleLogin: 0 },
    instances: ['someone-else'],
  }),
}))
afterAll(() => {
  mock.module('../src/core/instance-ref', () => realRef)
  mock.module('../src/chat-dossier', () => realDossier)
})

const { app } = await import('../src/http-app')
await import('../src/routes/sessions')
const http = new Hono().route('/', app)

const EMPTY_DIR = 'C:\\Users\\me\\.claude-instances\\never-used'

test('a resolved desktop account with no chat records answers 200 and an empty list', async () => {
  resolved = {
    num: 37,
    kind: 'desktop',
    handle: EMPTY_DIR,
    ref: `desktop:${EMPTY_DIR}`,
    name: 'never-used',
  }
  const r = await http.request(`/api/chats?instance=${encodeURIComponent(`desktop:${EMPTY_DIR}`)}`)
  expect(r.status).toBe(200)
  const body = (await r.json()) as { rows: unknown[]; counts: { unarchived: number } }
  expect(body.rows).toEqual([])
  expect(body.counts.unarchived).toBe(0)
})

test('a name the registry cannot resolve is still a 404 naming the labels the scan saw', async () => {
  resolved = null
  const r = await http.request('/api/chats?instance=nobody-by-this-name')
  expect(r.status).toBe(404)
  const body = (await r.json()) as { instances: string[] }
  expect(body.instances).toEqual(['someone-else'])
})
