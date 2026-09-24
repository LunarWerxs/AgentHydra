// server/tests/import-desktop-two-current-names.test.ts - the naming door on
// POST /api/sessions/:id/import-desktop must know a chat by BOTH of its current names, same as
// /migrate already does (chat-title-two-current-names.test.ts, desktop-sessions.ts's /migrate
// route).
//
// Filed by the overnight orchestration run, 2026-09-15 (docs/todo/TODO.md, "Overnight
// orchestration run", item 1): migrate_chat.py drives THIS route, restates the chat's DOSSIER
// title (the desktop record's on-disk `title` - what the sidebar and the Instances "Chats" list
// show) as `confirm_title`, and the route used to compare that only against the session list's
// transcript-derived title. A chat the daemon titled by its first message while the desktop
// record called it something else (session 7e1fa278: daemon "Your market still looks like ..."
// vs desktop meta "Logos for Connections products") was refused 400 deterministically, and
// move_chats had no per-chat title to route around it. Fixed by reading the on-disk record the
// same way /migrate does and accepting either name restated exactly - this pins that both names
// now land the chat, and a genuinely wrong name is still refused.
//
// Routes are exercised through the real registration on a PRIVATE Hono copied from the shared
// app (see queue-patch-guard.test.ts for why the copy matters). Every collaborator the handler
// reaches for is mocked or, for the on-disk record, a real temp file - nothing here touches a
// real transcript store or a real desktop instance.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

const SID = 'twonames-1111-2222-3333-444455556666'
const TRANSCRIPT_TITLE = 'Your market still looks like ...'
const RECORD_TITLE = 'Logos for Connections products'

const dir = mkdtempSync(join(tmpdir(), 'ah-import-desktop-titles-'))
const recordPath = join(dir, `${SID}.json`)
writeFileSync(recordPath, JSON.stringify({ title: RECORD_TITLE }), 'utf8')

// ⛔ THE REAL EXPORTS, CAPTURED BEFORE ANY FAKE IS INSTALLED, AND PUT BACK IN afterAll
// (scripts/checks/test-stub-outlives-its-file.mjs rule 2) - same discipline as
// session-message-peer-only.test.ts, for the same reason: bun test runs every file in one
// process and mock.module is global for the run.
const realSessions = { ...(await import('../src/sessions')) }
const realInstanceSessions = { ...(await import('../src/instance-sessions')) }
const realSessionLaunch = { ...(await import('../src/session-launch')) }

let importCalls: Array<{ sessionId: string; instanceDir: string; title: string; force: boolean }> =
  []

mock.module('../src/sessions', () => ({
  ...realSessions,
  getSession: async () => ({ title: TRANSCRIPT_TITLE }),
}))
mock.module('../src/instance-sessions', () => ({
  ...realInstanceSessions,
  findDesktopChat: () => ({ path: recordPath }),
}))
mock.module('../src/session-launch', () => ({
  ...realSessionLaunch,
  isSessionSuperseded: () => false,
  importSessionToDesktop: async (opts: {
    sessionId: string
    instanceDir: string
    title: string
    force: boolean
  }) => {
    importCalls.push(opts)
    return { ok: true, titled: true, titleDurable: true }
  },
}))

afterAll(() => {
  mock.module('../src/sessions', () => realSessions)
  mock.module('../src/instance-sessions', () => realInstanceSessions)
  mock.module('../src/session-launch', () => realSessionLaunch)
  rmSync(dir, { recursive: true, force: true })
})

const { app } = await import('../src/http-app')
await import('../src/routes/desktop-sessions')
const http = new Hono().route('/', app)

async function post(body: Record<string, unknown>) {
  const res = await http.request(`/api/sessions/${SID}/import-desktop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_ref: 'desktop:c:\\instances\\target', ...body }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  importCalls = []
})
afterEach(() => {
  importCalls = []
})

test('restating the desktop record title (what migrate_chat reads from the dossier) lands the chat', async () => {
  const { status, body } = await post({ confirm_title: RECORD_TITLE })
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(importCalls).toHaveLength(1)
  expect(importCalls[0]!.title).toBe(RECORD_TITLE)
})

test('restating the daemon session title still lands the chat, unchanged', async () => {
  const { status, body } = await post({ confirm_title: TRANSCRIPT_TITLE })
  expect(status).toBe(200)
  expect(body.ok).toBe(true)
  expect(importCalls).toHaveLength(1)
  expect(importCalls[0]!.title).toBe(TRANSCRIPT_TITLE)
})

test('a title that is neither current name is still refused - this is not a blanket bypass', async () => {
  const { status, body } = await post({ confirm_title: 'A completely different chat title' })
  expect(status).toBe(400)
  expect(body.ok).toBe(false)
  expect(String(body.error)).toContain('does not match')
  expect(importCalls).toHaveLength(0)
})
