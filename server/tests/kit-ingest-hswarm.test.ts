import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ingestHswarm } from '../src/kit/ingest-hswarm'
import { KitStore } from '../src/kit/store'

const root = mkdtempSync(join(tmpdir(), 'kit-hswarm-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // a Windows handle still draining: the OS temp cleaner takes it
  }
})

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const jl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')

const line = (task: string, extra: Record<string, unknown> = {}) => ({
  ts: iso(NOW - 60_000),
  job: 'job-a',
  task,
  backend: 'api',
  model: 'deepseek-flash',
  provider: 'deepseek',
  status: 'ok',
  calls: 1,
  in_miss: 100,
  in_hit: 40,
  in_write: 7,
  out: 30,
  reasoning: 5,
  cost_usd: 0.25,
  seconds: 2.5,
  billed: true,
  caller_account: 'acct-0123abcd',
  caller_instance: 'inst1',
  caller_session: 'abcdef12',
  ...extra,
})

// The fixture mixes every money kind, a failure, a retry of one task, a resume's cached line and a line
// older than 30 days.
const FIXTURE = [
  line('t1'),
  line('t2', { billed: false, cost_usd: 1.5 }),
  line('t3', { billed: undefined, cost_usd: 0.75, status: 'error' }),
  line('t1', { cost_usd: 0.125 }),
  line('t4', { cached: 'job-0', cost_usd: 9 }),
  line('t5', { ts: iso(NOW - 40 * 86_400_000) }),
]

function kitTotals(store: KitStore, since: number) {
  return store.db
    .query(
      'select count(*) as calls, coalesce(sum(billed_usd), 0) as billed from usage_event where ts >= ?',
    )
    .get(since) as { calls: number; billed: number }
}

