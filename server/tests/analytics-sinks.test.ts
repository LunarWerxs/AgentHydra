// server/src/analytics.ts token sinks (their evidence: analytics-sinks.ts) - what a session carried in its prompt and never used.
//
// These pin the evidence the scan keeps and the ranking the report builds from it. The cases that
// matter are the ones where a plausible implementation is quietly wrong: a skill used by typing
// /name counted as dead, a request split across content-block records counted as two deep calls,
// a subagent's spend credited to its parent, and an MCP server whose instructions name it
// differently from its tool prefix never matching the calls made to it.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshAnalytics, scanSessionAnalytics, sinkReport } from '../src/analytics'
import { DEEP_CONTEXT_TOKENS } from '../src/analytics-sinks'

const dir = mkdtempSync(join(tmpdir(), 'ah-sinks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function transcript(lines: unknown[]): string {
  const path = join(dir, `s${n++}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  return path
}

const U = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }
const assistant = (
  at: string,
  usage: Record<string, number> = U,
  ids: { id?: string; requestId?: string } = {},
) => ({
  type: 'assistant',
  timestamp: at,
  ...(ids.requestId ? { requestId: ids.requestId } : {}),
  message: { role: 'assistant', model: 'claude-opus-5', usage, ...(ids.id ? { id: ids.id } : {}) },
})
const toolUse = (at: string, name: string, input: unknown) => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
})
const attachment = (attachment: unknown) => ({ type: 'attachment', attachment })
const listing = (names: string[]) =>
  attachment({
    type: 'skill_listing',
    names,
    content: names.map((s) => `- ${s}: does the ${s} thing, at some length`).join('\n'),
    isInitial: true,
  })
const slash = (at: string, name: string) => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: `<command-name>/${name}</command-name>` },
})

describe('what a session loaded and what it used', () => {
  test('a skill used through the Skill tool OR a typed /command counts as used', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        listing(['by-tool', 'by-command', 'never', 'plugin:skill', 'plugin:other']),
        toolUse('2024-08-10T10:00:00.000Z', 'Skill', { skill: 'by-tool' }),
        slash('2024-08-10T10:01:00.000Z', 'by-command'),
        assistant('2024-08-10T10:02:00.000Z'),
      ]),
      'claude',
    )
    const [entries] = [...a.sinks.listings.values()]
    // A plugin skill keeps its whole `plugin:skill` name: splitting at its first colon would fold
    // both into one fake `plugin` skill that no call ever names.
    expect(Object.keys(entries ?? {}).sort()).toEqual([
      'by-command',
      'by-tool',
      'never',
      'plugin:other',
      'plugin:skill',
    ])
    // An estimate off the injected line, never zero for a listed skill.
    expect(entries?.never).toBeGreaterThan(0)
    // Estimated off its own description line, not off the bare name.
    expect(entries?.['plugin:skill']).toBeGreaterThan(10)
    expect(a.sinks.skillUses).toEqual({ 'by-tool': 1, 'by-command': 1 })
  })

  test('an MCP server named in its instructions matches the prefix its tools carry', async () => {
    // Claude Code prefixes a tool with the server name with every character outside [A-Za-z0-9_-]
    // replaced, so `plugin:acme:crm` announces itself under one spelling and calls under another.
    const a = await scanSessionAnalytics(
      transcript([
        attachment({
          type: 'mcp_instructions_delta',
          addedNames: ['plugin:acme:crm'],
          addedBlocks: ['## plugin:acme:crm\nUse the CRM tools for customer lookups.'],
        }),
        attachment({
          type: 'deferred_tools_delta',
          addedNames: ['Read', 'mcp__plugin_acme_crm__lookup', 'mcp__plugin_acme_crm__update'],
          addedLines: ['Read', 'mcp__plugin_acme_crm__lookup', 'mcp__plugin_acme_crm__update'],
        }),
        assistant('2024-08-10T10:00:00.000Z'),
      ]),
      'claude',
    )
    expect([...a.sinks.mcp.keys()]).toEqual(['plugin_acme_crm'])
    const e = a.sinks.mcp.get('plugin_acme_crm')
    expect(e?.instr).toBeGreaterThan(0)
    expect(e?.tools.size).toBe(2)
  })

  test('a deep request is one deep call, however many records carry its usage', async () => {
    // Claude Code writes one record per content block with the same usage on each; counting
    // records would call one 160k-token request three deep calls.
    const deep = {
      input_tokens: 10,
      cache_read_input_tokens: DEEP_CONTEXT_TOKENS,
      output_tokens: 5,
    }
    const ids = { id: 'msg_1', requestId: 'req_1' }
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2024-08-10T10:00:00.000Z', deep, ids),
        assistant('2024-08-10T10:00:00.000Z', deep, ids),
        assistant('2024-08-10T10:00:00.000Z', deep, ids),
        assistant('2024-08-10T10:01:00.000Z', U, { id: 'msg_2', requestId: 'req_2' }),
      ]),
      'claude',
    )
    expect(a.sinks.deepCalls).toBe(1)
    expect(a.sinks.deepWeighted).toBeGreaterThan(0)
  })

  test('the deep-context sink is the prompt read past the line, not the whole deep call', async () => {
    // A call 50k past the line on Opus (x2), all of it a cache read (0.1), with a 1k reply (31):
    // the whole call weighs 0.2 x 200k + 62 x 1k = 102k; what reading past the line cost is
    // 0.2 x 50k = 10k. Charging the sink the whole call made it 61% of a month on this machine.
    const deep = {
      input_tokens: 0,
      cache_read_input_tokens: DEEP_CONTEXT_TOKENS + 50_000,
      output_tokens: 1_000,
    }
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2024-08-10T10:00:00.000Z', deep, { id: 'msg_x', requestId: 'req_x' }),
      ]),
      'claude',
    )
    expect(a.sinks.deepWeighted).toBeCloseTo(0.2 * (DEEP_CONTEXT_TOKENS + 50_000) + 62_000, 3)
    expect(a.sinks.deepExcess).toBeCloseTo(10_000, 3)
  })

  test("a subagent's spend is the subagent share, not the parent's", async () => {
    const parent = transcript([assistant('2024-08-10T10:00:00.000Z')])
    const child = transcript([
      assistant('2024-08-10T10:01:00.000Z'),
      assistant('2024-08-10T10:02:00.000Z'),
    ])
    const alone = await scanSessionAnalytics(parent, 'claude')
    const a = await scanSessionAnalytics(parent, 'claude', 'sess', [child])
    const total = Object.values(a.tokens).reduce((s, m) => s + m.weighted, 0)
    const own = Object.values(alone.tokens).reduce((s, m) => s + m.weighted, 0)
    expect(alone.sinks.subWeighted).toBe(0)
    expect(a.sinks.subWeighted).toBeCloseTo(total - own, 6)
    expect(a.sinks.subWeighted).toBeGreaterThan(own)
  })
})

describe('the sink report ranks dead load across sessions', () => {
  test('dead tokens are load x calls, counted only in sessions that never used it', async () => {
    const skills = ['zz-sink-used', 'zz-sink-dead']
    const mcp = attachment({
      type: 'mcp_instructions_delta',
      addedNames: ['zzsinksrv'],
      addedBlocks: ['## zzsinksrv\nInstructions for a server one session calls.'],
    })
    // Session A: 2 calls, uses one skill and the server. Session B: 3 calls, uses nothing.
    const a = transcript([
      listing(skills),
      mcp,
      toolUse('2024-08-10T10:00:00.000Z', 'Skill', { skill: 'zz-sink-used' }),
      toolUse('2024-08-10T10:00:30.000Z', 'mcp__zzsinksrv__lookup', {}),
      assistant('2024-08-10T10:01:00.000Z'),
      assistant('2024-08-10T10:02:00.000Z'),
    ])
    const b = transcript([
      listing(skills),
      mcp,
      assistant('2024-08-11T10:01:00.000Z'),
      assistant('2024-08-11T10:02:00.000Z'),
      assistant('2024-08-11T10:03:00.000Z'),
    ])
    const tf = (path: string, i: number) => ({
      source: 'claude' as const,
      session_id: `bbbbbbbb-0000-4000-8000-00000000000${i}`,
      path,
      project: 'sink-project',
      cwd: 'D:/sink',
      mtime_ms: 1_700_000_000_000 + i,
      size_bytes: 1000 + i,
      title: '',
      archived: false,
      created_at: null,
    })
    const r = await refreshAnalytics([tf(a, 1), tf(b, 2)] as never, {
      budgetMs: 5_000,
      concurrency: 1,
    })
    expect(r.failed).toBe(0)

    const report = sinkReport({})
    const dead = report.skills.find((s) => s.key === 'zz-sink-dead')
    const used = report.skills.find((s) => s.key === 'zz-sink-used')
    expect(dead?.sessionsLoaded).toBe(2)
    expect(dead?.sessionsUsed).toBe(0)
    expect(dead?.deadTokens).toBe((dead?.loadTokens ?? 0) * 5)
    expect(used?.sessionsUsed).toBe(1)
    expect(used?.uses).toBe(1)
    expect(used?.deadTokens).toBe((used?.loadTokens ?? 0) * 3)

    const srv = report.mcpServers.find((s) => s.key === 'zzsinksrv')
    expect(srv?.sessionsUsed).toBe(1)
    expect(srv?.deadTokens).toBe((srv?.loadTokens ?? 0) * 3)

    // Every sink is reported with its kind and basis, and dead load ranks with a real weight.
    expect(report.sinks.map((s) => s.id).sort()).toEqual([
      'cache-writes',
      'dead-mcp',
      'dead-skills',
      'deep-context',
      'output',
      'subagents',
    ])
    const deadSkills = report.sinks.find((s) => s.id === 'dead-skills')
    expect(deadSkills?.kind).toBe('structural')
    expect(deadSkills?.basis).toBe('estimated')
    expect(deadSkills?.weighted).toBeGreaterThan(0)
    expect(deadSkills?.fix.length).toBeGreaterThan(0)
    // Replies and thinking: every call here replied 50 tokens on Opus, 50 x 31 x 2 = 3,100 a call.
    expect(report.sinks.find((s) => s.id === 'output')?.weighted).toBeGreaterThanOrEqual(5 * 3_100)
  })
})

describe('a sink figure is scoped to the window like spend', () => {
  test('a three-week session in a 24h window contributes only its in-window share', async () => {
    const deep = {
      input_tokens: 10,
      cache_read_input_tokens: DEEP_CONTEXT_TOKENS,
      output_tokens: 5,
    }
    const now = Date.now()
    const old = new Date(now - 20 * 86_400_000).toISOString()
    const recent = new Date(now - 60_000).toISOString()
    // Three deep calls three weeks ago and one just now: a quarter of the session is in the window.
    const path = transcript([
      assistant(old, deep, { id: 'm1', requestId: 'r1' }),
      assistant(old, deep, { id: 'm2', requestId: 'r2' }),
      assistant(old, deep, { id: 'm3', requestId: 'r3' }),
      assistant(recent, deep, { id: 'm4', requestId: 'r4' }),
    ])
    const r = await refreshAnalytics(
      [
        {
          source: 'claude' as const,
          session_id: 'cccccccc-0000-4000-8000-000000000001',
          path,
          project: 'sink-window',
          cwd: 'D:/sink',
          mtime_ms: now,
          size_bytes: 4000,
          title: '',
          archived: false,
          created_at: null,
        },
      ] as never,
      { budgetMs: 5_000, concurrency: 1 },
    )
    expect(r.failed).toBe(0)
    const whole = sinkReport({ sinceMs: now - 30 * 86_400_000 })
    const day = sinkReport({ sinceMs: now - 86_400_000 })
    expect(whole.deepContext.calls).toBe(4)
    expect(day.deepContext.calls).toBe(1)
    expect(day.subagents.spawns).toBeLessThanOrEqual(whole.subagents.spawns)
    expect(day.deepContext.weighted).toBeLessThan(whole.deepContext.weighted / 2)
    expect(day.deepContext.weighted).toBeLessThanOrEqual(day.totalWeighted)
  })
})
