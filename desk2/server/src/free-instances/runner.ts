import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FreeConfig, FreeHarnessCommand, FreeRequest } from '@shared/free-instances'
import { terminate } from './runtime'

export interface RunOutput { code: number; stdout: string }
export type FreeRunRequest = Omit<FreeRequest, 'command'> & { command: FreeHarnessCommand }
export type FreeRunner = (config: FreeConfig, request: FreeRunRequest, signal: AbortSignal) => Promise<RunOutput>

/** No shell, credentials in argv, browser fallback, or automatic message retries. */
export function commandArgs(config: FreeConfig, request: FreeRunRequest): string[] {
  const args = [join(config.harnessDir, 'desk_entry.py'), request.command]
  // The harness refuses --json with forget, and forget prints a sentence: its exit code is the result.
  if (request.command === 'forget') return [...args, '--provider', request.provider, '--request-timeout', '120']
  // Sign-in: desk_entry prints the JSON itself, and the harness refuses --json and --brief with login.
  if (request.command === 'login') return [...args, '--provider', request.provider, '--no-desktop', '--timeout', '900']
  if (request.chatId) args.push(request.chatId)
  args.push('--provider', request.provider, '--transport', 'http', '--json', '--brief', '--request-timeout', '120')
  if (request.command === 'chat' || request.command === 'resume') args.push('--stdin')
  // Registry aliases are restricted; Desk keeps the friendly display name separately.
  if (request.name) args.push('--name', `desk-${createHash('sha256').update(request.name).digest('hex').slice(0, 24)}`)
  if (request.webSearch) args.push('--web-search')
  return args
}

export const runFree: FreeRunner = (config, request, signal) => new Promise((resolve, reject) => {
  const child = spawn(config.python, commandArgs(config, request), {
    cwd: config.harnessDir,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', CLAUDFREE_STATE_DIR: config.stateDir, CLAUDFREE_CACHE_DIR: config.cacheDir },
  })
  const chunks: Buffer[] = []
  let bytes = 0
  let failed = false
  const stop = () => { if (failed) return; failed = true; terminate(child); reject(new Error('stopped')) }
  const timer = setTimeout(stop, request.command === 'login' ? 960_000 : 300_000)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) stop()
    else chunks.push(chunk)
  })
  child.on('error', () => { failed = true; reject(new Error('launch_failed')) })
  child.on('close', code => {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    if (!failed) resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') })
  })
  child.stdin.on('error', () => { /* A process may exit before consuming its input. */ })
  child.stdin.end(request.prompt ?? '')
})
