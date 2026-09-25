// server/tests/mcp-api-levels.test.ts - the frozen MCP API levels (server/src/mcp-api-levels.ts).
//
// Two gates and the comparator behind them. The gates replay every committed level against the
// live TOOLS, so a tool that disappears or an argument that tightens fails here instead of in some
// agent's prompt weeks later, and they refuse a version bump that did not freeze its level. The
// comparator cases pin what counts as a break: a check that flagged loosening would be switched off
// within a week, and one that missed tightening is the silent break this exists to catch.

import { describe, expect, test } from 'bun:test'
import { SERVER_INFO, TOOLS } from '../src/mcp'
import {
  type ApiLevel,
  breaksBetween,
  contractOf,
  loadApiLevels,
  surfaceOf,
} from '../src/mcp-api-levels'
import type { McpEngineTool } from '../src/mcp-stdio.mjs'

const tool = (name: string, inputSchema: unknown): McpEngineTool => ({
  name,
  description: `${name} tool`,
  inputSchema,
  run: () => null,
})

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const level = (version: string, tools: McpEngineTool[], earlier: ApiLevel[] = []) =>
  surfaceOf(tools, version, earlier)

const paths = (frozen: ApiLevel, live: ApiLevel) =>
  breaksBetween(frozen, live, {}).map((b) => `${b.path}: ${b.what}`)

describe('committed levels against the live tool surface', () => {
  const levels = loadApiLevels()
  const live = surfaceOf(TOOLS, SERVER_INFO.version, levels)

  test('the running version has a frozen level (a release freezes its surface)', () => {
    expect(levels.map((l) => l.version)).toContain(SERVER_INFO.version)
  })

  test('no committed level is broken by the live tools', () => {
    expect(levels.flatMap((l) => breaksBetween(l, live))).toEqual([])
  })
})

describe('breaksBetween', () => {
  const base = level('1.0.0', [
    tool('move', obj({ chat: { type: 'string' }, to: { type: 'string' } }, ['chat'])),
    tool('mode', obj({ action: { type: 'string', enum: ['a', 'b'] } })),
    tool(
      'fan',
      obj({ tasks: { type: 'array', items: obj({ cwd: { type: 'string' } }), minItems: 1 } }),
    ),
    tool('gone', obj()),
  ])

  test('flags a removed tool, a removed argument and an optional argument turned required', () => {
    const live = level('1.1.0', [
      tool('move', obj({ chat: { type: 'string' }, to: { type: 'string' } }, ['chat', 'to'])),
      tool('mode', obj({})),
      tool(
        'fan',
        obj({ tasks: { type: 'array', items: obj({ cwd: { type: 'string' } }), minItems: 1 } }),
      ),
    ])
    expect(paths(base, live)).toEqual([
      'gone: tool removed',
      'mode.action: argument removed',
      'move.to: optional argument became required',
    ])
  })

  test('flags a new required argument, a dropped enum value, a narrowed type and nested tightening', () => {
    const live = level('1.1.0', [
      tool(
        'move',
        obj({ chat: { type: 'number' }, to: { type: 'string' }, by: { type: 'string' } }, [
          'by',
          'chat',
        ]),
      ),
      tool('mode', obj({ action: { type: 'string', enum: ['a'] } })),
      tool(
        'fan',
        obj({
          tasks: {
            type: 'array',
            items: obj({ cwd: { type: 'string' }, prompt: { type: 'string' } }, ['prompt']),
            minItems: 2,
          },
        }),
      ),
      tool('gone', obj()),
    ])
    expect(paths(base, live)).toEqual([
      'fan.tasks: minItems raised to 2',
      'fan.tasks[].prompt: new required argument',
      'mode.action: enum value(s) removed: b',
      'move.chat: type no longer accepts string',
      'move.by: new required argument',
    ])
  })

  test('additions, loosening and reworded descriptions are not breaks', () => {
    const live = level('1.1.0', [
      tool('move', {
        ...obj({
          chat: { type: ['string', 'number'], description: 'reworded' },
          to: { type: 'string' },
          archived_count: { type: 'number' },
        }),
        description: 'a schema-level note',
      }),
      tool('mode', obj({ action: { type: 'string', enum: ['a', 'b', 'c'] } })),
      tool('fan', obj({ tasks: { type: 'array', items: obj({ cwd: { type: 'string' } }) } })),
      tool('gone', obj()),
      tool('brand_new', obj({ x: { type: 'string' } }, ['x'])),
    ])
    expect(paths(base, live)).toEqual([])
  })

  test('an accepted break is excused for its own level only', () => {
    const live = level('1.1.0', [tool('move', obj({ chat: { type: 'string' } }, ['chat']))])
    const excused = breaksBetween(base, live, { '1.0.0:gone': 'retired on purpose' })
    expect(excused.map((b) => b.path)).not.toContain('gone')
    expect(excused.map((b) => b.path)).toContain('move.to')
    const other = breaksBetween(base, live, { '0.9.0:gone': 'a different level' })
    expect(other.map((b) => b.path)).toContain('gone')
  })
})

describe('surfaceOf', () => {
  test('since is the earliest level holding the tool, else the version being frozen', () => {
    const first = level('1.0.0', [tool('old', obj())])
    const second = level('1.1.0', [tool('old', obj()), tool('mid', obj())], [first])
    const now = level(
      '1.2.0',
      [tool('old', obj()), tool('mid', obj()), tool('new', obj())],
      [second, first],
    )
    expect(Object.fromEntries(now.tools.map((t) => [t.name, t.since]))).toEqual({
      mid: '1.1.0',
      new: '1.2.0',
      old: '1.0.0',
    })
  })

  test('the frozen schema keeps a property named "description" and drops description prose', () => {
    expect(
      contractOf(
        obj({ description: { type: 'string', description: 'the text' } }, ['description']),
      ),
    ).toEqual({
      additionalProperties: false,
      properties: { description: { type: 'string' } },
      required: ['description'],
      type: 'object',
    })
  })
})
