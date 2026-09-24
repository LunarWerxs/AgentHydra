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
const instances: Record<
  string,
  { num: number; kind: string; name: string; handle: string; email?: string | null }
> = {
  '36': { num: 36, kind: 'desktop', name: 'Darragh', handle: 'c:\\i\\anutha23' },
  martin: { num: 8, kind: 'desktop', name: 'Martin', handle: 'c:\\i\\another_meh' },
  '8': { num: 8, kind: 'desktop', name: 'Martin', handle: 'c:\\i\\another_meh' },
  '9': { num: 9, kind: 'cli', name: 'a CLI login', handle: 'cli-uuid' },
  '42': {
    num: 42,
    kind: 'desktop',
    name: 'Priya',
    handle: 'c:\\i\\priya',
    email: 'priya@example.com',
  },
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
      email: row.email ?? null,
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

// Item 4, filed 2026-09-07: a stale identity signal made move_chats { to: 'here' } land three
// chats on the wrong account, and the only confirmation of WHICH account it actually used was
// `targetNote`'s bare name+nickname, read only after every chat had already imported. These pin
// that `targetNote` now also carries the resolved account's EMAIL - the detail a human or an
// agent skimming a nickname is far less likely to miss - and that it is built from the SAME
// resolve, before either tool posts the orchestrator run that does the actual importing.
describe('targetNote confirms the resolved account by name AND email (item 4, filed 2026-09-07)', () => {
  test('move_chat: a target with an email on record gets it appended to targetNote', async () => {
    const r = (await moveChat().run({ chat: 'x', to: 42 })) as Record<string, unknown>
    expect(r.targetNote).toBe('to = instance #42 (Priya · Max 20×) — priya@example.com')
  })

  test('move_chat: a target with NO email on record still gets a clean note, never a dangling dash', async () => {
    const r = (await moveChat().run({ chat: 'x', to: 36 })) as Record<string, unknown>
    expect(r.targetNote).toBe('to = instance #36 (Darragh · Max 20×)')
    expect(r.targetNote).not.toContain('—')
  })

  test('move_chat: the resolve that produces targetNote happens before the orchestrator run is posted', async () => {
    await moveChat().run({ chat: 'x', to: 42 })
    const resolveIdx = calls.findIndex((c) => c.url.includes('/api/instance-numbers/resolve'))
    const runIdx = calls.findIndex((c) => c.url.endsWith('/api/orchestrator/run'))
    expect(resolveIdx).toBeGreaterThanOrEqual(0)
    expect(resolveIdx).toBeLessThan(runIdx)
  })

  test('move_chat: targetNote is still reported on a refusal, not only after a landed move', async () => {
    scriptExit = 6
    scriptStdout = JSON.stringify({ landed: false, held: true, report: 'REFUSED: HELD ...' })
    const r = (await moveChat().run({ chat: 'x', to: 42 })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(r.targetNote).toContain('priya@example.com')
  })

  test('move_chat: targetNote reads identically for a real move and a dry_run of the same target', async () => {
    const real = (await moveChat().run({ chat: 'x', to: 42 })) as Record<string, unknown>
    const planned = (await moveChat().run({ chat: 'x', to: 42, dry_run: true })) as Record<
      string,
      unknown
    >
    expect(planned.targetNote).toBe(real.targetNote)
  })

  test('move_chats: the batch target is resolved ONCE, with email, before the first import runs', async () => {
    const t = TOOLS.find((x) => x.name === 'move_chats')
    if (!t) throw new Error('no MCP tool named move_chats')
    scriptStdout = JSON.stringify({ moved: ['x'], refused: [], results: [] })
    const r = (await t.run({ chats: ['x'], to: 42 })) as Record<string, unknown>
    expect(r.targetNote).toBe('to = instance #42 (Priya · Max 20×) — priya@example.com')
    const resolves = calls.filter((c) => c.url.includes('/api/instance-numbers/resolve'))
    expect(resolves).toHaveLength(1) // one resolve for the WHOLE batch, not per chat
    const resolveIdx = calls.findIndex((c) => c.url.includes('/api/instance-numbers/resolve'))
    const runIdx = calls.findIndex((c) => c.url.endsWith('/api/orchestrator/run'))
    expect(resolveIdx).toBeLessThan(runIdx) // resolved before migrate_batch imports anything
  })

  // TODO item 1 (2026-09-15): migrate_chat restates one of a chat's two CURRENT names as
  // confirm_title, and the two can disagree (the daemon session's own title vs the desktop
  // record's) - a caller with no way to tell which one the door wants had no way past a
  // mismatch. `{chat, title}` names that one chat's own real title, which reaches
  // migrate_batch.py as `--chat-title` and sidesteps the restatement entirely.
  test('move_chats: a {chat, title} entry sends --chat-title for that chat only', async () => {
    const t = TOOLS.find((x) => x.name === 'move_chats')
    if (!t) throw new Error('no MCP tool named move_chats')
    scriptStdout = JSON.stringify({ moved: ['x', 'y'], refused: [], results: [] })
    await t.run({
      chats: [{ chat: 'x', title: 'x real title' }, 'y'],
      to: 42,
    })
    const run = runCall()
    const args = (run.body?.args ?? []) as string[]
    expect(args.slice(args.indexOf('--chat'), args.indexOf('--chat') + 4)).toEqual([
      '--chat',
      'x',
      '--chat-title',
      'x real title',
    ])
    // 'y' is a bare string: it carries no --chat-title of its own.
    const yIdx = args.lastIndexOf('--chat')
    expect(args[yIdx + 1]).toBe('y')
    expect(args[yIdx + 2]).not.toBe('--chat-title')
  })

  test('the descriptions point a caller at targetNote and dry_run as the pre-flight check', () => {
    const chats = TOOLS.find((x) => x.name === 'move_chats')
    expect(moveChat().description).toContain('targetNote')
    expect(moveChat().description.toLowerCase()).toContain('dry_run: true')
    expect(chats?.description).toContain('targetNote')
  })
})

// docs/todo/improvements/tooling/agenthydra-move-chats-resume-never-delivered-and-the-call-times-out.md
// (2026-09-13): a one-chat move_chats call died on a bare MCP transport timeout with NO
// operationId and no per-chat report - the batch's own declared length (330s+, even for one
// chat: the 180s floor plus a 90s-per-chat settle/stamp allowance) was always longer than the
// AUTO_DETACH_MS ceiling (120s), but `background` only went async when the caller explicitly
// asked for it. These pin that move_chats now reads the SAME auto-detach rule orchestrator_run
// already has: async unless a caller who knows their transport can wait says `background: false`.
function moveChats() {
  const t = TOOLS.find((x) => x.name === 'move_chats')
  if (!t) throw new Error('no MCP tool named move_chats')
  return t
}

describe('move_chats auto-detaches so a lost transport never loses the report (2026-09-13)', () => {
  test('a bare one-chat call already declares itself past the ceiling, and goes async without being asked', async () => {
    scriptStdout = JSON.stringify({ moved: ['x'], refused: [], results: [] })
    const r = (await moveChats().run({ chats: ['x'], to: 36 })) as Record<string, unknown>
    expect(runCall().body?.timeoutMs).toBeGreaterThan(120_000)
    expect(runCall().body?.async).toBe(true)
    expect(r.started).toBe(true)
    expect(String(r.poll)).toContain('orchestrator_operation')
    expect(String(r.note)).toContain('Detached automatically')
    // the auto note names the batch's own declared length, not a generic excuse
    expect(String(r.note)).toMatch(/\d+s\)/)
  })

  test('background: false is a person choosing to wait, and is honoured even past the ceiling', async () => {
    scriptStdout = JSON.stringify({ landed: true, report: 'landed and VERIFIED' })
    const r = (await moveChats().run({ chats: ['x'], to: 36, background: false })) as Record<
      string,
      unknown
    >
    expect(runCall().body?.timeoutMs).toBeGreaterThan(120_000)
    expect(runCall().body?.async).toBe(false)
    expect(r.started).toBeUndefined()
    expect(r.poll).toBeUndefined()
    // the blocking path still parses the script's own JSON off stdout
    expect(r.landed).toBe(true)
  })

  test('background: true still answers with the id and how to poll it, in its own words', async () => {
    scriptStdout = JSON.stringify({ moved: ['x'], refused: [], results: [] })
    const r = (await moveChats().run({ chats: ['x'], to: 36, background: true })) as Record<
      string,
      unknown
    >
    expect(runCall().body?.async).toBe(true)
    expect(String(r.note)).toContain('Poll the id above')
    expect(String(r.note)).not.toContain('Detached automatically')
  })
})

// The archive stopgap's caller half (2026-09-13): a COUNT travels with `--archived`, never a
// bare boolean - see migrate_batch's own _archive_gate for why a boolean could not tell a
// human's instruction from an agent's own initiative.
describe('archived_count is the only way --archived reaches migrate_batch', () => {
  test('a positive archived_count adds --archived --archived-count <n>', async () => {
    scriptStdout = JSON.stringify({ moved: [], refused: [], results: [] })
    await moveChats().run({ chats: ['x'], to: 36, archived_count: 3 })
    const args = runCall().body?.args as string[]
    expect(args).toContain('--archived')
    expect(args[args.indexOf('--archived-count') + 1]).toBe('3')
  })

  test('archived_count is dropped for all_unarchived - it is unarchived by definition', async () => {
    scriptStdout = JSON.stringify({ moved: [], refused: [], results: [] })
    await moveChats().run({ all_unarchived: true, to: 36, archived_count: 5 })
    const args = runCall().body?.args as string[]
    expect(args).not.toContain('--archived')
    expect(args).not.toContain('--archived-count')
  })

  test('omitting archived_count (or zero) never adds the flag', async () => {
    scriptStdout = JSON.stringify({ moved: [], refused: [], results: [] })
    await moveChats().run({ chats: ['x'], to: 36 })
    expect(runCall().body?.args).not.toContain('--archived')
    await moveChats().run({ chats: ['x'], to: 36, archived_count: 0 })
    expect(runCall().body?.args).not.toContain('--archived')
  })
})
