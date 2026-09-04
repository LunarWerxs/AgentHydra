// Integration tests for the detached-dispatch pipeline (server/src/dispatch.ts + dispatch-runner.ts).
// These drive the REAL flow with the fake `claude` stand-in (AGENTHYDRA_FAKE): dispatchItem writes
// a spec, launches the detached runner (WMI on win32 / setsid on POSIX), which runs the fake CLI and
// appends its stream-json to a per-run log; the daemon tails that log, records run_events, and
// finalizes the DB row. Locks in complete / cancel / reattach, plus the property the whole detached
// design exists for: the runner does NOT hang off the daemon, so quitting the app cannot take a run
// with it (see 'the runner escapes...' below).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import * as dispatch from '../src/dispatch'
import { invalidateSessionMetaCache } from '../src/instance-sessions'

// AGENTHYDRA_DB / AGENTHYDRA_HOME / AGENTHYDRA_RUN_LOG_DIR are isolated by the preload
// (tests/setup.ts); AGENTHYDRA_FAKE is read at dispatch-CALL time, so setting it here (before any
// dispatchItem call) makes buildArgv use the harmless fake `claude` stand-in.
process.env.AGENTHYDRA_FAKE = '1'
// THE PIPELINE TESTS NEED A PIPELINE. Since 2026-08-27 the dispatch chokepoint refuses every
// headless run outright (owner law, see headless-policy.ts), which is the correct product
// behaviour and would leave every test below asserting nothing but the refusal. So the escape
// hatch is opened here, for the tests that exercise spec-writing, the detached runner, cancel,
// reattach and rate-limit classification. The tests of the LAW ITSELF close it again, one by one,
// so they can never pass just because this line exists.
// The instance store the surface-purity guard searches, isolated by the preload (tests/setup.ts)
// so this file's "does this session live in a desktop app?" checks see a world it controls
// rather than the developer's real fleet.
const INSTANCES_ROOT = process.env.AGENTHYDRA_INSTANCES_ROOT as string
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
  // See the seam's own comment in dispatch.ts: never let one test's override leak into the next.
  dispatch.__setCompletionEvidenceCheckForTests(null)
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

test('EVERY headless dispatch is refused - there is no setting that permits one', async () => {
  // The eleven tests removed alongside this one drove real headless runs: completion,
  // cancellation, rate-limit and overload handling, the WMI-detached runner. None of those paths
  // can execute any more - dispatchItem refuses before reaching them and headlessRunsAllowed() is
  // a constant false. Keeping them would have been coverage of a capability this program no
  // longer has, which reads as reassurance and is the opposite.
  const item = makeItem()
  await dispatch.dispatchItem(item)
  const row = statusOf(item.id)
  expect(row?.status).toBe('failed')
  expect(dispatch.isActive(item.id)).toBe(false)
})

test('reattachRuns: a run that finished while the daemon was down is recovered from its log', async () => {
  // Simulate the "daemon died mid-run, run finished on its own" state: a queue_items row still
  // marked 'running', an on-disk log ending in the runner's terminal marker, and a status sidecar.
  const item = makeItem({ status: 'running' })
  db.query('update queue_items set status = ? where id = ?').run('running', item.id)
  // This run's session id is synthetic and has no real transcript on disk (see the seam's comment
  // in dispatch.ts), so stand in for the independent read-back finalize() now requires before a
  // completed run.
  dispatch.__setCompletionEvidenceCheckForTests(async () => ({ ok: true }))
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

// --- never claim a run landed without checking (ported from hermes-agent's
// _confirm_adapter_delivery + delivery_queue.py's never-retry-on-UNKNOWN doctrine) -------------

test('finalize: exit 0 with no transcript evidence is unverified, not completed - and it says why', async () => {
  // Same recovered-log shape as the test above, but standing in (via the seam - the REAL check
  // would otherwise scan the developer's actual ~/.claude/projects, which is both slow here and
  // not what this test is about) for the shape of a crash right after `claude` printed its exit
  // marker, with nothing durable on disk to back it up. Also carries a desktop import target, so
  // this run doubles as the "never deliver silently" check below.
  dispatch.__setCompletionEvidenceCheckForTests(async () => ({
    ok: false,
    reason: 'no transcript file was found for this session',
  }))
  const item = makeItem({ status: 'running' })
  db.query(
    "update queue_items set status = 'running', started_at = ?, import_to = 'desktop:some-instance' where id = ?",
  ).run(new Date().toISOString(), item.id)
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.stream.jsonl`),
    `${[
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fake' }),
      JSON.stringify({ __dispatch: 'exit', code: 0, at: new Date().toISOString() }),
    ].join('\n')}\n`,
  )
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.status.json`),
    JSON.stringify({ runnerPid: 1, childPid: null, state: 'exited', code: 0 }),
  )

  await dispatch.reattachRuns()
  expect(await waitForStatus(item.id, 'unverified')).toBe('unverified')

  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('UNVERIFIED'))).toBe(true)
  // Never deliver a desktop import on unverified evidence - it must be skipped, visibly, not fired.
  expect(events.some((e) => e.text.includes('desktop delivery skipped'))).toBe(true)
  const row = db
    .query<{ import_state: string | null }, [string]>(
      'select import_state from queue_items where id = ?',
    )
    .get(item.id)
  expect(row?.import_state).not.toBe('pending')
})

