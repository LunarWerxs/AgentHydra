#!/usr/bin/env bun
// scripts/climayte-live.ts — live stress/smoke run of CliMayte against the owner's REAL CLI accounts,
// through the running daemon's HTTP API. It spends a little of each account's quota (each turn is
// a one-line reply; moving a session to another account costs one uncached prompt, about $0.50).
//
//   bun scripts/climayte-live.ts handoff        context across account moves, queued follow-ups,
//                                            cancel-and-revive, a follow-up on a dead login
//   bun scripts/climayte-live.ts restart        a daemon restart under two running workers (it
//                                            RESTARTS THE DAEMON: other sessions see a blip)
//   bun scripts/climayte-live.ts burst [n]      n tasks (default 10) over every signed-in account
//   bun scripts/climayte-live.ts subagent       a session that used a subagent moves with its files
//
// Accounts are found, not named: "good" = has a credential file and no signed-out wall, least used
// first; "dead" = has a credential file but no wall yet and `claude auth status` says signed out
// (with no such account the dead-login scenario is skipped: once walled, CliMayte never hands a dead
// login a worker again, which is the point). Workers write into a scratch folder under the OS temp.
// Measured 2026-09-30 (docs/CLIMAYTE-LIVE-TESTS.md): every scenario passed on #83/#84/#88/#90.
//
// ⚠ The CLI refuses a bare `sleep N` in its Bash tool, so the "keep an account busy" steps use
// python's time.sleep instead.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.AGENTHYDRA_URL ?? 'http://127.0.0.1:7787'
const AH = join(homedir(), '.agenthydra')
const STORE = join(AH, 'corch', 'workers.json')
const WALLS = join(AH, 'corch', 'walls.json')
const phase = process.argv[2] ?? 'handoff'
const ROOT = mkdtempSync(join(tmpdir(), 'climayte-live-'))
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }))
const EFFORT = 'low'
const rnd = () => Math.floor(1000 + Math.random() * 9000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${s}`)
const wait = (secs: number) => `python -c "import time; time.sleep(${secs})"`

type Instance = {
  id: string
  num: number | null
  configDir: string
  loggedIn: boolean
  lastUsageCheck?: { weekAll?: { pct?: number } | null } | null
}
type View = {
  id: string
  status: string
  result: string | null
  error: string | null
  accountId: string | null
  moves: number
  costUsd: number
  lastActivity: string | null
  attempts: Array<{
    account: { id: string; num: number | null }
    outcome: string
    notice: string | null
  }>
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const init =
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
      const r = await fetch(BASE + path, init)
      const j = await r.json()
      if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`)
      return j as T
    } catch (e) {
      // Only a read is retried through a daemon restart. A POST is sent once: re-sending one that
      // may have landed would queue a message twice, start extra workers on real accounts, or
      // restart the daemon a second time.
      if (body !== undefined || i >= 40 || / 4\d\d /.test(String(e))) throw e
      await sleep(1500) // the daemon is restarting
    }
  }
}

const run = async (
  group: string,
  tasks: Array<{ prompt: string; cwd: string; title: string }>,
  accounts?: string[],
  perAccount?: number,
) =>
  (
    await api<{ workers: View[] }>('/api/corch/workers', {
      group,
      accounts,
      perAccount,
      tasks: tasks.map((t) => ({ ...t, effort: EFFORT })),
    })
  ).workers
const get = (id: string) => api<View>(`/api/corch/workers/${id}`)
const send = (id: string, text: string) =>
  api<{ ok: boolean; message: string }>(`/api/corch/workers/${id}/send`, { text })
const cancel = (id: string) => api<{ cancelled: string[] }>('/api/corch/cancel', { id })

async function until(
  id: string,
  pred: (v: View) => boolean,
  timeoutS: number,
  what: string,
): Promise<View> {
  const end = Date.now() + timeoutS * 1000
  let v = await get(id)
  while (!pred(v)) {
    if (Date.now() > end)
      throw new Error(
        `timeout waiting for ${what} on ${id}: ${v.status} ${v.error ?? ''} ${v.lastActivity ?? ''}`,
      )
    await sleep(2000)
    v = await get(id)
  }
  return v
}
const settled = (id: string, s = 400) =>
  until(id, (v) => ['done', 'failed', 'cancelled'].includes(v.status), s, 'the end')