describe('HSwarm ledger ingest', () => {
  test('maps a ledger line to a usage_event', async () => {
    const path = join(root, 'map.jsonl')
    writeFileSync(
      path,
      jl([line('t1'), line('t2', { billed: false }), line('t3', { billed: undefined })]),
    )
    const store = new KitStore(':memory:')
    expect(await ingestHswarm(store, path, { pc: 'pc1' })).toBe(3)
    const rows = store.db.query('select * from usage_event order by id').all() as Record<
      string,
      unknown
    >[]
    expect(rows[0]).toMatchObject({
      id: 'hswarm:job-a/t1/0',
      source: 'hswarm',
      pc: 'pc1',
      account: 'acct-0123abcd',
      instance: 'inst1',
      session: 'abcdef12',
      model: 'deepseek-flash',
      provider: 'deepseek',
      input: 100,
      cache_read: 40,
      cache_write_5m: 7,
      output: 30,
      reasoning: 5,
      list_usd: 0.25,
      billed_usd: 0.25,
      ok: 1,
      seconds: 2.5,
      ref: 'job-a/t1',
    })
    expect(rows[1]?.billed_usd).toBe(0) // free key: nothing paid
    expect(rows[1]?.list_usd).toBe(0.25)
    expect(rows[2]?.billed_usd).toBeNull() // the line never said
    store.close()
  })

  test('calls and billed_usd equal HSwarm model stats on the same lines', async () => {
    const path = join(root, 'parity.jsonl')
    writeFileSync(path, jl(FIXTURE))
    const store = new KitStore(':memory:')
    await ingestHswarm(store, path)
    const kit = kitTotals(store, NOW - 30 * 86_400_000)

    const code = [
      'import sys, json, pathlib',
      'from hswarm.model_stats import compute',
      'out = compute(30, pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[1] + ".none"))',
      'print(json.dumps({"calls": sum(m["tasks"] for m in out["models"]), "billed": sum(m["spent_usd"] for m in out["models"])}))',
    ].join('\n')
    const run = Bun.spawnSync(['python', '-c', code, path], {
      cwd: resolve(import.meta.dir, '../..'),
    })
    expect(run.exitCode).toBe(0)
    const py = JSON.parse(run.stdout.toString()) as { calls: number; billed: number }
    expect(py.calls).toBe(4) // t1 twice, t2, t3: the cached and the 40-day-old lines do not count
    expect(kit.calls).toBe(py.calls)
    expect(kit.billed).toBe(py.billed)
    store.close()
  })

  test('resumes from its cursor and reads only appended lines, finishing a torn one later', async () => {
    const path = join(root, 'resume.jsonl')
    writeFileSync(path, jl([line('t1'), line('t2')]))
    const store = new KitStore(':memory:')
    expect(await ingestHswarm(store, path)).toBe(2)
    expect(await ingestHswarm(store, path)).toBeNull() // nothing new

    const torn = JSON.stringify(line('t3'))
    appendFileSync(path, `${torn.slice(0, 40)}`)
    expect(await ingestHswarm(store, path)).toBe(0)
    appendFileSync(path, `${torn.slice(40)}\n${JSON.stringify(line('t1'))}\n`)
    expect(await ingestHswarm(store, path)).toBe(2)
    const ids = (
      store.db.query('select id from usage_event order by id').all() as { id: string }[]
    ).map((r) => r.id)
    expect(ids).toEqual([
      'hswarm:job-a/t1/0',
      'hswarm:job-a/t1/1',
      'hswarm:job-a/t2/0',
      'hswarm:job-a/t3/0',
    ])
    store.close()
  })

  test('a file that shrank is read again from byte 0', async () => {
    const path = join(root, 'rotate.jsonl')
    writeFileSync(path, jl([line('t1'), line('t2'), line('t3')]))
    const store = new KitStore(':memory:')
    await ingestHswarm(store, path)
    writeFileSync(path, jl([line('n1', { job: 'job-b' })])) // rotated: a new, shorter ledger
    expect(await ingestHswarm(store, path)).toBe(1)
    expect(kitTotals(store, 0).calls).toBe(4)
    expect(store.getCursor(path)?.offset).toBe(
      Buffer.byteLength(jl([line('n1', { job: 'job-b' })])),
    )
    store.close()
  })

  test('lines appended just before a month rotation are ingested from the archive, once', async () => {
    const path = join(root, 'month.jsonl')
    const old = [line('t1'), line('t2')]
    writeFileSync(path, jl(old))
    const store = new KitStore(':memory:')
    expect(await ingestHswarm(store, path)).toBe(2)

    // t3 lands, then HSwarm rotates before the next sweep: t1-t3 move to the archive, the live file keeps the new month, and
    // grows past the old cursor offset so the size alone cannot say it was replaced.
    const t3 = line('t3')
    writeFileSync(join(root, 'month-202609.jsonl.gz'), gzipSync(jl([...old, t3])))
    const fresh = Array.from({ length: 6 }, (_, i) => line(`n${i}`, { job: 'job-b' }))
    writeFileSync(path, jl(fresh))
    expect(await ingestHswarm(store, path)).toBe(9) // 3 from the archive, 6 from the live file
    const ids = (store.db.query('select id from usage_event').all() as { id: string }[]).map(
      (r) => r.id,
    )
    expect(ids).toContain('hswarm:job-a/t3/0')
    expect(ids).toHaveLength(9) // t1 and t2 were already there under the same ids: not counted twice
    expect(kitTotals(store, 0).calls).toBe(9)

    expect(await ingestHswarm(store, path)).toBeNull() // a fully read archive is skipped by size+mtime
    appendFileSync(path, jl([line('n6', { job: 'job-b' })]))
    expect(await ingestHswarm(store, path)).toBe(1)
    expect(kitTotals(store, 0).calls).toBe(10)
    store.close()
  })

  test('an archive written before the live file was replaced does not count its month twice', async () => {
    const path = join(root, 'pending.jsonl')
    const month = (ms: number) => iso(ms).slice(0, 7).replace('-', '')
    const lastMonth = new Date(NOW)
    lastMonth.setUTCDate(1)
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
    const old = [
      line('t1', { ts: iso(lastMonth.getTime()) }),
      line('t2', { ts: iso(lastMonth.getTime() + 1000) }),
    ]
    const fresh = line('t3')
    writeFileSync(path, jl([...old, fresh]))
    const store = new KitStore(':memory:')
    expect(await ingestHswarm(store, path)).toBe(3)

    // Rotation: the archive exists, the swap of the live file failed, so the live file still holds the moved lines.
    writeFileSync(join(root, `pending-${month(lastMonth.getTime())}.jsonl.gz`), gzipSync(jl(old)))
    await ingestHswarm(store, path)
    expect(kitTotals(store, 0).calls).toBe(3)

    writeFileSync(path, jl([fresh])) // the swap goes through later
    await ingestHswarm(store, path)
    expect(kitTotals(store, 0).calls).toBe(3)
    store.close()
  })
})
