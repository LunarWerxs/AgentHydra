// move_chat: the ONE-CALL account move (owner, 2026-09-04: "slower than I wanted ... I use this
// function frequently"). By hand, "move the X chat from Martin to here" was a dozen MCP round
// trips - find the account, list its chats, load schemas, read --help, check quota, run, verify.
// This tool folds all of it into one call, so what is pinned here is exactly what it SENDS to the
// orchestrator for each argument shape, and how it reads the script's answer back.
//
// The daemon is a fetch stub answering by URL; nothing here spawns python or needs a fleet.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TOOLS } from '../src/mcp'

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
const originalFetch = globalThis.fetch

/** What the fake daemon says for each route. `stdout` is what migrate_chat printed. */
let scriptStdout = JSON.stringify({
  landed: true,
  report: 'landed and VERIFIED',
  permissionMode: 'bypassPermissions',
})
let scriptExit = 0
const instances: Record<string, { num: number; kind: string; name: string; handle: string }> = {
  '36': { num: 36, kind: 'desktop', name: 'Darragh', handle: 'c:\\i\\anutha23' },
  martin: { num: 8, kind: 'desktop', name: 'Martin', handle: 'c:\\i\\another_meh' },
  '8': { num: 8, kind: 'desktop', name: 'Martin', handle: 'c:\\i\\another_meh' },
  '9': { num: 9, kind: 'cli', name: 'a CLI login', handle: 'cli-uuid' },
}

function respond(url: string, init?: RequestInit): Response {
  const u = new URL(url)
  if (u.pathname === '/api/instance-numbers/resolve') {
    const ref = (u.searchParams.get('ref') ?? '').toLowerCase()
    const row = instances[ref]
    if (!row)
      return new Response(JSON.stringify({ error: `no instance matches ${ref}` }), { status: 404 })
    return Response.json({
      ...row,
      ref: `${row.kind}:${row.handle}`,
      email: null,
      plan: null,
      tier: 'Max 20×',
      configDir: row.handle,
      loggedIn: true,
      isRunning: true,
    })
  }
  if (u.pathname === '/api/orchestrator/run') {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return Response.json({
      ok: scriptExit === 0,
      script: body.script,
      args: body.args,
      exitCode: scriptExit,
      exitMeaning: scriptExit === 0 ? 'ok' : 'refused',
      timedOut: false,
      durationMs: 5,
      stdout: scriptStdout,
      stderr: '',
    })
  }
  return new Response(JSON.stringify({ error: `stub has no route for ${u.pathname}` }), {
    status: 404,
  })
}

