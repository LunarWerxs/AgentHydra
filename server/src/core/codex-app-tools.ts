import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { type CodexDesktopTarget, codexDesktopRunState } from './codex-desktop'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const verifiedPipes = new Map<number, string[]>()

/** One request: a 4-byte little-endian length, then the JSON-RPC body. */
function encodeFrame(method: string, params: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  const frame = Buffer.alloc(4 + payload.length)
  frame.writeUInt32LE(payload.length)
  payload.copy(frame, 4)
  return frame
}

/** The whole frames at the front of `pending`, and what is left of it. `tooLarge`: the next frame
 *  claims more than MAX_FRAME_BYTES, so nothing after it is read. */
function takeFrames(pending: Buffer): { frames: Buffer[]; rest: Buffer; tooLarge: boolean } {
  const frames: Buffer[] = []
  let rest = pending
  while (rest.length >= 4) {
    const size = rest.readUInt32LE(0)
    if (size > MAX_FRAME_BYTES) return { frames, rest, tooLarge: true }
    if (rest.length < size + 4) break
    frames.push(rest.subarray(4, size + 4))
    rest = rest.subarray(size + 4)
  }
  return { frames, rest, tooLarge: false }
}

/** What one response frame answers: null when it is for another request id. */
function readResponse<T>(payload: Buffer): { error?: Error; result?: T } | null {
  try {
    const response = JSON.parse(payload.toString('utf8'))
    if (response.id !== 1) return null
    if (response.jsonrpc !== '2.0') throw new Error('Invalid response')
    if (response.error)
      return { error: new Error(response.error.message || 'Codex app refused the request.') }
    if (!('result' in response)) throw new Error('Missing result')
    return { result: response.result }
  } catch {
    return { error: new Error('Codex app returned an invalid response.') }
  }
}

/** The same length-prefixed JSON-RPC transport used by Codex's bundled app-tools plugin. */
export function callCodexAppPipe<T>(
  pipe: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe)
    let pending: Buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, result?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result as T)
    }
    const timer = setTimeout(() => finish(new Error('Codex app tools timed out.')), timeoutMs)
    socket.once('error', () => finish(new Error('Codex app tools connection failed.')))
    socket.once('end', () => finish(new Error('Codex app tools connection closed.')))
    socket.once('close', () => finish(new Error('Codex app tools connection closed.')))
    socket.once('connect', () => socket.write(encodeFrame(method, params)))
    socket.on('data', (chunk) => {
      const taken = takeFrames(
        Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]),
      )
      pending = taken.rest
      for (const frame of taken.frames) {
        const answer = readResponse<T>(frame)
        if (answer) return finish(answer.error, answer.result)
      }
      if (taken.tooLarge) finish(new Error('Codex app response is too large.'))
    })
  })
}

