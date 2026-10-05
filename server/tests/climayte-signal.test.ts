// The wind-down signal and the hooks that carry it into a CliMayte worker (climayte-signal.ts):
// what the worker's settings say, what the runner answers, and that the runner points the hook at
// itself before the CLI starts. The runner tests start the runner this platform uses (runnerArgv):
// misc/climayte-runner.exe on Windows, this app in runner mode elsewhere.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnerArgv } from '../src/climayte-runner'
import {
  pointSignalHook,
  RUN_IF_PRESENT,
  SIGNAL_HOOK_TIMEOUT_S,
  serveSignal,
  workerHooks,
} from '../src/climayte-signal'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ah-signal-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SIGNAL = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'WIND DOWN NOW' },
})

describe('workerHooks', () => {
  test('without the runner, the signal is the same `cat` command as before, on every tool call', () => {
    const hooks = workerHooks({ signalFile: 'C:/x/signals/w-1.json', claims: null })
    expect(hooks).toEqual({
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: "cat 'C:/x/signals/w-1.json' 2>/dev/null || true" }],
        },
      ],
    })
  })

  test('edit_claims runs in exec form: python itself, no shell launcher in front of it', () => {
    const hooks = workerHooks({
      signalFile: 'C:/x/s.json',
      claims: 'C:/u/.claude/hooks/edit_claims.py',
    })
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          {
            type: 'command',
            command: 'python',
            args: ['-S', '-c', RUN_IF_PRESENT, 'C:/u/.claude/hooks/edit_claims.py'],
            timeout: 10,
          },
        ],
      },
    ])
  })

  // The interpreter exits 2 for a script it cannot open, and a PreToolUse exit 2 denies the edit: the
  // shell form's `|| true` used to absorb it (the claims file deleted mid-attempt blocked every edit).
  test('the launcher runs the claims script when present, and exits 0 quietly when it is gone', () => {
    const dir = tmp()
    const script = join(dir, 'claims.py')
    writeFileSync(script, "import sys\nprint('ran', __name__)\nsys.exit(0)\n")
    const run = (file: string) =>
      Bun.spawnSync(['python', '-S', '-c', RUN_IF_PRESENT, file], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const present = run(script)
    expect(present.exitCode).toBe(0)
    expect(present.stdout.toString().trim()).toBe('ran __main__')
    const gone = run(join(dir, 'missing.py'))
    expect(gone.exitCode).toBe(0)
    expect(gone.stdout.toString()).toBe('')
    expect(gone.stderr.toString()).toBe('')
  }, 30_000)
})

