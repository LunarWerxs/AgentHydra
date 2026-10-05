// server/tests/daemon-preboot.test.ts - what the daemon does before index.ts loads (daemon-preboot.ts).
//
// Each case is a real child process: module load order and process exit are the behaviour under
// test, and neither can be observed inside the test runner's own process. The child keeps
// NODE_ENV=test, so the boot watchdog stays inert and config.ts never resolves the live store.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '../src')
const PREBOOT = JSON.stringify(join(SRC, 'daemon-preboot.ts'))
const CONFIG = JSON.stringify(join(SRC, 'config.ts'))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ah-preboot-'))
  dirs.push(d)
  return d
}

/** Runs `body` as a child script with no inherited AgentHydra identity, plus `env` and `args`. */
function runChild(body: string, opts: { env?: Record<string, string>; args?: string[] } = {}) {
  const dir = scratch()
  const script = join(dir, 'child.ts')
  writeFileSync(script, body)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(AGENTHYDRA|CCMANAGERUI)_/.test(k)) env[k] = v
  const r = Bun.spawnSync([process.execPath, script, ...(opts.args ?? [])], {
    env: { ...env, NODE_ENV: 'test', ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

const daemonLog = (home: string) => readFileSync(join(home, 'logs', 'daemon.log'), 'utf8')

describe('daemon preboot', () => {
  test('a relaunch successor resolves config from its handoff identity, not the environment', () => {
    const home = scratch()
    const handoff = { AGENTHYDRA_HOME: home, AGENTHYDRA_DATA_DIR: join(home, 'data') }
    const r = runChild(
      `const { loadDaemon } = await import(${PREBOOT})
await loadDaemon(async () => {
  const c = await import(${CONFIG})
  console.log(JSON.stringify({ configDir: c.CONFIG_DIR, dataDir: c.DATA_DIR }))
})`,
      { args: ['--relaunch', '--handoff-env', JSON.stringify(handoff)] },
    )
    expect(r.stderr).not.toContain('CRASH')
    expect(JSON.parse(r.stdout.trim())).toEqual({ configDir: home, dataDir: join(home, 'data') })
  }, 20_000)

  test('an exit before file logging starts leaves its code, pid and argv in daemon.log', () => {
    const home = scratch()
    const r = runChild(
      `await import(${PREBOOT})
console.log(process.pid)
process.exit(3)`,
      { env: { AGENTHYDRA_HOME: home }, args: ['--port', '7999'] },
    )
    expect(r.code).toBe(3)
    const log = daemonLog(home)
    expect(log).toContain('daemon exited code=3 before file logging started')
    expect(log).toContain(`pid=${r.stdout.trim()}`)
    expect(log).toContain('argv=["--port","7999"]')
  }, 20_000)

  test('a daemon module that throws while loading leaves its error in daemon.log and exits 1', () => {
    const home = scratch()
    const r = runChild(
      `const { loadDaemon } = await import(${PREBOOT})
await loadDaemon(async () => { throw new Error('database is locked (fixture)') })
console.log('still running')`,
      { env: { AGENTHYDRA_HOME: home } },
    )
    expect(r.code).toBe(1)
    expect(r.stdout).not.toContain('still running')
    const log = daemonLog(home)
    expect(log).toContain('reason=daemon failed to load')
    expect(log).toContain('database is locked (fixture)')
    expect(log).toContain('daemon exited code=1 before file logging started')
  }, 20_000)
})
