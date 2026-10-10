import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveCodexExe } from '../config'

// ONE APP-SERVER PER CODEX HOME AT A TIME. A Codex login is <codexHome>/auth.json, and its refresh
// token ROTATES: each refresh spends the old token and saves a new one. Two app-servers on one home
// (the usage refresh and a chat move, say) can both refresh with the same token, and the loser's
// write leaves a token the server has already retired: the account is signed out until someone signs
// in again. So the connections this daemon opens on one home take turns, each holding it from spawn
// until its process has closed. A Codex Desktop or CLI the person runs on that home is not ours to
// queue (codex-logout.ts names the same gap). Idea from stablyai/orca's
// src/main/codex-cli/codex-home-process-lock.ts (MIT).
const homeTurns = new Map<string, Promise<void>>()

function homeKey(codexHome: string): string {
  const full = resolve(codexHome)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** Waits for this home's earlier connections to close; answers the release for this one (idempotent). */
async function takeHomeTurn(codexHome: string): Promise<() => void> {
  const key = homeKey(codexHome)
  const before = homeTurns.get(key) ?? Promise.resolve()
  const { promise: mine, resolve: release } = Promise.withResolvers<void>()
  const tail = before.then(() => mine)
  homeTurns.set(key, tail)
  await before
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    if (homeTurns.get(key) === tail) homeTurns.delete(key)
  }
}

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
  const releaseHome = await takeHomeTurn(codexHome)
  const child = (() => {
    try {
      return spawn(command[0]!, command.slice(1), {
        env: { ...process.env, CODEX_HOME: codexHome },
        cwd: codexHome,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      releaseHome()
      throw error
    }
  })()
  // The home stays held while the process is alive, and is released only once it has closed, not when close() is called: a refresh it started
  // can still be writing auth.json while it shuts down.
  child.once('close', releaseHome)
  child.once('error', releaseHome)
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