describe('serveSignal', () => {
  const post = (port: number) =>
    fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    })

  test('answers an empty object until the daemon writes the signal, then the signal itself', async () => {
    const file = join(tmp(), 'w-1.json')
    const s = serveSignal(file)
    expect(s).not.toBeNull()
    try {
      let res = await post(s!.port)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({})

      writeFileSync(file, SIGNAL)
      res = await post(s!.port)
      expect(await res.text()).toBe(SIGNAL)
      // Shown on every later call too, the way the `cat` it replaces did, until the file is removed.
      expect(await (await post(s!.port)).text()).toBe(SIGNAL)

      rmSync(file)
      expect(await (await post(s!.port)).json()).toEqual({})
    } finally {
      s!.stop()
    }
  })

  test('a half-written signal file answers an empty object, never invalid JSON', async () => {
    const file = join(tmp(), 'w-2.json')
    writeFileSync(file, '{"hookSpecificOutput":{"hookEvent')
    const s = serveSignal(file)!
    try {
      expect(await (await post(s.port)).json()).toEqual({})
    } finally {
      s.stop()
    }
  })

  // The CLI's http hook sends no Origin. A browser always does, and no page has any business here:
  // one on another local port (or a rebinding site) must not read a worker's signal.
  test('a request from a browser page is refused, and never sees the signal', async () => {
    const file = join(tmp(), 'w-5.json')
    writeFileSync(file, SIGNAL)
    const s = serveSignal(file)!
    try {
      const fromPage = await fetch(`http://127.0.0.1:${s.port}/signal`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:5173' },
        body: '{}',
      })
      expect(fromPage.status).toBe(403)
      expect(await fromPage.text()).not.toContain('WIND DOWN NOW')
      expect(await (await post(s.port)).text()).toBe(SIGNAL)
    } finally {
      s.stop()
    }
  })

  // A worker's sub-agents (Agent tool) run in the same CLI and fire its PostToolUse hook too. The
  // handoff belongs to the worker: a sub-agent told to write it quits mid-task and overwrites the
  // worker's own (2026-10-04: every visitor of a SUE run did both). The CLI sends `agent_id` only
  // inside a sub-agent.
  test('a tool call made inside a sub-agent never sees the signal', async () => {
    const file = join(tmp(), 'w-6.json')
    writeFileSync(file, SIGNAL)
    const s = serveSignal(file)!
    try {
      const fromSubagent = await fetch(`http://127.0.0.1:${s.port}/signal`, {
        method: 'POST',
        body: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          agent_id: 'a1b2c3',
          agent_type: 'sue-driver',
        }),
      })
      expect(fromSubagent.status).toBe(200)
      expect(await fromSubagent.json()).toEqual({})
      expect(await (await post(s.port)).text()).toBe(SIGNAL)
    } finally {
      s.stop()
    }
  })

  test('stop closes the port', async () => {
    const s = serveSignal(join(tmp(), 'w-3.json'))!
    s.stop()
    await expect(post(s.port)).rejects.toThrow()
  })
})

describe('pointSignalHook', () => {
  test('swaps the PostToolUse hook for an http hook at the runner, and keeps the rest', () => {
    const file = join(tmp(), 'w-4.json')
    const before = {
      deniedMcpServers: [{ serverName: 'x' }],
      syncClaudeAiSkills: false,
      hooks: { ...workerHooks({ signalFile: 'C:/s.json', claims: 'C:/c.py' }) },
    }
    writeFileSync(file, JSON.stringify(before))
    expect(pointSignalHook(file, 4321)).toBe(true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.hooks.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [
          { type: 'http', url: 'http://127.0.0.1:4321/signal', timeout: SIGNAL_HOOK_TIMEOUT_S },
        ],
      },
    ])
    expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse)
    expect(after.deniedMcpServers).toEqual(before.deniedMcpServers)
    expect(after.syncClaudeAiSkills).toBe(false)
  })

  test('a missing or unreadable settings file is left alone and reported', () => {
    const dir = tmp()
    expect(pointSignalHook(join(dir, 'none.json'), 1)).toBe(false)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(pointSignalHook(bad, 1)).toBe(false)
    expect(readFileSync(bad, 'utf8')).toBe('{not json')
  })
})

