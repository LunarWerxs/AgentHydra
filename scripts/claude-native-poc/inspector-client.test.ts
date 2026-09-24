import { describe, expect, test } from 'bun:test'
import {
  connectClaudeInspector,
  type InspectorDependencies,
  type InspectorSocket,
} from './inspector-client'

const identity = {
  pid: 4321,
  argv: ['C:\\Claude\\claude.exe', '--user-data-dir=C:\\Profiles\\Target'],
  electron: '40.0.0',
  profile: 'C:\\Profiles\\Target',
  version: '2.2553.1',
}

class FakeSocket extends EventTarget implements InspectorSocket {
  readyState: number = WebSocket.OPEN
  sent: Array<{ id: number; method: string; params: { expression: string } }> = []
  identityValue: unknown = identity

  send(data: string): void {
    const request = JSON.parse(data)
    this.sent.push(request)
    if (this.sent.length === 1) {
      queueMicrotask(() => this.result(request.id, this.identityValue))
    }
  }

  emit(response: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) }))
  }

  result(id: number, value: unknown): void {
    this.emit({ id, result: { result: { type: 'object', value } } })
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

function fixture(endpoint = 'ws://127.0.0.1:9229/target') {
  const socket = new FakeSocket()
  const urls: string[] = []
  const dependencies: InspectorDependencies = {
    fetch: async (url, options) => {
      urls.push(url)
      expect(options.redirect).toBe('error')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return { ok: true, status: 200, json: async () => [{ webSocketDebuggerUrl: endpoint }] }
    },
    createSocket: (url) => {
      urls.push(url)
      return socket
    },
  }
  const connect = (overrides = {}) =>
    connectClaudeInspector(
      { pid: 4321, profile: 'c:/profiles/target/', ...overrides },
      dependencies,
    )
  return { socket, urls, dependencies, connect }
}

describe('Claude inspector connection', () => {
  test('validates identity before returning and routes concurrent replies by ID', async () => {
    const proof = fixture()
    const client = await proof.connect()
    expect(client.identity).toEqual(identity)
    expect(proof.urls).toEqual(['http://127.0.0.1:9229/json/list', 'ws://127.0.0.1:9229/target'])
    expect(proof.socket.sent[0].params.expression).toContain("app.getPath('userData')")
    const first = client.evaluate('1')
    const second = client.evaluate('2')
    proof.socket.emit({ method: 'Runtime.consoleAPICalled', params: {} })
    proof.socket.result(999, 'unrelated')
    proof.socket.result(3, 'second')
    proof.socket.result(2, 'first')
    expect(await first).toBe('first')
    expect(await second).toBe('second')
    client.close()
  })

  test.each([
    ['PID', { ...identity, pid: 4322 }],
    ['profile', { ...identity, profile: 'C:\\Profiles\\Other' }],
  ])('rejects an unexpected %s before exposing evaluation', async (_field, value) => {
    const proof = fixture()
    proof.socket.identityValue = value
    await expect(proof.connect()).rejects.toThrow('does not match')
    expect(proof.socket.sent).toHaveLength(1)
    expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
  })

  test.each([null, { ...identity, electron: undefined }, { ...identity, argv: 'not-an-array' }])(
    'rejects malformed main-process identity',
    async (value) => {
      const proof = fixture()
      proof.socket.identityValue = value
      await expect(proof.connect()).rejects.toThrow('Malformed Claude')
      expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
    },
  )

  test.each([
    { error: { code: -32000, message: 'internal detail' } },
    { result: { exceptionDetails: { text: 'internal detail' } } },
    { result: {} },
    { result: { result: { type: 'object', objectId: 'not-serialized' } } },
  ])('rejects protocol, expression, and malformed result errors', async (response) => {
    const proof = fixture()
    const client = await proof.connect()
    const pending = client.evaluate('1')
    proof.socket.emit({ id: 2, ...response })
    await expect(pending).rejects.toThrow(/inspector/i)
    client.close()
  })

  test('malformed JSON rejects pending calls and closes the connection', async () => {
    const proof = fixture()
    const client = await proof.connect()
    const pending = client.evaluate('1')
    proof.socket.dispatchEvent(new MessageEvent('message', { data: '{' }))
    await expect(pending).rejects.toThrow('Malformed inspector response')
    expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
  })

  test('preserves bounded error details for diagnosing native bootstrap', async () => {
    const proof = fixture()
    const client = await proof.connect()
    const protocol = client.evaluate('1')
    proof.socket.emit({ id: 2, error: { message: 'Main-process require unavailable' } })
    await expect(protocol).rejects.toThrow('Main-process require unavailable')
    const exception = client.evaluate('2')
    proof.socket.emit({
      id: 3,
      result: {
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: `Native manager unavailable${'x'.repeat(600)}` },
        },
      },
    })
    const failure = await exception.catch((error: Error) => error.message)
    expect(failure).toBe(
      `Inspector expression threw an exception: ${`Native manager unavailable${'x'.repeat(600)}`.slice(0, 500)}`,
    )
    client.close()
  })

  test('remote close rejects all pending calls immediately', async () => {
    const proof = fixture()
    const client = await proof.connect()
    const first = client.evaluate('1')
    const second = client.evaluate('2')
    proof.socket.close()
    await expect(first).rejects.toThrow('connection closed')
    await expect(second).rejects.toThrow('connection closed')
    await expect(client.evaluate('3')).rejects.toThrow('not open')
  })

  test('call timeout closes the socket without accepting a late reply', async () => {
    const proof = fixture()
    const client = await proof.connect({ callTimeoutMs: 15 })
    await expect(client.evaluate('1')).rejects.toThrow('call timed out')
    proof.socket.result(2, 'late')
    expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
  })

  test('connection timeout closes an unopened socket', async () => {
    const proof = fixture()
    proof.socket.readyState = WebSocket.CONNECTING
    await expect(proof.connect({ connectTimeoutMs: 15 })).rejects.toThrow('connect timed out')
    expect(proof.socket.sent).toHaveLength(0)
    expect(proof.socket.readyState).toBe(WebSocket.CLOSED)
  })

  test.each([
    'ws://example.com:9229/target',
    'ws://127.0.0.1:9230/target',
    'wss://127.0.0.1:9229/target',
    'ws://user:password@127.0.0.1:9229/target',
  ])('refuses an untrusted discovery endpoint %s', async (endpoint) => {
    const proof = fixture(endpoint)
    await expect(proof.connect()).rejects.toThrow('not loopback on the requested port')
    expect(proof.urls).toHaveLength(1)
    expect(proof.socket.sent).toHaveLength(0)
  })

  test('discovers only an explicitly selected alternate port', async () => {
    const proof = fixture('ws://127.0.0.1:9333/target')
    const client = await proof.connect({ port: 9333 })
    expect(proof.urls[0]).toBe('http://127.0.0.1:9333/json/list')
    client.close()
  })

  test('identifies a disabled or unavailable loopback debugger clearly', async () => {
    const proof = fixture()
    proof.dependencies.fetch = async () => {
      throw new Error('Connection refused')
    }
    await expect(proof.connect()).rejects.toThrow(
      'Inspector discovery unavailable at 127.0.0.1:9229: Connection refused',
    )
    expect(proof.socket.sent).toHaveLength(0)
    expect(proof.urls).toHaveLength(0)
  })
})
