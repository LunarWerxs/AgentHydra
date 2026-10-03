// server/tests/climayte-origin.test.ts — who dispatched a CliMayte worker, and the ping that goes back.
//
// Owner, 2026-10-03: "when a chat finishes, it pings the orchestrator that started it", and a worker
// that is five-hour or weekly limited and moved is reported to that chat too. That needs the
// dispatching chat recorded on every worker (its `origin`), taken only from the caller the MCP
// route itself resolved, never from what a client wrote into its arguments, and an outbox the
// daemon starts with CliMayte (climayte-ping.ts).
//
// The MCP tools run here against the REAL /api/corch routes: fetch is pointed at the shared Hono
// app, so a tool's POST lands in climayte.ts exactly as it would in the daemon. The caller's
// transcript lookup and every transport (peer pipe, composer, toast) are injected: nothing here
// resolves a real process, messages a real chat or launches a CLI (no account is signed in, so
// every worker waits).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  climayteCancel,
  climayteGet,
  climaytePing,
  climayteRun,
  setCliMayteAccountsProvider,
  setCliMaytePingDeps,
  startCliMayte,
  stopCliMaytePing,
} from '../src/climayte'
import { notify, ROOT, workers } from '../src/climayte-core'
import type { CliMayteAttempt } from '../src/climayte-lib'
import { resolveOwnTranscript } from '../src/compaction-history'
import { app } from '../src/http-app'
import { POINTER_DIR } from '../src/instance'
import { TOOLS, toolsForCaller } from '../src/mcp'
import { CALLER_AWARE_TOOLS, setCallerTranscriptResolver } from '../src/mcp-self'
import '../src/routes/climayte'

// The shared `app` in http-app.ts freezes its router on its first request, after which every later
// file that loads a routes/*.ts module dies at import (queue-patch-guard.test.ts has the story).
// A fresh Hono with the routes copied in keeps the shared one open.
const http = new Hono().route('/', app)

const SID = '12345678-aaaa-4bbb-8ccc-1234567890ab'
const SPOOF = '99999999-dead-4bee-8fee-000000000000'
const scratch = mkdtempSync(join(tmpdir(), 'climayte-origin-'))
const HOME = join(scratch, 'claude-home')
const CWD = join(scratch, 'repo')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
const TRANSCRIPT = join(HOME, 'projects', 'p', `${SID}.jsonl`)
const PING_DIR = join(POINTER_DIR, 'climayte')
const KILL = join(PING_DIR, 'ping-off')

type Delivery = { sessionId: string; transcript: string | null; text: string; home: string }
const delivered: Delivery[] = []
const posted: Array<{ url: string; body: Record<string, unknown> | null }> = []
/** Who the bound caller resolves to; a function so a test can make it throw. */
let caller: () => { sessionId: string; path: string; home: string; how: string } = () => ({
  sessionId: SID,
  path: TRANSCRIPT,
  home: HOME,
  how: 'test caller',
})
const realFetch = globalThis.fetch

beforeAll(() => {
  setCliMayteAccountsProvider(() => [])
  setCliMaytePingDeps({
    deliverPeer: async (sessionId, transcript, text, _ms, home) => {
      delivered.push({ sessionId, transcript, text, home })
      return { ok: true, reason: 'delivered' }
    },
    composer: undefined,
    toast: async () => undefined,
    journal: () => undefined,
  })
  setCallerTranscriptResolver(async () => caller())
  // @ts-expect-error a narrower signature than the real fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    if (init?.method === 'POST')
      posted.push({ url: u.pathname, body: init.body ? JSON.parse(String(init.body)) : null })
    return http.fetch(new Request(`http://127.0.0.1${u.pathname}${u.search}`, init))
  }
})

afterAll(() => {
  // Every group here is 'og-*'. Its workers wait for an account that never comes; left queued in
  // the shared store, they would take the accounts a later suite in this process hands out.
  const groups = new Set(
    [...workers.values()].map((w) => w.group).filter((g) => g?.startsWith('og-')),
  )
  for (const group of groups) climayteCancel({ group })
  globalThis.fetch = realFetch
  setCallerTranscriptResolver(null)
  setCliMaytePingDeps(null)
  stopCliMaytePing()
  setCliMayteAccountsProvider(null)
  rmSync(KILL, { force: true })
  rmSync(scratch, { recursive: true, force: true })
})

