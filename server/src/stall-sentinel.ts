// server/src/stall-sentinel.ts - notice when the daemon's one thread stops answering, and write
// down WHAT it was doing while there is still a process to write it.
//
// ⛔ WHY (2026-09-27). The tray watchdog (AgentHydra-Tray.exe, misc/AgentHydra-Tray.json) probes
// GET /api/health every 5 s with a 400 ms budget and, after three misses in a row, reaps the
// daemon with `taskkill /T /F`. That kill is untrappable: exit code 1, no uncaughtException, no
// 'exit' listener, so crash-record.ts's two lines never reach daemon.log. move_chats died that way
// eight times in nine minutes, and daemon.log held nothing but the respawn banners - the cause
// (a 1.3 s synchronous chat-store scan the migrate_batch child polled in a loop, see
// core/chat-store-scan.ts recordCache) had to be found by profiling a second daemon.
//
// Two detectors, because a starved loop looks two different ways:
//   * UNRESPONSIVE - one long block. The main thread cannot report its own freeze, so a Worker
//     watches a heartbeat the main thread stamps into shared memory, and when it goes stale the
//     worker appends to daemon.log itself, naming the requests in flight. Its lines are what a
//     watchdog kill leaves behind.
//   * SATURATED - many short blocks back to back (today's shape: each scan 1.3 s, the heartbeat
//     squeezing in between, never one gap long enough to look frozen, yet three probes in a row
//     unanswered). The main thread sums its own heartbeat lateness over a window and says which
//     requests the late time followed.
//
// Nothing here can stop a kill; it makes the next one explain itself.
//
// ⛔ AND NAMES THE FUNCTIONS (2026-10-04). On a loaded box the daemon was reaped every few minutes
// with every SATURATED line blaming "(no request: timers/background work)": true, and no help. The
// first time the loop is late by PROFILE_FROM_MS in a window, JSC's sampling profiler starts (Bun
// has no stop; at Windows' timer tick it takes ~120 samples a second, drained every PROFILE_BUCKET_MS
// into counts), and every SATURATED line then says which functions the samples were in.

import * as jsc from 'bun:jsc'
import type { MiddlewareHandler } from 'hono'

const BEAT_MS = 250
/** Worker: gaps at which an unresponsive main thread is reported, then every REPEAT_MS. */
const UNRESPONSIVE_STEPS_MS = [2_000, 5_000, 9_000, 15_000, 30_000, 60_000]
const REPEAT_MS = 60_000
/** Main: report when the loop spent at least this much of the last WINDOW_MS blocked. */
const WINDOW_MS = 10_000
const SATURATED_MS = 5_000
const SATURATED_QUIET_MS = 30_000
/** Heartbeat lateness below this is scheduling noise, not a block. */
const LATE_FLOOR_MS = 50

/** Start sampling once a window holds this much lateness: a healthy daemon never pays for it. */
const PROFILE_FROM_MS = 1_000
/** Samples are drained into counts this often and kept for WINDOW_MS. */
const PROFILE_BUCKET_MS = 2_000
const PROFILE_TOP = 5
/**
 * One beat this late is one block, named on its own line with its samples. A lone 2-3 s freeze never
 * fills SATURATED_MS, so after the 2026-10-07 fixes the stalls left were all "in flight: none" and no
 * profile: nine in 47 minutes that said nothing about what held the loop.
 */
const LONG_BLOCK_MS = 2_000

/** What the tray does to a daemon that stops answering, stated where a reader of the log needs it. */
const WATCHDOG_NOTE =
  'the tray watchdog tree-kills (taskkill /T /F: exit code 1, no exit record) a daemon that misses 3 /api/health probes 5s apart - a respawn banner right after this line is that kill'

/** One request line for the log: method and path, ids collapsed, the query kept but bounded. */
function requestKey(method: string, url: string): string {
  let path = url
  try {
    const u = new URL(url, 'http://x')
    path = u.pathname + u.search
  } catch {
    // not a URL: log what we were given
  }
  const collapsed = path.replace(
    /\/[0-9a-f]{8}-[0-9a-f-]{27,}|\/local_[\w-]{8,}|\/\d{3,}/gi,
    '/:id',
  )
  return `${method} ${collapsed.length > 100 ? `${collapsed.slice(0, 100)}...` : collapsed}`
}

