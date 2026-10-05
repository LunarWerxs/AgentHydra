// Pings to the dispatching chat (climayte-ping.ts). Owner, 2026-10-03: "when a CliMayte worker
// finishes, stops, or is five-hour/weekly limited and moved, the orchestrator chat that started it
// is pinged, so that chat knows without polling."
//
// Every transport is injected and the clock is fake, so nothing here messages a real chat. The one
// test that drives the real peer pipe points it at a temp Claude home whose registry names a pipe
// this test serves itself.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliMayteWorker } from '../src/climayte-lib'
import {
  type CliMayteOrigin,
  type CliMaytePingDeps,
  hhmm,
  PING_HEADER,
  type PingAttempt,
  type PingKind,
  type PingWorker,
  pingEvents,
  pingMessage,
  STUCK_AFTER_MS,
  snapshotOf,
  startCliMaytePing,
} from '../src/climayte-ping'

// A CliMayteWorker is a PingWorker once the integration adds `origin`, with no edit to either type.
const _fits: PingWorker = {} as CliMayteWorker
void _fits

const dirs: string[] = []
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'climayte-ping-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const SID = '4138a08f-1111-2222-3333-444455556666'
const CHAT: CliMayteOrigin = {
  kind: 'chat',
  sessionId: SID,
  home: 'C:/fake/.claude',
  transcript: null,
  how: 'test',
}
const T0 = Date.UTC(2026, 9, 3, 16, 20, 0)

const acct = (num: number | null) => ({ id: `acct-${num ?? 'x'}`, num, name: `name-${num}` })
const attempt = (num: number | null, over: Partial<PingAttempt> = {}): PingAttempt => ({
  account: acct(num),
  startedAt: T0,
  endedAt: null,
  outcome: 'running',
  ...over,
})
const worker = (over: Partial<PingWorker> = {}): PingWorker => ({
  id: 'w-1a2b3c4d',
  group: 'aws-teardown-planes',
  title: 'Tear down sales plane',
  status: 'running',
  accountId: 'acct-35',
  attempts: [attempt(35)],
  check: null,
  checkRunner: null,
  verdicts: [],
  error: null,
  origin: CHAT,
  ...over,
})

describe('pingEvents', () => {
  const ran = worker()
  const prev = snapshotOf(ran, null, T0)
  const kinds = (w: PingWorker, p = prev, now = T0) => pingEvents(p, w, now).map((e) => e.kind)
  const cases: Array<[string, PingWorker, PingKind[]]> = [
    ['running to checking says nothing', worker({ status: 'checking' }), []],
    [
      'a check that passed is finished',
      worker({ status: 'done', check: 'bun test', verdicts: [{ verdict: 'pass', by: 'check' }] }),
      ['finished'],
    ],
    ['done with no check needs a verdict', worker({ status: 'done' }), ['needs-verdict']],
    [
      'a check that failed and was sent back',
      worker({ status: 'queued', check: 'x', verdicts: [{ verdict: 'fail', by: 'check' }] }),
      ['check-failed'],
    ],
    ['failed', worker({ status: 'failed', error: 'not converging (4 moves)' }), ['failed']],
    ['cancelled', worker({ status: 'cancelled' }), ['cancelled']],
    [
      "the chat's own verdict is not news to the chat",
      worker({ status: 'done', verdicts: [{ verdict: 'pass', by: 'orchestrator' }] }),
      ['needs-verdict'],
    ],
    [
      'a limit then a launch on another account is one limited-moved',
      worker({
        attempts: [
          attempt(94, { outcome: 'quota', endedAt: T0 }),
          attempt(102, { startedAt: T0 + 42_000 }),
        ],
      }),
      ['limited-moved'],
    ],
    [
      'a transient retry on the same account is not a move',
      worker({
        attempts: [attempt(35, { outcome: 'transient', endedAt: T0 }), attempt(35)],
      }),
      [],
    ],
    [
      'a context handoff that moves is planned, not a limit',
      worker({
        attempts: [
          attempt(35, {
            outcome: 'handoff',
            endedAt: T0,
            windDown: { pct: null, reason: 'context' },
          }),
          attempt(102),
        ],
      }),
      [],
    ],
  ]
  for (const [name, w, want] of cases) test(name, () => expect(kinds(w)).toEqual(want))

  test('the moved line names both accounts, the window and the gap', () => {
    const w = worker({
      attempts: [
        attempt(94, { outcome: 'quota', endedAt: T0, notice: 'weekly limit reached' }),
        attempt(102, { startedAt: T0 + 42_000 }),
      ],
    })
    expect(pingEvents(prev, w, T0)[0].line).toBe(
      'w-1a2b3c4d "Tear down sales plane": #94 hit its weekly limit; resumed on #102 after 42s.',
    )
    const fiveHour = worker({
      attempts: [attempt(94, { outcome: 'quota', endedAt: T0 }), attempt(102, { startedAt: T0 })],
    })
    expect(pingEvents(prev, fiveHour, T0)[0].line).toContain('#94 hit its 5-hour limit')
  })

  test('stuck: waiting past the five-minute rule, not before', () => {
    const waiting = worker({ status: 'waiting', error: 'Waiting for room on #35.' })
    const held = snapshotOf(waiting, prev, T0)
    expect(kinds(waiting, held, T0 + STUCK_AFTER_MS - 1000)).toEqual([])
    expect(kinds(waiting, held, T0 + STUCK_AFTER_MS + 1000)).toEqual(['stuck'])
  })

  test('the key is worker, kind and attempt, so a re-run reports again', () => {
    const e = pingEvents(prev, worker({ status: 'failed', error: 'boom' }), T0)[0]
    expect(e.key).toBe('w-1a2b3c4d:failed:1')
  })
})

