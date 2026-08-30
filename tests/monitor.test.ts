// server/tests/monitor.test.ts — the auto-resume monitor state machine (server/src/monitor.ts).
//
// Covers the enabled gate, candidate selection, every outcome of the usage gate (unreadable →
// needs_human, weekly maxed → blocked_weekly, weekly has room → scheduled), idempotency, the
// per-account override, and the settings round-trip. Uses the isolated test DB (tests/setup.ts).
//
// The usage reading is injected via MonitorDeps, which is what lets the gate be tested at all. It
// used to be unreachable here: a run with no dispatch account short-circuited to needs_human before
// the gate, and every test ran with no account, so the whole scheduling path was left to manual
// verification. Now that ambient runs go through the gate like any other, a real read would hit the
// network with the developer's own login (or spawn `claude -p "/usage"`, ~9s) — so the snapshot is
// handed in instead. Deliberately NOT mock.module: in Bun that is global for the whole run and leaks
// into every other test file (it broke desktop-install.test.ts when tried).

import { afterEach, describe, expect, test } from 'bun:test'
import { db, getSetting, setSetting } from '../server/src/db'
import {
  getMonitorSettings,
  listMonitorAccounts,
  type MonitorDeps,
  monitorEnabledForAccount,
  monitorStatus,
  pickLandingInstance,
  resumeSurfaceFor,
  runMonitorOnce,
  setMonitorForAccount,
  setMonitorSettings,
} from '../server/src/monitor'
import type { RateLimitedStop } from '../server/src/rate-limit-discovery'
import type { UsageSnapshot } from '../server/src/types'

