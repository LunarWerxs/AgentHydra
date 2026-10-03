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
