// The fan-out MCP tools (fan_out / fan_out_status / fan_out_send), pinned at the same seam as
// orchestrator-mcp.test.ts: what each one SENDS to the daemon for a given argument shape, and how
// it reads fan_out.py's report back. The daemon is a fetch stub; nothing here spawns python, a
// chat, or needs a fleet. fan_out.py's own behaviour is proven by its Python suite.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_INSTRUCTIONS, TOOLS } from '../src/mcp'

type Call = { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = []
let answer: (url: string) => unknown = () => ({ ok: true })
const originalFetch = globalThis.fetch

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no MCP tool named ${name}`)
  return t
}

/** A daemon that answers the run route with a fan_out.py report on stdout. */
function reportRun(report: unknown, exitCode = 0, stderr = '') {
  answer = (url) =>
    url.includes('/api/orchestrator/run')
      ? { ok: true, exitCode, stdout: JSON.stringify(report), stderr }
      : { ok: true }
}

function runBody() {
  const c = calls.find((x) => x.url.includes('/api/orchestrator/run'))
  if (!c) throw new Error('no run call was made')
  return c.body as { script: string; args: string[]; timeoutMs: number }
}

beforeEach(() => {
  calls = []
  answer = () => ({ ok: true })
  // @ts-expect-error test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify(answer(String(url))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

const twoTasks = [
  { title: 'lint web', cwd: 'D:/repo/web', prompt: 'run the lint gate and fix what it finds' },
  { cwd: 'D:/repo/api', prompt: 'run the lint gate and fix what it finds' },
]

describe('the three fan-out tools exist and say what they are', () => {
  test.each(['fan_out', 'fan_out_status', 'fan_out_send'])('%s has an object schema', (name) => {
    const t = tool(name)
    expect((t.inputSchema as { type: string }).type).toBe('object')
    expect(t.description.length).toBeGreaterThan(80)
  })
  test('the two acting tools say MUTATES; the reader says READ-ONLY', () => {
    expect(tool('fan_out').description).toMatch(/^MUTATES:/)
    expect(tool('fan_out_send').description).toMatch(/^MUTATES:/)
    expect(tool('fan_out_status').description).toMatch(/^READ-ONLY:/)
  })
  test('fan_out_send describes the composer route it takes, not a peer channel it never uses', () => {
    const d = tool('fan_out_send').description
    expect(d).toContain('PEER PIPE IS NOT USED')
    expect(d.toLowerCase()).toContain('composer')
    expect(d).not.toMatch(/native peer channel when the chat is live/)
  })
  test('fan_out promises the properties that make it safe: visible, one account each, sequential', () => {
    const d = tool('fan_out').description.toLowerCase()
    expect(d).toContain('visible')
    expect(d).toContain('one account each')
    expect(d).toContain('one at a time')
    expect(d).toContain('never headless')
  })
  test('the two refused tools now say so up front and point at fan_out', () => {
    for (const name of ['add_queue_item', 'launch_terminal_session']) {
      const d = tool(name).description
      expect(d.startsWith('⛔ REFUSED ON EVERY CALL')).toBe(true)
      expect(d).toContain('fan_out')
    }
  })
  test('the standing instructions teach the fan-out path and warn off the refused tools', () => {
    expect(SERVER_INSTRUCTIONS).toContain('fan_out {tasks:[{cwd, prompt}]}')
    expect(SERVER_INSTRUCTIONS).toContain('fan_out_status')
    expect(SERVER_INSTRUCTIONS).toContain('fan_out_send')
    expect(SERVER_INSTRUCTIONS).toContain('add_queue_item and launch_terminal_session are REFUSED')
  })
})

describe('what fan_out sends to the daemon', () => {
  test('tasks become an inline --spec (cwd -> folder, title kept when given) plus --json', async () => {
    reportRun({ id: 'fo-1', members: [] })
    const res = (await tool('fan_out').run({ tasks: twoTasks, exclude_self: false })) as Record<
      string,
      unknown
    >
    const b = runBody()
    expect(b.script).toBe('fan_out')
    expect(b.args[0]).toBe('--spec')
    expect(JSON.parse(b.args[1]!)).toEqual({
      tasks: [
        { title: 'lint web', folder: 'D:/repo/web', prompt: twoTasks[0]!.prompt },
        { folder: 'D:/repo/api', prompt: twoTasks[1]!.prompt },
      ],
    })
    expect(b.args.slice(2)).toEqual(['--json'])
    expect(res.ok).toBe(true)
    expect(res.id).toBe('fo-1')
    expect(res.selfNote).toContain('exclude_self: false')
  })

  test('group, per_account, open_closed, force and dry_run map onto the script flags', async () => {
    reportRun({ id: 'fo-2', dryRun: true, members: [] })
    await tool('fan_out').run({
      tasks: twoTasks,
      group: 'lint sweep',
      per_account: 2,
      open_closed: true,
      force: true,
      dry_run: true,
      exclude_self: false,
    })
    const b = runBody()
    expect(JSON.parse(b.args[1]!).group).toBe('lint sweep')
    expect(b.args.slice(2)).toEqual([
      '--json',
      '--per-account',
      '2',
      '--open-closed',
      '--force',
      '--dry-run',
    ])
    expect(b.timeoutMs).toBe(180_000) // a dry run only ranks and plans
  })

  test('per_account of 1 (the default) adds no flag; the spawn deadline grows with the task count', async () => {
    reportRun({ id: 'fo-3', members: [] })
    await tool('fan_out').run({ tasks: twoTasks, per_account: 1, exclude_self: false })
    const b = runBody()
    expect(b.args).not.toContain('--per-account')
    expect(b.timeoutMs).toBe(90_000 + 2 * 240_000)
  })

  test('only/exclude refs are resolved to instance NUMBERS through the daemon before posting', async () => {
    answer = (url) => {
      if (url.includes('/api/instance-numbers/resolve')) {
        const ref = decodeURIComponent(url.split('ref=')[1] ?? '')
        return { num: ref === 'Martin' ? 8 : 36, kind: 'desktop', name: ref, handle: 'x' }
      }
      if (url.includes('/api/orchestrator/run'))
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ id: 'fo-4', members: [] }) }
      return { ok: true }
    }
    await tool('fan_out').run({
      tasks: twoTasks,
      only: ['Martin', 36],
      exclude: ['Martin'],
      exclude_self: false,
    })
    const b = runBody()
    expect(b.args.slice(2)).toEqual(['--json', '--only', '8', '--only', '36', '--exclude', '8'])
  })

  test('a spec too long for one argv entry travels as a temp file the script can read, removed after the run', async () => {
    // a box, not a bare let: TypeScript cannot see the closure assignment below, so a plain
    // variable would narrow to `null` at the assertion
    const seen: { atRunTime: { exists: boolean; tasks: number; last: string } | null } = {
      atRunTime: null,
    }
    answer = (url) => {
      if (url.includes('/api/orchestrator/run')) {
        // the daemon (and the script it runs) reads the file DURING the call
        const path = (calls.at(-1)!.body as { args: string[] }).args[1]!
        const spec = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
        seen.atRunTime = {
          exists: spec !== null,
          tasks: spec?.tasks?.length ?? 0,
          last: spec?.tasks?.[7]?.folder ?? '',
        }
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ id: 'fo-5', members: [] }) }
      }
      return { ok: true }
    }
    const big = Array.from({ length: 8 }, (_, i) => ({
      cwd: `D:/repo/plane-${i}`,
      prompt: `plane ${i}: ${'lint every file and fix what you find. '.repeat(20)}`,
    }))
    await tool('fan_out').run({ tasks: big, exclude_self: false })
    const b = runBody()
    const path = b.args[1]!
    expect(path.length).toBeLessThan(4000)
    expect(seen.atRunTime).toEqual({ exists: true, tasks: 8, last: 'D:/repo/plane-7' })
    // review 2026-09-05: the temp file used to be left behind forever
    expect(existsSync(path)).toBe(false)
  })

  test('an inline spec leaves no file behind and the inline arg is left alone', async () => {
    reportRun({ id: 'fo-5b', members: [] })
    await tool('fan_out').run({ tasks: twoTasks, exclude_self: false })
    const b = runBody()
    expect(b.args[1]!.startsWith('{')).toBe(true)
    expect(existsSync(b.args[1]!)).toBe(false)
  })

  test('refuses an empty task list and a task missing cwd or prompt before any request', async () => {
    await expect(tool('fan_out').run({ tasks: [] })).rejects.toThrow(/at least one/)
    await expect(tool('fan_out').run({ tasks: [{ prompt: 'x' }] })).rejects.toThrow(/no cwd/)
    await expect(tool('fan_out').run({ tasks: [{ cwd: 'D:/x' }] })).rejects.toThrow(/no prompt/)
    expect(calls).toHaveLength(0)
  })

  test("the script's exit code becomes a verdict, and a non-zero one is ok:false with the report intact", async () => {
    reportRun({ id: 'fo-6', members: [{ index: 0, state: 'unassigned' }] }, 4, 'note')
    const res = (await tool('fan_out').run({ tasks: twoTasks, exclude_self: false })) as Record<
      string,
      unknown
    >
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(4)
    expect(String(res.verdict)).toMatch(/^partial/)
    expect(res.stderr).toBe('note')
    expect((res.members as unknown[]).length).toBe(1)
  })

  test('no JSON on stdout hands back the raw run with ok:false rather than a bare failure', async () => {
    answer = (url) =>
      url.includes('/api/orchestrator/run')
        ? { ok: true, exitCode: 3, stdout: '', stderr: 'REFUSED: task 0: not a directory' }
        : { ok: true }
    const res = (await tool('fan_out').run({ tasks: twoTasks, exclude_self: false })) as Record<
      string,
      unknown
    >
    expect(res.ok).toBe(false)
    expect(res.stderr).toContain('not a directory')
    expect(String(res.verdict)).toMatch(/^refused/)
  })
})

describe('fan_out excludes the calling account by default', () => {
  // Self-identification is driven by the environment: CLAUDE_CONFIG_DIR names this process's
  // credential dir (the strongest signal), and the daemon's whoami route turns it into a
  // numbered instance. Both are controlled here; nothing is read from the real fleet.
  const savedEnv: Record<string, string | undefined> = {}
  const configDir = mkdtempSync(join(tmpdir(), 'agenthydra-fanout-self-'))
  beforeAll(() => {
    for (const k of [
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_HOST_SESSION_ID',
    ])
      savedEnv[k] = process.env[k]
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CODEX_HOME
    delete process.env.CLAUDE_CODE_EXECPATH
    delete process.env.CLAUDE_CODE_HOST_SESSION_ID
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {}
  })

  function whoamiAnswers(row: Record<string, unknown> | null) {
    answer = (url) => {
      if (url.includes('/api/instance-numbers/whoami')) return row
      if (url.includes('/api/orchestrator/run'))
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ id: 'fo-self', members: [] }) }
      return { ok: true }
    }
  }

  test('a desktop instance this process runs as is passed as --exclude', async () => {
    whoamiAnswers({
      num: 37,
      kind: 'desktop',
      name: 'Michael',
      email: 'm@x',
      handle: configDir,
      ref: `desktop:${configDir}`,
    })
    const res = (await tool('fan_out').run({ tasks: twoTasks })) as Record<string, unknown>
    const b = runBody()
    expect(b.args).toContain('--exclude')
    expect(b.args[b.args.indexOf('--exclude') + 1]).toBe('37')
    expect(String(res.selfNote)).toMatch(/^excluded self = /)
  })

  test('a CLI instance is not excluded, and the note says the real reason', async () => {
    whoamiAnswers({
      num: 12,
      kind: 'cli',
      name: 'console',
      email: 'c@x',
      handle: configDir,
      ref: `cli:${configDir}`,
    })
    const res = (await tool('fan_out').run({ tasks: twoTasks })) as Record<string, unknown>
    expect(runBody().args).not.toContain('--exclude')
    expect(String(res.selfNote)).toContain('cannot host desktop chats')
    expect(String(res.selfNote)).not.toContain('not exact')
  })

  test('an explicit exclude still rides along beside the self exclusion', async () => {
    answer = (url) => {
      if (url.includes('/api/instance-numbers/whoami'))
        return {
          num: 37,
          kind: 'desktop',
          name: 'Michael',
          email: 'm@x',
          handle: configDir,
          ref: 'desktop:x',
        }
      if (url.includes('/api/instance-numbers/resolve'))
        return { num: 8, kind: 'desktop', name: 'Martin', handle: 'y' }
      if (url.includes('/api/orchestrator/run'))
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ id: 'fo-self2', members: [] }) }
      return { ok: true }
    }
    await tool('fan_out').run({ tasks: twoTasks, exclude: ['Martin'] })
    const args = runBody().args
    const excluded = args.flatMap((a, i) => (a === '--exclude' ? [args[i + 1]] : []))
    expect(excluded.sort()).toEqual(['37', '8'])
  })
})

describe('fan_out_status and fan_out_send', () => {
  test('status with no group asks for the latest; with a group, names it', async () => {
    reportRun({ id: 'fo-7', counts: { working: 2 }, members: [] })
    await tool('fan_out_status').run({})
    await tool('fan_out_status').run({ group: 'lint sweep' })
    const bodies = calls.map((c) => c.body as { args: string[]; timeoutMs: number })
    expect(bodies[0]!.args).toEqual(['status', '--json'])
    expect(bodies[1]!.args).toEqual(['status', 'lint sweep', '--json'])
    expect(bodies[0]!.timeoutMs).toBe(180_000)
  })

  test('send maps group, text, only and force onto the script, with a long deadline', async () => {
    reportRun({ id: 'fo-8', results: [{ delivered: true }] })
    const res = (await tool('fan_out_send').run({
      group: 'fo-8',
      text: 'Also run the tests.',
      only: ['s1', 's2'],
      force: true,
    })) as Record<string, unknown>
    const b = runBody()
    expect(b.args).toEqual([
      'send',
      'fo-8',
      '--text',
      'Also run the tests.',
      '--only',
      's1',
      '--only',
      's2',
      '--force',
      '--json',
    ])
    expect(b.timeoutMs).toBe(20 * 60_000)
    expect(res.ok).toBe(true)
  })

  test('send refuses a missing group or empty text before any request', async () => {
    await expect(tool('fan_out_send').run({ group: '', text: 'x' })).rejects.toThrow(/group/)
    await expect(tool('fan_out_send').run({ group: 'g', text: '  ' })).rejects.toThrow(/text/)
    expect(calls).toHaveLength(0)
  })
})

describe('fan_out_delete - the cleanup a probe fan-out owes', () => {
  test('is registered, MUTATES, and names the owner rule it enforces', () => {
    const d = tool('fan_out_delete').description
    expect(d).toMatch(/^MUTATES:/)
    expect(d).toContain('not left in the account')
    expect(d).toContain('undo')
  })

  test('maps group and force onto the delete subcommand with a long deadline', async () => {
    reportRun({ id: 'fo-9', results: [{ deleted: true }] })
    const res = (await tool('fan_out_delete').run({ group: 'pong drill', force: true })) as Record<
      string,
      unknown
    >
    const b = runBody()
    expect(b.args).toEqual(['delete', 'pong drill', '--force', '--json'])
    expect(b.timeoutMs).toBe(15 * 60_000)
    expect(res.ok).toBe(true)
    await tool('fan_out_delete').run({ group: 'fo-9' })
    expect((calls[1]!.body as { args: string[] }).args).toEqual(['delete', 'fo-9', '--json'])
  })

  test('refuses a missing group before any request', async () => {
    await expect(tool('fan_out_delete').run({ group: ' ' })).rejects.toThrow(/group/)
    expect(calls).toHaveLength(0)
  })

  test('fan_out itself and the standing instructions both say a probe must be deleted', () => {
    expect(tool('fan_out').description).toContain('fan_out_delete')
    expect(SERVER_INSTRUCTIONS).toContain('MUST BE DELETED AFTERWARDS')
    expect(SERVER_INSTRUCTIONS).toContain('fan_out_delete {group}')
  })
})
