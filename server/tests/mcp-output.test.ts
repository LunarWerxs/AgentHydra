// server/tests/mcp-output.test.ts - the projection and size guard every MCP tool result passes
// through on its way to an agent (server/src/mcp-output.ts, server/src/jmespath.ts).
//
// What is pinned: an agent can take one field instead of the whole payload; a bad expression
// refuses BEFORE the tool runs; a miss or a type error names the payload's keys so the retry can be
// right; an oversized answer is cut to the cap with every cut named; and a write's confirmation
// (ok, verdict, operation id, collateral, per-chat results) survives the cut.
import { afterEach, describe, expect, test } from 'bun:test'
import { compile, JmesPathError, search } from '../src/jmespath'
import { TOOLS } from '../src/mcp'
import {
  DEFAULT_MAX_RESULT_BYTES,
  guardResult,
  maxResultBytes,
  resultBytes,
  withOutputShaping,
} from '../src/mcp-output'
import type { McpEngineTool } from '../src/mcp-stdio.mjs'
import { handleRpc } from '../src/mcp-stdio.mjs'

const PAYLOAD = {
  total: 3,
  sessions: [
    { id: 'a', title: 'Fix login', source: 'claude', cost: 1.5, tags: ['auth'] },
    { id: 'b', title: 'Docs pass', source: 'codex', cost: 0.25, tags: [] },
    { id: 'c', title: 'Release', source: 'claude', cost: 4, tags: ['ship', 'ci'] },
  ],
  byModel: { opus: { cost: 5 }, sonnet: { cost: 0.75 } },
}

describe('jmespath', () => {
  const CASES: [string, unknown][] = [
    ['total', 3],
    ['sessions[0].title', 'Fix login'],
    ['sessions[-1].id', 'c'],
    ['sessions[].id', ['a', 'b', 'c']],
    ['sessions[:2].id', ['a', 'b']],
    ['sessions[::-1].id', ['c', 'b', 'a']],
    ["sessions[?source=='claude'].id", ['a', 'c']],
    [
      'sessions[?cost > `1`].{id: id, cost: cost}',
      [
        { id: 'a', cost: 1.5 },
        { id: 'c', cost: 4 },
      ],
    ],
    [
      'sessions[].[id, title]',
      [
        ['a', 'Fix login'],
        ['b', 'Docs pass'],
        ['c', 'Release'],
      ],
    ],
    ['sessions[].tags[]', ['auth', 'ship', 'ci']],
    ['byModel.*.cost', [5, 0.75]],
    ['sessions[].id | [0]', 'a'], // a pipe ends the projection
    ['length(sessions)', 3],
    ['keys(@)', ['total', 'sessions', 'byModel']],
    ['max_by(sessions, &cost).id', 'c'],
    ['sort_by(sessions, &title)[].id', ['b', 'a', 'c']],
    ['sum(sessions[].cost)', 5.75],
    ["sessions[?contains(tags, 'ci') || source=='codex'].id", ['b', 'c']],
    ['sessions[?!tags].id', ['b']], // an empty list is false
    ['missing.deeper', null],
    ['sessions[].missing', []], // a projection drops the nulls
  ]
  test.each(CASES)('%s', (expr, expected) => {
    expect(search(compile(expr), PAYLOAD)).toEqual(expected)
  })

  test('a malformed expression throws at compile time, naming where', () => {
    expect(() => compile('sessions[?source==]')).toThrow(JmesPathError)
    expect(() => compile('a.')).toThrow(/position 2/)
  })

  test('a function handed the wrong type throws while evaluating', () => {
    expect(() => search(compile('length(total)'), PAYLOAD)).toThrow(JmesPathError)
  })
})

/** A fake tool that counts its runs and records the args it was handed. */
function fakeTool(name: string, description: string, value: unknown) {
  const calls: Record<string, unknown>[] = []
  const tool: McpEngineTool = {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      additionalProperties: false,
    },
    run: (args: Record<string, unknown>) => {
      calls.push(args)
      return value
    },
  }
  return { tool, calls, shaped: withOutputShaping([tool])[0] as McpEngineTool }
}

