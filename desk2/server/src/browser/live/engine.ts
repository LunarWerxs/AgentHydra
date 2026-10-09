// One long-lived hidden PowerShell process runs browser-live.ps1. Each request is one JSON line on its stdin and is
// answered by one JSON line on its stdout with the same id. Calls run one at a time.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveHome } from './tags'

export type EngineAnswer = Record<string, unknown> & { ok?: boolean }

export const BROWSER_LIVE_IDLE_MS = 10 * 60_000
export const BROWSER_LIVE_OWNER = process.env.CONNECTIONS_BROWSER_LIVE_OWNER || randomUUID()

interface Engine {
  child: ChildProcess
  stderr: string
  out: string
  waiting: { id: string; done: (answer: EngineAnswer) => void } | null
  idle: ReturnType<typeof setTimeout> | null
}

let engine: Engine | null = null
let starts = 0
let queue: Promise<unknown> = Promise.resolve()
let exitHooked = false
let enginePathCache: string | null = null

export function browserLiveStatePath(): string {
  return process.env.CONNECTIONS_BROWSER_LIVE_STATE || join(liveHome(), 'browser-live', 'state.json')
}

export function browserLiveEnginePath(): string {
  if (enginePathCache) return enginePathCache
  const source = fileURLToPath(new URL('./browser-live.ps1', import.meta.url))
  const bytes = readFileSync(source)
  const dir = join(liveHome(), 'browser-live')
  const path = join(dir, `browser-live-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.ps1`)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) copyFileSync(source, path)
  enginePathCache = path
  return path
}

export function browserLiveEngineStats(): { starts: number; pid: number | null; alive: boolean } {
  const pid = engine?.child.pid ?? null
  return { starts, pid, alive: engine !== null }
}

function failWaiting(e: Engine, detail: string): void {
  if (engine === e) engine = null
  if (e.idle) clearTimeout(e.idle)
  const w = e.waiting
  e.waiting = null
  w?.done({ ok: false, error: 'browser_live_engine_failed', detail, hint: 'Retry: the next call starts a fresh engine.' })
}

function startEngine(): Engine {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', browserLiveEnginePath()], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  starts++
  const e: Engine = { child, stderr: '', out: '', waiting: null, idle: null }
  child.stdin?.on('error', () => {})
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    e.out += chunk
    let nl = e.out.indexOf('\n')
    while (nl >= 0) {
      const line = e.out.slice(0, nl).trim()
      e.out = e.out.slice(nl + 1)
      nl = e.out.indexOf('\n')
      if (!line) continue
      let answer: EngineAnswer
      try {
        answer = JSON.parse(line)
      } catch {
        continue
      }
      if (e.waiting && answer.id === e.waiting.id) {
        const w = e.waiting
        e.waiting = null
        w.done(answer)
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    e.stderr = (e.stderr + chunk).slice(-4000)
  })
  child.on('error', (err) => failWaiting(e, err.message))
  child.once('exit', (code) => failWaiting(e, e.stderr.trim() || `The engine exited with code ${code}.`))
  child.unref()
  if (!exitHooked) {
    exitHooked = true
    process.once('exit', () => engine?.child.kill())
  }
  engine = e
  return e
}

function stopIdle(e: Engine): void {
  if (engine === e) engine = null
  e.child.kill()
}

function callEngine(request: Record<string, unknown>, owner: string): Promise<EngineAnswer> {
  const e = engine ?? startEngine()
  if (e.idle) {
    clearTimeout(e.idle)
    e.idle = null
  }
  const id = randomUUID()
  const steps = Array.isArray(request.steps) ? (request.steps as Record<string, unknown>[]) : []
  const stepMs = steps.reduce((n, s) => n + (Number(s.timeoutMs) || 0) + 5000, 0)
  const limitMs = Math.min((Number(request.timeoutMs) || 0) + stepMs + 30_000, 150_000)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (e.waiting?.id !== id) return
      e.waiting = null
      resolve({
        ok: false,
        error: 'browser_live_timeout',
        detail: `The engine did not answer within ${Math.round(limitMs / 1000)} s.`,
        hint: 'Retry: the next call starts a fresh engine.',
      })
      stopIdle(e)
    }, limitMs)
    e.waiting = {
      id,
      done: (answer) => {
        clearTimeout(timer)
        resolve(answer)
        if (engine === e && !e.waiting) {
          e.idle = setTimeout(() => stopIdle(e), BROWSER_LIVE_IDLE_MS)
          e.idle.unref()
        }
      },
    }
    e.child.stdin?.write(JSON.stringify({ ...request, id, stateFile: browserLiveStatePath(), owner }) + '\n')
  })
}

export function runBrowserLiveEngine(request: Record<string, unknown>, owner = BROWSER_LIVE_OWNER): Promise<EngineAnswer> {
  const run = queue.then(() => callEngine(request, owner))
  queue = run.catch(() => undefined)
  return run
}