const snapshot = (weekAllPct: number | null): UsageSnapshot => ({
  account: 'test',
  session: {
    pct: 50,
    resets: 'Jul 15, 6:00pm',
    resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  weekAll: weekAllPct === null ? null : { pct: weekAllPct, resets: 'Jul 19, 3:59am' },
  weekModel: null,
  capturedAt: new Date().toISOString(),
})

/**
 * A usage reader that always answers with `snap`, and counts the accountIds it was asked about.
 * `stops` are transcript-discovered stops to hand the monitor — empty by default, so a test that
 * only cares about dispatched runs never touches the real ~/.claude transcript store.
 */
function reader(
  snap: UsageSnapshot,
  stops: RateLimitedStop[] = [],
): MonitorDeps & { asked: (string | null)[] } {
  const asked: (string | null)[] = []
  return {
    asked,
    readUsage: async (accountId) => {
      asked.push(accountId)
      return snap
    },
    discoverStops: async () => stops,
  }
}

/** A stop the monitor FOUND on disk: no queue_items row exists for it, by definition. Mirrors what
 *  rate-limit-discovery.ts builds for a session the user ran in a terminal. */
function discoveredStop(sessionId: string, title = 'a terminal session'): RateLimitedStop {
  return {
    id: `disc:${sessionId}`,
    session_id: sessionId,
    title,
    cwd: 'D:/x',
    prompt: '',
    model: null,
    effort: null,
    permission_mode: null,
    account_id: null,
    instance_ref: null,
    new_chat: false,
    fork: false,
    status: 'rate_limited',
    pid: null,
    position: 0,
    not_before: null,
    retry_attempts: 0,
    started_at: null,
    finished_at: new Date().toISOString(),
    exit_code: null,
    created_at: Date.now(),
    discovered: true,
  }
}

const PREFIX = 'MONTEST_'

function insertRateLimited(
  id: string,
  sessionId: string,
  accountId: string | null = null,
  instanceRef: string | null = null,
): void {
  db.query(
    `insert into queue_items (id, session_id, title, cwd, prompt, account_id, instance_ref, status, position, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'rate_limited', 0, ?)`,
  ).run(id, sessionId, 'test run', 'D:/x', 'do work', accountId, instanceRef, Date.now())
}

function stateFor(itemId: string) {
  return monitorStatus().find((r) => r.itemId === itemId) ?? null
}

afterEach(() => {
  db.query(`delete from monitor_state where item_id like '${PREFIX}%'`).run()
  db.query(`delete from monitor_state where item_id like 'disc:${PREFIX}%'`).run()
  db.query(`delete from queue_items where id like '${PREFIX}%'`).run()
  db.query(`delete from queue_items where title like 'Auto-resume: test run%'`).run()
  db.query(`delete from queue_items where title like 'Auto-resume: a terminal session%'`).run()
  db.query(`delete from monitor_accounts where account_id like '${PREFIX}%'`).run()
  setSetting('monitor_enabled', '0')
})

describe('monitor gate', () => {
  test('does nothing when disabled', async () => {
    setSetting('monitor_enabled', '0')
    insertRateLimited(`${PREFIX}a`, `${PREFIX}sess-a`)
    await runMonitorOnce(reader(snapshot(10)))
    expect(stateFor(`${PREFIX}a`)).toBeNull()
  })

  // The regression this guards: a run with no dispatch account is the DEFAULT (the accounts table is
  // empty until someone pastes a token in), and it used to be parked at needs_human on sight — so the
  // monitor resumed nothing at all for the common case. Ambient is a readable login, not a dead end.
  test('a run with no account is gated on the AMBIENT login, not refused for lacking an account', async () => {
    setSetting('monitor_enabled', '1')
    const deps = reader(snapshot(10)) // weekly has room
    insertRateLimited(`${PREFIX}b`, `${PREFIX}sess-b`)
    await runMonitorOnce(deps)
    const s = stateFor(`${PREFIX}b`)
    // asked about the AMBIENT login (null account) instead of refusing on sight
    expect(deps.asked).toEqual([null])
    expect(s?.state).toBe('scheduled')
    expect(s?.resumeItemId).not.toBeNull()
    // the scheduled resume is a real queued item carrying the locked prompt
    const resume = db
      .query<{ prompt: string; status: string; not_before: string | null }, [string]>(
        'select prompt, status, not_before from queue_items where id = ?',
      )
      .get(s?.resumeItemId as string)
    expect(resume?.status).toBe('queued')
    expect(resume?.prompt).toBe('resume')
    expect(resume?.not_before).not.toBeNull()
  })

  test('an unreadable usage reading is never treated as "plenty left"', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}d`, `${PREFIX}sess-d`)
    await runMonitorOnce(reader(snapshot(null))) // no weekAll = no reading
    const s = stateFor(`${PREFIX}d`)
    expect(s?.state).toBe('needs_human')
    expect(s?.resumeItemId).toBeNull()
  })

  test('a maxed weekly cap blocks the resume rather than slamming the wall', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}e`, `${PREFIX}sess-e`)
    await runMonitorOnce(reader(snapshot(100)))
    const s = stateFor(`${PREFIX}e`)
    expect(s?.state).toBe('blocked_weekly')
    expect(s?.resumeItemId).toBeNull()
  })

  // The regression this guards: enqueueResume's INSERT used to omit instance_ref, so an
  // instance-pinned run that got auto-resumed silently lost its pin and resumed as Ambient —
  // defeating the entire point of pinning (wrong credentials, and never surfaced as an error).
  test('a rate-limited run pinned to an instance carries that pin forward into its auto-resume', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}f`, `${PREFIX}sess-f`, null, 'desktop:C:\\fake\\dir')
    await runMonitorOnce(reader(snapshot(10)))
    const s = stateFor(`${PREFIX}f`)
    expect(s?.state).toBe('scheduled')
    const resume = db
      .query<{ instance_ref: string | null }, [string]>(
        'select instance_ref from queue_items where id = ?',
      )
      .get(s?.resumeItemId as string)
    expect(resume?.instance_ref).toBe('desktop:C:\\fake\\dir')
  })

  test('is idempotent — a second pass does not add a duplicate state row or a second resume', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}c`, `${PREFIX}sess-c`)
    await runMonitorOnce(reader(snapshot(10)))
    await runMonitorOnce(reader(snapshot(10)))
    const mine = monitorStatus().filter((r) => r.itemId === `${PREFIX}c`)
    expect(mine.length).toBe(1)
    const resumes = db
      .query<{ n: number }, [string]>(
        "select count(*) as n from queue_items where session_id = ? and title like 'Auto-resume:%'",
      )
      .get(`${PREFIX}sess-c`)
    expect(resumes?.n).toBe(1)
  })
})

