// server/tests/move-chats-refused-resume.test.ts - how move_chats REPORTS a refused move.
//
// WHY (found live 2026-09-12). `move_chats` carrying a resume was refused `409 busy` by the route
// lock. The refusal was right; losing the message was not, and neither was the shape it arrived
// in: `api()` rejects on every non-2xx, so the caller got the bare string `AgentHydra 409: {…}`.
//
// The staging itself is the DAEMON's job (orchestrator.ts stageRefusedResume, pinned in
// orchestrator-preempt.test.ts), because move_chats detaches by default and a refusal inside a
// detached operation is never seen by MCP code. What is pinned HERE is that the tool hands the
// daemon's refusal back as an object and says plainly whether the resume survived.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'

type Call = { url: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const originalFetch = globalThis.fetch

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** A daemon that refuses migrate_batch as busy, with whatever the daemon staged on the refusal. */
function stubDaemon(refusal: Record<string, unknown>, status = 409) {
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url: String(url), body })
    if (String(url).includes('/api/orchestrator/run')) return json(refusal, status)
    if (String(url).includes('/api/instance-numbers/resolve'))
      return json({
        num: 8,
        kind: 'desktop',
        name: 'Martin',
        handle: 'c:\\i\\another_meh',
        ref: 'desktop:c:\\i\\another_meh',
        email: null,
        plan: null,
        tier: 'Max 20×',
        configDir: 'c:\\i\\another_meh',
        loggedIn: true,
        isRunning: true,
      })
    return json({ ok: true })
  }
}

const BUSY = {
  ok: false,
  busy: true,
  operationId: 'op-holder',
  error: 'migrate_batch is already running through this route (started 40s ago)',
}

beforeEach(() => {
  calls = []
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('a busy refusal comes back as the daemon object, never as a thrown string', async () => {
  stubDaemon(BUSY)
  const out = (await tool('move_chats').run({
    chats: ['alpha'],
    to: 8,
    background: false,
  })) as Record<string, unknown>
  expect(out.ok).toBe(false)
  expect(out.busy).toBe(true)
  expect(out.operationId).toBe('op-holder')
  expect(out.note).toBeUndefined() // no resume, nothing to say about one
})

test('when the daemon staged the resume, the tool says where it went', async () => {
  stubDaemon({
    ...BUSY,
    resumeStaged: [
      { chat: 'alpha', staged: true, id: 'del-1', reused: false },
      { chat: 'beta', staged: true, id: 'del-2', reused: false },
    ],
  })
  const out = (await tool('move_chats').run({
    chats: ['alpha', 'beta'],
    to: 8,
    resume: 'four background jobs were orphaned by the kill',
    background: false,
  })) as Record<string, unknown>
  const rows = out.resumeStaged as Array<Record<string, unknown>>
  expect(rows.map((r) => r.id)).toEqual(['del-1', 'del-2'])
  expect(String(out.note)).toContain('STAGED')
  // The MCP layer does not stage a second copy of its own.
  expect(calls.filter((c) => c.body?.script === 'stage_reply')).toHaveLength(0)
})

test('a refusal whose resume could not be kept says so outright', async () => {
  stubDaemon({ ...BUSY, resumeStaged: [] })
  const out = (await tool('move_chats').run({
    all_unarchived: true,
    from: 8,
    to: 8,
    resume: 'say this',
    background: false,
  })) as Record<string, unknown>
  expect(String(out.note)).toContain('NOT kept')
})

test('a 409 that is not a busy refusal is not swallowed', async () => {
  stubDaemon({ error: 'something else entirely' })
  await expect(
    tool('move_chats').run({ chats: ['alpha'], to: 8, background: false }),
  ).rejects.toThrow('AgentHydra 409')
})
