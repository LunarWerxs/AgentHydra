// The `unblock_prompts` MCP tool, pinned at the same seam as orchestrator-mcp.test.ts and
// fan-out-mcp.test.ts: what it SENDS to the daemon for a given argument shape, and the one thing
// it refuses to send. The daemon is a fetch stub; nothing here spawns python, presses a button, or
// needs a fleet. unblock_prompts.py's own behaviour is proven by its Python suite.
//
// THE TEST THAT MATTERS IS THE VERSION-SKEW ONE. The daemon runs whatever orchestrator copy is
// installed beside it, and that script reads argv by lookup, so a copy predating `--session`
// ignores it and sweeps the whole fleet. With `--yes` attached that presses prompts in chats
// nobody named, and nothing anywhere would say so. The tool plans first and refuses; the
// assertion below is that NO acting call is made when the plan comes back without `supports`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
let answer: (url: string, body: Record<string, unknown> | null) => unknown = () => ({ ok: true })
const originalFetch = globalThis.fetch

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

/** Every run call's argv, in order. */
function argvs(): string[][] {
  return calls
    .filter((c) => c.url.includes('/api/orchestrator/run'))
    .map((c) => (c.body as { args: string[] }).args)
}

/** A daemon whose unblock_prompts answers with this report on stdout. */
function reports(report: unknown, exitCode = 0) {
  answer = () => ({ ok: true, exitCode, stdout: JSON.stringify(report), stderr: '' })
}

const SUPPORTED = { supports: ['session', 'min-wait'], stuck: [], results: [], notFound: [] }

beforeEach(() => {
  calls = []
  answer = () => ({ ok: true })
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), method: init?.method ?? 'GET', body })
    return new Response(JSON.stringify(answer(String(url), body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('the tool says what it is', () => {
  test('is registered, MUTATES, and states the tray-icon requirement in its own description', () => {
    const t = tool('unblock_prompts')
    expect((t.inputSchema as { type: string }).type).toBe('object')
    expect(t.description).toContain('MUTATES:')
    expect(t.description.toLowerCase()).toContain('tray icon')
    // The stall it exists for: fan_out_send cannot clear a chat whose engine reads working.
    expect(t.description).toContain('fan_out_send')
  })
})

describe('what it sends to the daemon', () => {
  test('a targeted act plans FIRST, then acts, and only the second call carries --yes', async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({ session: 'sid-1' })
    const [plan, act] = argvs()
    expect(plan).toEqual(['--json', '--session', 'sid-1'])
    expect(act).toEqual(['--json', '--session', 'sid-1', '--yes'])
    expect(calls[0]!.body).toMatchObject({ script: 'unblock_prompts' })
  })

  test('REFUSES to act when the orchestrator does not name --session, and sends no act call', async () => {
    reports({ stuck: [], results: [] }) // an older build: no `supports` key at all
    await expect(tool('unblock_prompts').run({ session: 'sid-1' })).rejects.toThrow(
      /predates `--session`/,
    )
    // The whole point: exactly ONE call happened, and it was the plan.
    expect(argvs()).toHaveLength(1)
    expect(argvs()[0]).not.toContain('--yes')
  })

  test('a dry run never asks twice and never carries --yes', async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({ session: 'sid-1', dry_run: true })
    expect(argvs()).toEqual([['--json', '--session', 'sid-1']])
  })

  test('an untargeted sweep acts in one call, with no plan probe', async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({})
    expect(argvs()).toEqual([['--json', '--yes']])
  })

  test('several sessions each become their own --session flag', async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({ session: ['a', 'b'], dry_run: true })
    expect(argvs()[0]).toEqual(['--json', '--session', 'a', '--session', 'b'])
  })

  test("force, max and min_wait_secs map onto the script's own flags", async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({ session: 'a', force: true, max: 2, min_wait_secs: 0 })
    expect(argvs()[1]).toEqual([
      '--json',
      '--session',
      'a',
      '--min-wait',
      '0',
      '--max',
      '2',
      '--yes',
      '--force',
    ])
  })

  test('blank and non-string session values are dropped rather than sent as empty flags', async () => {
    reports(SUPPORTED)
    await tool('unblock_prompts').run({ session: ['  ', 'real'], dry_run: true })
    expect(argvs()[0]).toEqual(['--json', '--session', 'real'])
  })
})

describe('what it hands back', () => {
  test("the script's parsed report rides alongside the raw run result", async () => {
    reports({ ...SUPPORTED, notFound: [{ sessionId: 'ghost', why: 'not waiting' }] })
    const out = (await tool('unblock_prompts').run({ session: 'ghost', dry_run: true })) as {
      exitCode: number
      report: { notFound: { sessionId: string }[] }
    }
    expect(out.exitCode).toBe(0)
    expect(out.report.notFound[0]!.sessionId).toBe('ghost')
  })

  test('a non-JSON stdout leaves report null instead of throwing', async () => {
    answer = () => ({ ok: true, exitCode: 1, stdout: 'unblock FAILED: daemon unreachable' })
    const out = (await tool('unblock_prompts').run({ dry_run: true })) as { report: unknown }
    expect(out.report).toBeNull()
  })
})
