// Cross-PC usage (docs/ANALYTICS-PLAN.md piece 17). Each PC writes its own usage_hour rows as one shard,
// `kit/<machine>.jsonl.gz`, into the private git repo HSwarm's usage sync already uses (HSWARM_SYNC_REPO, the
// `sync` branch checked out under <HSWARM_HOME>/sync-tree), and imports every other PC's shard as usage_hour
// rows carrying that PC's `pc`.
//
// Why `kit/` and gzip: HSwarm reads every `*.jsonl` directly in the tree root as one of its own shards and
// commits only the paths it names, so a subfolder keeps the two apart; two PCs never write the same file, so
// a pull never conflicts. Shard: line 1 is {"kit":1,"pc":…,"rows":N}, then one usage_hour row per line, sorted
// by hour and key, so an unchanged store writes the same bytes and commits nothing.
//
// Imported rows live in usage_hour next to this PC's own, and the store's rollup, prune and backfill skip any
// pc listed in imported_pc (store.ts), so nothing here is rebuilt from raw rows that do not exist. Every
// import replaces that PC's rows, hour range by hour range, each in one transaction: importing the same shard
// twice changes nothing, a shard that shrank removes what it no longer has, and a reader never sees a gap.
//
// The daemon's event loop is never held: git runs in Bun.spawn, files are read and gzipped off-thread, and
// SQLite is touched in slices of IMPORT_SLICE rows with a loop turn between them.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { hswarmHome } from '../hswarm'
import { machineId } from './machine'
import { KIT_HOUR_DIMS, KIT_MEASURES } from './schema'
import { type KitStore, yieldLoop } from './store'

/** Import rows per transaction: small, so a commit never holds the loop past ~100 ms. */
const IMPORT_SLICE = 150

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

const SYNC_BRANCH = 'sync'
export const SHARD_DIR = 'kit'
const SHARD_EXT = '.jsonl.gz'
/** The kit sweep calls syncOnce on every sweep; the transport runs at most this often. */
export const SYNC_EVERY_MS = 15 * 60_000
const FAR = 8.64e15
const NULLABLE = new Set(['list_usd', 'billed_usd', 'seconds'])
const COLS = [
  'hour',
  'day',
  ...KIT_HOUR_DIMS,
  'calls',
  'ok_calls',
  'failed_calls',
  ...KIT_MEASURES,
] as const

type ShardRow = Record<string, string | number | null>

export interface SyncReport {
  on: boolean
  /** Why sync is off (the same words HSwarm's refusal uses), or a note on a step that failed. */
  notes: string[]
  exported: number
  imported: Record<string, number>
  committed: boolean
  pushed: boolean
}

const emptyReport = (): SyncReport => ({
  on: false,
  notes: [],
  exported: 0,
  imported: {},
  committed: false,
  pushed: false,
})

// ---- git, async ----------------------------------------------------------------------------------

interface Ran {
  code: number
  out: string
  err: string
}

async function git(cwd: string, args: string[], input?: string): Promise<Ran> {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out: out.trim(), err: err.trim() }
}

const gitOrThrow = async (cwd: string, args: string[], input?: string): Promise<string> => {
  const r = await git(cwd, args, input)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).slice(0, 300)}`)
  return r.out
}

/** The repo checkout this server runs from: the public one, which a shard must never be written into. */
const OWN_REPO = resolve(import.meta.dir, '..', '..', '..')

/**
 * The private clone HSWARM_SYNC_REPO names, or the reason sync is off (utilization.py sync_repo's refusals).
 * It is off when unset, when not a git checkout, and when it is this repo or has this repo's origin.
 */
export async function syncRepo(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ repo: string } | { off: string }> {
  const raw = env.HSWARM_SYNC_REPO?.trim()
  if (!raw)
    return {
      off: 'sync is off: set HSWARM_SYNC_REPO to a local clone of a PRIVATE git repo (a shard carries project paths, session ids and labels)',
    }
  const repo = resolve(
    raw.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~'),
  )
  if (!existsSync(join(repo, '.git')))
    return { off: `sync is off: HSWARM_SYNC_REPO ${repo} is not a git checkout` }
  const own = (await git(OWN_REPO, ['remote', 'get-url', 'origin'])).out
  const theirs = (await git(repo, ['remote', 'get-url', 'origin'])).out
  if (repo.toLowerCase() === OWN_REPO.toLowerCase() || (own && theirs === own))
    return {
      off: "sync is off: HSWARM_SYNC_REPO is HSwarm's own (public) repo; name a private one",
    }
  return { repo }
}

/** The sync-branch worktree HSwarm keeps (utilization.py ensure_sync_tree); made here the same way when absent. */
async function ensureTree(repo: string, home: string): Promise<string> {
  const tree = join(home, 'sync-tree')
  if (existsSync(join(tree, '.git'))) return tree
  await git(repo, ['worktree', 'prune'])
  await git(repo, ['fetch', '--quiet', 'origin', SYNC_BRANCH]) // fails until the first machine pushes
  const remote = await git(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${SYNC_BRANCH}`,
  ])
  await mkdir(home, { recursive: true })
  if (remote.code === 0) {
    await gitOrThrow(repo, [
      'worktree',
      'add',
      '--quiet',
      '-B',
      SYNC_BRANCH,
      tree,
      `origin/${SYNC_BRANCH}`,
    ])
    await git(tree, [
      'branch',
      '--quiet',
      '--set-upstream-to',
      `origin/${SYNC_BRANCH}`,
      SYNC_BRANCH,
    ])
  } else {
    const empty = await gitOrThrow(repo, ['hash-object', '-t', 'tree', '--stdin'], '')
    const root = await gitOrThrow(
      repo,
      ['commit-tree', empty, '-m', 'sync: shard branch for hswarm utilization ledgers'],
      '',
    )
    await gitOrThrow(repo, ['worktree', 'add', '--quiet', '-B', SYNC_BRANCH, tree, root])
  }
  return tree
}