const running = (id: string) => until(id, (v) => v.status === 'running', 90, 'running')
const inBash = (id: string) =>
  until(id, (v) => /^Bash/.test(v.lastActivity ?? ''), 90, 'a Bash step')
// A finished worker is its own file under corch/done; workers.json holds the work in flight.
const rawWorker = (id: string) => {
  const done = join(AH, 'corch', 'done', `${id}.json`)
  return (
    JSON.parse(readFileSync(STORE, 'utf8')).workers.find((w: { id: string }) => w.id === id) ??
    (existsSync(done) ? JSON.parse(readFileSync(done, 'utf8')) : undefined)
  )
}
const path = (v: View) => v.attempts.map((a) => `#${a.account.num}:${a.outcome}`).join(' > ')
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function transcriptHas(configDir: string, sessionId: string, needle: string): boolean {
  const root = join(configDir, 'projects')
  if (!existsSync(root)) return false
  return readdirSync(root).some((d) => {
    const f = join(root, d, `${sessionId}.jsonl`)
    return existsSync(f) && readFileSync(f, 'utf8').includes(needle)
  })
}
const dir = (name: string) => {
  const d = join(ROOT, name)
  mkdirSync(d, { recursive: true })
  return d
}
/** Keeps `acct` busy for `secs`. It joins the worker's own group: `per_account` caps a group's
 *  workers, so only a worker of the same group makes the account full for it. */
const blocker = (group: string, acct: string, cwd: string, secs: number) =>
  run(
    group,
    [
      {
        title: `keep busy ${secs}s`,
        cwd,
        prompt: `Use the Bash tool to run exactly this command: ${wait(secs)}\nWhen it finishes, reply with exactly BLOCKER-DONE and nothing else.`,
      },
    ],
    [acct],
    1,
  )

const walls: Record<string, { reason: string; until: number }> = existsSync(WALLS)
  ? JSON.parse(readFileSync(WALLS, 'utf8'))
  : {}
// The background refresh's readings (what CliMayte itself schedules by). An account at 98% or more of
// a window that has not reset is skipped: CliMayte will not place a worker there, and one with paid
// extra usage switched on would bill it.
type Reading = { session?: { pct?: number; resetsAt?: string | null } | null } | null
const USAGE_CACHE = join(AH, 'data', 'usage-cache.json')
const cache: Record<string, Reading> = existsSync(USAGE_CACHE)
  ? JSON.parse(readFileSync(USAGE_CACHE, 'utf8'))
  : {}
const full = (id: string): boolean => {
  const s = cache[`cli:${id}`]?.session
  return (s?.pct ?? 0) >= 98 && Date.parse(s?.resetsAt ?? '') > Date.now()
}
const instances = (await api<Instance[]>('/api/cli-instances')).filter((i) => i.loggedIn)
const good = instances
  .filter((i) => walls[i.id]?.reason !== 'signed out')
  .sort((a, b) => (a.lastUsageCheck?.weekAll?.pct ?? 50) - (b.lastUsageCheck?.weekAll?.pct ?? 50))