// ---- the outbox, with a fake clock ---------------------------------------------------------

interface Sent {
  sessionId: string
  text: string
  home?: string
}

function harness(
  opts: {
    dir?: string
    workers?: PingWorker[]
    peer?: (n: number) => { ok: boolean; reason: string }
    composer?: { eligible: boolean; ok: boolean }
    send?: (id: string, text: string) => { ok: boolean; message: string }
    start?: number
  } = {},
) {
  const dir = opts.dir ?? scratch()
  let now = opts.start ?? T0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const sent: Sent[] = []
  const composerSent: string[] = []
  const toasts: string[] = []
  const workerSends: Array<[string, string]> = []
  const journal: Array<Record<string, unknown>> = []
  const ws = new Map<string, PingWorker>()
  for (const w of opts.workers ?? []) ws.set(w.id, w)
  const listeners = new Set<(w: PingWorker) => void>()
  let peerCalls = 0
  const confirms: number[] = []
  const deps: CliMaytePingDeps = {
    dir,
    workers: () => [...ws.values()],
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.push({ at: now + Math.max(0, ms), fn, id })
        return id
      },
      clearTimeout: (id) => {
        timers = timers.filter((t) => t.id !== id)
      },
    },
    deliverPeer: async (sessionId, _transcript, text, confirm, home) => {
      peerCalls++
      confirms.push(confirm)
      const r = opts.peer ? opts.peer(peerCalls) : { ok: true, reason: 'enqueued' }
      if (r.ok) sent.push({ sessionId, text, home })
      return r
    },
    composer: opts.composer
      ? {
          eligible: async () => opts.composer?.eligible ?? false,
          send: async (_sid, text) => {
            composerSent.push(text)
            return { ok: opts.composer?.ok ?? false, reason: opts.composer?.ok ? 'typed' : 'no' }
          },
        }
      : undefined,
    toast: async (n) => {
      toasts.push(`${n.title}\n${n.body}`)
    },
    climayteSend: (id, text) => {
      workerSends.push([id, text])
      return opts.send ? opts.send(id, text) : { ok: true, message: 'queued' }
    },
    journal: (line) => journal.push(line),
  }
  const ping = startCliMaytePing(deps)
  const change = (w: PingWorker) => {
    ws.set(w.id, w)
    for (const cb of listeners) cb(w)
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
      await ping.idle()
    }
    now = end
    await ping.idle()
  }
  const at = (ms: number) => advance(T0 + ms - now)
  return {
    ping,
    dir,
    change,
    advance,
    at,
    sent,
    composerSent,
    toasts,
    workerSends,
    journal,
    peerCalls: () => peerCalls,
    confirms,
  }
}

