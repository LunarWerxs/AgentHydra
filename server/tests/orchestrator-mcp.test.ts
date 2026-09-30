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

/** The bodies POSTed to the run route (a detached run's operation reads are left out). */
const runBodies = () =>
  calls.filter((c) => c.url.endsWith('/api/orchestrator/run')).map((c) => c.body)

beforeEach(() => {
  calls = []
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), method: init?.method ?? 'GET', body })
    // The run route as the daemon answers it: a detached POST gets a 202 with the operation id,
    // and that operation then reads done with the run's result.
    const [status, answer] =
      String(url).endsWith('/api/orchestrator/run') && body?.async === true
        ? [202, { ok: true, operationId: 'op-1', status: 'running', reused: false }]
        : String(url).endsWith('/api/orchestrator/operations/op-1')
          ? [200, { id: 'op-1', status: 'done', result: { ok: true, echoed: true } }]
          : [200, { ok: true, echoed: true }]
    return new Response(JSON.stringify(answer), {
      status,
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
      timeout_secs: 30,
    })
    expect(calls[0]!.url).toMatch(/\/api\/orchestrator\/run$/)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({
      script: 'migrate_chat',
      args: ['Odin', '--to', '3claude'],
      timeoutMs: 30_000,
      // `async` is always explicit (mcp.ts, 2026-09-09): a run's sync/async shape is a decision
      // the route reads off the body. Since 2026-09-30 every run is detached on the wire unless
      // the caller said background:false, so no call is held past the MCP client's ~60 s.
      async: true,
    })
  })

  test('orchestrator_run with no args and no timeout sends an empty argv and no deadline', async () => {
    await tool('orchestrator_run').run({ script: 'census' })
    expect(calls[0]!.body).toEqual({ script: 'census', args: [], async: true })
  })

  test('orchestrator_run never lets a non-array args through as argv', async () => {
    await tool('orchestrator_run').run({ script: 'census', args: '--json' })
    expect((calls[0]!.body as { args: unknown }).args).toEqual([])
  })

  test('orchestrator_loop is dry by default, --json when asked, --live with a 30-minute deadline', async () => {
    await tool('orchestrator_loop').run({})
    await tool('orchestrator_loop').run({ json: true })
    const live = (await tool('orchestrator_loop').run({ live: true, json: true })) as Record<
      string,
      unknown
    >
    expect(runBodies()).toEqual([
      { script: 'loop', args: [], async: true },
      { script: 'loop', args: ['--json'], async: true },
      { script: 'loop', args: ['--live'], timeoutMs: 30 * 60_000, async: true },
    ])
    // the live walk runs for minutes, so it answers with its operation at once
    expect(String(live.poll)).toContain('orchestrator_operation')
  })

  test('orchestrator_switch maps every action onto the driver words', async () => {
    for (const action of ['armed', 'arm', 'arm_now', 'resume', 'pause', 'disarm'])
      await tool('orchestrator_switch').run({ action })
    expect(
      runBodies().map((body) => {
        const b = body as { script: string; args: string[] }
        return [b.script, ...b.args]
      }),
    ).toEqual([['armed'], ['arm'], ['arm', '--now'], ['resume'], ['pause'], ['disarm']])
    for (const b of runBodies()) expect((b as { timeoutMs: number }).timeoutMs).toBe(120_000)
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
  // 90 s: past the desktop app's MCP client, which drops a call at about 60 s (measured
  // 2026-09-30), though under the old 120 s ceiling that let such a run block and lose its report.
  test.each([90, 1200])(
    'a declared timeout of %ds is detached at once, with the id and how to poll it',
    async (secs) => {
      const out = (await tool('orchestrator_run').run({
        script: 'sweep',
        args: ['--all', '--yes'],
        timeout_secs: secs,
      })) as Record<string, unknown>
      expect((calls[0]!.body as { async: boolean }).async).toBe(true)
      expect(calls).toHaveLength(1) // answered at once: not even one wait on the operation
      expect(out.started).toBe(true)
      expect(String(out.poll)).toContain('orchestrator_operation')
      expect(String(out.note)).toContain('Detached automatically')
    },
  )

  test('a short run is waited on and answers inline with its verdict', async () => {
    const out = (await tool('orchestrator_run').run({
      script: 'census',
      timeout_secs: 30,
    })) as Record<string, unknown>
    expect(out.started).toBeUndefined()
    expect(out.poll).toBeUndefined()
    expect(out.echoed).toBe(true) // the run's own result, read off its settled operation
    expect(out.operationStatus).toBe('done')
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

// orchestrator_cancel: the stop half of the pair whose read half is orchestrator_operation. Added
// 2026-09-13 after a 25-chat migrate_batch launched with the wrong scope could only be stopped by
// finding the pid by hand and killing it - the daemon has had cancelOrchestratorOperation and its
// route all along, and only the MCP surface was missing.
describe('orchestrator_cancel stops a run that is still going', () => {
  test('it is registered, and says outright that it is not an undo', () => {
    const t = tool('orchestrator_cancel')
    expect((t.inputSchema as { type: string }).type).toBe('object')
    expect((t.inputSchema as { required: string[] }).required).toEqual(['id'])
    expect(t.description).toContain('MUTATES')
    expect(t.description).toContain('NOT AN UNDO')
  })

  test('it POSTs the cancel route for that id, and encodes it', async () => {
    await tool('orchestrator_cancel').run({ id: 'op 1/2' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toMatch(/\/api\/orchestrator\/operations\/op%201%2F2\/cancel$/)
  })

  test('a blank id is refused here rather than POSTed as a cancel of nothing', async () => {
    const out = (await tool('orchestrator_cancel').run({ id: '   ' })) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('id is required')
    expect(calls).toHaveLength(0)
  })

  test('orchestrator_operation no longer claims nothing can cancel a run', () => {
    expect(tool('orchestrator_operation').description).toContain('orchestrator_cancel')
  })
})
