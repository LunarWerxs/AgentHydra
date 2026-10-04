// server/src/core/spawn-worker.ts - a captured child process, spawned and drained on a worker thread.
//
// ⛔ WHY (2026-10-04). Bun.spawn holds the calling thread while the OS creates the process: on this
// Windows PC a CPU profile and a 5 ms loop-lag probe both showed 100-280 ms per call (Defender scans
// the image, CreateProcess is slow under load). The daemon serves every route on one thread, so each
// scan (process list, netstat, secret-store, git) froze /api/health and /api/queue for that long.
// Here the worker pays that cost; the daemon thread posts a message and awaits a promise.
//
// Built from source through a blob URL, like sqlite-worker.ts, so the compiled exe carries it with no
// second build entrypoint. The worker does the WHOLE capture (spawn, drain both streams, deadline,
// kill the tree on timeout) with the same contract as spawnCaptured in process.ts. Where no worker
// can be started the caller runs the capture inline: slower for its thread, never a missing answer.

export interface WorkerCapture {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const WORKER_SOURCE = `
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {}
}
async function capture(cmd, opts) {
  let proc
  try {
    proc = Bun.spawn(cmd, {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    })
  } catch {
    return { code: null, stdout: '', stderr: '', timedOut: false }
  }
  const held = { stdout: '', stderr: '' }
  const drain = async (stream, into) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        held[into] += decoder.decode(value, { stream: true })
      }
      held[into] += decoder.decode()
    } catch {}
  }
  let timer
  let timedOut = false
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; if (proc.pid) killTree(proc.pid); resolve('timeout') }, opts.timeoutMs)
  })
  const work = Promise.all([drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr')])
    .then(() => proc.exited).then((code) => ({ code }))
  const out = (code) => ({ code, stdout: held.stdout, stderr: opts.wantStderr ? held.stderr : '', timedOut })
  try {
    const settled = await Promise.race([work, deadline])
    if (settled === 'timeout') {
      await Promise.race([work, new Promise((r) => setTimeout(() => r(null), 2000))])
      return out(proc.exitCode)
    }
    return out(settled.code)
  } catch {
    return out(null)
  } finally {
    clearTimeout(timer)
    if (proc.exitCode === null && !proc.killed && proc.pid) killTree(proc.pid)
  }
}
self.onmessage = async (e) => {
  const { id, cmd, opts } = e.data
  self.postMessage({ id, result: await capture(cmd, opts) })
}
`

interface Pending {
  resolve: (r: WorkerCapture) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
const pending = new Map<number, Pending>()
let nextId = 0

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })))
  // Never what keeps the process alive: a test run or one-shot CLI must be free to exit.
  w.unref()
  w.onmessage = (e: MessageEvent<{ id: number; result: WorkerCapture }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    p.resolve(e.data.result)
  }
  w.onerror = (e) => {
    // A dead worker fails what it held and is replaced on the next call.
    worker = null
    failAll(new Error(`spawn worker failed: ${e.message}`))
    w.terminate()
  }
  worker = w
  return w
}

/** Run `cmd` on the worker thread. Rejects when the worker cannot be used (not started, or died
 *  mid-run); the caller then runs the capture inline. A child's own failure is data, not a rejection. */
export function captureInWorker(
  cmd: string[],
  opts: {
    timeoutMs: number
    cwd?: string
    env?: Record<string, string | undefined>
    wantStderr: boolean
  },
): Promise<WorkerCapture> {
  let w: Worker
  try {
    w = ensureWorker()
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  const id = ++nextId
  return new Promise<WorkerCapture>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      w.postMessage({ id, cmd, opts })
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