const skipped = good.filter((i) => full(i.id) || (walls[i.id]?.until ?? 0) > Date.now())
async function authOk(configDir: string): Promise<boolean> {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
  const p = Bun.spawn(['claude', 'auth', 'status', '--json'], {
    env,
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  try {
    return JSON.parse(await new Response(p.stdout).text()).loggedIn === true
  } catch {
    return false
  }
}
const live: Instance[] = []
const dead: Instance[] = []
for (const i of good) {
  if (skipped.includes(i)) continue
  ;((await authOk(i.configDir)) ? live : dead).push(i)
}
const label = (i?: Instance) => (i ? `#${i.num}` : 'none')
log(
  `accounts: live ${live.map((i) => label(i)).join(' ')}; full or walled (skipped) ${skipped.map((i) => label(i)).join(' ') || 'none'}; dead and not yet walled ${dead.map((i) => label(i)).join(' ') || 'none'}; scratch ${ROOT}`,
)

const results: Array<{ name: string; pass: boolean | 'skip' }> = []
async function scenario(
  name: string,
  fn: (check: (ok: boolean, s: string) => void, note: (s: string) => void) => Promise<void>,
) {
  let pass = true
  const note = (s: string) => log(`[${name}] ${s}`)
  try {
    await fn((ok, s) => {
      if (!ok) pass = false
      note(`${ok ? 'PASS' : 'FAIL'} ${s}`)
    }, note)
  } catch (e) {
    pass = false
    note(`ERROR ${e instanceof Error ? e.message : String(e)}`)
  }
  results.push({ name, pass })
}
const skip = (name: string, why: string) => {
  log(`[${name}] SKIP ${why}`)
  results.push({ name, pass: 'skip' })
}

/** Context survives A -> B -> A: B's newer transcript must overwrite A's stale copy. */
async function moveAndBack(a: Instance, b: Instance) {
  await scenario('move-and-back', async (check) => {
    const cwd = dir('move')
    const c1 = `MANGO-${rnd()}`
    const c2 = `KIWI-${rnd()}`
    const group = `live-move-${rnd()}`
    const [w] = await run(
      group,
      [
        {
          title: 'move and back',
          cwd,
          prompt: `Remember this codeword for later turns: ${c1}. Create the file relay.txt in the current folder containing one line: turn1. Then reply with exactly READY.`,
        },
      ],
      [a.id, b.id],
      1,
    )
    let v = await settled(w!.id)
    const home = v.accountId!
    const other = home === a.id ? b.id : a.id
    check(v.status === 'done', `turn 1: ${v.status} ${v.result}`)
    const [b1] = await blocker(group, home, cwd, 70)
    await running(b1!.id)
    await send(
      w!.id,
      `Second codeword to remember: ${c2}. Append a line turn2 to relay.txt. Then reply with the FIRST codeword you were given, and nothing else.`,
    )
    v = await settled(w!.id)
    check(
      v.accountId === other && (v.result ?? '').includes(c1),
      `turn 2 moved (${path(v)}) and remembered ${c1}: ${v.result}`,
    )
    const [b2] = await blocker(group, other, cwd, 90)
    await running(b2!.id)
    await send(
      w!.id,
      'Append a line turn3 to relay.txt. Then reply with both codewords you were given, first then second, separated by one space, and nothing else.',
    )
    v = await settled(w!.id)
    const r = v.result ?? ''
    check(
      v.accountId === home && r.includes(c1) && r.includes(c2),
      `turn 3 moved back (${path(v)}) and knows both codewords: ${r}`,
    )
    const relay = existsSync(join(cwd, 'relay.txt'))
      ? readFileSync(join(cwd, 'relay.txt'), 'utf8').trim().split(/\r?\n/).join(',')
      : ''
    check(
      relay === 'turn1,turn2,turn3',
      `relay.txt = ${relay}; moves ${v.moves}; $${v.costUsd.toFixed(2)}`,
    )
    await Promise.all([settled(b1!.id, 200), settled(b2!.id, 200)])
  })
}

/** Two follow-ups sent while the worker is busy arrive in order, in the same session. */
async function queuedFollowUps(a: Instance) {
  await scenario('queued follow-ups', async (check) => {
    const cwd = dir('queue')
    const s1 = `STEP1-${rnd()}`
    const [w] = await run(
      `live-queue-${rnd()}`,
      [
        {
          title: 'queued follow-ups',
          cwd,
          prompt: `Use the Bash tool to run exactly: ${wait(20)}\nThen reply with exactly ${s1} and nothing else.`,
        },
      ],
      [a.id],
      2,
    )
    await inBash(w!.id)
    await send(
      w!.id,
      'Reply with the word STEP2, one space, then the exact text of your previous reply. Nothing else.',
    )
    await send(
      w!.id,
      'Reply with the word STEP3, one space, then the exact text of your previous reply. Nothing else.',
    )
    const v = await settled(w!.id)
    check(
      new RegExp(`STEP3\\s+STEP2\\s+${s1}`).test(v.result ?? '') && v.attempts.length === 3,
      `${v.status}: ${v.result} (${path(v)})`,
    )
  })
}

/** Stop kills the CLI; a later message resumes the same session with what it knew. */
async function cancelAndRevive(a: Instance) {
  await scenario('cancel-and-revive', async (check) => {
    const cwd = dir('cancel')
    const code = `PLUM-${rnd()}`
    const [w] = await run(
      `live-cancel-${rnd()}`,
      [
        {
          title: 'cancel and revive',
          cwd,
          prompt: `Remember this codeword: ${code}. Use the Bash tool to run exactly: ${wait(90)}\nThen reply with exactly D-DONE.`,
        },
      ],
      [a.id],
      2,
    )
    await inBash(w!.id)
    const pid = rawWorker(w!.id).attempts.at(-1).pid as number
    check((await cancel(w!.id)).cancelled.includes(w!.id), 'cancel answered')
    await sleep(3000)
    check(!pidAlive(pid), `CLI process ${pid} is gone`)
    await send(
      w!.id,
      'Your previous step was stopped on purpose. Do not run any command. Reply with the codeword you were given in the first message, and nothing else.',
    )
    const v = await settled(w!.id)
    check(
      v.status === 'done' && (v.result ?? '').includes(code),
      `revived: ${v.status} ${v.result} (${path(v)})`,
    )
  })
}

/** A dead login loses nothing: whichever turn lands on it (the first, or a follow-up while the
 *  live account is busy) fails `auth`, and the session carries on on the live account. A
 *  follow-up survives because the CLI writes it into the transcript before the login fails. */
async function deadLoginFollowUp(deadAcct: Instance, a: Instance) {
  await scenario('follow-up on a dead login', async (check, note) => {
    const cwd = dir('dead')
    const code = `PEAR-${rnd()}`
    const token = `FOLLOWUP-${rnd()}`
    const group = `live-dead-${rnd()}`
    const [w] = await run(
      group,
      [
        {
          title: 'dead login',
          cwd,
          prompt: `Remember this codeword: ${code}. Reply with exactly READY.`,
        },
      ],
      [deadAcct.id, a.id],
      1,
    )
    await settled(w!.id)
    const [b] = await blocker(group, a.id, cwd, 60)
    await running(b!.id)
    await send(w!.id, `Reply with ${token}, one space, then the codeword, and nothing else.`)
    const v = await settled(w!.id, 300)
    note(
      `dead account's copy has the follow-up: ${transcriptHas(deadAcct.configDir, rawWorker(w!.id).sessionId, token)}`,
    )
    check(
      v.attempts.some((x) => x.account.id === deadAcct.id && x.outcome === 'auth'),
      `the dead login was really tried (${path(v)})`,
    )
    check(
      v.status === 'done' && (v.result ?? '').includes(token) && (v.result ?? '').includes(code),
      `${v.status}: ${v.result}`,
    )
    await settled(b!.id, 200)
  })
}

/** A restart is refused while workers run; forced, each worker resumes and finishes. */
async function restartMidRun(a: Instance, b: Instance) {
  await scenario('daemon restart mid-run', async (check, note) => {
    const cwd = dir('restart')
    const toks = [`E1-${rnd()}`, `E2-${rnd()}`]
    const ws = await run(
      `live-restart-${rnd()}`,
      toks.map((t, i) => ({
        title: `restart ${i + 1}`,
        cwd,
        prompt: `Use the Bash tool to run exactly: ${wait(40)}\nThen reply with exactly ${t} and nothing else.`,
      })),
      [a.id, b.id],
      1,
    )
    for (const w of ws) await inBash(w.id)
    const r = await fetch(`${BASE}/api/daemon/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const j = (await r.json()) as { error?: string }
    check(
      r.status === 409 && /CliMayte/.test(j.error ?? ''),
      `unforced restart refused: ${r.status} ${j.error}`,
    )
    note(`forced restart: ${JSON.stringify(await api('/api/daemon/restart', { force: true }))}`)
    for (const [i, w] of ws.entries()) {
      const v = await settled(w.id, 300)
      check(
        v.status === 'done' &&
          (v.result ?? '').includes(toks[i]!) &&
          v.attempts.some((x) => x.outcome === 'interrupted'),
        `${v.status}: ${v.result ?? v.error} (${path(v)})`,
      )
    }
  })
}

/** More tasks than the fleet runs at once drain completely. */
async function burst(n: number) {
  await scenario(`burst of ${n}`, async (check, note) => {
    const cwd = dir('burst')
    const toks = Array.from({ length: n }, (_, i) => `B${i + 1}-${rnd()}`)
    const start = Date.now()
    const ws = await run(
      `live-burst-${rnd()}`,
      toks.map((t, i) => ({
        title: `burst ${i + 1}`,
        cwd,
        prompt: `Use the Bash tool to run exactly: echo ${t}\nThen reply with the command's output only.`,
      })),
      undefined,
      2,
    )
    const views = await Promise.all(ws.map((w) => settled(w.id, 900)))
    const ok = views.filter(
      (v, i) => v.status === 'done' && (v.result ?? '').includes(toks[i]!),
    ).length
    const by: Record<string, number> = {}
    for (const v of views)
      for (const a of v.attempts)
        by[`#${a.account.num}:${a.outcome}`] = (by[`#${a.account.num}:${a.outcome}`] ?? 0) + 1
    check(
      ok === n,
      `${ok}/${n} done with the right output in ${((Date.now() - start) / 1000).toFixed(0)}s`,
    )
    note(`attempts by account: ${JSON.stringify(by)}`)
  })
}