beforeEach(() => {
  calls = []
  scriptExit = 0
  scriptStdout = JSON.stringify({
    landed: true,
    report: 'landed and VERIFIED',
    permissionMode: 'bypassPermissions',
  })
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return respond(String(url), init)
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function moveChat() {
  const t = TOOLS.find((x) => x.name === 'move_chat')
  if (!t) throw new Error('no MCP tool named move_chat')
  return t
}

function runCall(): Call {
  const c = calls.find((x) => x.url.endsWith('/api/orchestrator/run'))
  if (!c)
    throw new Error(`no orchestrator run was posted; calls: ${calls.map((x) => x.url).join(', ')}`)
  return c
}

describe('move_chat is registered as the one-call move', () => {
  test('it exists, mutates, and requires only the chat', () => {
    const t = moveChat()
    expect(t.description).toMatch(/^MUTATES:/)
    expect((t.inputSchema as { required: string[] }).required).toEqual(['chat'])
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties
    for (const k of ['chat', 'from', 'to', 'title', 'force', 'wait_secs', 'dry_run'])
      expect(props).toHaveProperty(k)
  })

  test('the description promises the things a caller must be able to rely on', () => {
    const d = moveChat().description.toLowerCase()
    expect(d).toContain('fuzz') // the title is matched fuzzily
    expect(d).toContain('bypasspermissions') // every landing is stamped
    expect(d).toMatch(/person'?s word/) // force is not the tool's to spend
    expect(d).toContain('"here"')
    expect(d).toContain('"best"')
  })
})

describe('what it sends to the orchestrator', () => {
  test('a numeric target is resolved and becomes migrate_chat --to <num> with the fast-path flags', async () => {
    const r = (await moveChat().run({ chat: 'arkitecht cleanup', to: 36 })) as Record<
      string,
      unknown
    >
    const run = runCall()
    expect(run.method).toBe('POST')
    expect(run.body).toMatchObject({ script: 'migrate_chat' })
    expect(run.body?.args).toEqual([
      'arkitecht cleanup',
      '--to',
      '36',
      '--stop-idle',
      '--now',
      '--idle-wait',
      '330',
      '--json',
    ])
    // the wait happens inside the script, so the daemon deadline must outlast it
    expect(run.body?.timeoutMs).toBe((330 + 180) * 1000)
    expect(r.ok).toBe(true)
    expect(r.landed).toBe(true)
    expect(r.permissionMode).toBe('bypassPermissions')
  })

  test('`from` is resolved by name (an account label) and travels as --from <num>', async () => {
    await moveChat().run({ chat: 'arkitecht cleanup', from: 'Martin', to: 36 })
    const resolves = calls.filter((c) => c.url.includes('/api/instance-numbers/resolve'))
    expect(resolves.some((c) => decodeURIComponent(c.url).includes('ref=Martin'))).toBe(true)
    expect(runCall().body?.args).toContain('--from')
    const args = runCall().body?.args as string[]
    expect(args[args.indexOf('--from') + 1]).toBe('8')
  })

  test('"best" is handed to the orchestrator verbatim - it ranks the fleet itself', async () => {
    await moveChat().run({ chat: 'x', to: 'best' })
    const args = runCall().body?.args as string[]
    expect(args[args.indexOf('--to') + 1]).toBe('best')
    // no instance resolve was needed for that
    expect(calls.some((c) => c.url.includes('/api/instance-numbers/resolve'))).toBe(false)
  })

  test('force, title, dry_run and wait_secs map onto the script flags; wait is capped at 360', async () => {
    await moveChat().run({
      chat: 'x',
      to: 36,
      force: true,
      title: 'A real name',
      dry_run: true,
      wait_secs: 9999,
    })
    const args = runCall().body?.args as string[]
    expect(args).toContain('--force')
    expect(args).toContain('--dry-run')
    expect(args[args.indexOf('--title') + 1]).toBe('A real name')
    expect(args[args.indexOf('--idle-wait') + 1]).toBe('360')
  })

  test('force is NEVER added on its own - a person has to say it', async () => {
    await moveChat().run({ chat: 'x', to: 36 })
    expect(runCall().body?.args).not.toContain('--force')
  })

  test('a CLI instance is refused as a target before anything is posted', async () => {
    await expect(moveChat().run({ chat: 'x', to: 9 })).rejects.toThrow(/DESKTOP/)
    expect(calls.some((c) => c.url.endsWith('/api/orchestrator/run'))).toBe(false)
  })

  test("an unknown target is the daemon's own refusal, and nothing is posted", async () => {
    await expect(moveChat().run({ chat: 'x', to: 'nobody' })).rejects.toThrow(/404/)
    expect(calls.some((c) => c.url.endsWith('/api/orchestrator/run'))).toBe(false)
  })

  test('an empty chat is refused locally', async () => {
    await expect(moveChat().run({ chat: '  ', to: 36 })).rejects.toThrow(/chat is required/)
    expect(calls).toHaveLength(0)
  })
})

describe('how it reads the answer back', () => {
  test("the script's JSON is the result; a refusal is ok:false with the report intact", async () => {
    scriptExit = 6
    scriptStdout = JSON.stringify({
      landed: false,
      held: true,
      report: 'REFUSED: HELD by audit_twins ...',
    })
    const r = (await moveChat().run({ chat: 'x', to: 36 })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(r.landed).toBe(false)
    expect(r.held).toBe(true)
    expect(r.report).toContain('HELD')
    expect(r.exitCode).toBe(6)
  })

  test('a dry run is ok even though nothing landed', async () => {
    scriptStdout = JSON.stringify({
      dryRun: true,
      landed: false,
      report: 'DRY RUN: would move ...',
    })
    const r = (await moveChat().run({ chat: 'x', to: 36, dry_run: true })) as Record<
      string,
      unknown
    >
    expect(r.ok).toBe(true)
    expect(r.dryRun).toBe(true)
  })

  test('no JSON on stdout (a usage error, no python) hands back the raw run, never a silent success', async () => {
    scriptExit = 3
    scriptStdout = 'Usage: python migrate_chat.py ...'
    const r = (await moveChat().run({ chat: 'x', to: 36 })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(r.stdout).toContain('Usage')
    expect(r.args).toBeDefined()
  })
})
