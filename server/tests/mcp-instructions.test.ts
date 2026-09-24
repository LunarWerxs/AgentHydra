// server/tests/mcp-instructions.test.ts — the standing guidance AgentHydra hands every agent in
// the MCP `initialize` handshake (server/src/mcp.ts SERVER_INSTRUCTIONS).
//
// This is the only channel that reaches a model BEFORE it calls anything, so the rules that have
// to fire early (check quota before the expensive thing, save state before you are cut off) live
// or die here. The assertions below are on BEHAVIOUR-CHANGING content, not wording: each one
// corresponds to a mistake that actually cost a session, so deleting the line should fail a test
// rather than quietly shrink the block.

import { describe, expect, test } from 'bun:test'
import { SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS } from '../src/mcp'
import { handleRpc } from '../src/mcp-stdio.mjs'

describe('SERVER_INSTRUCTIONS', () => {
  test('is delivered in the initialize handshake, before any tool is called', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { serverInfo: SERVER_INFO, tools: TOOLS, instructions: SERVER_INSTRUCTIONS },
    )) as { result?: { instructions?: string } }
    expect(res.result?.instructions).toBe(SERVER_INSTRUCTIONS)
  })

  test('tells an agent to check its own quota WITHOUT being asked', () => {
    expect(SERVER_INSTRUCTIONS).toContain('check_my_usage {}')
    expect(SERVER_INSTRUCTIONS.toLowerCase()).toContain('unprompted')
  })

  const RULES: [string, string[]][] = [
    [
      'names the expensive failure: write state to a file before being cut off',
      ['shouldOffload', 'WRITE YOUR CONTEXT, FINDINGS AND NEXT STEPS TO A FILE'],
    ],
    [
      'gates a fan-out on projected cost, since a launched fan-out cannot be recalled',
      ['CURRENT + PROJECTED', 'cannot be recalled'],
    ],
    ['warns that Pro binds on the 5-hour window, not the weekly one', ['Pro', '5-hour']],
    ['refuses to let an unread check pass as headroom', ["'unknown'", 'plenty left']],
    [
      'bans unattributed percentages and makes the human the final authority on identity',
      ['NEVER QUOTE AN UNATTRIBUTED PERCENTAGE', 'OVERRULES'],
    ],
  ]
  test.each(RULES)('%s', (_rule, phrases) => {
    for (const phrase of phrases) expect(SERVER_INSTRUCTIONS).toContain(phrase)
  })

  test('stays small enough to be worth its rent in every request', () => {
    // It rides in context for the whole session. A cap is the only thing that stops a guidance
    // block growing a line at a time until it is skimmed instead of read.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2200)
    expect(SERVER_INSTRUCTIONS.split('\n').length).toBeLessThan(32)
  })
})

describe('per-result guidance', () => {
  test('every usage/identity tool that re-states the next step is served under its public name', () => {
    // The handshake block is read once; these are the tools that must re-state the ONE action
    // when the numbers actually arrive. The nextStep text itself is pinned in usage.test.ts.
    for (const name of ['check_my_usage', 'check_usage', 'list_usage', 'usage_budget', 'whoami']) {
      expect(TOOLS.find((t) => t.name === name)).toBeDefined()
    }
  })
})
