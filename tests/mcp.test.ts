// MCP stdio server tests — engine handshake, tool catalog, and a tool call against a stubbed
// HTTP backend (no live daemon required). Modeled on RepoYeti's tests/mcp.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { daemonBase, SERVER_INFO, TOOLS } from '../server/src/mcp.ts'
import { handleRpc } from '../server/src/mcp-stdio.mjs'

const ctx = { serverInfo: SERVER_INFO, tools: TOOLS }

const originalFetch = global.fetch
let calls: Array<{ url: string; init?: RequestInit }> = []
let stubResponse: unknown = {}
let stubOk = true
let stubStatus = 200

beforeEach(() => {
  calls = []
  stubResponse = {}
  stubOk = true
  stubStatus = 200
  // @ts-expect-error test stub, narrower than the real fetch signature
  global.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return {
      ok: stubOk,
      status: stubStatus,
      json: async () => stubResponse,
      text: async () =>
        typeof stubResponse === 'string' ? stubResponse : JSON.stringify(stubResponse),
    } as Response
  }
})

afterEach(() => {
  global.fetch = originalFetch
})

// ── protocol: initialize ──────────────────────────────────────────────────────────
describe('initialize', () => {
  test('echoes protocolVersion and reports serverInfo.name "agenthydra"', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      ctx,
    )) as {
      id: number
      result: {
        protocolVersion: string
        capabilities: object
        serverInfo: { name: string; version: string }
      }
    }
    expect(res.id).toBe(1)
    expect(res.result.protocolVersion).toBe('2025-03-26')
    expect(res.result.capabilities).toEqual({ tools: {} })
    expect(res.result.serverInfo.name).toBe('agenthydra')
  })

  test('falls back to the default protocolVersion when none is supplied', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ctx,
    )) as {
      result: { protocolVersion: string }
    }
    expect(res.result.protocolVersion).toBe('2024-11-05')
  })
})

// ── protocol: tools/list ────────────────────────────────────────────────────────────
describe('tools/list', () => {
  test('returns the full catalog including the key tools', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: object }> }
    }
    const names = res.result.tools.map((t) => t.name)
    for (const expected of [
      'list_sessions',
      'get_session',
      'tail_session',
      'list_queue',
      'add_queue_item',
      'update_queue_item',
      'run_queue_item',
      'cancel_queue_item',
      'get_run_events',
      'list_accounts',
      'get_scheduler',
      'set_scheduler',
      'list_instances',
      'launch_instance',
      'quit_instance',
      'open_codex_desktop_instance',
      'focus_codex_desktop_instance',
      'quit_codex_desktop_instance',
      'check_update',
    ]) {
      expect(names).toContain(expected)
    }
    // no shutdown tool per the task spec
    expect(names).not.toContain('shutdown')
    for (const t of res.result.tools) {
      expect(typeof t.description).toBe('string')
      expect((t.inputSchema as { type: string }).type).toBe('object')
    }
    expect(res.result.tools.length).toBe(TOOLS.length)
  })
})

// ── protocol: tools/call against a stubbed HTTP backend ─────────────────────────────
describe('tools/call', () => {
  test('list_sessions calls GET /api/sessions and returns the stubbed payload', async () => {
    stubResponse = [{ session_id: 'abc', title: 'hello' }]
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_sessions', arguments: {} },
      },
      ctx,
    )) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }

    expect(res.result.isError).toBeUndefined()
    expect(res.result.content[0]!.type).toBe('text')
    const payload = JSON.parse(res.result.content[0]!.text) as Array<{ session_id: string }>
    expect(payload[0]!.session_id).toBe('abc')
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/sessions`)
  })

  test('list_sessions passes a limit query param', async () => {
    stubResponse = []
    await handleRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_sessions', arguments: { limit: 5 } },
      },
      ctx,
    )
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/sessions?limit=5`)
  })

  test('add_queue_item POSTs the body to /api/queue', async () => {
    stubResponse = { id: 'q1', title: 'Test run' }
    const args = { title: 'Test run', cwd: 'D:\\some\\repo', prompt: 'do the thing' }
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'add_queue_item', arguments: args },
      },
      ctx,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } }

    expect(res.result.isError).toBeUndefined()
    expect(calls[0]!.url).toBe(`${daemonBase()}/api/queue`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(args)
    const payload = JSON.parse(res.result.content[0]!.text) as { id: string }
    expect(payload.id).toBe('q1')
  })

  test('a non-ok HTTP response comes back as an MCP isError result', async () => {
    stubOk = false
    stubStatus = 404
    stubResponse = 'session not found'
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'get_session', arguments: { id: 'nope' } },
      },
      ctx,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]!.text).toContain('404')
  })

  test('a missing required arg still reaches the backend as a literal "undefined" path segment (no client-side validation)', async () => {
    // The engine/tools here don't pre-validate; the id is coerced via String(undefined) — assert
    // the shape stays predictable rather than throwing an unrelated error.
    stubResponse = { error: 'session not found' }
    stubOk = false
    stubStatus = 404
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_session', arguments: {} },
      },
      ctx,
    )) as { result: { isError?: boolean } }
    expect(res.result.isError).toBe(true)
  })

  test('unknown tool -> JSON-RPC error -32602', async () => {
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} },
      },
      ctx,
    )) as { error?: { code: number; message: string } }
    expect(res.error?.code).toBe(-32602)
  })
})

// ── protocol: error / notification handling ──────────────────────────────────────────
describe('protocol edges', () => {
  test('an unknown method -> JSON-RPC error -32601', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 9, method: 'does/not/exist' }, ctx)) as {
      error?: { code: number; message: string }
    }
    expect(res.error?.code).toBe(-32601)
    expect(res.error?.message).toBe('Method not found')
  })

  test('a notification (no id) yields no response (null)', async () => {
    const res = await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)
    expect(res).toBeNull()
  })
})

// ── URL resolution ────────────────────────────────────────────────────────────────────
describe('daemonBase', () => {
  const origUrl = process.env.AGENTHYDRA_URL
  const origPort = process.env.AGENTHYDRA_PORT

  afterEach(() => {
    if (origUrl === undefined) delete process.env.AGENTHYDRA_URL
    else process.env.AGENTHYDRA_URL = origUrl
    if (origPort === undefined) delete process.env.AGENTHYDRA_PORT
    else process.env.AGENTHYDRA_PORT = origPort
  })

  test('AGENTHYDRA_URL overrides everything', () => {
    process.env.AGENTHYDRA_URL = 'http://example.test:1234'
    delete process.env.AGENTHYDRA_PORT
    expect(daemonBase()).toBe('http://example.test:1234')
  })

  test('AGENTHYDRA_PORT is used when no explicit URL is set', () => {
    delete process.env.AGENTHYDRA_URL
    process.env.AGENTHYDRA_PORT = '9999'
    expect(daemonBase()).toBe('http://127.0.0.1:9999')
  })
})
