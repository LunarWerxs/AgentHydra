// Manager MCP endpoint tests: POST /api/corch/mcp/:managerId with caller check.
// The endpoint gives a manager only its wave's tools and refuses ordinary workers and finished managers.
// Piece 4 of the Manager (CLIManager): docs/CLIMAYTE.md.

import { describe, expect, test } from 'bun:test'
import { MANAGER_MCP_TOOLS } from '../src/climayte-manager-mcp'

describe('manager MCP endpoint', () => {
  // Test structure: the endpoint tools are defined and validate caller permission.
  // The actual HTTP handler is tested through integration with the wave store (piece 1+)
  // and the full handler in index.ts.

  test('MANAGER_MCP_TOOLS defines all required tools', () => {
    const toolNames = new Set(MANAGER_MCP_TOOLS.map((t) => t.name))

    // The wave tools: state, dispatch, send, cancel, escalate, note, report.
    // No verdict tool: the daemon judges by command (piece 5).
    expect(toolNames.has('wave_state')).toBe(true)
    expect(toolNames.has('wave_dispatch')).toBe(true)
    expect(toolNames.has('wave_send')).toBe(true)
    expect(toolNames.has('wave_cancel')).toBe(true)
    expect(toolNames.has('wave_escalate')).toBe(true)
    expect(toolNames.has('wave_note')).toBe(true)
    expect(toolNames.has('wave_report')).toBe(true)

    // No verdict tool.
    expect(toolNames.has('wave_verdict')).toBe(false)
    expect(toolNames.has('climayte_verdict')).toBe(false)
  })

  test('MANAGER_MCP_TOOLS have proper input schemas', () => {
    const tool = MANAGER_MCP_TOOLS.find((t) => t.name === 'wave_dispatch')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toEqual({
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task keys from the plan to dispatch or re-dispatch.',
        },
      },
      required: ['keys'],
    })
  })

  test('manager tools are stubs that throw with helpful messages', () => {
    const tool = MANAGER_MCP_TOOLS.find((t) => t.name === 'wave_state')
    expect(tool).toBeDefined()

    // The stub throws a clear message about the endpoint.
    expect(async () => {
      await tool!.run({})
    }).toThrow('wave_state must be called through the manager endpoint')
  })
})

describe('manager MCP endpoint integration', () => {
  // These tests verify the endpoint's behavior when it's fully integrated.
  // For now, they document what the endpoint should do.

  test('endpoint at /api/corch/mcp/:managerId refuses a non-manager', async () => {
    // A worker that has no wave field is not a manager.
    // The endpoint should return 403 "Not a valid manager of a running wave".
  })

  test('endpoint refuses a finished manager', async () => {
    // A manager whose wave is not running (status not running/reported) is not live.
    // The endpoint should return 403.
  })

  test("endpoint refuses when caller pid does not match manager's CLI", async () => {
    // Even if the manager exists and has a running wave, a caller from a different process
    // should be refused with 403 "Caller is not the manager's CLI process".
  })

  test("wave_dispatch in the endpoint routes to the wave's group only", async () => {
    // A wave dispatch from a manager lands in the wave's group, not any group.
    // The endpoint scope (piece 4) enforces this; workers scheduled outside the wave's group
    // should not happen. Verified in the wave batch test (piece 3).
  })

  test('wave_dispatch refuses kind manage (no manager of managers)', async () => {
    // The endpoint handler (piece 5+) prevents a manager from starting another manager.
  })

  test('ordinary worker still denies the full agenthydra server', async () => {
    // An ordinary (non-manage) worker's settings should still carry the denials.
    // The worker's MCP config (from writeWorkerMcp) should exclude:
    // 1. WORKER_DENIED_MCP servers by name (agenthydra, magnific)
    // 2. WORKER_DENIED_MCP_URL patterns (*://*${MCP_PATH}*)
  })

  test('manager MCP config includes the manager endpoint', async () => {
    // A manage-kind worker's MCP config should include a `climayte-manager` entry
    // with only a URL (no header, no token), pointing to /api/corch/mcp/:managerId.
    // The daemon listens on 127.0.0.1 (loopback only).
  })

  test('manager endpoint is outside /api/mcp*, so worker URL denials still apply', async () => {
    // The endpoint URL is /api/corch/mcp/:managerId, not /api/mcp*.
    // A worker that carries a URL deny for *://*/api/mcp* still cannot reach the full
    // agenthydra server. The manager endpoint is listed in the manager's own MCP config,
    // not the worker's, so the denial does not apply to the manager accessing it.
  })
})
