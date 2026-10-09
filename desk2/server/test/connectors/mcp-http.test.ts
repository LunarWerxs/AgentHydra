import { describe, expect, test } from 'bun:test'
import { type McpHandler, type RpcMessage, serveMcpHttp } from '../../src/connectors/mcp-http'

// A server like redesign-mcp's: replies to requests, sends progress through notify on a tools/call.
const server: McpHandler = {
  async handle(msg: RpcMessage, notify = () => {}) {
    if (msg.id === undefined || msg.id === null) return null
    if (msg.method === 'tools/call') notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })
    return { jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }
  }
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:7798/mcp/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('serveMcpHttp', () => {
  test('a request is answered as JSON when the client takes no stream', async () => {
    const res = await serveMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { accept: 'application/json' }), server)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { method: 'initialize' } })
  })

  test('a batch is answered as a batch', async () => {
    const res = await serveMcpHttp(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]), server)
    expect((await res.json()).map((r: { id: number }) => r.id)).toEqual([1, 2])
  })

  test('notifications alone get 202 and no body', async () => {
    const res = await serveMcpHttp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), server)
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  test('a streaming client gets the progress before the result', async () => {
    const res = await serveMcpHttp(post({ jsonrpc: '2.0', id: 7, method: 'tools/call' }, { accept: 'application/json, text/event-stream' }), server)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const events = (await res.text()).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.split('data: ')[1]))
    expect(events.map((e) => e.method ?? e.id)).toEqual(['notifications/progress', 7])
  })

  test('a browser page is refused, by Origin or by Sec-Fetch', async () => {
    expect((await serveMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://127.0.0.1:7798' }), server)).status).toBe(403)
    expect((await serveMcpHttp(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'sec-fetch-site': 'same-origin' }), server)).status).toBe(403)
  })

  test('GET has no stream to open', async () => {
    expect((await serveMcpHttp(new Request('http://127.0.0.1:7798/mcp/x'), server)).status).toBe(405)
  })
})
