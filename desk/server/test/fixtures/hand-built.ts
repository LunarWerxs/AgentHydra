// Hand-built SDK message streams for what a short real run will not produce on demand. Each message is
// typed against sdk.d.ts so a shape change in the SDK breaks the typecheck, not the app. Only the
// Anthropic API bodies (BetaMessage, stream events, usage) are cast: their full types are long.

import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKHookResponseMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

type UUID = SDKAssistantMessage['uuid']
const SID = 'fixture-session-0001'
let n = 0
function u(): UUID {
  n++
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

export function init(): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.288',
    cwd: 'C:/Users/test/project',
    tools: ['Bash', 'Read', 'TodoWrite', 'Agent'],
    mcp_servers: [],
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: u(),
    session_id: SID,
  } as SDKSystemMessage
}

function stream(event: Record<string, unknown>, parent: string | null = null): SDKPartialAssistantMessage {
  return { type: 'stream_event', event: event as unknown as SDKPartialAssistantMessage['event'], parent_tool_use_id: parent, uuid: u(), session_id: SID }
}

function assistant(id: string, content: Record<string, unknown>[], parent: string | null = null, extra: Partial<SDKAssistantMessage> = {}): SDKAssistantMessage {
  const message = { id, type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  return { type: 'assistant', message: message as unknown as SDKAssistantMessage['message'], parent_tool_use_id: parent, uuid: u(), session_id: SID, ...extra }
}

function toolResult(toolUseId: string, content: string, isError = false, parent: string | null = null): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    parent_tool_use_id: parent,
    uuid: u(),
    session_id: SID,
  }
}

function result(over: Partial<{ ok: boolean; cost: number; text: string; errors: string[]; turns: number }> = {}): SDKResultMessage {
  const base = {
    type: 'result',
    duration_ms: 1200,
    duration_api_ms: 900,
    num_turns: over.turns ?? 1,
    stop_reason: 'end_turn',
    total_cost_usd: over.cost ?? 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: u(),
    session_id: SID,
  }
  if (over.errors) return { ...base, subtype: 'error_during_execution', is_error: true, errors: over.errors } as unknown as SDKResultMessage
  return { ...base, subtype: 'success', is_error: over.ok === false, result: over.text ?? 'Done.' } as unknown as SDKResultMessage
}

/** Thinking that streams real text, then two TodoWrite calls (the second updates the checklist). */
export function todoWrite(): SDKMessage[] {
  const todos1 = [
    { content: 'Read the spec', status: 'in_progress', activeForm: 'Reading the spec' },
    { content: 'Write the code', status: 'pending', activeForm: 'Writing the code' },
  ]
  const todos2 = [
    { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
    { content: 'Write the code', status: 'in_progress', activeForm: 'Writing the code' },
  ]
  return [
    init(),
    stream({ type: 'message_start', message: { id: 'msg_todo_1', type: 'message', role: 'assistant', content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan the ' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'work first.' } }),
    assistant('msg_todo_1', [{ type: 'thinking', thinking: 'Plan the work first.', signature: 'sig' }]),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_todo_1', name: 'TodoWrite', input: {} } }),
    assistant('msg_todo_1', [{ type: 'tool_use', id: 'toolu_todo_1', name: 'TodoWrite', input: { todos: todos1 } }]),
    stream({ type: 'content_block_stop', index: 1 }),
    stream({ type: 'message_stop' }),
    toolResult('toolu_todo_1', 'Todos have been modified successfully.'),
    assistant('msg_todo_2', [{ type: 'tool_use', id: 'toolu_todo_2', name: 'TodoWrite', input: { todos: todos2 } }]),
    toolResult('toolu_todo_2', 'Todos have been modified successfully.'),
    result({ cost: 0.02, turns: 3, text: 'Planned.' }),
  ]
}

/** An Agent tool call whose sub-agent streams, runs Read, and reports through task events. */
export function subAgent(): SDKMessage[] {
  const started: SDKTaskStartedMessage = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_a',
    tool_use_id: 'toolu_agent',
    description: 'Survey the repo',
    subagent_type: 'general-purpose',
    task_type: 'local_agent',
    uuid: u(),
    session_id: SID,
  }
  const ambient: SDKTaskStartedMessage = { ...started, task_id: 'task_watch', description: 'watcher', ambient: true, uuid: u() }
  const progress: SDKToolProgressMessage = {
    type: 'tool_progress',
    tool_use_id: 'toolu_sub_read',
    tool_name: 'Read',
    parent_tool_use_id: 'toolu_agent',
    elapsed_time_seconds: 2.4,
    uuid: u(),
    session_id: SID,
  }
  const taskProgress: SDKTaskProgressMessage = {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task_a',
    tool_use_id: 'toolu_agent',
    description: 'Survey the repo',
    usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 3000 },
    last_tool_name: 'Read',
    summary: 'Reading package.json',
    uuid: u(),
    session_id: SID,
  }
  const updated: SDKTaskUpdatedMessage = {
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task_a',
    patch: { status: 'completed', end_time: 1_700_000_000_000 },
    uuid: u(),
    session_id: SID,
  }
  const notification: SDKTaskNotificationMessage = {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_a',
    tool_use_id: 'toolu_agent',
    status: 'completed',
    output_file: 'C:/Users/test/.claude/tasks/task_a.output',
    summary: 'Found 3 packages',
    uuid: u(),
    session_id: SID,
  }
  return [
    init(),
    assistant('msg_main_1', [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Survey the repo', prompt: 'List the packages.', subagent_type: 'general-purpose' } }]),
    started,
    ambient,
    stream({ type: 'message_start', message: { id: 'msg_sub_1', type: 'message', role: 'assistant', content: [] } }, 'toolu_agent'),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'toolu_agent'),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading it.' } }, 'toolu_agent'),
    assistant('msg_sub_1', [{ type: 'text', text: 'Reading it.' }], 'toolu_agent'),
    assistant('msg_sub_1', [{ type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: 'C:/Users/test/project/package.json' } }], 'toolu_agent'),
    progress,
    taskProgress,
    toolResult('toolu_sub_read', '{ "name": "x" }', false, 'toolu_agent'),
    updated,
    notification,
    toolResult('toolu_agent', 'Found 3 packages'),
    result({ cost: 0.05, turns: 2 }),
  ]
}

/** An auto compaction mid-turn. */
export function compactBoundary(): SDKMessage[] {
  const compacting: SDKStatusMessage = { type: 'system', subtype: 'status', status: 'compacting', uuid: u(), session_id: SID }
  const boundary: SDKCompactBoundaryMessage = {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 152_000, post_tokens: 31_000 },
    uuid: u(),
    session_id: SID,
  }
  const done: SDKStatusMessage = { type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: u(), session_id: SID }
  return [init(), compacting, boundary, done, result()]
}

/** A usage warning, then the limit is reached and the turn fails on it. */
export function rateLimit(): SDKMessage[] {
  const warning: SDKRateLimitEvent = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1_791_086_400 },
    uuid: u(),
    session_id: SID,
  }
  const rejected: SDKRateLimitEvent = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_791_086_400 },
    uuid: u(),
    session_id: SID,
  }
  return [
    init(),
    warning,
    rejected,
    assistant('msg_limit', [{ type: 'text', text: "You've hit your limit · resets 3pm" }], null, { error: 'rate_limit' }),
    result({ ok: false, text: "You've hit your limit · resets 3pm", cost: 0 }),
  ]
}

