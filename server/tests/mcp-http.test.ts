// Tests for the MCP-over-HTTP transport (server/src/mcp-http.mjs).
//
// The transport exists so that N Claude Code clients cost ONE server process instead of N (see the
// module header). These tests pin the two things that make it safe to swap in for stdio: it must
// dispatch through the SAME `handleRpc` the stdio server uses, and it must map JSON-RPC's
// "notifications produce no response" rule onto HTTP as an EMPTY 202 body - not the JSON document
// `null`, which a client would happily parse as a result and then choke on.
import { expect, test } from 'bun:test'
import { handleMcpHttp, PARSE_ERROR } from '../src/mcp-http.mjs'
import { handleRpc } from '../src/mcp-stdio.mjs'

const ctx = {
  serverInfo: { name: 'test-server', version: '1.2.3' },
  instructions: 'be brief',
  tools: [
    {
      name: 'echo',
      description: 'echo back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: (args: Record<string, unknown>) => ({ echoed: args.text }),
    },
  ],
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }

test('initialize answers 200 with the server identity, through the real dispatcher', async () => {
  const { status, json } = await handleMcpHttp(init, ctx, handleRpc)
  expect(status).toBe(200)
  const res = json as { id: number; result: { serverInfo: unknown; instructions: string } }
  expect(res.id).toBe(1)
  expect(res.result.serverInfo).toEqual({ name: 'test-server', version: '1.2.3' })
  // The instructions ride the handshake, so an HTTP client gets the same operating rules a stdio
  // client gets. A transport that dropped them would be silently less useful, not obviously broken.
  expect(res.result.instructions).toBe('be brief')
})

test('tools/call runs the tool and returns its result', async () => {
  const { status, json } = await handleMcpHttp(
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    },
    ctx,
    handleRpc,
  )
  expect(status).toBe(200)
  expect(JSON.stringify(json)).toContain('hi')
})

test('a notification answers 202 with an EMPTY body, never the JSON document null', async () => {
  const { status, json } = await handleMcpHttp(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ctx,
    handleRpc,
  )
  expect(status).toBe(202)
  expect(json).toBeNull() // the route reads this as "send no body"
})

test('unparseable body answers 400 and -32700 against a null id', async () => {
  const { status, json } = await handleMcpHttp(PARSE_ERROR, ctx, handleRpc)
  expect(status).toBe(400)
  expect(json).toEqual({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  })
})

test('a batch answers with an array of only the responses, notifications dropped', async () => {
  const { status, json } = await handleMcpHttp(
    [
      init,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ],
    ctx,
    handleRpc,
  )
  expect(status).toBe(200)
  const arr = json as { id: number }[]
  expect(arr.map((r) => r.id)).toEqual([1, 2])
})

test('a batch of nothing but notifications answers 202 with an empty body', async () => {
  const { status, json } = await handleMcpHttp(
    [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
    ],
    ctx,
    handleRpc,
  )
  expect(status).toBe(202)
  expect(json).toBeNull()
})

test('an unknown method still answers 200 with a JSON-RPC error, not an HTTP error', async () => {
  // Transport-level status codes describe the TRANSPORT. A method the server does not implement is
  // a protocol-level fact and belongs in the body, or a client cannot tell "server is broken" from
  // "server does not do that".
  const { status, json } = await handleMcpHttp(
    { jsonrpc: '2.0', id: 9, method: 'nope' },
    ctx,
    handleRpc,
  )
  expect(status).toBe(200)
  expect((json as { error: { code: number } }).error.code).toBe(-32601)
})