// ---- export --------------------------------------------------------------------------------------

/** Hours per page of the export read (an index walk on usage_hour's primary key). */
const EXPORT_HOURS = 120

/** This PC's own rows (its id, and the empty pc of rows from before pcs were stamped) as shard bytes. */
export async function buildShard(
  store: KitStore,
  pc: string = machineId(),
): Promise<{ bytes: Uint8Array; rows: number }> {
  const hours = store.db.query(
    `select distinct hour from usage_hour where hour > $lo and (pc = $pc or pc = '')
       and pc not in (select pc from imported_pc where pc != '') order by hour limit ${EXPORT_HOURS}`,
  )
  const rows = store.db.query(
    `select ${COLS.join(', ')} from usage_hour where hour >= $a and hour <= $b and (pc = $pc or pc = '')
       and pc not in (select pc from imported_pc where pc != '')
       order by hour, ${KIT_HOUR_DIMS.join(', ')}`,
  )
  const lines: string[] = []
  for (let lo = -FAR; ; ) {
    const page = hours.all({ $lo: lo, $pc: pc }) as { hour: number }[]
    if (page.length === 0) break
    const a = page[0].hour
    const b = page[page.length - 1].hour
    for (const r of rows.all({ $a: a, $b: b, $pc: pc }) as ShardRow[])
      lines.push(JSON.stringify({ ...r, pc }))
    lo = b
    await yieldLoop()
  }
  const head = JSON.stringify({ kit: 1, pc, rows: lines.length })
  const text = `${head}\n${lines.map((l) => `${l}\n`).join('')}`
  return { bytes: await gzipAsync(text), rows: lines.length }
}

// ---- import --------------------------------------------------------------------------------------

/** Replace the usage_hour rows of `pc` with the shard's, a few hundred rows (whole hours) at a time. */
export async function importShard(
  store: KitStore,
  bytes: Uint8Array,
  fallbackPc: string,
  self: string = machineId(),
): Promise<{ pc: string; rows: number; skipped: boolean }> {
  const sig = createHash('sha1').update(bytes).digest('hex')
  const text = (await gunzipAsync(bytes)).toString('utf8')
  const lines = text.split('\n')
  let head: { kit?: number; pc?: string } = {}
  try {
    head = JSON.parse(lines[0] ?? '')
  } catch {
    throw new Error('not a kit shard')
  }
  if (head.kit !== 1) throw new Error('not a kit shard')
  const pc = String(head.pc || fallbackPc)
  if (!pc || pc === self) return { pc, rows: 0, skipped: true }
  const db = store.db
  const done = db.query('select sig from imported_pc where pc = ?').get(pc) as {
    sig: string
  } | null
  if (done && done.sig === sig) return { pc, rows: 0, skipped: true }

  const parsed: ShardRow[] = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]) {
      try {
        parsed.push(JSON.parse(lines[i]))
      } catch {
        // a torn line is dropped; the whole file is replaced by the next import
      }
    }
    if (i % 2000 === 0) await yieldLoop()
  }
  parsed.sort((x, y) => Number(x.hour) - Number(y.hour))

  // Registered before the first row lands, with no signature: a run cut short is redone, never trusted.
  db.query(
    'insert into imported_pc (pc, sig, rows, at) values ($pc, $sig, 0, $at) on conflict (pc) do update set sig = $sig',
  ).run({ $pc: pc, $sig: '', $at: Date.now() })
  const del = db.prepare('delete from usage_hour where pc = $pc and hour >= $a and hour < $b')
  const ins = db.prepare(
    `insert or replace into usage_hour (${COLS.join(', ')}) values (${COLS.map((c) => `$${c}`).join(', ')})`,
  )
  const bind = (r: ShardRow): Record<string, string | number | null> => {
    const o: Record<string, string | number | null> = {}
    for (const c of COLS) {
      const v = r[c]
      o[`$${c}`] =
        c === 'pc'
          ? pc
          : v === undefined || v === null
            ? NULLABLE.has(c)
              ? null
              : defaultOf(c)
            : v
    }
    return o
  }
  // Slices end on an hour boundary; the first reaches down to -inf and the last up to +inf, so the rows of
  // hours the shard no longer has go in the same transactions that put the new ones in.
  let i = 0
  do {
    let j = Math.min(i + IMPORT_SLICE, parsed.length)
    while (j < parsed.length && parsed[j].hour === parsed[j - 1].hour) j++
    const a = i === 0 ? -FAR : Number(parsed[i].hour)
    const b = j >= parsed.length ? FAR : Number(parsed[j].hour)
    db.transaction(() => {
      del.run({ $pc: pc, $a: a, $b: b })
      for (let k = i; k < j; k++) ins.run(bind(parsed[k]))
    })()
    i = j
    await yieldLoop()
  } while (i < parsed.length)
  db.query('update imported_pc set sig = ?, rows = ?, at = ? where pc = ?').run(
    sig,
    parsed.length,
    Date.now(),
    pc,
  )
  return { pc, rows: parsed.length, skipped: false }
}

