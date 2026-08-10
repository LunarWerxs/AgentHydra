// Integration tests for the detached-dispatch pipeline (server/src/dispatch.ts + dispatch-runner.ts).
// These drive the REAL flow with the fake `claude` stand-in (AGENTHYDRA_FAKE): dispatchItem writes
// a spec, launches the detached runner (WMI on win32 / setsid on POSIX), which runs the fake CLI and
// appends its stream-json to a per-run log; the daemon tails that log, records run_events, and
// finalizes the DB row. Locks in complete / cancel / reattach, plus the property the whole detached
// design exists for: the runner does NOT hang off the daemon, so quitting the app cannot take a run
// with it (see 'the runner escapes...' below).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markDispatchReady } from '../src/boot-state'
import { db } from '../src/db'
import * as dispatch from '../src/dispatch'

// AGENTHYDRA_DB / AGENTHYDRA_HOME / AGENTHYDRA_RUN_LOG_DIR are isolated by the preload
// (tests/setup.ts); AGENTHYDRA_FAKE is read at dispatch-CALL time, so setting it here (before any
// dispatchItem call) makes buildArgv use the harmless fake `claude` stand-in.
process.env.AGENTHYDRA_FAKE = '1'
const RUN_LOG_DIR = process.env.AGENTHYDRA_RUN_LOG_DIR as string
const dir = tmpdir() // a real cwd for the fake run; nothing is written to it

// FAKE_SLEEP_MS is how the slow-run tests below keep a runner alive long enough to inspect or
// cancel it, and `bun test` shares ONE process across every file. Each of those tests used to clear
// it on its LAST line, which is the success path only: one failed assertion and the value survives
// into unrelated tests, where the fake CLI (which reads `FAKE_SLEEP_MS ?? 120` at spawn time) is
// suddenly an order of magnitude slower for no visible reason. Clearing it here means a red test
// stays one red test instead of dragging its neighbours down with it.
afterEach(() => {
  delete process.env.FAKE_SLEEP_MS
})

let counter = 0
function makeItem(overrides: Record<string, unknown> = {}) {
  const id = `it-${++counter}`
  const sessionId = `sess-${counter}`
  db.query(
    `insert into queue_items (id, session_id, title, cwd, prompt, new_chat, fork, status, position, created_at)
     values (?, ?, 'test', ?, 'hello', 1, 0, 'queued', 0, ?)`,
  ).run(id, sessionId, dir, Date.now())
  return {
    id,
    session_id: sessionId,
    title: 'test',
    cwd: dir,
    prompt: 'hello',
    model: null,
    effort: null,
    permission_mode: null,
    account_id: null,
    new_chat: true,
    fork: false,
    status: 'queued',
    pid: null,
    position: 0,
    not_before: null,
    started_at: null,
    finished_at: null,
    exit_code: null,
    created_at: Date.now(),
    ...overrides,
  } as any
}

const statusOf = (id: string) =>
  db
    .query<{ status: string; exit_code: number | null }, [string]>(
      'select status, exit_code from queue_items where id = ?',
    )
    .get(id)

async function waitForStatus(id: string, want: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = statusOf(id)?.status ?? 'missing'
    if (s === want || Date.now() > deadline) return s
    await Bun.sleep(150)
  }
}

test('dispatchItem: a fake run completes, records events, and cleans up its spec/status files', async () => {
  delete process.env.FAKE_SLEEP_MS
  const item = makeItem()
  await dispatch.dispatchItem(item) // resolves when the run finalizes

  const row = statusOf(item.id)
  expect(row?.status).toBe('completed')
  expect(row?.exit_code).toBe(0)

  const events = dispatch.getRunEvents(item.id)
  expect(events.length).toBeGreaterThan(0)
  expect(events.some((e) => e.kind === 'text')).toBe(true) // the fake's assistant text line

  // the runner's spec + status sidecars are removed on finalize; the raw log is kept
  expect(existsSync(join(RUN_LOG_DIR, `${item.id}.spec.json`))).toBe(false)
  expect(existsSync(join(RUN_LOG_DIR, `${item.id}.status.json`))).toBe(false)
  expect(existsSync(join(RUN_LOG_DIR, `${item.id}.stream.jsonl`))).toBe(true)
  expect(dispatch.isActive(item.id)).toBe(false)
})