describe('the runner points the hook at itself before the CLI starts', () => {
  test('a CLI that reads its --settings finds an http hook and gets the signal from the runner', async () => {
    const dir = tmp()
    const settings = join(dir, 'settings.json')
    const signal = join(dir, 'signal.json')
    const before = {
      deniedMcpServers: [{ serverUrl: '*://*/api/mcp*' }],
      hooks: workerHooks({ signalFile: signal.replace(/\\/g, '/'), claims: 'C:/c.py' }),
      syncClaudeAiSkills: false,
    }
    writeFileSync(settings, JSON.stringify(before))
    // The stand-in CLI: reads the settings the way the real one does, calls the PostToolUse hook
    // twice (a signal appears between the calls), and prints what each answered. Then, with the
    // signal up, the call a sub-agent's tool call makes (`agent_id` in its input) and one a web
    // page on another local port would make (it carries an Origin).
    const cli = join(dir, 'cli.ts')
    writeFileSync(
      cli,
      `import { readFileSync, writeFileSync } from 'node:fs'
const [settings, signal, payload] = process.argv.slice(2)
const hook = JSON.parse(readFileSync(settings, 'utf8')).hooks.PostToolUse[0].hooks[0]
if (hook.type !== 'http') { console.log('FORM=' + hook.type); process.exit(0) }
const call = async () => (await fetch(hook.url, { method: 'POST', body: '{}' })).text()
console.log('FORM=http')
console.log('FIRST=' + (await call()))
writeFileSync(signal, payload)
console.log('SECOND=' + (await call()))
const sub = await fetch(hook.url, { method: 'POST', body: JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: 'a1b2' }) })
console.log('SUBAGENT=' + (await sub.text()))
const page = await fetch(hook.url, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173' }, body: '{}' })
console.log('PAGE=' + page.status)
`,
    )
    const spec = join(dir, 'spec.json')
    const out = join(dir, 'out.log')
    writeFileSync(out, '')
    writeFileSync(join(dir, 'in.txt'), '')
    writeFileSync(
      spec,
      JSON.stringify({
        argv: [process.execPath, cli, settings, signal, SIGNAL],
        cwd: dir,
        env: { ...(process.env as Record<string, string>) },
        stdin: join(dir, 'in.txt'),
        stdout: out,
        stderr: join(dir, 'err.log'),
        pidFile: join(dir, 'pid.json'),
        exitFile: join(dir, 'exit.json'),
        signal: { file: signal, settings },
        maxProcesses: 400,
      }),
    )
    writeFileSync(join(dir, 'err.log'), '')
    const runner = Bun.spawn(runnerArgv(spec), {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    const code = await runner.exited
    expect(code).toBe(0)
    const log = readFileSync(out, 'utf8')
    expect(log).toContain('FORM=http')
    expect(log).toContain('FIRST={}')
    expect(log).toContain(`SECOND=${SIGNAL}`)
    expect(log).toContain('SUBAGENT={}')
    expect(log).toContain('PAGE=403')
    // Only the PostToolUse hook changed: every other key is as the daemon wrote it.
    const after = JSON.parse(readFileSync(settings, 'utf8'))
    expect(after.hooks.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [
          {
            type: 'http',
            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/signal$/),
            timeout: SIGNAL_HOOK_TIMEOUT_S,
          },
        ],
      },
    ])
    expect({ ...after, hooks: { ...after.hooks, PostToolUse: null } }).toEqual({
      ...before,
      hooks: { ...before.hooks, PostToolUse: null },
    })
    const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8'))
    expect(exit.code).toBe(0)
    // On Windows the runner's job also counted the worker's tree: the runner and the CLI at least.
    if (process.platform === 'win32') expect(exit.peakProcesses).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test('a spec with no signal leaves the settings as the daemon wrote them', async () => {
    const dir = tmp()
    const settings = join(dir, 'settings.json')
    const written = JSON.stringify({
      hooks: workerHooks({ signalFile: 'C:/s.json', claims: null }),
    })
    writeFileSync(settings, written)
    const cli = join(dir, 'cli.ts')
    writeFileSync(cli, `console.log('ran')\n`)
    writeFileSync(join(dir, 'in.txt'), '')
    writeFileSync(join(dir, 'out.log'), '')
    writeFileSync(join(dir, 'err.log'), '')
    const spec = join(dir, 'spec.json')
    writeFileSync(
      spec,
      JSON.stringify({
        argv: [process.execPath, cli],
        cwd: dir,
        env: { ...(process.env as Record<string, string>) },
        stdin: join(dir, 'in.txt'),
        stdout: join(dir, 'out.log'),
        stderr: join(dir, 'err.log'),
        pidFile: join(dir, 'pid.json'),
        exitFile: join(dir, 'exit.json'),
      }),
    )
    const runner = Bun.spawn(runnerArgv(spec), {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    expect(await runner.exited).toBe(0)
    expect(readFileSync(settings, 'utf8')).toBe(written)
  }, 30_000)
})