/** A tool bound to a caller, the way the HTTP MCP route binds it. */
function bound(name: string) {
  const t = toolsForCaller(async () => 4242).find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

const task = (title: string) => ({ prompt: `do ${title}`, cwd: CWD, title, size: 'whole' })
const lastPost = (path: string) => posted.filter((p) => p.url === path).at(-1)?.body ?? null

describe('climayte_run records the calling chat as the origin', () => {
  test('the three CliMayte dispatch/status tools are caller-aware', () => {
    for (const n of ['climayte_run', 'climayte_manage', 'climayte_status'])
      expect(CALLER_AWARE_TOOLS.has(n)).toBe(true)
    // ...and rebound, so they receive the route's caller binding.
    const rebound = toolsForCaller(async () => 1)
      .filter((t, i) => t !== TOOLS[i])
      .map((t) => t.name)
    expect(rebound).toEqual(expect.arrayContaining(['climayte_run', 'climayte_status']))
  })

  test('origin is the resolved caller, and the answer says ping: on', async () => {
    const r = (await bound('climayte_run').run({
      tasks: [task('origin a')],
      group: 'og-run',
    })) as { ping: string; workers: Array<{ id: string }> }
    expect(lastPost('/api/corch/workers')?.origin).toEqual({
      kind: 'chat',
      sessionId: SID,
      home: HOME,
      transcript: TRANSCRIPT,
      how: 'test caller',
    })
    expect(r.ping).toBe('on: 12345678 is messaged when work settles (test caller)')
    const w = climayteGet(r.workers[0].id) as { origin?: { sessionId: string } }
    expect(w.origin?.sessionId).toBe(SID)
  })

  test('an origin the client wrote into its own arguments is ignored', async () => {
    const spoof = { kind: 'chat', sessionId: SPOOF, home: HOME, transcript: null, how: 'me' }
    await bound('climayte_run').run({ tasks: [task('origin b')], group: 'og-spoof', origin: spoof })
    expect(
      (lastPost('/api/corch/workers')?.origin as { sessionId?: string } | undefined)?.sessionId,
    ).toBe(SID)

    // An unresolvable caller sends no origin at all, the spoof included.
    caller = () => {
      throw new Error('no live session in the calling chain')
    }
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('origin c')],
        group: 'og-spoof2',
        origin: spoof,
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(lastPost('/api/corch/workers')?.origin).toBeUndefined()
      expect(r.ping).toBe(
        'off: no live session in the calling chain; run python ~/.claude/tools/climayte_wait.py --group og-spoof2',
      )
      expect((climayteGet(r.workers[0].id) as { origin?: unknown }).origin).toBeUndefined()
    } finally {
      caller = () => ({ sessionId: SID, path: TRANSCRIPT, home: HOME, how: 'test caller' })
    }
  })

  test('notify: false opts out', async () => {
    const r = (await bound('climayte_run').run({
      tasks: [task('origin d')],
      group: 'og-quiet',
      notify: false,
    })) as { ping: string }
    expect(lastPost('/api/corch/workers')?.origin).toBeUndefined()
    expect(r.ping).toStartWith('off: notify: false')
  })

  test('the route refuses a malformed origin rather than storing it', async () => {
    const res = await http.fetch(
      new Request('http://127.0.0.1/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [task('origin e')],
          group: 'og-bad',
          origin: { kind: 'chat', sessionId: 'not-a-uuid', home: 'relative', transcript: null },
        }),
      }),
    )
    const r = (await res.json()) as { workers: Array<{ id: string }>; ping: { on: boolean } }
    expect(r.ping.on).toBe(false)
    expect((climayteGet(r.workers[0].id) as { origin?: unknown }).origin).toBeUndefined()
  })

  test('the origin is saved with the worker', async () => {
    const r = climayteRun({
      tasks: [task('origin f')],
      group: 'og-store',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    })
    const id = r.workers[0].id
    const stored = JSON.parse(readFileSync(join(ROOT, 'workers.json'), 'utf8')) as {
      workers: Array<{ id: string; origin?: { sessionId: string } }>
    }
    expect(stored.workers.find((w) => w.id === id)?.origin?.sessionId).toBe(SID)
  })
})

