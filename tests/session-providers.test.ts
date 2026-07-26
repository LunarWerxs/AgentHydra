import { expect, test } from 'bun:test'
import { openCodePartsToTailEvents } from '../server/src/opencode-sessions'
import { sessionMarkKey } from '../server/src/sessions'
import {
  codexEventToTailEvents,
  codexRolloutIdentity,
  isCodexInjectedUserText,
  parseCodexSessionIndex,
} from '../server/src/transcript'

test('Codex rollout identity groups by the user chat and identifies subagent forks', () => {
  expect(
    codexRolloutIdentity(
      {
        type: 'session_meta',
        payload: {
          id: 'child-rollout',
          session_id: 'parent-chat',
          thread_source: 'subagent',
          source: {
            subagent: { thread_spawn: { parent_thread_id: 'parent-chat', depth: 1 } },
          },
        },
      },
      'filename-rollout',
    ),
  ).toEqual({ sessionId: 'parent-chat', isSubagent: true })

  expect(
    codexRolloutIdentity(
      {
        type: 'session_meta',
        payload: { id: 'top-level-chat', session_id: 'top-level-chat', thread_source: 'user' },
      },
      'filename-rollout',
    ),
  ).toEqual({ sessionId: 'top-level-chat', isSubagent: false })
  expect(codexRolloutIdentity(null, 'legacy-filename-id')).toEqual({
    sessionId: 'legacy-filename-id',
    isSubagent: false,
  })
})

test('Codex injected runtime blocks are not rendered as human messages', () => {
  expect(
    isCodexInjectedUserText('<environment_context>machine details</environment_context>'),
  ).toBe(true)
  expect(isCodexInjectedUserText('# AGENTS.md instructions for D:\\work')).toBe(true)
  expect(
    isCodexInjectedUserText('# AGENTS.md instructions\n\n<INSTRUCTIONS>...</INSTRUCTIONS>'),
  ).toBe(true)
  expect(
    codexEventToTailEvents({
      timestamp: '2026-07-23T12:00:00Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<recommended_plugins>...</recommended_plugins>' }],
      },
    }),
  ).toEqual([])
})

test('Codex sidebar index supplies authoritative chat titles and tolerates malformed rows', () => {
  const entries = parseCodexSessionIndex(
    [
      '{"id":"chat-1","thread_name":"Old generated title","updated_at":"2026-07-25T01:00:00Z"}',
      'not json',
      '{"id":"chat-1","thread_name":"Investigate chat splitting behavior","updated_at":"2026-07-26T01:00:00Z"}',
      '{"id":"chat-2","thread_name":"Audit analytics and Heimdall","updated_at":"invalid"}',
      '{"id":"missing-title"}',
    ].join('\n'),
  )

  expect(entries.get('chat-1')).toEqual({
    title: 'Investigate chat splitting behavior',
    updatedAt: Date.parse('2026-07-26T01:00:00Z'),
  })
  expect(entries.get('chat-2')).toEqual({
    title: 'Audit analytics and Heimdall',
    updatedAt: null,
  })
  expect(entries.has('missing-title')).toBe(false)
})

test('Codex rollout messages and tools map to the shared tail model', () => {
  const message = codexEventToTailEvents({
    timestamp: '2026-07-23T12:00:00Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '  Fixed the issue.  ' }],
    },
  })
  expect(message).toEqual([
    {
      role: 'assistant',
      kind: 'text',
      text: 'Fixed the issue.',
      tool_name: null,
      timestamp: '2026-07-23T12:00:00Z',
    },
  ])

  const tool = codexEventToTailEvents({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"bun test"}' },
  })
  expect(tool[0]?.kind).toBe('tool_use')
  expect(tool[0]?.tool_name).toBe('shell_command')
})

test('OpenCode text and tool parts map to the shared tail model while reasoning stays hidden', () => {
  const events = openCodePartsToTailEvents('assistant', 1000, [
    { data: { type: 'reasoning', text: 'private chain' }, timeCreatedAt: 1000 },
    { data: { type: 'text', text: 'Done.' }, timeCreatedAt: 2000 },
    {
      data: {
        type: 'tool',
        tool: 'read',
        state: { input: { file: 'README.md' }, output: 'contents', time: { completed: 4000 } },
      },
      timeCreatedAt: 3000,
    },
  ])
  expect(events.map((event) => event.kind)).toEqual(['text', 'tool_use', 'tool_result'])
  expect(events.some((event) => event.text.includes('private chain'))).toBe(false)
})

test('non-Claude done marks are namespaced to avoid cross-provider UUID collisions', () => {
  expect(sessionMarkKey('claude', 'same-id')).toBe('same-id')
  expect(sessionMarkKey('codex', 'same-id')).toBe('codex:same-id')
  expect(sessionMarkKey('opencode', 'same-id')).toBe('opencode:same-id')
})