/** A session that used a subagent moves with its `<session>/subagents/` files, and the resumed turn
 *  on the other account still knows what the subagent reported. */
async function subagentMove(a: Instance, b: Instance) {
  await scenario('subagent session moves', async (check, note) => {
    const cwd = dir('subagent')
    const group = `live-sub-${rnd()}`
    const salt = `climayte-sub-${rnd()}`
    const [w] = await run(
      group,
      [
        {
          title: 'subagent then move',
          cwd,
          prompt: `Use the Task tool to start a general-purpose subagent whose job is to run this in Bash and report the output: python -c "import hashlib; print(hashlib.sha256(b'${salt}').hexdigest()[:16])". Then reply with exactly the 16-character value the subagent reported and nothing else.`,
        },
      ],
      [a.id, b.id],
      1,
    )
    let v = await settled(w!.id)
    const expected = new Bun.CryptoHasher('sha256').update(salt).digest('hex').slice(0, 16)
    check((v.result ?? '').includes(expected), `turn 1 on ${path(v)}: ${v.result}`)
    const sid = rawWorker(w!.id).sessionId as string
    const home = v.accountId!
    const homeDir = live.find((i) => i.id === home)?.configDir ?? ''
    const hasSubagents = (configDir: string) =>
      existsSync(join(configDir, 'projects')) &&
      readdirSync(join(configDir, 'projects')).some((d) =>
        existsSync(join(configDir, 'projects', d, sid, 'subagents')),
      )
    note(`subagent files beside the transcript on the home account: ${hasSubagents(homeDir)}`)
    const [bl] = await blocker(group, home, cwd, 60)
    await running(bl!.id)
    await send(
      w!.id,
      'Without using any tools: what exact 16-character value did your subagent report? Reply with just that value.',
    )
    v = await settled(w!.id)
    const newDir = live.find((i) => i.id === v.accountId)?.configDir ?? ''
    check(
      v.moves === 1 && (v.result ?? '').includes(expected) && hasSubagents(newDir),
      `turn 2 moved (${path(v)}), subagent files copied: ${hasSubagents(newDir)}, answer: ${v.result}`,
    )
    await settled(bl!.id, 200)
  })
}