// The bug these cover, verbatim: the resume list said "Nothing to resume right now" while two real
// sessions sat stopped at a session limit, because a session the user ran in a terminal never gets a
// queue_items row and processRateLimited only ever read that table. Measured on a real machine
// 2026-07-16 — 2 pending stops on disk, 0 of them reachable by any code path.
describe('discovered stops (sessions we never dispatched)', () => {
  test('a rate-limited session with NO queue row still reaches the resume list', async () => {
    setSetting('monitor_enabled', '1')
    const stop = discoveredStop(`${PREFIX}sess-d`)
    const deps = reader(snapshot(10), [stop])
    await runMonitorOnce(deps)
    const s = stateFor(`disc:${PREFIX}sess-d`)
    expect(s).not.toBeNull()
    expect(s?.state).toBe('scheduled')
    // it is flagged as found-on-disk, and carries its own title (there is no queue row to join)
    expect(s?.discovered).toBe(true)
    expect(s?.title).toBe('a terminal session')
    // ...and the resume it scheduled is a real queued run against that session
    const resume = db
      .query<{ session_id: string; status: string }, [string]>(
        'select session_id, status from queue_items where id = ?',
      )
      .get(s?.resumeItemId as string)
    expect(resume?.session_id).toBe(`${PREFIX}sess-d`)
    expect(resume?.status).toBe('queued')
  })

  test('a discovered stop passes the SAME weekly gate as a dispatched one', async () => {
    // No special path: a maxed weekly blocks a found session exactly like one of our own runs.
    setSetting('monitor_enabled', '1')
    await runMonitorOnce(reader(snapshot(100), [discoveredStop(`${PREFIX}sess-e`)]))
    expect(stateFor(`disc:${PREFIX}sess-e`)?.state).toBe('blocked_weekly')
  })

  test('a discovered stop is gated on the ambient login', async () => {
    // A terminal session has no pasted credential, so account_id is null by construction — which
    // must mean "read the ambient login's quota", not "refuse for lacking an account".
    setSetting('monitor_enabled', '1')
    const deps = reader(snapshot(10), [discoveredStop(`${PREFIX}sess-f`)])
    await runMonitorOnce(deps)
    expect(deps.asked).toEqual([null])
  })

  test('re-running discovery does not double-queue a resume for the same session', async () => {
    setSetting('monitor_enabled', '1')
    const stop = discoveredStop(`${PREFIX}sess-g`)
    await runMonitorOnce(reader(snapshot(10), [stop]))
    // A real second pass would no longer find it (the transcript has bytes after the notice, and it
    // now owns a queue row) — but if it DID, the idempotency rails must still hold.
    await runMonitorOnce(reader(snapshot(10), [stop]))
    const resumes = db
      .query<{ n: number }, [string]>(
        "select count(*) as n from queue_items where session_id = ? and title like 'Auto-resume:%'",
      )
      .get(`${PREFIX}sess-g`)
    expect(resumes?.n).toBe(1)
  })

  test('discovery is off while the monitor is off', async () => {
    // The whole feature stays behind the master switch — it auto-prompts sessions while you sleep.
    setSetting('monitor_enabled', '0')
    let asked = false
    await runMonitorOnce({
      readUsage: async () => snapshot(10),
      discoverStops: async () => {
        asked = true
        return []
      },
    })
    expect(asked).toBe(false)
  })

  test('a discovery failure never takes the dispatched path down with it', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}h`, `${PREFIX}sess-h`)
    await runMonitorOnce({
      readUsage: async () => snapshot(10),
      discoverStops: async () => {
        throw new Error('transcript store unreadable')
      },
    })
    // the run we DID dispatch is still scheduled
    expect(stateFor(`${PREFIX}h`)?.state).toBe('scheduled')
  })

  test('a dispatched stop is not flagged as discovered', async () => {
    setSetting('monitor_enabled', '1')
    insertRateLimited(`${PREFIX}i`, `${PREFIX}sess-i`)
    await runMonitorOnce(reader(snapshot(10)))
    expect(stateFor(`${PREFIX}i`)?.discovered).toBe(false)
  })
})

describe('per-account override', () => {
  test('an explicit disabled row opts an account out; others default on', () => {
    setMonitorForAccount(`${PREFIX}acc1`, false)
    expect(monitorEnabledForAccount(`${PREFIX}acc1`)).toBe(false)
    expect(monitorEnabledForAccount(`${PREFIX}acc2`)).toBe(true) // absent row = follow global
    expect(listMonitorAccounts()[`${PREFIX}acc1`]).toBe(false)
  })
})

// The list is a to-do, not a ledger. Before this, nothing ever revisited a 'scheduled' row: the row
// was written the moment a resume was enqueued and then never looked at again (processRateLimited
// skips stops it has already seen, dispatchDueResumes only dispatches, and dispatch.ts's finalize /
// cancelItem touch queue_items alone). So a resume that ran to completion months ago still reported
// "Scheduled · resumes ~09:14" forever, and deleting its queue item left a row pointing at nothing.
// That is what filled the panel with runs the user knew were long finished.
describe('settling finished resumes', () => {
  /** Put a row in the 'scheduled' state with a resume item in `status`, the way a real pass would. */
  function scheduledWithResume(suffix: string, status: string | null): string {
    const itemId = `${PREFIX}sch-${suffix}`
    const resumeId = `${PREFIX}res-${suffix}`
    insertRateLimited(itemId, `${PREFIX}sess-${suffix}`)
    if (status !== null) {
      db.query(
        `insert into queue_items (id, session_id, title, cwd, prompt, status, position, created_at)
         values (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        resumeId,
        `${PREFIX}sess-${suffix}`,
        'Auto-resume: test run',
        'D:/x',
        'resume',
        status,
        Date.now(),
      )
    }
    db.query(
      `insert into monitor_state
         (item_id, session_id, account_id, resume_attempts, state, resume_item_id, message, next_check_at, updated_at, title, discovered)
       values (?, ?, null, 1, 'scheduled', ?, 'resumes ~09:14', null, ?, 'test run', 0)`,
    ).run(itemId, `${PREFIX}sess-${suffix}`, resumeId, new Date().toISOString())
    return itemId
  }

  test('a resume that finished stops being listed', () => {
    const id = scheduledWithResume('done', 'completed')
    expect(stateFor(id)).toBeNull()
  })

  test('a resume the user cancelled stops being listed', () => {
    const id = scheduledWithResume('cancelled', 'canceled')
    expect(stateFor(id)).toBeNull()
  })

  test('a resume whose queue item was deleted stops being listed', () => {
    // The orphan case: "Scheduled, resumes ~09:14" pointing at a row that no longer exists.
    const id = scheduledWithResume('orphan', null)
    expect(stateFor(id)).toBeNull()
  })

  test('a resume that FAILED is kept, and asks for a human', () => {
    // Not settled away: a failed resume is the one outcome that still wants attention.
    const id = scheduledWithResume('failed', 'failed')
    const row = stateFor(id)
    expect(row?.state).toBe('needs_human')
  })

  test('a resume still queued is left alone', () => {
    const id = scheduledWithResume('pending', 'queued')
    const row = stateFor(id)
    expect(row?.state).toBe('scheduled')
    expect(row?.message).toBe('resumes ~09:14')
  })

  test('a running resume is left alone', () => {
    const id = scheduledWithResume('running', 'running')
    expect(stateFor(id)?.state).toBe('scheduled')
  })

  test('the row survives so the per-session attempt count is not lost', () => {
    // Settling is about what is SHOWN. The row itself carries resume_attempts, which the cap
    // depends on, so dropping it would silently hand every session a fresh set of attempts.
    const id = scheduledWithResume('kept', 'completed')
    expect(stateFor(id)).toBeNull()
    const raw = db
      .query<{ state: string; resume_attempts: number }, [string]>(
        'select state, resume_attempts from monitor_state where item_id = ?',
      )
      .get(id)
    expect(raw?.state).toBe('done')
    expect(raw?.resume_attempts).toBe(1)
  })
})

