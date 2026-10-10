// server/src/keep-awake.ts - the PC is held awake exactly while something works: a live working
// session heard within the lease, or a running CliMayte worker. Restored, stale, blocked and finished
// rows never hold it, the switch releases it, and the OS is asked once per change, not once a tick.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'

// db.ts opens the file on import, so the scratch home has to be in place first.
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-keep-awake-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { db } = await import('../src/db')
const { hookEventFromPayload, hydrateAgentStatus, recordAgentStatus } = await import(
  '../src/agent-status'
)
const { KEEP_AWAKE_LEASE_MS, countWorkingSessions, createKeepAwake } = await import(
  '../src/keep-awake'
)

const NOW = Date.parse('2001-01-01T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const hook = (sessionId: string, event: string, msAgo: number, extra = {}) => {
  const e = hookEventFromPayload(
    { session_id: sessionId, hook_event_name: event, ...extra },
    at(msAgo),
  )
  if (!e) throw new Error('payload rejected')
  recordAgentStatus(e)
}

beforeEach(() => {
  db.exec('delete from agent_status')
})
// The db stays open: other test files in the same run share the module (agent-status.test.ts does
// the same).
afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // the open db file may still be held on Windows
  }
})

describe('countWorkingSessions', () => {
  test('counts only live working rows inside the lease', () => {
    hook('working-now', 'UserPromptSubmit', 60_000)
    hook('working-old', 'UserPromptSubmit', KEEP_AWAKE_LEASE_MS + 60_000)
    hook('finished', 'UserPromptSubmit', 120_000)
    hook('finished', 'Stop', 60_000)
    hook('asking', 'UserPromptSubmit', 120_000)
    hook('asking', 'Notification', 60_000, { notification_type: 'permission_prompt' })
    expect(countWorkingSessions(NOW)).toBe(1)
  })

  test('a row restored from before a restart never holds the PC', () => {
    hook('working-now', 'UserPromptSubmit', 60_000)
    hydrateAgentStatus()
    expect(countWorkingSessions(NOW)).toBe(0)
    // The next event for it is live again.
    hook('working-now', 'PreToolUse', 1_000, { tool_name: 'Bash' })
    expect(countWorkingSessions(NOW)).toBe(1)
  })
})

describe('createKeepAwake', () => {
  function rig(initial: { sessions: number; workers: number }) {
    const calls: string[] = []
    let enabled = true
    let counts: { sessions: number; workers: number } | Error = initial
    const ka = createKeepAwake({
      holder: {
        kind: 'windows',
        hold: () => calls.push('hold'),
        release: () => calls.push('release'),
      },
      enabled: () => enabled,
      counts: () => {
        if (counts instanceof Error) throw counts
        return counts
      },
      now: () => NOW,
    })
    return {
      ka,
      calls,
      set: (c: typeof counts) => (counts = c),
      enable: (v: boolean) => (enabled = v),
    }
  }

  test('holds while work runs, once, and releases when it stops', () => {
    const r = rig({ sessions: 0, workers: 1 })
    expect(r.ka.refresh()).toMatchObject({ active: true, workers: 1, since: at(0) })
    r.ka.refresh()
    r.set({ sessions: 2, workers: 0 })
    r.ka.refresh()
    expect(r.calls).toEqual(['hold'])
    r.set({ sessions: 0, workers: 0 })
    expect(r.ka.refresh()).toMatchObject({ active: false, since: null })
    expect(r.calls).toEqual(['hold', 'release'])
  })

  test('the switch off releases at once and holds nothing after', () => {
    const r = rig({ sessions: 1, workers: 0 })
    r.ka.refresh()
    r.enable(false)
    expect(r.ka.refresh()).toMatchObject({ enabled: false, active: false })
    r.ka.refresh()
    expect(r.calls).toEqual(['hold', 'release'])
  })

  test('a failed count keeps the last decision instead of reading as idle', () => {
    const r = rig({ sessions: 0, workers: 1 })
    r.ka.refresh()
    r.set(new Error('disk busy'))
    const s = r.ka.refresh()
    expect(s.active).toBe(true)
    expect(s.error).toContain('disk busy')
    expect(r.calls).toEqual(['hold'])
  })

  test('a refused hold is reported and retried on the next tick', () => {
    let refuse = true
    const calls: string[] = []
    const ka = createKeepAwake({
      holder: {
        kind: 'windows',
        hold: () => {
          calls.push('hold')
          if (refuse) throw new Error('refused')
        },
        release: () => calls.push('release'),
      },
      enabled: () => true,
      counts: () => ({ sessions: 1, workers: 0 }),
      now: () => NOW,
    })
    expect(ka.refresh()).toMatchObject({ active: false, error: 'hold failed: refused' })
    refuse = false
    expect(ka.refresh()).toMatchObject({ active: true, error: null })
    expect(calls).toEqual(['hold', 'hold'])
  })
})
