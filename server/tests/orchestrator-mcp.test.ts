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
      // `background` gained an explicit false rather than being omitted (mcp.ts, 2026-09-09):
      // a run's sync/async shape is a decision the route should read off the body, not infer
      // from an absent key. Asserted, not loosened - the value is part of the contract.
      async: false,
    })
  })

  test('orchestrator_run with no args and no timeout sends an empty argv and no deadline', async () => {
    await tool('orchestrator_run').run({ script: 'census' })
    expect(calls[0]!.body).toEqual({ script: 'census', args: [], async: false })
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

// ⛔ A LONG BLOCKING RUN LOSES ITS OWN REPORT (2026-09-11). `sweep --all --yes` with
// timeout_secs 1200 answered only "The operation timed out" while the sweep ran five minutes to
// completion in the daemon - no stdout, no exit code, and no operationId to re-attach to, so a
// finished verdict was unreachable. The detached path already existed; nobody could be expected to
// know to ask for it the first time, so a declared-long run now detaches itself.
describe('a run that will outlive the caller detaches instead of losing its report', () => {
  test('a declared timeout past the ceiling is sent async, with the id and how to poll it', async () => {
    const out = (await tool('orchestrator_run').run({
      script: 'sweep',
      args: ['--all', '--yes'],
      timeout_secs: 1200,
    })) as Record<string, unknown>
    expect((calls[0]!.body as { async: boolean }).async).toBe(true)
    expect(out.started).toBe(true)
    expect(String(out.poll)).toContain('orchestrator_operation')
    expect(String(out.note)).toContain('Detached automatically')
  })

  test('a short run still blocks, exactly as before', async () => {
    const out = (await tool('orchestrator_run').run({
      script: 'census',
      timeout_secs: 60,
    })) as Record<string, unknown>
    expect((calls[0]!.body as { async: boolean }).async).toBe(false)
    expect(out.started).toBeUndefined()
    expect(out.poll).toBeUndefined()
  })

  test('an explicit background:false is a person choosing to wait, and is honoured', async () => {
    const out = (await tool('orchestrator_run').run({
      script: 'sweep',
      timeout_secs: 3000,
      background: false,
    })) as Record<string, unknown>
    expect((calls[0]!.body as { async: boolean }).async).toBe(false)
    expect(out.poll).toBeUndefined()
  })

  test('an explicit background:true still says how to read the result', async () => {
    const out = (await tool('orchestrator_run').run({
      script: 'sweep',
      background: true,
    })) as Record<string, unknown>
    expect((calls[0]!.body as { async: boolean }).async).toBe(true)
    expect(String(out.poll)).toContain('orchestrator_operation')
    expect(String(out.note)).toContain('Poll the id above')
  })
})
