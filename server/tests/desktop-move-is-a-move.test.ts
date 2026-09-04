// A MOVE IS A MOVE (owner rule, 2026-09-04). The MCP landing tool used to POST
// /import-desktop, which only LANDS a chat: the source account's row is left untouched, so the
// thread showed on both accounts. It happened live that day - an agent "moved" a burndown chat
// onto a fresh account and the owner still had it on the old one, which is also how the zombie
// twins that make a later resolve ambiguous get made.
//
// Pinned here at the seam that regressed: which endpoint the tool sends to, and the one flag
// that keeps the old live-session refusal (the migrate route stops a live engine on its own for
// a person who clicked migrate; an agent that has not watched the chat must be refused instead).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function moveTool() {
  const t = TOOLS.find((x) => x.name === 'import_session_to_desktop')
  if (!t) throw new Error('no MCP tool named import_session_to_desktop')
  return t
}

test('landing a chat drives /migrate, never the half-move /import-desktop', async () => {
  await moveTool().run({
    session_id: 'sess-1234',
    instance_ref: 'desktop:c:\\instances\\target',
    confirm_title: 'A chat that already has a real name',
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.method).toBe('POST')
  expect(calls[0]!.url).toContain('/api/sessions/sess-1234/migrate')
  expect(calls[0]!.url).not.toContain('/import-desktop')
})

test('it declines the kill, so a live session is still refused rather than ended mid-turn', async () => {
  await moveTool().run({ session_id: 's1', instance_ref: 'desktop:x', title: 'A real name' })
  expect(calls[0]!.body).toMatchObject({
    instance_ref: 'desktop:x',
    title: 'A real name',
    stop_live: false,
  })
})

test('the description promises the move, so a doc revert fails here too', () => {
  const d = moveTool().description.toLowerCase()
  expect(d).toContain('move')
  // the half-move is exactly what the owner said must not happen: the other account keeps it
  expect(d).toMatch(/source account no longer shows it|archives every other profile/)
})
