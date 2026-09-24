import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolveCodexExe } from '../config'

/** Short-lived, local app-server connection. It never starts a model turn. */
export interface CodexRpc {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
  close(): void | Promise<void>
}

export async function connectCodexRpc(
  codexHome: string,
  options: { command?: string[]; timeoutMs?: number } = {},
): Promise<CodexRpc> {
  const command = options.command ?? [resolveCodexExe(), 'app-server']
  const child = spawn(command[0]!, command.slice(1), {
    env: { ...process.env, CODEX_HOME: codexHome },
    cwd: codexHome,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  let nextId = 0
  let closed = false
  let closing = false
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const lines = createInterface({ input: child.stdout })
  function fail(error: Error) {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  // Do not forward app-server stderr or raw responses: they can contain private session data.
  child.on('error', () =>
    fail(new Error('Could not start Codex. Check the Codex CLI installation.')),
  )
  child.on('exit', () => fail(new Error('Codex app-server exited before the operation completed.')))
  child.stdin.on('error', () => fail(new Error('Codex app-server connection closed.')))
  lines.on('line', (line) => {
    let message: { id?: number; method?: string; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method && message.id !== undefined) {
      // A fork/read must never approve a tool execution or perform an authentication handoff.
      child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } })}\n`,
      )
      return
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? 'Codex request failed.'))
    else entry.resolve(message.result)
  })
  const rpc: CodexRpc = {
    call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (closed) return Promise.reject(new Error('Codex app-server connection is closed.'))
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          void rpc.close()
        }, options.timeoutMs ?? 30_000)
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    async close() {
      if (!closing) {
        closing = true
        fail(new Error('Codex operation stopped or timed out. Refresh before retrying.'))
        lines.close()
        child.stdin.end()
        child.kill()
      }
      await exited
    },
  }
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'agenthydra', title: 'Agent Hydra', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return rpc
  } catch (error) {
    await rpc.close()
    throw error
  }
}