const running = (id: string, over: Partial<PingWorker> = {}) =>
  worker({ id, title: `Task ${id}`, ...over })
const doneOf = (w: PingWorker): PingWorker => ({ ...w, status: 'done' })

describe('batching', () => {
  test('three finishes 20 s apart give one flush after 90 s quiet', async () => {
    const ws = ['w-a', 'w-b', 'w-c', 'w-live'].map((id) => running(id))
    const h = harness({ workers: ws })
    h.change(doneOf(ws[0]))
    await h.at(20_000)
    h.change(doneOf(ws[1]))
    await h.at(40_000)
    h.change(doneOf(ws[2]))
    await h.at(129_000)
    expect(h.sent).toHaveLength(0)
    await h.at(130_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('Ping 1-3, 3 updates since')
    await h.at(3_600_000)
    expect(h.sent).toHaveLength(1)
    h.ping.stop()
  })

  test('a flood of 15 finishes is one ping, capped at 5 minutes from the oldest', async () => {
    const ws = Array.from({ length: 16 }, (_, i) => running(`w-${i}`))
    const h = harness({ workers: ws })
    for (let i = 0; i < 15; i++) {
      await h.at(i * 20_000)
      h.change(doneOf(ws[i]))
    }
    await h.at(299_000)
    expect(h.sent).toHaveLength(0)
    await h.at(300_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('Ping 1-15, 15 updates since')
    expect(h.sent[0].text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(15)
    await h.at(7_200_000)
    expect(h.sent).toHaveLength(1)
    h.ping.stop()
  })

  test('a move alone sends nothing before 30 minutes, then goes alone', async () => {
    const w = running('w-m', { attempts: [attempt(94)] })
    const h = harness({ workers: [w] })
    h.change({
      ...w,
      accountId: 'acct-102',
      attempts: [attempt(94, { outcome: 'quota', endedAt: T0 }), attempt(102, { startedAt: T0 })],
    })
    await h.at(30 * 60_000 - 1000)
    expect(h.sent).toHaveLength(0)
    await h.at(30 * 60_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('#94 hit its 5-hour limit; resumed on #102 after 0s')
    h.ping.stop()
  })

  test('a move rides along with the next waking flush', async () => {
    const m = running('w-m', { attempts: [attempt(94)] })
    const f = running('w-f')
    const h = harness({ workers: [m, f, running('w-live')] })
    h.change({
      ...m,
      attempts: [attempt(94, { outcome: 'quota', endedAt: T0 }), attempt(102, { startedAt: T0 })],
    })
    await h.at(60_000)
    h.change(doneOf(f))
    await h.at(150_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('Ping 1-2, 2 updates')
    await h.at(3_600_000)
    expect(h.sent).toHaveLength(1)
    h.ping.stop()
  })

  test('group-done flushes at 10 s', async () => {
    const a = running('w-a')
    const b = running('w-b', { status: 'done' })
    const h = harness({ workers: [a, b] })
    h.change(doneOf(a))
    await h.at(9_000)
    expect(h.sent).toHaveLength(0)
    await h.at(10_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('settled')
    h.ping.stop()
  })

  test('the first pass seeds and emits nothing, even for work already done', async () => {
    const h = harness({ workers: [running('w-a', { status: 'done' }), running('w-b')] })
    await h.at(3_600_000)
    expect(h.peerCalls()).toBe(0)
    h.ping.stop()
  })

  test('the kill switch file stops every ping', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'ping-off'), '')
    const a = running('w-a')
    const h = harness({ dir, workers: [a] })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(3_600_000)
    expect(h.peerCalls()).toBe(0)
    h.ping.stop()
  })
})

describe('the message', () => {
  test('exact text: header, bullets, group tally, next step', () => {
    const at = T0
    const workers = [
      worker({ id: 'w-1', title: 'Tear down sales plane', status: 'done' }),
      worker({ id: 'w-2', title: 'Drop SES identities', status: 'done' }),
      worker({ id: 'w-3', title: 'Delete stale buckets', status: 'failed' }),
      worker({ id: 'w-4', title: 'Retire box B', status: 'running' }),
      worker({ id: 'w-5', title: 'Queued one', status: 'waiting' }),
    ]
    const text = pingMessage(
      [
        { seq: 41, at, group: 'aws-teardown-planes', line: 'w-1 "Tear down sales plane": a.' },
        { seq: 42, at: at + 5000, group: 'aws-teardown-planes', line: 'w-2 b.' },
        { seq: 43, at: at + 9000, group: 'aws-teardown-planes', line: 'w-3 c.' },
      ],
      workers,
    )
    expect(text).toEqual(
      [
        `[AgentHydra · CliMayte] Not from the user. Automatic status note, nobody typed this. Ping 41-43, 3 updates since ${hhmm(at)}:`,
        '• w-1 "Tear down sales plane": a.',
        '• w-2 b.',
        '• w-3 c.',
        'Group aws-teardown-planes: 2 done, 1 failed, 1 running, 1 waiting.',
        'Next: climayte_status {group:"aws-teardown-planes", report:true}, then climayte_verdict.',
      ].join('\n'),
    )
  })

  test('the bullets each kind writes', () => {
    const base = worker({ id: 'w-9c0d1e2f', title: 'Delete stale buckets' })
    const p = snapshotOf(base, null, T0)
    const line = (w: PingWorker) => pingEvents(p, w, T0)[0].line
    expect(line({ ...base, status: 'done' })).toBe(
      'w-9c0d1e2f "Delete stale buckets": done on #35, needs your verdict.',
    )
    expect(
      line({ ...base, status: 'done', check: 'x', verdicts: [{ verdict: 'pass', by: 'check' }] }),
    ).toBe('w-9c0d1e2f "Delete stale buckets": done on #35, check passed.')
    const failed = (error: string, outcome = 'error') =>
      line({ ...base, status: 'failed', error, attempts: [attempt(35, { outcome })] })
    expect(
      failed(
        'Not converging: 4 moves between accounts in this turn, so CliMayte stopped it to ask. Split the task.',
        'quota',
      ),
    ).toBe(
      'w-9c0d1e2f "Delete stale buckets": failed: not converging (4 moves between accounts); details in climayte_status.',
    )
    expect(failed('Anthropic stayed overloaded through 3 retries: 529', 'transient')).toBe(
      'w-9c0d1e2f "Delete stale buckets": failed: Anthropic stayed overloaded through 3 retries; details in climayte_status.',
    )
    expect(line({ ...base, status: 'cancelled' })).toBe(
      'w-9c0d1e2f "Delete stale buckets": cancelled.',
    )
    expect(
      line({ ...base, status: 'queued', check: 'x', verdicts: [{ verdict: 'fail', by: 'check' }] }),
    ).toBe('w-9c0d1e2f "Delete stale buckets": check failed, sent back.')
  })

  test('more than 15 bullets end in "+N more"; titles and errors are cut', () => {
    const events = Array.from({ length: 17 }, (_, i) => ({
      seq: i + 1,
      at: T0,
      group: 'g',
      line: `w-${i} x.`,
    }))
    const lines = pingMessage(events, []).split('\n')
    expect(lines.filter((l) => l.startsWith('• '))).toHaveLength(15)
    expect(lines).toContain('+2 more')
    const long = worker({ title: 'T'.repeat(200), status: 'failed', error: 'E'.repeat(400) })
    const e = pingEvents(snapshotOf(worker(), null, T0), long, T0)[0]
    expect(e.line).toStartWith(`w-1a2b3c4d "${'T'.repeat(80)}": failed: `)
    expect(e.line).not.toContain('EEE')
  })

  test("a failed worker's error holding its own report or stderr never reaches the chat", () => {
    // climayte.ts settleWorker: a failed attempt's error is its result text, else its stderr.
    const base = worker({ id: 'w-9c0d1e2f', title: 'Delete stale buckets' })
    const p = snapshotOf(base, null, T0)
    for (const error of [
      'REPORT-BODY: I deleted 14 buckets in account 1234 and here is the table',
      'STDERR-BODY Error: ENOENT C:/Users/someone/secret.txt',
    ]) {
      const w = {
        ...base,
        status: 'failed' as const,
        error,
        attempts: [attempt(35, { outcome: 'error' })],
      }
      const bullet = pingEvents(p, w, T0)[0].line
      expect(bullet).not.toContain('BODY')
      expect(bullet).toBe(
        'w-9c0d1e2f "Delete stale buckets": failed: its CLI run ended in an error; details in climayte_status.',
      )
    }
  })

  test('carries no prompt, report, follow-up or verdict note', async () => {
    const secret = {
      prompt: 'PROMPT-BODY-sk-ant-xyz',
      result: 'REPORT-BODY',
      results: ['REPORT-BODY'],
      pending: ['FOLLOW-UP-BODY'],
      message: 'MESSAGE-LINE',
    }
    const w = running('w-s', secret as Partial<PingWorker>)
    const h = harness({ workers: [w] })
    h.change({
      ...w,
      status: 'queued',
      check: 'x',
      verdicts: [{ verdict: 'fail', by: 'check', note: 'NOTE-BODY' } as never],
    })
    h.change({ ...w, status: 'done', ...secret } as PingWorker)
    await h.at(3_600_000)
    expect(h.sent.length).toBeGreaterThan(0)
    for (const s of h.sent)
      for (const bad of ['PROMPT', 'REPORT', 'FOLLOW-UP', 'MESSAGE-LINE', 'NOTE-BODY', 'name-'])
        expect(s.text).not.toContain(bad)
    h.ping.stop()
  })
})

describe('the outbox', () => {
  test('a ping not yet sent is replayed after a restart, once, with its seq', async () => {
    const dir = scratch()
    const a = running('w-a')
    const live = running('w-live')
    const first = harness({ dir, workers: [a, live] })
    first.change({ ...a, status: 'failed', error: 'boom' })
    await first.at(30_000)
    first.ping.stop()
    expect(first.sent).toHaveLength(0)

    const second = harness({ dir, workers: [{ ...a, status: 'failed', error: 'boom' }, live] })
    await second.at(89_000)
    expect(second.sent).toHaveLength(0)
    await second.at(90_000)
    expect(second.sent).toHaveLength(1)
    expect(second.sent[0].text).toContain('Ping 1, 1 update since')
    second.ping.stop()

    const third = harness({ dir, workers: [{ ...a, status: 'failed', error: 'boom' }, live] })
    await third.at(7_200_000)
    expect(third.peerCalls()).toBe(0)
    third.ping.stop()
  })

  test('not live, then live: retried every 2 minutes and delivered once', async () => {
    const a = running('w-a')
    const h = harness({
      workers: [a],
      peer: (n) => (n < 3 ? { ok: false, reason: 'not-live' } : { ok: true, reason: 'ok' }),
    })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(10_000)
    expect(h.peerCalls()).toBe(1)
    await h.at(10_000 + 119_000)
    expect(h.peerCalls()).toBe(1)
    await h.at(10_000 + 240_000)
    expect(h.peerCalls()).toBe(3)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].home).toBe(CHAT.kind === 'chat' ? CHAT.home : '')
    expect(h.journal.filter((j) => j.event === 'ping-failed')).toHaveLength(2)
    await h.at(7_200_000)
    expect(h.peerCalls()).toBe(3)
    h.ping.stop()
  })

  test('two hours not live, a failed group: the composer, only once', async () => {
    const a = running('w-a')
    const h = harness({
      workers: [a],
      peer: () => ({ ok: false, reason: 'not-live' }),
      composer: { eligible: true, ok: true },
    })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(10_000 + 2 * 3_600_000 + 130_000)
    expect(h.composerSent).toHaveLength(1)
    expect(h.toasts).toHaveLength(0)
    const calls = h.peerCalls()
    expect(calls).toBeGreaterThanOrEqual(60)
    await h.at(6 * 3_600_000)
    expect(h.peerCalls()).toBe(calls)
    h.ping.stop()
  })

  test('no composer for a batch without group-done or failed: a toast and unreadPings', async () => {
    const a = running('w-a')
    const h = harness({
      workers: [a, running('w-live')],
      peer: () => ({ ok: false, reason: 'not-live' }),
      composer: { eligible: true, ok: true },
    })
    h.change(doneOf(a))
    await h.at(3 * 3_600_000)
    expect(h.composerSent).toHaveLength(0)
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).not.toContain('Task w-a')
    expect(h.ping.unreadPings(SID).count).toBe(1)
    expect(h.ping.unreadPings(SID, { clear: true }).texts[0]).toContain('Ping 1,')
    expect(h.ping.unreadPings(SID).count).toBe(0)
    h.ping.stop()
  })

  test('a pipe that took the bytes is delivered once: a busy chat is never sent a copy', async () => {
    // A chat mid-turn (inside a long climayte_status wait) queues what the pipe took, so its
    // transcript does not grow in time. Re-piping every 2 minutes gave it up to 60 copies.
    const a = running('w-a')
    const h = harness({
      workers: [a],
      peer: () => ({ ok: false, reason: 'wrote-but-no-transcript-growth' }),
      composer: { eligible: true, ok: true },
    })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(30 * 60_000)
    expect(h.peerCalls()).toBe(1)
    expect(h.composerSent).toHaveLength(0)
    expect(h.toasts).toHaveLength(0)
    expect(h.ping.unreadPings(SID).count).toBe(0)
    expect(h.journal.filter((j) => j.event === 'ping-failed')).toHaveLength(0)
    h.ping.stop()
  })

  test('an origin without a transcript is not confirmed by waiting on one', async () => {
    // Nothing can grow, so a 45 s wait would read every delivery as a failure.
    const a = running('w-a')
    const h = harness({
      workers: [a],
      peer: () => ({ ok: false, reason: 'wrote-but-no-transcript-growth' }),
    })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(60_000)
    expect(h.confirms).toEqual([0])
    h.ping.stop()
  })

  test('a worker origin is sent with climayteSend, never the pipe', async () => {
    const mgr: CliMayteOrigin = { kind: 'worker', workerId: 'w-manager' }
    const a = running('w-a', { origin: mgr })
    const h = harness({ workers: [a] })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(60_000)
    expect(h.peerCalls()).toBe(0)
    expect(h.workerSends).toHaveLength(1)
    expect(h.workerSends[0][0]).toBe('w-manager')
    expect(h.workerSends[0][1]).toContain(
      '[AgentHydra · CliMayte] Not from the user. Automatic status note, nobody typed this. Ping 1-2,',
    )
    expect(h.workerSends[0][1]).toContain('• Group aws-teardown-planes settled')
    h.ping.stop()
  })

  test('a worker without an origin is never pinged', async () => {
    const a = running('w-a', { origin: undefined })
    const h = harness({ workers: [a] })
    h.change({ ...a, status: 'failed', error: 'boom' })
    await h.at(3_600_000)
    expect(h.peerCalls()).toBe(0)
    expect(h.workerSends).toHaveLength(0)
    h.ping.stop()
  })
})