describe('settings', () => {
  test('round-trips maxAttempts + resumeBufferMin and keeps a sane resumePrompt', () => {
    setMonitorSettings({ maxAttempts: 5, resumeBufferMin: 10 })
    const s = getMonitorSettings()
    expect(s.maxAttempts).toBe(5)
    expect(s.resumeBufferMin).toBe(10)
    expect(s.resumePrompt.length).toBeGreaterThan(0)
    // restore defaults for the shared test DB
    setSetting('monitor_max_attempts', '3')
    setSetting('monitor_resume_buffer_min', '3')
    expect(getSetting('monitor_max_attempts')).toBe('3')
  })
})

// --- where a due resume is delivered ------------------------------------------
// Owner law 2026-08-27: "We should never have any headless chats. No headless." And surface
// purity (2026-08-28): desktop stays desktop, console stays console. The function returns a
// two-member type with no headless answer in it, so the law holds by construction rather than
// by a branch someone could put back.
describe('resume surface', () => {
  test('a thread living in a desktop app stays native', () => {
    expect(resumeSurfaceFor(true)).toBe('native')
  })

  test('everything else LANDS in a desktop app - never a console, never headless', () => {
    // Owner ruling 2026-08-29: automation never opens a console; a homeless chat is imported
    // into a desktop instance. The type has no 'terminal' member to regress back to.
    expect(resumeSurfaceFor(false)).toBe('land')
    expect(resumeSurfaceFor(undefined)).toBe('land')
    expect(resumeSurfaceFor()).toBe('land')
  })
})