/** Two retries of one failing request inside a turn, then success. */
export function apiRetry(): SDKMessage[] {
  const retry = (attempt: number): SDKAPIRetryMessage => ({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    retry_delay_ms: attempt * 2000,
    error_status: 529,
    error: 'overloaded',
    uuid: u(),
    session_id: SID,
  })
  return [init(), retry(1), retry(2), assistant('msg_retry', [{ type: 'text', text: 'Back.' }]), result()]
}

/** A refusal retried on a fallback model, then one with no fallback. */
export function refusal(): SDKMessage[] {
  const fallback: SDKModelRefusalFallbackMessage = {
    type: 'system',
    subtype: 'model_refusal_fallback',
    trigger: 'refusal',
    direction: 'retry',
    scope: 'session',
    original_model: 'claude-opus-5-5',
    fallback_model: 'claude-sonnet-5-5',
    request_id: null,
    content: 'Opus 5.5 declined this request; retried on Sonnet 5.5.',
    uuid: u(),
    session_id: SID,
  }
  const noFallback: SDKModelRefusalNoFallbackMessage = {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'claude-opus-5-5',
    request_id: null,
    content: 'The model declined this request.',
    uuid: u(),
    session_id: SID,
  }
  return [init(), fallback, noFallback, result()]
}

/** A tool the permission layer denied, a failing hook, an interrupted error result, and junk. */
export function deniedAndHook(): SDKMessage[] {
  const deniedMsg: SDKPermissionDeniedMessage = {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'toolu_rm',
    decision_reason_type: 'rule',
    message: 'Permission to use Bash has been denied.',
    uuid: u(),
    session_id: SID,
  }
  const hook: SDKHookResponseMessage = {
    type: 'system',
    subtype: 'hook_response',
    hook_id: 'hook_1',
    hook_name: 'lint',
    hook_event: 'PostToolUse',
    output: '',
    stdout: '',
    stderr: 'eslint not found\nmore',
    exit_code: 2,
    outcome: 'error',
    uuid: u(),
    session_id: SID,
  }
  const unknown = { type: 'something_new', uuid: u(), session_id: SID } as unknown as SDKMessage
  const broken = { type: 'assistant', message: null, parent_tool_use_id: null, uuid: u(), session_id: SID } as unknown as SDKMessage
  return [
    init(),
    assistant('msg_rm', [{ type: 'tool_use', id: 'toolu_rm', name: 'Bash', input: { command: 'rm -rf build' } }]),
    deniedMsg,
    toolResult('toolu_rm', 'Permission to use Bash has been denied.', true),
    hook,
    unknown,
    broken,
    result({ errors: ['Request was aborted.'] }),
  ]
}
