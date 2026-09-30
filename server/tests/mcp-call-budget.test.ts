// No AgentHydra MCP tool holds a call past the budget (2026-09-30). The desktop app's MCP client
// drops a call at about 60 s - measured: 55 s answered, 110 s and 300 s came back "The operation
// timed out" with nothing - so a verdict that arrives later is lost, and for an act it was the
// caller's only record of what happened. Two guards own that, pinned here at their own boundary:
// runScript (every orchestrator-backed tool) and withCallBudget (every tool, at the transport).
// The tools' own suites (orchestrator-mcp, move-chat-mcp, fan-out-mcp) pin the inline verdict.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runScript, withCallBudget } from '../src/mcp-client'
import type { McpEngineTool } from '../src/mcp-stdio.mjs'

const originalFetch = globalThis.fetch
let polls = 0

beforeEach(() => {
  polls = 0
  // A daemon whose run never settles: the POST is accepted, every read says still running.
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string) => {
    if (String(url).endsWith('/api/orchestrator/run'))
      return Response.json(
        { ok: true, operationId: 'op-9', status: 'running', reused: false },
        { status: 202 },
      )
    polls++
    return Response.json({ id: 'op-9', status: 'running', result: null })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('runScript never holds a call past its wait', () => {
  test('a run still going when the wait runs out answers with its operation id, on time', async () => {
    const t0 = Date.now()
    const r = await runScript({ script: 'sweep', args: [] }, 'wait', 400)
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(r.detached).toBe(true)
    expect(r.operationId).toBe('op-9')
    expect(polls).toBeGreaterThan(0) // it did wait on the operation before handing it back
  })
})

describe('withCallBudget answers for a tool that runs over', () => {
  const tool = (run: McpEngineTool['run']): McpEngineTool => ({
    name: 'slow_tool',
    description: 'a tool',
    inputSchema: {},
    run,
  })

  test('a tool still running at the budget is answered as still running, not left to the client', async () => {
    const [wrapped] = withCallBudget([tool(() => new Promise(() => {}))], 50)
    const out = (await wrapped!.run({})) as Record<string, unknown>
    expect(out.stillRunning).toBe(true)
    expect(out.tool).toBe('slow_tool')
    expect(String(out.note)).toContain('Do NOT call it again blind')
  })

  test('a tool that answers in time is untouched, and its error is still an error', async () => {
    const [fast] = withCallBudget([tool(async () => ({ ok: true, n: 1 }))], 1_000)
    expect(await fast!.run({})).toEqual({ ok: true, n: 1 })
    const [bad] = withCallBudget(
      [
        tool(async () => {
          throw new Error('boom')
        }),
      ],
      1_000,
    )
    await expect(bad!.run({})).rejects.toThrow('boom')
  })
})
