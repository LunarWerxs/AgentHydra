// server/tests/climayte-store.test.ts — CliMayte's storage: the split store (workers.json for work
// in flight, done/<id>.json for finished work), the packed attempt logs, and a replayed log's
// usage reading.
//
// The store loads once per process, so every "start" here is a child process with its own
// AGENTHYDRA_HOME: the same code path a daemon's boot takes, against files this test wrote.
import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freshRead, readInto } from '../src/climayte-core'

const CLIMAYTE = pathToFileURL(resolve(import.meta.dir, '../src/climayte.ts')).href
const MARK = '@@store-test@@'
const root = mkdtempSync(join(tmpdir(), 'ah-climayte-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A scratch install: its CliMayte state is `<home>/corch`. */
function install(name: string): { home: string; corch: string } {
  const home = join(root, name)
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(join(home, 'corch'), { recursive: true })
  return { home, corch: join(home, 'corch') }
}

/** One start of CliMayte on `home`: runs `body` (the module is `c`, `args` as given) and returns
 *  what it returned. */
async function start(home: string, body: string, args: unknown = null): Promise<unknown> {
  const script = `
    const c = await import(${JSON.stringify(CLIMAYTE)})
    const args = ${JSON.stringify(args)}
    const out = await (async () => { ${body} })()
    console.log(${JSON.stringify(MARK)} + JSON.stringify(out ?? null))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      AGENTHYDRA_HOME: home,
      AGENTHYDRA_DATA_DIR: join(home, 'data'),
      AGENTHYDRA_DB: join(home, 'data', 'test.db'),
      AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = out
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(MARK))
  if (code !== 0 || !line) throw new Error(`the start failed (exit ${code}): ${err}\n${out}`)
  return JSON.parse(line.slice(MARK.length))
}

const DAY = 24 * 3_600_000
const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function worker(id: string, status: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    group: 'g-store',
    title: id,
    cwd,
    prompt: 'a task',
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status,
    sessionId: null,
    accountId: null,
    attempts: [],
    result: null,
    results: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    tokens: noTokens,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  }
}

/** An ended attempt whose record is complete, so a load reads nothing to fill it in. */
function attempt(
  log: string,
  outcome: string,
  endedAt: number,
  extra: Record<string, unknown> = {},
) {
  return {
    account: { id: 'acct-1', num: 1, name: 'one' },
    pid: null,
    log,
    errLog: `${log}.err.log`,
    startedAt: endedAt - 60_000,
    endedAt,
    outcome,
    notice: null,
    resumed: false,
    started: true,
    sessionId: null,
    peak: null,
    spend: null,
    tokens: noTokens,
    ...extra,
  }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

test('the first start files every finished worker of the single store; workers.json keeps the work in flight', async () => {
  const { home, corch } = install('migrate')
  // The shape the measurement found: 200 finished workers holding the bytes (a report each), and
  // the work still waiting.
  const finished = Array.from({ length: 200 }, (_, i) =>
    worker(`w-done${i}`, i % 3 === 0 ? 'failed' : 'done', home, {
      result: 'r'.repeat(8_000),
      createdAt: 1_000 + i,
    }),
  )
  const waiting = [
    worker('w-waiting', 'waiting', home, { createdAt: 5_000 }),
    worker('w-queued', 'queued', home, { createdAt: 5_001 }),
  ]
  const legacy = { workers: [...finished, ...waiting], perAccount: { 'g-store': 3 } }
  writeFileSync(join(corch, 'workers.json'), JSON.stringify(legacy, null, 2))
  expect(statSync(join(corch, 'workers.json')).size).toBeGreaterThan(1_000_000)

  const list = 'return c.climayteList().map((w) => [w.id, w.status])'
  const first = (await start(home, list)) as [string, string][]
  expect(first).toHaveLength(202)
  expect(Object.fromEntries(first)).toMatchObject({ 'w-waiting': 'waiting', 'w-queued': 'queued' })

  expect(statSync(join(corch, 'workers.json')).size).toBeLessThan(100_000)
  const hot = readJson(join(corch, 'workers.json'))
  expect(hot.workers.map((w: { id: string }) => w.id)).toEqual(['w-waiting', 'w-queued'])
  expect(hot.perAccount).toEqual({ 'g-store': 3 })
  expect(readdirSync(join(corch, 'done'))).toHaveLength(200)
  expect(readJson(join(corch, 'done', 'w-done7.json'))).toEqual(finished[7])

  // A later start reads both halves.
  const second = (await start(home, list)) as [string, string][]
  expect(new Set(second.map(([id]) => id)).size).toBe(202)
  expect(second).toHaveLength(202)
}, 60_000)

test("a message revives a finished worker: its file goes, and a stale one loses to workers.json's copy", async () => {
  const { home, corch } = install('revive')
  const done = worker('w-revived', 'done', home, { result: 'the report' })
  writeFileSync(join(corch, 'workers.json'), JSON.stringify({ workers: [done], perAccount: {} }))
  const file = join(corch, 'done', 'w-revived.json')

  await start(home, 'return c.climayteList().length')
  expect(existsSync(file)).toBe(true)
  expect(readJson(join(corch, 'workers.json')).workers).toEqual([])

  const sent = (await start(home, 'return c.climayteSend(args, "one more thing")', done.id)) as {
    ok: boolean
  }
  expect(sent.ok).toBe(true)
  expect(existsSync(file)).toBe(false)
  const hot = readJson(join(corch, 'workers.json')).workers
  expect(hot).toHaveLength(1)
  expect(hot[0]).toMatchObject({ id: 'w-revived', pending: ['one more thing'] })
  expect(['queued', 'waiting']).toContain(hot[0].status)

  // A daemon that died after writing workers.json and before removing the file left both.
  writeFileSync(file, JSON.stringify(done))
  const rows = (await start(
    home,
    'return c.climayteList().map((w) => [w.id, w.status, w.pending.length])',
  )) as [string, string, number][]
  expect(rows).toHaveLength(1)
  expect(rows[0]?.[1]).not.toBe('done')
  expect(rows[0]?.[2]).toBe(1)
}, 60_000)

test("a finished attempt's log is packed a day on and reads the same; a cancelled one whose runner still lives is left", async () => {
  const { home, corch } = install('pack')
  const logs = join(corch, 'logs')
  mkdirSync(logs, { recursive: true })
  const said = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] },
  })
  const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const init = { type: 'system', subtype: 'init', model: 'fake-model' }
  const end = { type: 'result', is_error: false, result: 'ok', total_cost_usd: 0.02, num_turns: 2 }
  const first = join(logs, 'w-packed-0.jsonl')
  const second = join(logs, 'w-packed-1.jsonl')
  const open = join(logs, 'w-open-0.jsonl')
  writeFileSync(first, lines([init, said('first step'), said('out of room')]))
  writeFileSync(second, lines([init, said('second step'), end]))
  writeFileSync(open, lines([init, said('still writing')]))
  const ended = Date.now() - 2 * DAY
  const packed = worker('w-packed', 'done', home, {
    attempts: [attempt(first, 'quota', ended - 60_000), attempt(second, 'done', ended)],
  })
  // Cancelled, and its runner (this test process) is alive with no exit file: its CLI may still
  // be appending.
  const cancelled = worker('w-open', 'cancelled', home, {
    attempts: [
      attempt(open, 'cancelled', ended, {
        runner: {
          pid: process.pid,
          pidFile: join(logs, 'w-open-0.pids.json'),
          exitFile: join(logs, 'w-open-0.exit.json'),
          launchedAt: ended - 60_000,
        },
      }),
    ],
  })
  writeFileSync(
    join(corch, 'workers.json'),
    JSON.stringify({ workers: [packed, cancelled], perAccount: {} }),
  )

  const before = (await start(home, 'return c.climayteGet(args).events', packed.id)) as string[]
  expect(before).toContain('said: first step')
  expect(before).toContain('said: second step')
  expect(existsSync(first)).toBe(true)

  const old = new Date(ended)
  for (const log of [first, second, open]) utimesSync(log, old, old)
  const after = (await start(
    home,
    `const { existsSync } = await import('node:fs')
     c.startCliMayte()
     for (let i = 0; i < 100 && !existsSync(args.zst); i++) await Bun.sleep(100)
     return c.climayteGet(args.id).events`,
    { id: packed.id, zst: `${second}.zst` },
  )) as string[]

  expect(after).toEqual(before)
  for (const log of [first, second]) {
    expect(existsSync(log)).toBe(false)
    expect(existsSync(`${log}.zst`)).toBe(true)
  }
  expect(existsSync(open)).toBe(true)
  expect(existsSync(`${open}.zst`)).toBe(false)
}, 60_000)

test('a usage reading replayed after a restart keeps its own time; one tailed live is from now', () => {
  const log = join(root, 'replayed.jsonl')
  const tenMinutesAgo = Date.now() - 600_000
  const turn = {
    type: 'assistant',
    timestamp: new Date(tenMinutesAgo).toISOString(),
    message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'busy' }] },
  }
  const reading = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.78, resetsAt: Math.round(Date.now() / 1000) + 3_600 },
      },
    },
  }
  writeFileSync(log, `${JSON.stringify(turn)}\n${JSON.stringify(reading)}\n`)

  expect(readInto(log, freshRead(), true).live).toMatchObject({
    sessionPct: 78,
    at: tenMinutesAgo,
  })
  const now = Date.now()
  expect(readInto(log, freshRead()).live?.at).toBeGreaterThanOrEqual(now)
})
