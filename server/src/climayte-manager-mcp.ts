// Manager MCP endpoint: `/api/corch/mcp/:managerId` gives a manager only its wave's tools and
// no verdict tool. Every call is refused unless that worker is the live manager of a running wave
// and the calling process is that worker's CLI (callerPidOf, index.ts:356, against the attempt's pid).
// See docs/CLIMAYTE.md, "Scope and identity of the manager endpoint".

import type { McpEngineTool } from './mcp-stdio.mjs'

/** Tools available to a manager over its own endpoint. These are stubs — the actual implementation
 * lives in climayte.ts and is called through the routes registered in index.ts. The tools are
 * defined here for reference and for tests to validate the shape. */
export const MANAGER_MCP_TOOLS: McpEngineTool[] = [
  {
    name: 'wave_state',
    description:
      'Read the current wave state and the state of its tasks. Used at the start of a wake to decide what to dispatch, re-dispatch, or escalate.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    run: async () => {
      throw new Error(
        'wave_state must be called through the manager endpoint, not the main MCP server',
      )
    },
  },
  {
    name: 'wave_dispatch',
    description:
      "Dispatch tasks into the wave's group. Refuses the manage kind (no manager of managers) and a key past maxRounds. Every brief must end with Commits: <sha>... or Commits: none.",
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task keys from the plan to dispatch or re-dispatch.',
        },
      },
      required: ['keys'],
    },
    run: async () => {
      throw new Error('wave_dispatch must be called through the manager endpoint')
    },
  },
  {
    name: 'wave_send',
    description:
      'Send a message to a running task in the wave (for a follow-up on an escalated or stuck key).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The task key.' },
        text: { type: 'string', description: 'The message text.' },
      },
      required: ['key', 'text'],
    },
    run: async () => {
      throw new Error('wave_send must be called through the manager endpoint')
    },
  },
  {
    name: 'wave_cancel',
    description: 'Cancel a queued or running task in the wave.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The task key.' },
      },
      required: ['key'],
    },
    run: async () => {
      throw new Error('wave_cancel must be called through the manager endpoint')
    },
  },
  {
    name: 'wave_escalate',
    description:
      'Mark a task as escalated (needs orchestrator decision): a report says something was left undone, a worker made a choice the plan does not cover, or a plan step says to deploy.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The task key.' },
        reason: { type: 'string', description: 'Why this task is escalated.' },
      },
      required: ['key', 'reason'],
    },
    run: async () => {
      throw new Error('wave_escalate must be called through the manager endpoint')
    },
  },
  {
    name: 'wave_note',
    description: "Add a note to the wave (the manager's scratch, capped at 2,000 chars).",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text to add.' },
      },
      required: ['text'],
    },
    run: async () => {
      throw new Error('wave_note must be called through the manager endpoint')
    },
  },
  {
    name: 'wave_report',
    description:
      'Report that the wave is done: every key is passed, failed or escalated. At most 2,000 chars; the daemon prefixes a table with one line per key.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "The manager's final report." },
      },
      required: ['text'],
    },
    run: async () => {
      throw new Error('wave_report must be called through the manager endpoint')
    },
  },
]
