// The four orchestrator MCP tools, pinned at the seam the merge review found untested: what each
// tool SENDS to the daemon for a given argument shape. The daemon is a fetch stub that records the
// request; nothing here spawns python or needs a fleet.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'

type Call = { url: string; method: string; body: unknown }
let calls: Call[] = []
const originalFetch = globalThis.fetch

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

beforeEach(() => {
  calls = []
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ ok: true, echoed: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('the four orchestrator tools exist and say what they are', () => {
  test.each(['orchestrator_menu', 'orchestrator_run', 'orchestrator_loop', 'orchestrator_switch'])(
    '%s is registered with an input schema',
    (name) => {
      const t = tool(name)
      expect((t.inputSchema as { type: string }).type).toBe('object')
      expect(t.description.length).toBeGreaterThan(40)
    },
  )
  test('only the read-only menu omits the tray-icon rule from its description', () => {
    for (const name of ['orchestrator_run', 'orchestrator_loop', 'orchestrator_switch'])
      expect(tool(name).description.toLowerCase()).toMatch(/tray[- ]icon/)
  })
})

describe('what each tool sends to the daemon', () => {
  test('orchestrator_menu is a bare GET of /api/orchestrator', async () => {
    await tool('orchestrator_menu').run({})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toMatch(/\/api\/orchestrator$/)
    expect(calls[0]!.method).toBe('GET')
  })

  test('orchestrator_run maps script + args + timeout_secs (seconds -> ms) onto the run route', async () => {
    await tool('orchestrator_run').run({
      script: 'migrate_chat',
      args: ['Odin', '--to', '3claude'],
      timeout_secs: 90,
    })
    expect(calls[0]!.url).toMatch(/\/api\/orchestrator\/run$/)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({
      script: 'migrate_chat',
      args: ['Odin', '--to', '3claude'],
      timeoutMs: 90_000,
    })
  })

  test('orchestrator_run with no args and no timeout sends an empty argv and no deadline', async () => {
    await tool('orchestrator_run').run({ script: 'census' })
    expect(calls[0]!.body).toEqual({ script: 'census', args: [] })
  })

  test('orchestrator_run never lets a non-array args through as argv', async () => {
    await tool('orchestrator_run').run({ script: 'census', args: '--json' })
    expect((calls[0]!.body as { args: unknown }).args).toEqual([])
  })

  test('orchestrator_loop is dry by default, --json when asked, --live with a 30-minute deadline', async () => {
    await tool('orchestrator_loop').run({})
    await tool('orchestrator_loop').run({ json: true })
    await tool('orchestrator_loop').run({ live: true, json: true })
    expect(calls.map((c) => c.body)).toEqual([
      { script: 'loop', args: [] },
      { script: 'loop', args: ['--json'] },
      { script: 'loop', args: ['--live'], timeoutMs: 30 * 60_000 },
    ])
  })

  test('orchestrator_switch maps every action onto the driver words', async () => {
    for (const action of ['armed', 'arm', 'arm_now', 'resume', 'pause', 'disarm'])
      await tool('orchestrator_switch').run({ action })
    expect(
      calls.map((c) => {
        const b = c.body as { script: string; args: string[] }
        return [b.script, ...b.args]
      }),
    ).toEqual([['armed'], ['arm'], ['arm', '--now'], ['resume'], ['pause'], ['disarm']])
    for (const c of calls) expect((c.body as { timeoutMs: number }).timeoutMs).toBe(120_000)
  })

  test('orchestrator_switch refuses an action that is not on the list, before any request', async () => {
    await expect(tool('orchestrator_switch').run({ action: 'nuke' })).rejects.toThrow(
      /action must be one of/,
    )
    expect(calls).toHaveLength(0)
  })
})