/** Select pipes by their OS-reported server PID. An inherited pipe is only a discovery hint. */
export async function codexAppPipesForPid(pid: number): Promise<string[]> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Automatic Codex sidebar updates require a supported Windows desktop.')
  }
  const cached = verifiedPipes.get(pid)
  if (cached) return cached
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HydraCodexPipe {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$hydraPipeMatches = @()
$knownPipe = $env:CODEX_APP_TOOLS_PIPE_PATH
if ($knownPipe -and $knownPipe.StartsWith('\\\\.\\pipe\\codex-browser-use-')) {
  $handle = [HydraCodexPipe]::CreateFile($knownPipe,0,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
  if ($handle -ne [IntPtr](-1)) {
    try {
      $serverPid = [uint32]0
      if ([HydraCodexPipe]::GetNamedPipeServerProcessId($handle,[ref]$serverPid) -and $serverPid -eq ${pid}) {
        ConvertTo-Json -InputObject @($knownPipe) -Compress
        exit 0
      }
    } finally { [void][HydraCodexPipe]::CloseHandle($handle) }
  }
}
Get-ChildItem '\\\\.\\pipe\\' | Where-Object Name -Like 'codex-browser-use-*' | ForEach-Object {
  $pipePath = '\\\\.\\pipe\\' + $_.Name
  $handle = [HydraCodexPipe]::CreateFile($pipePath,0,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
  if ($handle -ne [IntPtr](-1)) {
    try {
      $serverPid = [uint32]0
      if ([HydraCodexPipe]::GetNamedPipeServerProcessId($handle,[ref]$serverPid) -and $serverPid -eq ${pid}) { $hydraPipeMatches += $pipePath }
    } finally { [void][HydraCodexPipe]::CloseHandle($handle) }
  }
}
ConvertTo-Json -InputObject @($hydraPipeMatches) -Compress
`
  const child = Bun.spawn(
    [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    },
  )
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exitCode !== 0) throw new Error('Could not identify the destination Codex app connection.')
    const pipes: unknown = JSON.parse(stdout)
    if (!Array.isArray(pipes) || !pipes.every((pipe) => typeof pipe === 'string'))
      throw new Error('Invalid Codex app connection inventory.')
    if (pipes.length) verifiedPipes.set(pid, pipes)
    return pipes
  } finally {
    clearTimeout(timer)
  }
}

export interface CodexAppTools {
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>
}

/** The tools a migration calls; a pipe whose catalog lacks one is not the app-tools server. */
const MIGRATION_TOOLS = [
  'list_threads',
  'navigate_to_codex_page',
  'create_sidebar_section',
  'move_thread_to_sidebar_section',
]

/** The first of `pid`'s pipes that serves every migration tool, with each tool's namespace. */
async function findAppToolsPipe(
  pid: number,
): Promise<{ pipe: string; tools: Map<string, string> } | null> {
  for (const pipe of await codexAppPipesForPid(pid)) {
    let catalog: { tools: { name: string; namespace: string }[] }
    try {
      catalog = await callCodexAppPipe(pipe, 'tools/list', { threadStartKind: 'all' })
    } catch {
      continue // Read-only discovery; no mutation has been dispatched.
    }
    const tools = new Map(catalog.tools.map((tool) => [tool.name, tool.namespace]))
    if (MIGRATION_TOOLS.every((name) => tools.has(name))) return { pipe, tools }
  }
  return null
}

function appToolsClient(
  target: CodexDesktopTarget,
  pid: number,
  pipe: string,
  tools: Map<string, string>,
  callerThreadId: string,
): CodexAppTools {
  return {
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      const namespace = tools.get(tool)
      if (!namespace) throw new Error(`This Codex desktop does not support ${tool}.`)
      // Recheck profile identity immediately before dispatch. Never retry a mutation on
      // another connection after a timeout or ambiguous reply.
      const current = await codexDesktopRunState(target)
      if (current.state !== 'running' || current.runtime.pid !== pid)
        throw new Error('The destination Codex desktop changed during migration.')
      const response = await callCodexAppPipe<{
        success: boolean
        contentItems: { type: string; text?: string }[]
      }>(pipe, 'tools/call', {
        arguments: args,
        namespace,
        tool,
        callerSource: 'codex',
        threadId: callerThreadId,
        callId: `hydra-migration-${randomUUID()}`,
        turnId: `hydra-migration-${randomUUID()}`,
      })
      const text = response.contentItems
        .filter((item) => item.type === 'inputText')
        .map((item) => item.text ?? '')
        .join('\n')
      if (!response.success) throw new Error(`Codex sidebar update refused: ${text}`)
      try {
        return JSON.parse(text) as T
      } catch {
        throw new Error('Codex app returned an unreadable sidebar result.')
      }
    },
  }
}

export async function connectCodexAppTools(
  target: CodexDesktopTarget,
  callerThreadId: string,
): Promise<CodexAppTools> {
  const state = await codexDesktopRunState(target)
  if (state.state !== 'running') throw new Error('The destination Codex desktop is not available.')
  const pid = state.runtime.pid
  // A process appears before its app-tools server finishes startup. Only discovery is retried.
  const deadline = Date.now() + 15_000
  do {
    const found = await findAppToolsPipe(pid)
    if (found) return appToolsClient(target, pid, found.pipe, found.tools, callerThreadId)
    verifiedPipes.delete(pid)
    if (Date.now() >= deadline) break
    await Bun.sleep(500)
  } while (Date.now() < deadline)
  throw new Error('The destination Codex app-tools connection could not be found.')
}