/** The worker, as source: a blob URL needs no build entrypoint, so the compiled exe carries it. */
const WORKER_SOURCE = `
const { appendFileSync } = require('node:fs')
let beat = null, logPath = null, pid = 0, steps = [], repeat = 60000, note = ''
const inflight = new Map()
let reported = 0, stallStart = 0
function line(text) {
  if (!logPath) return
  try { appendFileSync(logPath, '[' + new Date().toISOString() + '] ERROR [agenthydra] ' + text + '\\n') } catch {}
}
function inflightText(now) {
  const rows = [...inflight.values()].sort((a, b) => a.at - b.at)
  if (!rows.length) return 'none (timers/background work)'
  return rows.slice(0, 6).map((r) => r.what + ' (' + ((now - r.at) / 1000).toFixed(1) + 's)').join(', ')
}
function check() {
  const now = Date.now()
  const gap = now - Number(Atomics.load(beat, 0))
  const due = reported < steps.length ? steps[reported] : steps[steps.length - 1] + repeat * (reported - steps.length + 1)
  if (gap >= due) {
    if (!reported) stallStart = now - gap
    reported++
    line('STALL main thread unresponsive for ' + (gap / 1000).toFixed(1) + 's pid=' + pid +
      ' in flight: ' + inflightText(now) + (gap >= 9000 ? ' | ' + note : ''))
  } else if (reported && gap < 1000) {
    line('STALL over: main thread answered again after ' + ((now - stallStart) / 1000).toFixed(1) + 's pid=' + pid)
    reported = 0
  }
}
self.onmessage = (e) => {
  const m = e.data
  if (m.t === 'init') {
    beat = m.beat; logPath = m.logPath; pid = m.pid; steps = m.steps; repeat = m.repeat; note = m.note
    setInterval(check, 250)
  } else if (m.t === 'begin') inflight.set(m.id, { what: m.what, at: m.at })
  else if (m.t === 'end') inflight.delete(m.id)
}
`

interface Late {
  at: number
  lateMs: number
  blame: string[]
}

/** One stack sample as bun:jsc's samplingProfilerStackTraces() gives it, innermost frame first. */
export interface SampledFrame {
  name?: string
  sourceURL?: string
  line?: number
}
export interface SampledTrace {
  frames?: SampledFrame[]
}
type Sampler = {
  startSamplingProfiler(): void
  samplingProfilerStackTraces(): { traces?: SampledTrace[] }
}

/** Sample counts: the frame on top, and the innermost and outermost frames in the daemon's own source. */
export interface SampleCounts {
  n: number
  top: Map<string, number>
  inner: Map<string, number>
  outer: Map<string, number>
}

const OWN_SOURCE = /[\\/]server[\\/]src[\\/](.+)$/

function frameKey(f: SampledFrame): string {
  const own = f.sourceURL ? OWN_SOURCE.exec(f.sourceURL) : null
  const file = own ? (own[1] as string).replace(/\\/g, '/') : f.sourceURL?.split(/[\\/]/).pop()
  return `${f.name || '(anonymous)'}${file ? ` ${file}:${f.line}` : ''}`
}

function bump(m: Map<string, number>, k: string, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by)
}

/** Count samples into `into` (new counts when omitted). This file's own frames are never blamed. */
export function countSamples(traces: SampledTrace[], into?: SampleCounts): SampleCounts {
  const c = into ?? { n: 0, top: new Map(), inner: new Map(), outer: new Map() }
  for (const t of traces) {
    const frames = t.frames ?? []
    const first = frames[0]
    if (!first) continue
    c.n++
    bump(c.top, frameKey(first))
    const own = frames.filter(
      (f) => f.sourceURL && OWN_SOURCE.test(f.sourceURL) && !/stall-sentinel/.test(f.sourceURL),
    )
    const inner = own[0]
    const outer = own[own.length - 1]
    if (inner) bump(c.inner, frameKey(inner))
    if (outer) bump(c.outer, frameKey(outer))
  }
  return c
}

/** "N samples; on top: f a.ts:12 40%, ...; innermost daemon frame: ...; outermost: ..." or '' with none. */
export function profileText(c: SampleCounts): string {
  if (!c.n) return ''
  const list = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROFILE_TOP)
      .map(([k, v]) => `${k} ${Math.round((100 * v) / c.n)}%`)
      .join(', ') || 'none'
  return `${c.n} samples; on top: ${list(c.top)}; innermost daemon frame: ${list(c.inner)}; outermost daemon frame: ${list(c.outer)}`
}

function mergeCounts(from: SampleCounts, into: SampleCounts): void {
  into.n += from.n
  for (const k of ['top', 'inner', 'outer'] as const)
    for (const [f, v] of from[k]) bump(into[k], f, v)
}

const timers = new Set<ReturnType<typeof setInterval>>()

/** Stop the main-thread heartbeat timers (daemon shutdown). */
export function stopStallSentinel(): void {
  for (const t of timers) clearInterval(t)
  timers.clear()
}

/**
 * Start both detectors. Returns the middleware that feeds them what is in flight; register it
 * before every route. `logPath` null (file logging failed to open) still runs the main-thread
 * detector, which logs through console like everything else; the worker has nowhere to write.
 */