// Instance-pinning must never silently degrade to Ambient credentials: a queue item's instance_ref
// that doesn't resolve to a real, live instance has to fail loudly BEFORE the runner ever launches
// (dispatch.ts never registers the item in `active`, so isActive must read false throughout).
test('dispatchItem: an unrecognized instance_ref prefix fails loudly instead of falling back to Ambient', async () => {
  const item = makeItem({ instance_ref: 'garbage:foo' })
  await dispatch.dispatchItem(item)

  const row = statusOf(item.id)
  expect(row?.status).toBe('failed')
  expect(row?.exit_code).toBe(-1)
  expect(dispatch.isActive(item.id)).toBe(false)

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('malformed'))).toBe(true)
})

test('dispatchItem: "desktop:" with an empty suffix fails loudly instead of falling back to Ambient', async () => {
  const item = makeItem({ instance_ref: 'desktop:' })
  await dispatch.dispatchItem(item)

  const row = statusOf(item.id)
  expect(row?.status).toBe('failed')
  expect(row?.exit_code).toBe(-1)

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('malformed'))).toBe(true)
})

test('dispatchItem: "cli:" with an empty suffix fails loudly instead of falling back to Ambient', async () => {
  const item = makeItem({ instance_ref: 'cli:' })
  await dispatch.dispatchItem(item)

  const row = statusOf(item.id)
  expect(row?.status).toBe('failed')
  expect(row?.exit_code).toBe(-1)

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('CLI instance not found'))).toBe(true)
})

test('dispatchItem: a "desktop:" ref pointing at a deleted/nonexistent dir fails loudly', async () => {
  const missingDir = join(tmpdir(), `agenthydra-missing-desktop-${counter}-${Date.now()}`)
  const item = makeItem({ instance_ref: `desktop:${missingDir}` })
  await dispatch.dispatchItem(item)

  const row = statusOf(item.id)
  expect(row?.status).toBe('failed')
  expect(row?.exit_code).toBe(-1)

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('desktop instance not found'))).toBe(true)
})

// THE guard for the promise the whole detached design exists to keep: "close AgentHydra and your
// runs carry on". It exists because that promise was previously only "verified manually", and
// nothing stopped it regressing.
//
// What must hold is JOB-OBJECT escape, not merely tree escape. Bun puts everything it spawns into a
// job object that kills its members when the daemon dies, and the `cmd /c start` hand-off's
// grandchild STAYS in that job (verified 2026-07-12). Only Win32_Process.Create (WMI) truly escapes:
// the OS builds the process for us, outside our job, parented to the WMI provider host.
//
// So this asserts the parent is WmiPrvSE *specifically*. "Parent isn't the daemon" would be too weak
// to be worth writing: under AGENTHYDRA_RUNNER_LAUNCH='start' the runner's parent is a cmd.exe that
// has already exited, which also isn't the daemon — that check passes for the very method documented
// NOT to survive. Naming the expected parent is what gives this teeth (confirmed: it goes red under
// 'startb', where the parent is cmd.exe).
test.if(process.platform === 'win32')(
  'the runner is created by WMI, outside the daemon job — so quitting the app cannot kill a run',
  async () => {
    process.env.FAKE_SLEEP_MS = '1200' // keep the runner alive long enough to inspect it
    const item = makeItem()
    const p = dispatch.dispatchItem(item)
    // try/finally, because `p` is deliberately NOT awaited yet: the whole point is to inspect the
    // runner WHILE it is alive. If the parent-name assertion below goes red, an un-awaited
    // dispatchItem keeps running and finalizes mid-way through some later test, mutating the shared
    // `active` map and its queue_items row there. Draining it here keeps the blast radius at one.
    try {
      for (let i = 0; i < 60 && !dispatch.isActive(item.id); i++) await Bun.sleep(50)

      // Find OUR runner by its unique spec-file argument (the same identity trick isRunnerAlive uses).
      // `AND Name <> 'powershell.exe'` matters: the launcher's OWN command line embeds the spec path
      // (it is the argument to Win32_Process.Create), so an unqualified match also returns the
      // transient PowerShell — which IS a child of the daemon and would make this assert the opposite
      // of what it means to.
      // This resolves the parent in TWO steps (find the runner, then look up its ParentProcessId),
      // and the second step is a race: WmiPrvSE is a service host that idles out, and Windows reuses
      // PIDs aggressively, so if it exits between the two queries the lookup can name whatever
      // process inherited its PID. Accepting the first non-empty answer therefore turned a rare
      // misread into a hard failure. Instead: stop as soon as the expected parent is seen, and treat
      // any OTHER name as a claim that has to be corroborated before it is believed.
      const CONFIRMATIONS = 3
      let parent = ''
      let streak = 0
      for (let i = 0; i < 40; i++) {
        const proc = Bun.spawn(
          [
            'powershell',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$r = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${item.id}.spec.json%' AND Name <> 'powershell.exe'" | Select-Object -First 1;` +
              ` if ($r) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($r.ParentProcessId)").Name }`,
          ],
          { stdout: 'pipe', stderr: 'ignore' },
        )
        const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        const name = out.trim()
        if (!name) {
          // The runner has not appeared yet, or has already exited. Keep whatever we last saw.
          await Bun.sleep(100)
          continue
        }
        if (name.toLowerCase() === 'wmiprvse.exe') {
          parent = name
          break
        }
        // A non-empty name that isn't the expected one: a real regression repeats it every poll (a
        // 'startb' launch reports cmd.exe consistently), a PID-recycle misread does not.
        streak = name === parent ? streak + 1 : 1
        parent = name
        if (streak >= CONFIRMATIONS) break
        await Bun.sleep(100)
      }

      // WmiPrvSE.exe as the parent IS the escape: it means the OS created the runner on our behalf,
      // so it is in neither this process's tree nor its job object.
      expect(parent.toLowerCase()).toBe('wmiprvse.exe')
    } finally {
      await p
    }
  },
  30000,
)