describe('a task a worker dispatches reports to that worker', () => {
  test('a caller that is a CliMayte worker becomes a worker origin; a wave task gets none', async () => {
    const mgr = climayteRun({
      tasks: [task('manager')],
      group: 'og-mgr',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    }).workers[0]
    const mgrSession = workers.get(mgr.id)?.sessionId as string
    caller = () => ({ sessionId: mgrSession, path: TRANSCRIPT, home: HOME, how: 'worker caller' })
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('sub task')],
        group: 'og-sub',
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(workers.get(r.workers[0].id)?.origin).toEqual({ kind: 'worker', workerId: mgr.id })
      expect(r.ping).toBe(`on: manager ${mgr.id} is sent a message when work settles`)
    } finally {
      caller = () => ({ sessionId: SID, path: TRANSCRIPT, home: HOME, how: 'test caller' })
    }
    const wave = climayteRun({
      tasks: [task('wave task')],
      group: 'og-wave',
      wave: 'wv-test',
      origin: { kind: 'chat', sessionId: mgrSession, home: HOME, transcript: null, how: 'x' },
    })
    expect(workers.get(wave.workers[0].id)?.origin).toBeUndefined()
  })
})

describe('climayte_status {group, ping: true} adopts a running group', () => {
  test('sets the caller as origin on live workers that have none, and only those', async () => {
    const r = climayteRun({ tasks: [task('adopt a'), task('adopt b')], group: 'og-adopt' })
    const [a, b] = r.workers.map((w) => w.id)
    const other = { kind: 'worker' as const, workerId: 'w-someone' }
    const wb = workers.get(b)
    if (wb) wb.origin = other
    const res = (await bound('climayte_status').run({ group: 'og-adopt', ping: true })) as {
      ping: string
      adopted: number
    }
    expect(res.adopted).toBe(1)
    expect(res.ping).toStartWith('on: 12345678')
    expect(workers.get(a)?.origin).toMatchObject({ kind: 'chat', sessionId: SID })
    expect(workers.get(b)?.origin).toEqual(other)
  })
})

describe('startCliMayte runs the ping outbox', () => {
  test('a finished worker, limited and moved on the way, is one delivery to its chat', async () => {
    startCliMayte()
    expect(climaytePing()).not.toBeNull()
    const id = climayteRun({
      tasks: [task('ping me')],
      group: 'og-ping',
      origin: { kind: 'chat', sessionId: SID, home: HOME, transcript: TRANSCRIPT, how: 'x' },
    }).workers[0].id
    const w = workers.get(id)
    if (!w) throw new Error('worker missing')
    const t = Date.now()
    const attempt = (num: number, outcome: string, notice: string | null) =>
      ({
        account: { id: `acct-${num}`, num },
        startedAt: t - 60_000,
        endedAt: t - 30_000,
        outcome,
        notice,
      }) as unknown as CliMayteAttempt
    w.attempts = [attempt(94, 'quota', "You've hit your session limit"), attempt(102, 'done', null)]
    w.attempts[1].startedAt = t - 25_000
    w.status = 'done'
    w.accountId = 'acct-102'
    notify(w)
    const before = delivered.length
    await climaytePing()?.flushNow()
    const mine = delivered.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ sessionId: SID, transcript: TRANSCRIPT, home: HOME })
    expect(mine[0].text).toContain('#94 hit its 5-hour limit; resumed on #102')
    expect(mine[0].text).toContain('needs your verdict')
    await climaytePing()?.flushNow()
    expect(delivered.length).toBe(before + 1)
  })

  test('the kill switch: nothing is sent, and climayte_run says ping: off', async () => {
    mkdirSync(PING_DIR, { recursive: true })
    writeFileSync(KILL, '')
    try {
      const r = (await bound('climayte_run').run({
        tasks: [task('silenced')],
        group: 'og-off',
      })) as { ping: string; workers: Array<{ id: string }> }
      expect(r.ping).toStartWith('off: ')
      expect(r.ping).toContain('ping-off')
      const w = workers.get(r.workers[0].id)
      if (!w) throw new Error('worker missing')
      w.status = 'done'
      notify(w)
      const before = delivered.length
      await climaytePing()?.flushNow()
      expect(delivered.length).toBe(before)
    } finally {
      rmSync(KILL, { force: true })
    }
    expect(existsSync(KILL)).toBe(false)
  })
})

describe('resolveOwnTranscript names the Claude home it matched', () => {
  test('home is the registry dir the transcript was found under', async () => {
    mkdirSync(join(HOME, 'projects', 'p'), { recursive: true })
    writeFileSync(TRANSCRIPT, '')
    const t = await resolveOwnTranscript({
      sessionId: SID,
      callerPid: null,
      extraHomes: async () => [HOME],
    })
    expect(t.home).toBe(HOME)
    expect(t.path).toBe(TRANSCRIPT)
  })
})