export function startStallSentinel(logPath: string | null): MiddlewareHandler {
  const beat = new BigInt64Array(new SharedArrayBuffer(8))
  Atomics.store(beat, 0, BigInt(Date.now()))
  let worker: Worker | null = null
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })))
    worker.unref()
    worker.postMessage({
      t: 'init',
      beat,
      logPath,
      pid: process.pid,
      steps: UNRESPONSIVE_STEPS_MS,
      repeat: REPEAT_MS,
      note: WATCHDOG_NOTE,
    })
  } catch (err) {
    worker = null
    console.warn('[agenthydra] stall sentinel: no worker, freezes will go unrecorded:', err)
  }

  // Requests begun since the last beat: a synchronous handler starts and finishes inside the gap
  // it causes, so these are what the next late beat is blamed on. A long async request (a
  // migrate_batch run holds its call open for minutes) began long ago and is never blamed.
  let begunSinceBeat: string[] = []
  const window: Late[] = []
  let lastBeat = Date.now()
  let lastSaturatedLog = 0
  let lastLongBlockLog = 0
  // The sampler (PROFILE_FROM_MS): off until the loop is first late, then drained into counts every
  // PROFILE_BUCKET_MS, the last WINDOW_MS of them kept for the next SATURATED line.
  const sampler = jsc as unknown as Sampler
  let sampling = false
  let samplerMissing = false
  let lastDrain = 0
  const buckets: Array<{ at: number; counts: SampleCounts }> = []
  const drain = () => countSamples(sampler.samplingProfilerStackTraces().traces ?? [])
  // A tick that throws is a tick skipped, never a dead daemon (scripts/checks/
  // timer-callback-can-kill-the-daemon.mjs): the watcher of stalls must not become a crash.
  const timer = setInterval(() => {
    try {
      const now = Date.now()
      Atomics.store(beat, 0, BigInt(now))
      const lateMs = now - lastBeat - BEAT_MS
      lastBeat = now
      const blame = begunSinceBeat
      begunSinceBeat = []
      if (lateMs >= LATE_FLOOR_MS) window.push({ at: now, lateMs, blame })
      while (window.length && (window[0] as Late).at < now - WINDOW_MS) window.shift()
      const blocked = window.reduce((sum, w) => sum + w.lateMs, 0)
      if (!sampling && !samplerMissing && blocked >= PROFILE_FROM_MS) {
        try {
          sampler.startSamplingProfiler()
          sampling = true
          lastDrain = now
        } catch {
          samplerMissing = true // not this runtime: the blame stays per request
        }
      }
      if (sampling && lateMs >= LONG_BLOCK_MS && now - lastLongBlockLog >= SATURATED_QUIET_MS) {
        // The samples since the last drain are this block's: drained now, they also stay in the
        // window for a SATURATED line.
        lastLongBlockLog = now
        lastDrain = now
        const counts = drain()
        buckets.push({ at: now, counts })
        const profile = profileText(counts)
        console.error(
          `[agenthydra] STALL one block of ${(lateMs / 1000).toFixed(1)}s pid=${process.pid}; it followed: ${blameText([{ lateMs, blame }])}${profile ? ` | profile: ${profile}` : ''}`,
        )
      }
      if (sampling && now - lastDrain >= PROFILE_BUCKET_MS) {
        lastDrain = now
        buckets.push({ at: now, counts: drain() })
        while (buckets.length && (buckets[0] as { at: number }).at < now - WINDOW_MS)
          buckets.shift()
      }
      if (blocked < SATURATED_MS || now - lastSaturatedLog < SATURATED_QUIET_MS) return
      lastSaturatedLog = now
      let profile = ''
      if (sampling) {
        const all = drain()
        lastDrain = now
        for (const b of buckets) mergeCounts(b.counts, all)
        buckets.length = 0
        profile = profileText(all)
      }
      console.error(
        `[agenthydra] STALL event loop saturated: blocked ${(blocked / 1000).toFixed(1)}s of the last ${WINDOW_MS / 1000}s pid=${process.pid}; the late time followed: ${blameText(window)}${profile ? ` | profile: ${profile}` : ''} | ${WATCHDOG_NOTE}`,
      )
    } catch {
      // skipped: the next beat is BEAT_MS away
    }
  }, BEAT_MS)
  timer.unref()
  timers.add(timer)

  let nextId = 0
  return async (c, next) => {
    const what = requestKey(c.req.method, c.req.url)
    begunSinceBeat.push(what)
    const id = ++nextId
    worker?.postMessage({ t: 'begin', id, what, at: Date.now() })
    try {
      await next()
    } finally {
      worker?.postMessage({ t: 'end', id })
    }
  }
}

/** The requests the window's late time followed, heaviest first: "GET /x x6 (7.8s), ...". */
function blameText(window: Array<{ lateMs: number; blame: string[] }>): string {
  const byKey = new Map<string, { ms: number; n: number }>()
  for (const w of window) {
    const keys = w.blame.length ? w.blame : ['(no request: timers/background work)']
    for (const k of keys) {
      const row = byKey.get(k) ?? { ms: 0, n: 0 }
      row.ms += w.lateMs / keys.length
      row.n++
      byKey.set(k, row)
    }
  }
  return [...byKey]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 4)
    .map(([k, r]) => `${k} x${r.n} (${(r.ms / 1000).toFixed(1)}s)`)
    .join(', ')
}
