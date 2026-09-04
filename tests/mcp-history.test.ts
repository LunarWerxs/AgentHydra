// tests/mcp-history.test.ts — can an MCP client actually read ALL the chat history on this machine?
//
// THE BUG THIS FILE EXISTS FOR. `list_sessions` had no `period` parameter, and GET /api/sessions
// defaults to `period=24h`. So an agent told to go through "all my chat histories" issued the only
// call available to it, got the last day, and had no way to tell that anything had been withheld —
// on the store this was written against, 19 rows out of 1,231. That is the worst failure an API can
// have: not an error, an answer that is quietly wrong and looks complete.
//
// There was no paging either, so even asking correctly capped out at the daemon's 500-row ceiling
// with no way to reach row 501, and no way to discover what projects existed before querying them.
//
// These tests pin the fix at the level a client actually experiences it: the parameters exist, they
// reach the daemon, and the description says out loud what the default does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { daemonBase, SERVER_INFO, TOOLS } from '../server/src/mcp.ts'
import { handleRpc } from '../server/src/mcp-stdio.mjs'

const ctx = { serverInfo: SERVER_INFO, tools: TOOLS }
const originalFetch = global.fetch
let calls: Array<{ url: string }> = []

beforeEach(() => {
  calls = []
  // @ts-expect-error test stub, narrower than the real fetch signature
  global.fetch = async (url: string) => {
    calls.push({ url: String(url) })
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' } as Response
  }
})
afterEach(() => {
  global.fetch = originalFetch
})

const call = (name: string, args: Record<string, unknown> = {}) =>
  handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx)

const tool = (name: string) => TOOLS.find((t) => t.name === name)
const params = (name: string) =>
  Object.keys((tool(name)?.inputSchema as { properties?: object })?.properties ?? {})

// --- the parameters a "read everything" client needs ------------------------------------------

describe('list_sessions', () => {
  test('offers the knobs that make "all my history" answerable', () => {
    // Each of these was missing, and each absence silently truncated an answer rather than failing.
    for (const p of ['period', 'since', 'until', 'offset', 'project', 'instance', 'archived'])
      expect(params('list_sessions')).toContain(p)
  })

  test('its description states the 24h default in so many words', () => {
    // The parameter alone is not enough: a client only reaches for `period` if it knows the default
    // is not "everything". This sentence is load-bearing, not decoration.
    const d = tool('list_sessions')?.description ?? ''
    expect(d).toContain('24 HOURS')
    expect(d.toLowerCase()).toContain('period="all"')
  })

  test('period reaches the daemon', async () => {
    await call('list_sessions', { period: 'all' })
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/sessions?period=all`)
  })

  test('offset reaches the daemon, so page 2 is reachable at all', async () => {
    await call('list_sessions', { limit: 500, offset: 500 })
    expect(calls[0]!.url).toContain('limit=500')
    expect(calls[0]!.url).toContain('offset=500')
  })

  test('a date range and a project scope reach the daemon', async () => {
    await call('list_sessions', {
      since: '2026-08-01',
      until: '2026-08-08',
      project: 'agenthydra',
    })
    const url = calls[0]!.url
    expect(url).toContain('since=2026-08-01')
    expect(url).toContain('until=2026-08-08')
    expect(url).toContain('project=agenthydra')
  })

  test("the usage-limit scope maps to the route's own parameter name", async () => {
    // The tool spells it rateLimited (camelCase, as MCP arguments read) and the route spells it
    // ratelimited. If this mapping breaks the filter silently stops narrowing, which looks like
    // "you have never been rate limited" rather than like a bug.
    await call('list_sessions', { rateLimited: 'pending' })
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/sessions?ratelimited=pending`)
  })

  test('every local store is reachable, foreign readers included', () => {
    const schema = tool('list_sessions')?.inputSchema as
      | { properties: Record<string, { enum?: string[] }> }
      | undefined
    const source = schema?.properties.source
    // 'foreign' is the shared reader for Cursor, Windsurf, Zed, Copilot CLI and the rest. Leaving it
    // out of the enum made a whole class of local history unaddressable over MCP.
    // 'hermes' joined on 2026-09-04: Hermes Agent's own SQLite store, read by hermes-sessions.ts.
    expect(source?.enum).toEqual(['claude', 'codex', 'opencode', 'hermes', 'foreign'])
  })
})

// --- finding out what "all" even is -------------------------------------------------------------

describe('list_projects', () => {
  test('exists, takes nothing, and hits the projects route', async () => {
    expect(tool('list_projects')).toBeDefined()
    expect(params('list_projects')).toEqual([])
    await call('list_projects')
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/sessions/projects`)
  })
})

// --- the terminated-by-a-limit list --------------------------------------------------------------

describe('list_rate_limited_sessions', () => {
  test('defaults to the whole store, not the 24h window', async () => {
    // This question is almost always historical ("what did I lose to a limit?"), so inheriting the
    // list's "what am I working on" default would answer it wrong nearly every time.
    await call('list_rate_limited_sessions')
    const url = calls[0]!.url
    expect(url).toContain('period=all')
    expect(url).toContain('ratelimited=only')
    // Archived sessions were still cut off by a wall; hiding them would under-report the answer.
    expect(url).toContain('archived=include')
  })

  test('pendingOnly narrows to the ones still stopped right now', async () => {
    await call('list_rate_limited_sessions', { pendingOnly: true })
    expect(calls[0]!.url).toContain('ratelimited=pending')
  })

  test('says plainly that it is Claude-only', () => {
    // An empty result must not be readable as "no session on this machine ever hit a limit" when
    // what it really means is "this detector does not cover the provider you asked about".
    expect(tool('list_rate_limited_sessions')?.description ?? '').toContain('Claude')
  })
})
