// Pins the two rules that stop the `/usage` probe from being a process mill.
//
// THE INCIDENT THIS COMES FROM (MPC-HELL, 2026-09-07). The monitor ticks every 30 seconds and asks
// for a usage reading. The fast path is a ~300ms API call that spawns nothing; the fallback boots
// the ~250 MB Claude CLI for ~9s. The ambient config dir's OAuth token had `expiresAt: 0`, so the
// fast path 401'd on EVERY call and the daemon had been booting a CLI every ~30 seconds - each one
// dragging the machine's whole MCP roster in with it, 7 child processes a time. Nothing in the log
// named it, because every individual spawn was correct behaviour.
//
// Both halves are tested because each alone leaves the failure reachable: without the flags a
// probe is 8 processes instead of 1, and without the cooldown it happens twice a minute forever.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_PROBE_NO_MCP_ARGS } from '../src/config'
import { cliProbeGate, rememberCliProbe, resetCliProbeCooldowns } from '../src/usage'

const SRC = join(import.meta.dir, '..', 'src')
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

test('the no-MCP probe args disable every configured server, not merely some', () => {
  expect(CLAUDE_PROBE_NO_MCP_ARGS).toContain('--strict-mcp-config')
  // --strict-mcp-config means "only servers from --mcp-config". The empty object is what turns
  // that into NONE; a non-empty one here would silently start servers again.
  const i = CLAUDE_PROBE_NO_MCP_ARGS.indexOf('--mcp-config')
  expect(i).toBeGreaterThanOrEqual(0)
  expect(JSON.parse(CLAUDE_PROBE_NO_MCP_ARGS[i + 1] as string)).toEqual({ mcpServers: {} })
})

// Source assertions, because a spawn cannot be exercised in a unit test and the regression is
// silent: dropping the args costs 7 extra processes per probe and nothing fails.
test.each([
  ['usage.ts', "'/usage'"],
  ['session-keepalive.ts', 'KEEPALIVE_PROMPT'],
])('the %s probe spawn still passes the no-MCP args', (file, marker) => {
  const src = read(file)
  const spawnLine = src.split('\n').find((l) => l.includes('Bun.spawn([resolveClaudeExe()'))
  expect(spawnLine).toBeDefined()
  expect(spawnLine).toContain(marker)
  expect(spawnLine).toContain('...CLAUDE_PROBE_NO_MCP_ARGS')
})

test('a second CLI probe for the same key inside the cooldown is refused', () => {
  resetCliProbeCooldowns()
  const t0 = 1_000_000
  expect(cliProbeGate('acct-a', t0).allow).toBe(true)
  rememberCliProbe('acct-a', t0)
  // 30s later is the monitor's very next tick - the exact case that produced the storm.
  expect(cliProbeGate('acct-a', t0 + 30_000).allow).toBe(false)
  expect(cliProbeGate('acct-a', t0 + 4 * 60_000).allow).toBe(false)
  expect(cliProbeGate('acct-a', t0 + 5 * 60_000).allow).toBe(true)
})

test('the cooldown is per key, so one stuck account cannot mute the others', () => {
  resetCliProbeCooldowns()
  const t0 = 2_000_000
  rememberCliProbe('acct-a', t0)
  expect(cliProbeGate('acct-a', t0 + 1000).allow).toBe(false)
  expect(cliProbeGate('acct-b', t0 + 1000).allow).toBe(true)
})

test('a refused probe hands back the last REAL reading, never a fresh no-data', () => {
  resetCliProbeCooldowns()
  const t0 = 3_000_000
  const real = {
    account: 'acct-a',
    session: { usedPct: 42, resets: null },
    weekAll: null,
    weekModel: null,
    capturedAt: '2026-09-07T00:00:00.000Z',
  }
  rememberCliProbe('acct-a', t0, real as never)
  const gate = cliProbeGate('acct-a', t0 + 30_000)
  expect(gate.allow).toBe(false)
  // Callers are told never to read no-data as 0%. A stale true number beats a hole.
  expect(gate.cached).toEqual(real as never)
})

test('a no-data reading is not remembered, so one hiccup cannot look like a dead account', () => {
  resetCliProbeCooldowns()
  const t0 = 4_000_000
  const empty = {
    account: 'acct-c',
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: 'x',
  }
  rememberCliProbe('acct-c', t0, empty as never)
  expect(cliProbeGate('acct-c', t0 + 1000).cached).toBeNull()
})