describe('withOutputShaping: projection', () => {
  test('read tools advertise jmespath; MUTATES tools do not', () => {
    const shaped = withOutputShaping(TOOLS)
    const props = (name: string) => {
      const schema = shaped.find((t) => t.name === name)?.inputSchema as
        | { properties: Record<string, unknown> }
        | undefined
      return schema?.properties ?? {}
    }
    expect(props('list_sessions').jmespath).toBeDefined()
    expect(props('list_sessions').limit).toBeDefined() // the tool's own arguments are kept
    expect(props('move_chat').jmespath).toBeUndefined()
    // TOOLS itself is untouched: a test of one tool still sees the bare schema.
    const bare = TOOLS.find((t) => t.name === 'list_sessions')?.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(bare.properties.jmespath).toBeUndefined()
  })

  test('returns only what the expression selects, and the tool never sees the argument', async () => {
    const { shaped, calls } = fakeTool('list_sessions', 'List sessions.', PAYLOAD)
    const out = await shaped.run({ limit: 5, jmespath: 'sessions[].id' })
    expect(out).toEqual(['a', 'b', 'c'])
    expect(calls).toEqual([{ limit: 5 }])
  })

  test('a bad expression refuses before the tool runs, with the grammar', async () => {
    const { shaped, calls } = fakeTool('list_sessions', 'List sessions.', PAYLOAD)
    await expect(shaped.run({ jmespath: 'sessions[?' })).rejects.toThrow(/Nothing ran\. JMESPath:/)
    expect(calls.length).toBe(0)
  })

  test('a type error answers as data naming the payload keys, never as a failed call', async () => {
    // The tool already ran: an isError here would read a landed act as a failure.
    const { shaped, calls } = fakeTool('orchestrator_run', 'Run a script.', PAYLOAD)
    const out = (await shaped.run({ jmespath: 'length(total)' })) as {
      result: unknown
      projectionError: string
      note: string
    }
    expect(calls.length).toBe(1)
    expect(out.result).toBeNull()
    expect(out.projectionError).toContain('length()')
    expect(out.note).toContain('ran and completed')
    expect(out.note).toContain(
      'top-level keys: total: number, sessions: array(3), byModel: object(2 keys)',
    )
  })

  test('a miss answers null with the payload keys, not a bare null', async () => {
    const { shaped } = fakeTool('list_sessions', 'List sessions.', PAYLOAD)
    const out = (await shaped.run({ jmespath: 'rows[].id' })) as { result: unknown; note: string }
    expect(out.result).toBeNull()
    expect(out.note).toContain('sessions: array(3)')
  })
})

describe('size guard', () => {
  const ORIGINAL = process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES
    else process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES = ORIGINAL
  })

  const bigSessions = {
    total: 400,
    sessions: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`,
      title: `session ${i} ${'x'.repeat(300)}`,
      turns: [{ text: 'y'.repeat(500) }],
    })),
  }

  test('an oversized read result arrives under the cap, saying what was cut and how to ask for less', async () => {
    process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES = '8192'
    const { tool } = fakeTool('list_sessions', 'List sessions.', bigSessions)
    // Measured on the text the engine actually sends, not on the value.
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_sessions', arguments: {} },
      },
      { serverInfo: { name: 't', version: '0' }, tools: withOutputShaping([tool]) },
    )) as { result: { content: { text: string }[] } }
    const text = res.result.content[0]?.text ?? ''
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8192)
    const body = JSON.parse(text) as {
      total: number
      _truncated: { bytes: number; notes: string[]; narrow: string[] }
    }
    expect(body.total).toBe(400)
    expect(body._truncated.bytes).toBe(resultBytes(bigSessions))
    expect(body._truncated.notes.join(' ')).toContain('sessions: kept')
    expect(body._truncated.narrow.join(' ')).toContain('project=')
    expect(body._truncated.narrow.join(' ')).toContain('jmespath')
  })

  test("a write's confirmation survives the cut, so a landed act never reads as a failure", () => {
    const answer = {
      ok: true,
      verdict: 'moved 60 of 60',
      operationId: 'op-7',
      collateral: [{ sessionId: 'z', account: 3, detail: { big: 'q'.repeat(2000) } }],
      results: Array.from({ length: 60 }, (_, i) => ({
        chat: `chat ${i}`,
        landed: true,
        bypassVerdict: 'app-confirmed',
        log: 'l'.repeat(3000),
      })),
    }
    const out = guardResult('move_chats', answer, { limit: 20_000 }) as Record<string, unknown>
    expect(resultBytes(answer)).toBeGreaterThan(20_000)
    expect(resultBytes(out)).toBeLessThanOrEqual(20_000)
    expect(out._truncated).toBeDefined()
    expect(out.ok).toBe(true)
    expect(out.verdict).toBe('moved 60 of 60')
    expect(out.operationId).toBe('op-7')
    expect(out.collateral).toEqual([{ sessionId: 'z', account: 3 }])
    const results = out.results as Record<string, unknown>[]
    expect(results.length).toBe(60)
    expect(results.every((r) => r.landed === true && r.bypassVerdict === 'app-confirmed')).toBe(
      true,
    )
  })

  test('at 80% of the cap an object answer says so; under it, nothing changes', () => {
    const value = { rows: 'r'.repeat(7000) }
    const near = guardResult('list_chats', value, { limit: 8192 }) as Record<string, unknown>
    expect(near._responseSize).toBeDefined()
    expect(near.rows).toBe(value.rows)
    expect(guardResult('list_chats', { rows: 'short' }, { limit: 8192 })).toEqual({ rows: 'short' })
  })

  test('the cap comes from AGENTHYDRA_MCP_MAX_RESULT_BYTES, and a nonsense value falls back', () => {
    process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES = '20000'
    expect(maxResultBytes()).toBe(20000)
    process.env.AGENTHYDRA_MCP_MAX_RESULT_BYTES = '12'
    expect(maxResultBytes()).toBe(DEFAULT_MAX_RESULT_BYTES)
  })
})