test('finalize: exit 0 WITH real completion evidence still reads completed', async () => {
  // The inverse of the test above, using the test seam so this pipeline test never has to touch
  // the developer's actual ~/.claude/projects to prove the positive case too.
  dispatch.__setCompletionEvidenceCheckForTests(async () => ({ ok: true }))
  const item = makeItem({ status: 'running' })
  db.query('update queue_items set status = ? where id = ?').run('running', item.id)
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.stream.jsonl`),
    `${JSON.stringify({ __dispatch: 'exit', code: 0, at: new Date().toISOString() })}\n`,
  )
  writeFileSync(
    join(RUN_LOG_DIR, `${item.id}.status.json`),
    JSON.stringify({ runnerPid: 1, childPid: null, state: 'exited', code: 0 }),
  )
  await dispatch.reattachRuns()
  expect(await waitForStatus(item.id, 'completed')).toBe('completed')
})

test('an unknown failure (pid vanished, no exit code) is never auto-retried, and that is recorded', async () => {
  // reattachRuns' own "unrecoverable" branch: status still 'running', but no runner and no log to
  // replay at all - the daemon genuinely never learned what happened, which is the UNKNOWN case
  // the hermes doctrine is about (never confuse "we know it failed" with "we never found out").
  const item = makeItem()
  db.query("update queue_items set status = 'running' where id = ?").run(item.id)

  await dispatch.reattachRuns()
  expect(await waitForStatus(item.id, 'failed')).toBe('failed')

  const row = db
    .query<{ retry_attempts: number; not_before: string | null }, [string]>(
      'select retry_attempts, not_before from queue_items where id = ?',
    )
    .get(item.id)
  // Never silently re-queued: an unknown outcome must never be retried automatically.
  expect(row?.retry_attempts ?? 0).toBe(0)
  expect(row?.not_before).toBeNull()
  // And the refusal to retry is on the record, not just a design property nobody can see.
  const events = dispatch.getRunEvents(item.id)
  expect(events.some((e) => e.text.includes('UNKNOWN outcome'))).toBe(true)
  expect(events.some((e) => e.text.includes('will not be auto-retried'))).toBe(true)
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
const _retryStateOf = (id: string) =>
  db
    .query<{ retry_attempts: number; not_before: string | null }, [string]>(
      'select retry_attempts, not_before from queue_items where id = ?',
    )
    .get(id)

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

// --- NO HEADLESS CHATS ----------------------------------------------------------
// Owner law 2026-08-27: "We should never have any headless chats. No headless."
//
// This supersedes the 2026-08-26 SURFACE PURITY guard whose tests used to live here. That one came
// from a reported failure ("every chat you were migrating from desktop to desktop ended up being
// migrated to a headless thing that I couldn't see") and it only ever asked whether THIS thread
// already lived in a desktop app, letting everything else through. The wider ruling closed the
// gap: an orphaned CLI thread or a scheduled run is exactly as unwatchable, so INVISIBLE is the
// property banned, not cross-surface.
//
// The tests below therefore assert the opposite of what their predecessors did. A new chat used to
// "sail through" and allow_headless used to be honoured; both are now refused, because an override
// that defeats "never" is not an override. Everything still funnels through the one chokepoint in
// dispatchItem, which is why one check can hold all five call sites.
//
// Note these run with the escape hatch OFF, unlike the pipeline tests above, which turn it on to
// have any pipeline to test at all.

/** Run `fn` with the ban actually in force, whatever the pipeline tests left set. */
async function withHeadlessBanned(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } finally {
  }
}

/** Write the desktop metadata file that makes a session "resident" in an instance's sidebar. */
function makeDesktopResident(sessionId: string): void {
  const store = join(INSTANCES_ROOT, 'desktoptest', 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, `local_${sessionId}.json`),
    JSON.stringify({ cliSessionId: sessionId, isArchived: false }),
  )
}

/** The OTHER residency shape: a chat CREATED in the app is filed under the app's own id, with the
 *  CLI transcript id only INSIDE the file. 1,325 of 1,343 chats on the owner's real fleet look
 *  like this, so a filename-only guard was blind to 98.7% of what it existed to protect. */
function makeDesktopResidentByContent(cliSessionId: string): void {
  const store = join(INSTANCES_ROOT, 'desktoptest', 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, `local_${crypto.randomUUID()}.json`),
    JSON.stringify({ cliSessionId, isArchived: false, title: 'a chat born in the app' }),
  )
  invalidateSessionMetaCache()
}

test('a chat CREATED in the app (id only inside the file) is refused too, not just imported ones', () =>
  withHeadlessBanned(async () => {
    const item = makeItem({ new_chat: false })
    makeDesktopResidentByContent(item.session_id)
    await dispatch.dispatchItem(item)
    expect(statusOf(item.id)?.status).toBe('failed')
    expect(dispatch.getRunEvents(item.id).some((e) => e.text.includes('no-headless'))).toBe(true)
  }))

test('a headless resume of a DESKTOP-resident chat is refused at the dispatch chokepoint', () =>
  withHeadlessBanned(async () => {
    const item = makeItem({ new_chat: false })
    makeDesktopResident(item.session_id)
    await dispatch.dispatchItem(item)
    // Refused BEFORE any spawn: failed, and the reason names the law rather than looking like a crash.
    expect(statusOf(item.id)?.status).toBe('failed')
    const events = dispatch.getRunEvents(item.id)
    expect(events.some((e) => e.text.includes('no-headless'))).toBe(true)
    expect(events.some((e) => e.text.includes('cannot see'))).toBe(true)
  }))

test('new_chat is NOT a way past the law', () =>
  withHeadlessBanned(async () => {
    // Under the old surface-purity guard this mattered a great deal: the create route accepts a
    // caller-supplied session_id even when new_chat is true, so a request LABELLED "new chat" but
    // pointed at an existing desktop chat wrote headless turns straight into it. The label was
    // never trustworthy. Under the wider law the question does not even arise, which is the point:
    // there is no id, label or route that produces an invisible chat.
    const liar = makeItem({ new_chat: true })
    makeDesktopResident(liar.session_id)
    await dispatch.dispatchItem(liar)
    expect(statusOf(liar.id)?.status).toBe('failed')
    expect(dispatch.getRunEvents(liar.id).some((e) => e.text.includes('no-headless'))).toBe(true)
  }))

// THE TEST THAT CHANGED SIDES. It used to be called "the guard spares a NEW chat and honours the
// owner explicit allow_headless override" and asserted both of those runs COMPLETED. Both are
// refusals now. A genuinely new chat was the largest hole the narrow guard left, because a fresh
// uuid has no desktop entry and so nothing could object to it, and allow_headless was a documented
// way to ask for the banned thing by name.
test('a brand-new chat and an explicit allow_headless override are BOTH refused now', () =>
  withHeadlessBanned(async () => {
    const fresh = makeItem({ new_chat: true })
    await dispatch.dispatchItem(fresh)
    expect(statusOf(fresh.id)?.status).toBe('failed')
    expect(dispatch.getRunEvents(fresh.id).some((e) => e.text.includes('no-headless'))).toBe(true)

    const forced = makeItem({ new_chat: false, allow_headless: true })
    makeDesktopResident(forced.session_id)
    await dispatch.dispatchItem(forced)
    expect(statusOf(forced.id)?.status).toBe('failed')
    expect(dispatch.getRunEvents(forced.id).some((e) => e.text.includes('no-headless'))).toBe(true)
  }))

test('nothing is spawned when a run is refused', () =>
  withHeadlessBanned(async () => {
    // The refusal has to happen BEFORE the spec is written and the detached runner launched, or
    // "refused" would only mean "killed slightly later", with a real child having briefly existed.
    const item = makeItem({ new_chat: true })
    await dispatch.dispatchItem(item)
    expect(statusOf(item.id)?.status).toBe('failed')
    expect(existsSync(join(RUN_LOG_DIR, `${item.id}.log`))).toBe(false)
  }))