test('cancelItem: a running fake dispatch is killed and finalized as canceled', async () => {
  process.env.FAKE_SLEEP_MS = '1500' // slow enough to cancel mid-run
  const item = makeItem()
  const p = dispatch.dispatchItem(item)
  // Same reason as the WMI test above: `p` is intentionally left running so there is something to
  // cancel, so the drain belongs in a finally or a red cancelItem strands it in a later test.
  try {
    // wait until it's actually running (runner launched, registered active)
    for (let i = 0; i < 40 && !dispatch.isActive(item.id); i++) await Bun.sleep(50)
    await Bun.sleep(600)
    expect(dispatch.cancelItem(item.id)).toBe(true)
  } finally {
    await p
  }
  expect(statusOf(item.id)?.status).toBe('canceled')
})

test('reattachRuns: a run that finished while the daemon was down is recovered from its log', async () => {
  // Simulate the "daemon died mid-run, run finished on its own" state: a queue_items row still
  // marked 'running', an on-disk log ending in the runner's terminal marker, and a status sidecar.
  const item = makeItem({ status: 'running' })
  db.query('update queue_items set status = ? where id = ?').run('running', item.id)
  const log = join(RUN_LOG_DIR, `${item.id}.stream.jsonl`)
  writeFileSync(
    log,
    `${[
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fake' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'recovered work' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      JSON.stringify({ __dispatch: 'exit', code: 0, at: new Date().toISOString() }),
    ].join('\n')}\n`,
  )
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.status.json`),
    JSON.stringify({ runnerPid: 1, childPid: null, state: 'exited', code: 0 }),
  )

  dispatch.reattachRuns() // rebuilds events from the log, then finalizes from the terminal marker
  const final = await waitForStatus(item.id, 'completed')
  expect(final).toBe('completed')

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('recovered work'))).toBe(true) // events rebuilt from the log
})

// --- transient overload (529) vs the user's quota ---------------------------------------------
//
// The incident (2026-07-16): a real run whose only two events were "session started" and
// "API Error: 529 Overloaded... usually temporary" was finalized status='rate_limited' — parked as
// though the user's 5-hour window were spent. It wasn't; the same message went through from the
// desktop app moments later, because a 529 clears in seconds. One pattern list covered both walls,
// so the daemon could not tell them apart. These drive the real pipeline (fake CLI dying the way
// the real one does, via FAKE_ERROR_MODE) and pin that they now finalize to different places.

/** The attempt/backoff bookkeeping the retry sweep reads. */
const retryStateOf = (id: string) =>
  db
    .query<{ retry_attempts: number; not_before: string | null }, [string]>(
      'select retry_attempts, not_before from queue_items where id = ?',
    )
    .get(id)

test('a 529 is NOT filed as the user hitting a rate limit — it schedules a retry instead', async () => {
  process.env.FAKE_ERROR_MODE = 'overloaded'
  try {
    const item = makeItem()
    await dispatch.dispatchItem(item)

    // The whole point: NOT 'rate_limited'. It goes back to 'queued' to be re-run shortly.
    const row = statusOf(item.id)
    expect(row?.status).toBe('queued')

    const retry = retryStateOf(item.id)
    expect(retry?.retry_attempts).toBe(1)
    // ...and it waits out a backoff rather than hammering the overloaded server immediately.
    expect(retry?.not_before).not.toBeNull()
    expect(Date.parse(retry?.not_before as string)).toBeGreaterThan(Date.now())

    // The reason is on screen during the wait, recorded before the re-dispatch wipes the events.
    const events = dispatch.getRunEvents(item.id)
    expect(events.some((e) => /retrying in \d+s/i.test(e.text))).toBe(true)
  } finally {
    delete process.env.FAKE_ERROR_MODE
  }
})

test("a spent quota is NOT retried — it parks as 'rate_limited' for the monitor", async () => {
  // The opposite wall. Retrying this would hammer a door that will not open for hours; parking it
  // is what lets monitor.ts resume it after the reset.
  process.env.FAKE_ERROR_MODE = 'session_limit'
  try {
    const item = makeItem()
    await dispatch.dispatchItem(item)
    const row = statusOf(item.id)
    expect(row?.status).toBe('rate_limited')
    expect(retryStateOf(item.id)?.retry_attempts).toBe(0) // never entered the retry path
  } finally {
    delete process.env.FAKE_ERROR_MODE
  }
})

test('an overload that outlasts the backoff gives up as its own status, never as a rate limit', async () => {
  // Seed the row at the cap so the next failure is the last one, without waiting out real backoffs.
  process.env.FAKE_ERROR_MODE = 'overloaded'
  try {
    const item = makeItem()
    db.query('update queue_items set retry_attempts = 3 where id = ?').run(item.id)
    await dispatch.dispatchItem(item)
    const row = statusOf(item.id)
    // 'overloaded', not 'rate_limited' (monitor.ts would park it against an unrelated 5-hour reset)
    // and not 'failed' (nothing is wrong with the run or the prompt).
    expect(row?.status).toBe('overloaded')
    expect(row?.exit_code).toBe(1)
  } finally {
    delete process.env.FAKE_ERROR_MODE
  }
})

test('a WEEKLY wall parks as rate_limited, driven by the CLI structured signal', async () => {
  // The 2026-07-27 miss. The weekly wall arrives as a typed line the daemon ignored outright —
  //   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day",…}}
  // — followed by prose ("You've hit your WEEKLY limit") that the quota patterns didn't match
  // either, since they named only the session wording. Both gaps landed the run on a bare 'failed':
  // no rate-limited badge, and invisible to monitor.ts, which resumes off that status. The fake CLI
  // replays the real line-for-line shape (fake-claude.ts weekly_limit).
  process.env.FAKE_ERROR_MODE = 'weekly_limit'
  try {
    const item = makeItem()
    await dispatch.dispatchItem(item)
    expect(statusOf(item.id)?.status).toBe('rate_limited')
    expect(retryStateOf(item.id)?.retry_attempts).toBe(0) // a quota wall is never retried
    // and it says which window, so the card doesn't read as a mystery failure
    const events = dispatch.getRunEvents(item.id)
    expect(events.some((e) => /weekly limit reached/i.test(e.text))).toBe(true)
  } finally {
    delete process.env.FAKE_ERROR_MODE
  }
})

// ORDER MATTERS: this must stay ABOVE the test that calls markDispatchReady() — the flag is a
// one-way latch with no un-set, so once any test flips it, "not ready yet" is unobservable.
test('the retry sweep stays parked until reattach settles (it must not double-dispatch)', async () => {
  // The one gate the sweep DOES honour: during the boot window a surviving run isn't back in
  // `active` yet, so dispatching would put a second `claude --resume` on a live transcript.
  const item = makeItem()
  db.query(
    "update queue_items set status = 'queued', retry_attempts = 1, not_before = ? where id = ?",
  ).run(new Date(Date.now() - 1000).toISOString(), item.id) // due, but boot hasn't settled
  await dispatch.dispatchDueRetries()
  expect(statusOf(item.id)?.status).toBe('queued') // untouched
})

test('the retry sweep re-dispatches a run whose backoff has elapsed', async () => {
  // The sweep is what actually finishes the job, and it is deliberately gated on NEITHER the
  // scheduler nor the monitor switch (both off by default) — a 529 retry is finishing the run the
  // user already started, not hours-scale autonomy.
  markDispatchReady() // stand in for index.ts's post-reattach flip
  const item = makeItem()
  db.query(
    "update queue_items set status = 'queued', retry_attempts = 1, not_before = ? where id = ?",
  ).run(new Date(Date.now() - 1000).toISOString(), item.id) // due a second ago
  await dispatch.dispatchDueRetries()
  // no FAKE_ERROR_MODE this time: the retry succeeds, which is the happy path a 529 should reach
  expect(await waitForStatus(item.id, 'completed')).toBe('completed')
})

test('the retry sweep leaves a run whose backoff has NOT elapsed alone', async () => {
  const item = makeItem()
  db.query(
    "update queue_items set status = 'queued', retry_attempts = 1, not_before = ? where id = ?",
  ).run(new Date(Date.now() + 60_000).toISOString(), item.id) // due in a minute
  await dispatch.dispatchDueRetries()
  expect(statusOf(item.id)?.status).toBe('queued') // untouched
})

test('the retry sweep ignores ordinary queued items — it only fires its own retries', async () => {
  // retry_attempts = 0 means "the user queued this", which is the scheduler's business, not ours.
  // Without this the sweep would quietly become an always-on scheduler nobody opted into.
  const item = makeItem()
  db.query("update queue_items set status = 'queued', not_before = ? where id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    item.id,
  )
  await dispatch.dispatchDueRetries()
  expect(statusOf(item.id)?.status).toBe('queued')
})

// --- a dead runner's pid is a number, not a handle ---------------------------------------------
//
// reattachRuns refuses to trust a dead runner's stored childPid, because on Windows that number
// gets recycled: comment at its own call site says a recycled pid means "stuck run, or a cancel
// force-killing an innocent process". tailRun then re-read the same status file and adopted the pid
// anyway, undoing it milliseconds later. This pins the refusal end to end.
//
// The fixture IS the race, deterministically: process.pid is guaranteed alive and guaranteed not to
// be our `claude` child — exactly the shape of a recycled pid. No real collision needed.
test('a reattach onto a dead runner never adopts its stale child pid', async () => {
  const item = makeItem()
  db.query("update queue_items set status = 'running' where id = ?").run(item.id)
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.status.json`),
    JSON.stringify({ runnerPid: process.pid, childPid: process.pid, state: 'running', code: null }),
  )
  // Real output but NO terminal marker: the runner died before it could write one.
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.stream.jsonl`),
    `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial work' }] },
    })}\n`,
  )

  // No <id>.spec.json process exists, so isRunnerAlive() is false — the runner is gone.
  await dispatch.reattachRuns()

  // It must reach a terminal state. Before the fix it never did: the adopted pid answered "alive"
  // forever, so the child-died grace never fired and no marker was ever coming — the row sat
  // 'running' for good, which is a permanent false "session is busy" in the UI.
  expect(await waitForStatus(item.id, 'failed')).toBe('failed')

  // And the foreign pid must never have been recorded as ours — that column is what cancelItem
  // would have handed to killTree(), i.e. this test process.
  const row = db
    .query<{ pid: number | null }, [string]>('select pid from queue_items where id = ?')
    .get(item.id)
  expect(row?.pid).toBeNull()

  // The work it did manage is still recoverable, not silently dropped.
  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('partial work'))).toBe(true)
  // Past bun's 5s default: this deliberately waits out the real DEAD_GRACE_MS (4s) on top of the
  // runner-liveness probe, because the grace is the thing under test — a marker still in flight has
  // to be able to win before we call the run lost.
}, 20_000)
