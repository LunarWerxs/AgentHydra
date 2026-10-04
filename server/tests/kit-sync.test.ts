import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountTokenWindows } from '../src/kit/account-windows'
import { KitStore } from '../src/kit/store'
import { buildShard, importShard, syncKit } from '../src/kit/sync'

const root = mkdtempSync(join(tmpdir(), 'kit-sync-'))
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // a Windows handle still draining: the OS temp cleaner takes it
  }
})

const H = 3_600_000
const T0 = Date.UTC(2026, 5, 10, 12, 0, 0)

const totals = (s: KitStore) =>
  s.db
    .query(
      'select pc, sum(input) as input, sum(calls) as calls from usage_hour group by pc order by pc',
    )
    .all()

/** A store that is PC `pc` with `n` hours of usage, rolled up from raw events like the real ingest does. */
function pcStore(pc: string, n: number, account = 'acct-1'): KitStore {
  const s = new KitStore(':memory:', { now: T0 })
  s.upsertEvents(
    Array.from({ length: n }, (_, i) => ({
      id: `${pc}:${i}`,
      ts: T0 + i * H + 5,
      source: 'cli',
      pc,
      account,
      model: 'm',
      input: 100 + i,
    })),
  )
  s.rollup()
  return s
}

describe('kit sync', () => {
  test('export then import into a second store gives the same per-pc totals', async () => {
    const a = pcStore('pc-a', 5)
    const b = pcStore('pc-b', 3)
    const { bytes, rows } = await buildShard(a, 'pc-a')
    expect(rows).toBe(5)
    const r = await importShard(b, bytes, 'pc-a')
    expect(r).toEqual({ pc: 'pc-a', rows: 5, skipped: false })
    const asOnA = a.db
      .query("select sum(input) as input, sum(calls) as calls from usage_hour where pc = 'pc-a'")
      .get()
    const onB = b.db
      .query("select sum(input) as input, sum(calls) as calls from usage_hour where pc = 'pc-a'")
      .get()
    expect(onB).toEqual(asOnA)
    expect(totals(b).map((t) => (t as { pc: string }).pc)).toEqual(['pc-a', 'pc-b'])
  })

  test('re-import changes nothing; a shrunk shard removes the rows it lost', async () => {
    const b = pcStore('pc-b', 2)
    const big = await buildShard(pcStore('pc-a', 6), 'pc-a')
    await importShard(b, big.bytes, 'pc-a')
    const before = totals(b)
    expect((await importShard(b, big.bytes, 'pc-a')).skipped).toBe(true)
    expect(totals(b)).toEqual(before)
    const small = await buildShard(pcStore('pc-a', 2), 'pc-a')
    await importShard(b, small.bytes, 'pc-a')
    expect(b.db.query("select count(*) as n from usage_hour where pc = 'pc-a'").get()).toEqual({
      n: 2,
    })
    await importShard(
      b,
      (await buildShard(new KitStore(':memory:', { now: T0 }), 'pc-a')).bytes,
      'pc-a',
    )
    expect(b.db.query("select count(*) as n from usage_hour where pc = 'pc-a'").get()).toEqual({
      n: 0,
    })
  })

  test('this pc is never imported back', async () => {
    const a = pcStore('pc-a', 3)
    const mine = await buildShard(a, 'pc-a')
    const before = totals(a)
    const r = await importShard(a, mine.bytes, 'pc-a', 'pc-a')
    expect(r.skipped).toBe(true)
    expect(totals(a)).toEqual(before)
    expect(a.db.query('select count(*) as n from imported_pc').get()).toEqual({ n: 0 })
  })

  test('rollup, prune and a rebuild of the same hours leave imported rows intact', async () => {
    const b = pcStore('pc-b', 4)
    await importShard(b, (await buildShard(pcStore('pc-a', 4), 'pc-a')).bytes, 'pc-a')
    const before = b.db.query("select * from usage_hour where pc = 'pc-a' order by hour").all()
    b.upsertEvents([
      { id: 'late', ts: T0 + 2 * H, source: 'cli', pc: 'pc-b', model: 'm', input: 7 },
    ])
    await b.rollupAsync()
    b.rollup(T0 - H)
    await b.pruneRawAsync(T0 + 90 * 24 * H, 1)
    expect(b.db.query("select * from usage_hour where pc = 'pc-a' order by hour").all()).toEqual(
      before,
    )
    // its own rows were rebuilt as usual
    expect(b.db.query("select sum(calls) as n from usage_hour where pc = 'pc-b'").get()).toEqual({
      n: 5,
    })
  })

  test('an account used on two pcs shows the sum of both in its windows, once', async () => {
    const b = pcStore('pc-b', 2)
    await importShard(b, (await buildShard(pcStore('pc-a', 2), 'pc-a')).bytes, 'pc-a')
    await importShard(b, (await buildShard(pcStore('pc-a', 2), 'pc-a')).bytes, 'pc-a')
    const w = accountTokenWindows(['acct-1'], { store: b, now: T0 + 6 * H, quota: () => null })
    // two hours on each pc: (100+101) per pc, one output token per call
    expect(w.get('acct-1')?.total.input).toBe(2 * (100 + 101))
  })

  test('sync is off, and says so, when HSWARM_SYNC_REPO is unset or names the public repo', async () => {
    const s = pcStore('pc-a', 1)
    const off = await syncKit(s, { env: { HSWARM_HOME: join(root, 'h0') } })
    expect(off.on).toBe(false)
    expect(off.notes[0]).toContain('sync is off: set HSWARM_SYNC_REPO')
    const pub = await syncKit(s, {
      env: { HSWARM_HOME: join(root, 'h0'), HSWARM_SYNC_REPO: join(import.meta.dir, '..', '..') },
    })
    expect(pub.on).toBe(false)
    expect(pub.notes[0]).toContain('public')
  })

  test('two pcs through a bare git repo: each sees the other, nothing is written twice', async () => {
    const git = (cwd: string, ...a: string[]) => {
      const r = Bun.spawnSync(['git', ...a], { cwd, stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
    }
    const bare = join(root, 'remote.git')
    mkdirSync(bare)
    git(bare, 'init', '--bare', '-q')
    const clone = (name: string) => {
      const dir = join(root, name)
      git(root, 'clone', '-q', bare, dir)
      git(dir, 'config', 'user.email', 't@example.invalid')
      git(dir, 'config', 'user.name', 't')
      return { HSWARM_SYNC_REPO: dir, HSWARM_HOME: join(root, `${name}-home`) }
    }
    const envA = clone('clone-a')
    const envB = clone('clone-b')
    const a = pcStore('pc-a', 3)
    const b = pcStore('pc-b', 2)

    const first = await syncKit(a, { env: envA, pc: 'pc-a' })
    expect(first.notes).toEqual([])
    expect(first.pushed).toBe(true)
    const second = await syncKit(b, { env: envB, pc: 'pc-b' })
    expect(second.notes).toEqual([])
    expect(second.imported).toEqual({ 'pc-a': 3 })
    expect(second.pushed).toBe(true)
    const third = await syncKit(a, { env: envA, pc: 'pc-a' })
    expect(third.imported).toEqual({ 'pc-b': 2 })
    // nothing changed since: no commit, no import
    const again = await syncKit(a, { env: envA, pc: 'pc-a' })
    expect(again.committed).toBe(false)
    expect(again.imported).toEqual({})
    expect(totals(a).map((t) => (t as { pc: string }).pc)).toEqual(['pc-a', 'pc-b'])
  }, 120_000)
})