describe('landing instance pick', () => {
  const inst = (ref: string, num: number, isRunning = true, signedIn = true) => ({
    ref,
    num,
    isRunning,
    signedIn,
  })
  const use = (ref: string, weeklyPct: number | null, stale = false) => ({ ref, weeklyPct, stale })

  test('the pinned instance wins when it is running', () => {
    // Backslashes built with fromCharCode on purpose (usage-probe.test.ts documents why):
    // the point of this fixture is that slash STYLE must not break the pinned match.
    const BS = String.fromCharCode(92)
    const t = pickLandingInstance(
      'desktop:C:/i/mine',
      [inst('desktop:C:/i/other', 1), inst(`desktop:C:${BS}i${BS}mine`, 7)],
      [use('desktop:C:/i/other', 5), use('desktop:C:/i/mine', 90)],
    )
    expect(t?.num).toBe(7) // pinned beats headroom, and slash style must not break the match
  })

  test('otherwise the running signed-in instance with lowest fresh weekly wins; #num settles ties', () => {
    const t = pickLandingInstance(
      null,
      [
        inst('desktop:a', 3),
        inst('desktop:b', 1),
        inst('desktop:c', 2, false),
        inst('desktop:d', 4, true, false),
      ],
      [use('desktop:a', 40), use('desktop:b', 40), use('desktop:c', 1), use('desktop:d', 0)],
    )
    expect(t?.num).toBe(1) // c not running, d not signed in, a/b tie on 40 -> lower #num
  })

  test('stale usage counts as unknown and sorts behind fresh numbers', () => {
    const t = pickLandingInstance(
      null,
      [inst('desktop:fresh', 9), inst('desktop:stale', 1)],
      [use('desktop:fresh', 80), use('desktop:stale', 2, true)],
    )
    expect(t?.ref).toBe('desktop:fresh')
  })

  test('no running signed-in instance means null - the caller parks honestly', () => {
    expect(pickLandingInstance(null, [inst('desktop:x', 1, false)], [])).toBe(null)
    expect(pickLandingInstance(null, [], [])).toBe(null)
  })
})
