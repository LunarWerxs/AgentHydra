// server/src/agent-status.ts + status-hooks.ts - the live status store's three rules (precedence at
// write, restored rows never live, the sub-agent fold) and the hook installer's promise to touch
// only its own hooks.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// db.ts opens the file on import, so the scratch home has to be in place first (same pattern as
// incidents.test.ts).
const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-agent-status-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = scratch

const { db } = await import('../src/db')
const {
  getAgentStatus,
  hookEventFromPayload,
  hydrateAgentStatus,
  recordAgentStatus,
  releaseRateLimitStatus,
} = await import('../src/agent-status')
const { HOOK_PATH, STATUS_HOOK_EVENTS, installedHookUrl, setStatusHooks, withStatusHooks } =
  await import('../src/status-hooks')

const SID = 'sess-1'
let clock = Date.parse('2026-09-25T10:00:00.000Z')
/** Each call is one second after the last, so "newer" is never ambiguous. */
const tick = () => {
  clock += 1000
  return new Date(clock).toISOString()
}
const hook = (event: string, extra: Record<string, unknown> = {}) => {
  const e = hookEventFromPayload({ session_id: SID, hook_event_name: event, ...extra }, tick())
  if (!e) throw new Error('payload rejected')
  return recordAgentStatus(e)
}

beforeEach(() => {
  db.exec('delete from agent_status')
})

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // scratch cleanup is best-effort
  }
})

describe('sub-agent fold', () => {
  test('a lead that finished while its sub-agent runs reads working, then done when it stops', () => {
    hook('UserPromptSubmit')
    hook('PreToolUse', { tool_name: 'Agent' })
    hook('Stop')
    const mid = getAgentStatus(SID)
    expect(mid?.state).toBe('working')
    expect(mid?.mainState).toBe('done')
    expect(mid?.subagents).toBe(1)
    hook('SubagentStop')
    expect(getAgentStatus(SID)?.state).toBe('done')
  })

  test("a sub-agent's own tool call does not make a finished lead working", () => {
    hook('UserPromptSubmit')
    hook('PreToolUse', { tool_name: 'Task' })
    hook('Stop')
    hook('PreToolUse', { tool_name: 'Bash', agent_id: 'a1' })
    expect(getAgentStatus(SID)?.mainState).toBe('done')
  })
})

describe('waiting on you', () => {
  test('a permission prompt blocks a working session and the next tool event clears it', () => {
    hook('UserPromptSubmit')
    hook('Notification', { notification_type: 'permission_prompt' })
    const blocked = getAgentStatus(SID)
    expect(blocked?.state).toBe('blocked')
    expect(blocked?.waiting).toBe('permission_prompt')
    hook('PostToolUse', { tool_name: 'Bash' })
    expect(getAgentStatus(SID)?.state).toBe('working')
  })

  test('the idle reminder after a finished turn leaves it done', () => {
    hook('UserPromptSubmit')
    hook('Stop')
    expect(hook('Notification', { notification_type: 'idle_prompt' }).outcome).toBe('ignored')
    expect(getAgentStatus(SID)?.state).toBe('done')
  })
})

describe('precedence at write', () => {
  const limit = (at: string) =>
    recordAgentStatus({ sessionId: SID, source: 'rate-limit', event: 'rate-limit', at })

  test('a usage wall older than later work is stale and changes nothing', () => {
    const stoppedAt = tick()
    hook('UserPromptSubmit')
    expect(limit(stoppedAt).outcome).toBe('ignored')
    expect(getAgentStatus(SID)?.state).toBe('working')
  })

  test("a usage wall outranks the same turn's Stop that the hook reported a moment later", () => {
    hook('UserPromptSubmit')
    const stoppedAt = tick()
    hook('Stop')
    const after = limit(stoppedAt)
    expect(after.outcome).toBe('applied')
    expect(after.status?.state).toBe('blocked')
    expect(after.status?.waiting).toBe('rate-limit')
    expect(after.status?.source).toBe('rate-limit')
  })
})

// Contract: a rate-limit row lives only while the scan still finds its stop. Regression: without the
// hooks nothing else writes for that session, so a resumed session read "waiting on you" until the
// next restart. Seam: the scan's release call (monitor.ts) into the store.
describe('rate-limit release', () => {
  const limit = (sessionId: string) =>
    recordAgentStatus({ sessionId, source: 'rate-limit', event: 'rate-limit', at: tick() })

  test('a stop the scan no longer finds is dropped; one it still finds stays blocked', () => {
    limit(SID)
    limit('sess-2')
    expect(releaseRateLimitStatus(['sess-2'])).toBe(1)
    expect(getAgentStatus(SID)).toBeNull()
    expect(getAgentStatus('sess-2')?.state).toBe('blocked')
  })

  test('a row a hook wrote since is not the scan to drop', () => {
    limit(SID)
    hook('UserPromptSubmit')
    expect(releaseRateLimitStatus([])).toBe(0)
    expect(getAgentStatus(SID)?.state).toBe('working')
  })
})

describe('restored rows', () => {
  test('a row read back after a restart is never live, and its sub-agent count is not carried on', () => {
    hook('UserPromptSubmit')
    hook('PreToolUse', { tool_name: 'Agent' })
    hydrateAgentStatus()
    const restored = getAgentStatus(SID)
    expect(restored?.restoredUnconfirmed).toBe(true)
    hook('Stop')
    const live = getAgentStatus(SID)
    expect(live?.restoredUnconfirmed).toBe(false)
    expect(live?.subagents).toBe(0)
    expect(live?.state).toBe('done')
  })
})

test('a hook payload with no session id is refused, and prompt text is never kept', () => {
  expect(hookEventFromPayload({ hook_event_name: 'Stop' }, tick())).toBeNull()
  const e = hookEventFromPayload(
    { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'secret plan' },
    tick(),
  )
  expect(JSON.stringify(e)).not.toContain('secret plan')
})

describe('status hooks installer', () => {
  const URL_A = 'http://127.0.0.1:7787'
  const foreign = { hooks: [{ type: 'command', command: 'echo mine' }] }

  test("installs every event, keeps the user's own hooks, re-points on a port hop, removes only its own", () => {
    const start = { theme: 'dark', hooks: { Stop: [foreign] } }
    const installed = withStatusHooks(start, URL_A)
    const hooks = installed.hooks as Record<string, unknown[]>
    for (const event of STATUS_HOOK_EVENTS)
      expect(hooks[event]).toHaveLength(event === 'Stop' ? 2 : 1)
    expect(hooks.Stop[0]).toEqual(foreign)
    expect(JSON.stringify(hooks.PreToolUse)).toContain(`${URL_A}${HOOK_PATH}`)

    const hopped = withStatusHooks(
      withStatusHooks(installed, 'http://127.0.0.1:7788'),
      'http://127.0.0.1:7788',
    )
    expect(installedHookUrl(hopped)).toBe('http://127.0.0.1:7788')
    expect((hopped.hooks as Record<string, unknown[]>).Stop).toHaveLength(2)

    expect(withStatusHooks(hopped, null)).toEqual(start)
  })

  test('an unreadable settings file is reported and left untouched', () => {
    mkdirSync(scratch, { recursive: true })
    const path = join(scratch, 'settings.json')
    writeFileSync(path, '{ not json', 'utf8')
    const r = setStatusHooks(URL_A, path)
    expect(r.error).toContain('not valid JSON')
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(existsSync(path)).toBe(true)
  })
})
