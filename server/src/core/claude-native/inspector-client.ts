import { win32 } from 'node:path'

export interface ClaudeInspectorIdentity {
  pid: number
  argv: string[]
  electron: string
  profile: string
  version: string
}

export interface ClaudeInspectorOptions {
  pid: number
  profile: string
  port?: number
  connectTimeoutMs?: number
  callTimeoutMs?: number
}

export interface InspectorSocket extends EventTarget {
  readonly readyState: number
  send(data: string): void
  close(): void
}

export interface InspectorDependencies {
  fetch: (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>
  createSocket: (url: string) => InspectorSocket
}

const identityExpression = `(() => {
  const mainRequire = typeof require === 'function'
    ? require : process.mainModule?.require?.bind(process.mainModule);
  if (!mainRequire) throw Error('Main-process require unavailable');
  const app = mainRequire('electron').app;
  return {
    pid: process.pid,
    argv: process.argv,
    electron: process.versions.electron,
    profile: app.getPath('userData'),
    version: app.getVersion()
  };
})()`

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorDetail(value: unknown): string {
  return typeof value === 'string' && value.trim() ? `: ${value.trim().slice(0, 500)}` : ''
}

function normalizedProfile(profile: string): string {
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(profile)) {
    throw new Error('Expected an absolute Windows profile path')
  }
  return win32
    .normalize(profile)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function verifyIdentity(
  value: unknown,
  expectedPid: number,
  expectedProfile: string,
): ClaudeInspectorIdentity {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.pid) ||
    !Array.isArray(value.argv) ||
    !value.argv.every((argument) => typeof argument === 'string') ||
    typeof value.electron !== 'string' ||
    value.electron.length === 0 ||
    typeof value.profile !== 'string' ||
    typeof value.version !== 'string' ||
    value.version.length === 0
  ) {
    throw new Error('Malformed Claude main-process identity')
  }
  if (value.pid !== expectedPid || normalizedProfile(value.profile) !== expectedProfile) {
    throw new Error('Inspector PID or profile does not match the requested instance')
  }
  return value as unknown as ClaudeInspectorIdentity
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class InspectorConnection {
  private nextId = 0
  private closed = false
  private readonly pending = new Map<number, PendingCall>()

  constructor(
    private readonly socket: InspectorSocket,
    private readonly timeoutMs: number,
  ) {
    socket.addEventListener('message', this.onMessage)
    socket.addEventListener('error', this.onError)
    socket.addEventListener('close', this.onClose)
  }

  private readonly onError = () => this.close(new Error('Inspector connection failed'))
  private readonly onClose = () => this.close(new Error('Inspector connection closed'))
  private readonly onMessage = (event: Event) => {
    let response: unknown
    try {
      const data = (event as MessageEvent).data
      if (typeof data !== 'string') throw new Error('Expected text')
      response = JSON.parse(data)
      if (!record(response)) throw new Error('Expected response object')
      if (!('id' in response) && typeof response.method === 'string') return
      if (!Number.isSafeInteger(response.id) || Number(response.id) <= 0) {
        throw new Error('Invalid response ID')
      }
    } catch {
      this.close(new Error('Malformed inspector response'))
      return
    }
    const pending = this.pending.get(Number(response.id))
    if (!pending) return
    this.pending.delete(Number(response.id))
    clearTimeout(pending.timer)
    if ('error' in response) {
      pending.reject(
        new Error(
          `Inspector protocol error${errorDetail(record(response.error) ? response.error.message : undefined)}`,
        ),
      )
      return
    }
    const result = response.result
    if (!record(result)) {
      pending.reject(new Error('Malformed inspector evaluation result'))
    } else if ('exceptionDetails' in result) {
      const details = result.exceptionDetails
      const description = record(details)
        ? ((record(details.exception) ? details.exception.description : undefined) ?? details.text)
        : undefined
      pending.reject(
        new Error(`Inspector expression threw an exception${errorDetail(description)}`),
      )
    } else if (!record(result.result) || typeof result.result.type !== 'string') {
      pending.reject(new Error('Malformed inspector evaluation result'))
    } else if (result.result.type === 'undefined') {
      pending.resolve(undefined)
    } else if ('value' in result.result) {
      pending.resolve(result.result.value)
    } else {
      pending.reject(new Error('Inspector did not return a serialized value'))
    }
  }

  evaluate<T = unknown>(expression: string, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Inspector connection is not open'))
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close(new Error('Inspector call timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      } catch {
        this.close(new Error('Inspector request could not be sent'))
      }
    })
  }

  close(error = new Error('Inspector connection closed')): void {
    if (this.closed) return
    this.closed = true
    this.socket.removeEventListener('message', this.onMessage)
    this.socket.removeEventListener('error', this.onError)
    this.socket.removeEventListener('close', this.onClose)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.socket.close()
  }
}