const defaultOf = (c: string): string | number =>
  c === 'day' || (KIT_HOUR_DIMS as readonly string[]).includes(c) ? '' : 0

// ---- the transport -------------------------------------------------------------------------------

export interface SyncOpts {
  /** Overrides process.env (a test points HSWARM_SYNC_REPO and HSWARM_HOME at temp dirs). */
  env?: NodeJS.ProcessEnv
  pc?: string
  push?: boolean
}

async function writeIfChanged(path: string, bytes: Uint8Array): Promise<boolean> {
  if (existsSync(path)) {
    const old = new Uint8Array(await Bun.file(path).arrayBuffer())
    if (old.length === bytes.length && Buffer.compare(old, bytes) === 0) return false
  }
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, path)
  return true
}

/** One full pass: pull, export this PC's shard, import the others, commit, push. Never throws. */
export async function syncKit(store: KitStore, opts: SyncOpts = {}): Promise<SyncReport> {
  const env = opts.env ?? process.env
  const pc = opts.pc ?? machineId()
  const rep = emptyReport()
  try {
    const found = await syncRepo(env)
    if ('off' in found) {
      rep.notes.push(found.off)
      return rep
    }
    const tree = await ensureTree(found.repo, hswarmHome(env))
    rep.on = true
    const upstream =
      (await git(tree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))
        .code === 0
    const push = opts.push ?? true
    if (push && upstream) {
      const r = await git(tree, ['pull', '--rebase', '--quiet'])
      if (r.code) rep.notes.push(`pull: ${(r.err || r.out).slice(0, 200)}`)
    }
    const mine = join(tree, SHARD_DIR, `${pc}${SHARD_EXT}`)
    const shard = await buildShard(store, pc)
    rep.exported = shard.rows
    await writeIfChanged(mine, shard.bytes)

    const dir = join(tree, SHARD_DIR)
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(SHARD_EXT) || name === `${pc}${SHARD_EXT}`) continue
      try {
        const bytes = new Uint8Array(await Bun.file(join(dir, name)).arrayBuffer())
        const r = await importShard(store, bytes, name.slice(0, -SHARD_EXT.length), pc)
        if (!r.skipped) rep.imported[r.pc] = r.rows
      } catch (err) {
        rep.notes.push(`import ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const rel = `${SHARD_DIR}/${pc}${SHARD_EXT}`
    await git(tree, ['add', '--', rel])
    if ((await git(tree, ['diff', '--cached', '--quiet', '--', rel])).code !== 0) {
      const r = await git(tree, [
        'commit',
        '--quiet',
        '-m',
        `kit: ${pc}, ${shard.rows} usage hours`,
        '--',
        rel,
      ])
      rep.committed = r.code === 0
      if (r.code) rep.notes.push(`commit: ${(r.err || r.out).slice(0, 200)}`)
    }
    if (push && (rep.committed || (await git(tree, ['status', '-sb'])).out.includes('ahead'))) {
      let r = await git(tree, ['push', '--quiet', '-u', 'origin', SYNC_BRANCH])
      if (r.code) {
        // Another PC pushed first: take its commit under ours and try once more. Never forced.
        await git(tree, ['pull', '--rebase', '--quiet'])
        r = await git(tree, ['push', '--quiet', '-u', 'origin', SYNC_BRANCH])
      }
      rep.pushed = r.code === 0
      if (r.code) rep.notes.push(`push: ${(r.err || r.out).slice(0, 200)}`)
    }
  } catch (err) {
    rep.notes.push(err instanceof Error ? err.message : String(err))
  }
  return rep
}

let lastAt = 0
let running: Promise<SyncReport> | null = null

/**
 * The sweep's entry: syncKit at most every SYNC_EVERY_MS (`force` ignores that), and a caller that arrives
 * while a pass runs joins it. Returns null when it is not time yet.
 */
export function runKitSync(
  store: KitStore,
  opts: SyncOpts & { force?: boolean } = {},
): Promise<SyncReport> | null {
  if (running) return running
  if (!opts.force && Date.now() - lastAt < SYNC_EVERY_MS) return null
  lastAt = Date.now()
  running = syncKit(store, opts).finally(() => {
    running = null
  })
  return running
}