const [l0, l1, l2, l3] = live
if (phase === 'subagent') {
  if (l0 && l1) await subagentMove(l0, l1)
  else skip('subagent session moves', 'needs two live accounts')
} else if (phase === 'handoff') {
  const jobs: Promise<void>[] = []
  if (l0 && l1) jobs.push(moveAndBack(l0, l1))
  else skip('move-and-back', 'needs two live accounts')
  if (l2 ?? l0) jobs.push(queuedFollowUps((l2 ?? l0)!), cancelAndRevive((l2 ?? l0)!))
  if (dead[0] && (l3 ?? l0)) jobs.push(deadLoginFollowUp(dead[0], (l3 ?? l0)!))
  else
    skip(
      'follow-up on a dead login',
      'no signed-out account without a wall (CliMayte already walls the known ones)',
    )
  await Promise.all(jobs)
} else if (phase === 'restart') {
  if (l0 && l1) await restartMidRun(l0, l1)
  else skip('daemon restart mid-run', 'needs two live accounts')
} else if (phase === 'burst') {
  await burst(Number(process.argv[3] ?? 10))
} else {
  console.error(`unknown phase '${phase}': handoff | restart | burst [n] | subagent`)
  process.exit(2)
}

console.log('\n==== SUMMARY ====')
for (const r of results)
  console.log(`${r.pass === 'skip' ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
process.exit(results.some((r) => r.pass === false) ? 1 : 0)