describe('the real peer pipe', () => {
  test('auth and user lines reach the chat on its own Claude home; a reload sends nothing', async () => {
    const home = scratch()
    const dir = scratch()
    const pipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\climayte-ping-test-${process.pid}-${Date.now()}`
        : join(home, 'msg.sock')
    const transcript = join(home, 'chat.jsonl')
    writeFileSync(transcript, '')
    mkdirSync(join(home, 'sessions'))
    writeFileSync(
      join(home, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: SID, messagingSocketPath: pipe }),
    )
    writeFileSync(
      join(home, 'sessions', `${process.pid}.abc.key`),
      JSON.stringify({ peerToken: 'tok' }),
    )
    const lines: Array<Record<string, unknown>> = []
    const server = net.createServer((sock) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
        let i = buf.indexOf('\n')
        while (i >= 0) {
          const line = JSON.parse(buf.slice(0, i))
          lines.push(line)
          if (line.type === 'user') appendFileSync(transcript, '{"queued":true}\n')
          buf = buf.slice(i + 1)
          i = buf.indexOf('\n')
        }
      })
    })
    await new Promise<void>((r) => server.listen(pipe, r))
    try {
      const origin: CliMayteOrigin = { kind: 'chat', sessionId: SID, home, transcript, how: 't' }
      const a = running('w-a', { origin })
      let now = a
      const real = startCliMaytePing({
        dir,
        workers: () => [now],
        subscribe: () => () => {},
        toast: async () => {},
        climayteSend: () => ({ ok: false, message: 'unused' }),
        journal: () => {},
      })
      now = { ...a, status: 'failed', error: 'boom' }
      real.observe(now)
      await real.flushNow()
      real.stop()
      expect(lines[0]).toEqual({ type: 'auth', token: 'tok' })
      expect(lines[1].type).toBe('user')
      const content = (lines[1].message as { content: string }).content
      expect(content).toContain(
        '[AgentHydra · CliMayte] Not from the user. Automatic status note, nobody typed this. Ping 1-2,',
      )

      const again = startCliMaytePing({
        dir,
        workers: () => [{ ...a, status: 'failed', error: 'boom' }],
        subscribe: () => () => {},
        toast: async () => {},
        climayteSend: () => ({ ok: false, message: 'unused' }),
        journal: () => {},
      })
      await again.flushNow()
      again.stop()
      expect(lines).toHaveLength(2)
    } finally {
      server.close()
    }
  }, 20_000)
})

describe('stale lines are dropped when the outbox flushes', () => {
  const judge = (w: PingWorker, by = 'orchestrator'): PingWorker => ({
    ...w,
    verdicts: [{ verdict: 'pass', by, at: T0 + 1000 }],
  })

  test('a result judged while its ping waited is left out; the rest still goes', async () => {
    const ws = ['w-a', 'w-b', 'w-live'].map((id) => running(id))
    const h = harness({ workers: ws })
    h.change(doneOf(ws[0]))
    h.change(doneOf(ws[1]))
    h.change(judge(doneOf(ws[0])))
    await h.at(200_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('w-b')
    expect(h.sent[0].text).not.toContain('w-a')
    expect(h.sent[0].text).toContain('1 update since')
    h.ping.stop()
  })

  test('everything judged: no ping at all, and the keys never resend', async () => {
    const ws = ['w-a', 'w-b'].map((id) => running(id))
    const h = harness({ workers: ws })
    h.change(doneOf(ws[0]))
    h.change(doneOf(ws[1])) // the group settles: group-done is queued too
    h.change(judge(doneOf(ws[0])))
    h.change(judge(doneOf(ws[1])))
    await h.at(3_600_000)
    expect(h.sent).toHaveLength(0)
    expect(h.workerSends).toHaveLength(0)
    // the same worker states observed again queue nothing new
    h.change(judge(doneOf(ws[0])))
    await h.at(7_200_000)
    expect(h.sent).toHaveLength(0)
    h.ping.stop()
  })

  test('a failed worker keeps its line and the group line goes only when it was reported', async () => {
    const ws = ['w-a', 'w-b'].map((id) => running(id))
    const h = harness({ workers: ws })
    h.change(judge(doneOf(ws[0])))
    h.change({ ...ws[1], status: 'failed', error: 'boom' })
    await h.at(3_600_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('failed')
    h.ping.stop()
  })

  test('a finished line is kept when only its own check judged it', async () => {
    const ws = [running('w-a', { check: 'bun test' }), running('w-live')]
    const h = harness({ workers: ws })
    h.change({
      ...ws[0],
      status: 'done',
      verdicts: [{ verdict: 'pass', by: 'check', at: T0 + 1000 }],
    })
    await h.at(200_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].text).toContain('check passed')
    h.ping.stop()
  })

  test('the header says nobody typed it and keeps the prefix the desk2 note card reads', () => {
    expect(PING_HEADER.startsWith('[AgentHydra · CliMayte] Not from the user.')).toBe(true)
    expect(PING_HEADER).toContain('nobody typed this')
  })
})