function waitForOpen(socket: InspectorSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onFailure)
      socket.removeEventListener('close', onFailure)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onFailure = () => {
      cleanup()
      socket.close()
      reject(new Error('Inspector connect failed'))
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.close()
      reject(new Error('Inspector connect timed out'))
    }, timeoutMs)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onFailure)
    socket.addEventListener('close', onFailure)
    if (socket.readyState === WebSocket.OPEN) onOpen()
    else if (socket.readyState !== WebSocket.CONNECTING) onFailure()
  })
}

export interface ClaudeInspectorClient {
  readonly identity: ClaudeInspectorIdentity
  evaluate<T = unknown>(expression: string): Promise<T>
  close(): void
}

export async function connectClaudeInspector(
  options: ClaudeInspectorOptions,
  dependencies: InspectorDependencies = {
    fetch: (url, init) => fetch(url, init),
    createSocket: (url) => new WebSocket(url),
  },
): Promise<ClaudeInspectorClient> {
  const pid = positiveInteger(options.pid, 'PID')
  const profile = normalizedProfile(options.profile)
  const port = positiveInteger(options.port ?? 9229, 'inspector port', 65535)
  const connectTimeout = positiveInteger(
    options.connectTimeoutMs ?? 2000,
    'connection timeout',
    60000,
  )
  const callTimeout = positiveInteger(options.callTimeoutMs ?? 10000, 'call timeout', 60000)
  const deadline = Date.now() + connectTimeout
  const remaining = () => {
    const timeout = deadline - Date.now()
    if (timeout <= 0) throw new Error('Inspector connect timed out')
    return timeout
  }
  let discovery: Pick<Response, 'ok' | 'status' | 'json'>
  try {
    discovery = await dependencies.fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(connectTimeout),
      redirect: 'error',
    })
  } catch (error) {
    throw new Error(
      `Inspector discovery unavailable at 127.0.0.1:${port}${errorDetail(error instanceof Error ? error.message : undefined)}`,
      { cause: error },
    )
  }
  if (!discovery.ok) throw new Error(`Inspector discovery failed with HTTP ${discovery.status}`)
  const targets: unknown = await discovery.json()
  if (
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    !record(targets[0]) ||
    typeof targets[0].webSocketDebuggerUrl !== 'string'
  ) {
    throw new Error('Expected exactly one inspector target')
  }
  const endpoint = new URL(targets[0].webSocketDebuggerUrl)
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
    Number(endpoint.port) !== port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error('Inspector endpoint is not loopback on the requested port')
  }
  const openTimeout = remaining()
  const socket = dependencies.createSocket(endpoint.href)
  await waitForOpen(socket, openTimeout)
  const connection = new InspectorConnection(socket, callTimeout)
  try {
    const identity = verifyIdentity(
      await connection.evaluate(identityExpression, Math.min(callTimeout, remaining())),
      pid,
      profile,
    )
    return {
      identity,
      evaluate: <T = unknown>(expression: string) => connection.evaluate<T>(expression),
      close: () => connection.close(),
    }
  } catch (error) {
    connection.close()
    throw error
  }
}
