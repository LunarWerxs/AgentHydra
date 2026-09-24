// server/src/version-drift.ts - the fleet's Claude versions: what is read, what is flagged, and what
// the fixing pass is (and is NOT) allowed to touch. Every path is a scratch fixture; nothing here
// reads a real profile, spawns npm or records into the real incidents table.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-version-drift-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = join(scratch, 'home')

const {
  checkVersionDrift,
  compareVersion,
  desktopBuildFromCmdline,
  fixVersionDrift,
  runVersionDriftPass,
  stageEngine,
  syncDriftIncidents,
} = await import('../src/version-drift')

type CheckDeps = Parameters<typeof checkVersionDrift>[0] & object
type FixDeps = Parameters<typeof fixVersionDrift>[1] & object
type IncidentDeps = Parameters<typeof syncDriftIncidents>[1] & object

let root: string
let install: string
let npmRoot: string
let claudeHome: string
const P: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' }

function norm(dir: string): string {
  return dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function stage(profile: string, version: string, bytes = `exe ${version}`, lie = false): void {
  const dir = join(profile, 'claude-code', version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'claude.exe'), bytes)
  const sha = createHash('sha256')
    .update(lie ? 'something else' : bytes)
    .digest('hex')
  writeFileSync(
    join(dir, '.payload'),
    JSON.stringify({ sha256: sha, size: Buffer.byteLength(bytes) }),
  )
  writeFileSync(join(dir, '.verified'), `required-${version}`)
}

function liveChat(pid: number, version: string, id: string): void {
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  writeFileSync(
    join(claudeHome, 'sessions', `${id}.json`),
    JSON.stringify({ pid, sessionId: id, cwd: 'D:\\repo', name: id, version }),
  )
}

function checkDeps(overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    desktopInstallRoot: install,
    npmRoot,
    claudeHomes: () => [claudeHome],
    listInstances: async () => [
      { num: 3, name: 'A', dir: P.a, isRunning: true },
      { num: 7, name: 'B', dir: P.b, isRunning: true },
      { num: 13, name: 'C', dir: P.c, isRunning: false },
      { num: 14, name: 'D', dir: P.d, isRunning: false },
    ],
    runningMains: async () => [
      {
        dir: P.a,
        cmdline: `"C:\\Users\\x\\.agenthydra\\data\\claude-native\\2.2553.13-e65898aa776d\\claude.exe" --user-data-dir="${P.a}"`,
      },
      {
        dir: P.b,
        cmdline: `"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-2.2553.1\\claude.exe" --user-data-dir="${P.b}"`,
      },
    ],
    now: () => new Date('2026-09-23T12:00:00Z'),
    ...overrides,
  }
}

function fixDeps(overrides: Partial<FixDeps> = {}): FixDeps & { installs: string[] } {
  const installs: string[] = []
  return {
    installs,
    runningDirs: async () => new Set([norm(P.a), norm(P.b)]),
    stage: stageEngine,
    cliInUse: async () => false,
    npmInstall: async (v) => {
      installs.push(v)
      return { ok: true, detail: '' }
    },
    autofix: true,
    ...overrides,
  }
}

function incidentDeps(open: Array<{ id: string; key: string }> = []) {
  const recorded: string[] = []
  const resolved: string[] = []
  const deps: IncidentDeps = {
    record: async (o) => {
      recorded.push(o.key)
      return { id: `id-${o.key}`, isNew: true, reopened: false, count: 1 }
    },
    notify: async () => ({
      desktop: { attempted: false, ok: false },
      email: { attempted: false, ok: false },
    }),
    openKeys: () => open,
    resolve: (id) => {
      resolved.push(id)
      return true
    },
  }
  return { deps, recorded, resolved }
}

beforeEach(() => {
  root = join(scratch, crypto.randomUUID())
  install = join(root, 'AnthropicClaude')
  npmRoot = join(root, 'npm')
  claudeHome = join(root, '.claude')
  for (const b of ['app-2.2553.1', 'app-2.2553.13', 'packages'])
    mkdirSync(join(install, b), { recursive: true })
  for (const k of ['a', 'b', 'c', 'd'] as const) {
    P[k] = join(root, 'instances', k)
    mkdirSync(join(P[k], 'logs'), { recursive: true })
  }
  // A: open on the newest build, and its log says what that build asked for.
  writeFileSync(
    join(P.a, 'logs', 'main.log'),
    '2026-09-22 13:33:26 [info] [CCD] Initialized with version 2.1.275\n2026-09-22 14:00:00 [info] [CCD] Initialized with version 2.1.280\n',
  )
  stage(P.a, '2.1.275')
  stage(P.a, '2.1.280')
  // B: open on an OLDER build, with the older engine.
  stage(P.b, '2.1.275')
  // C: closed and behind. D: closed, never used the Code tab (no claude-code folder at all).
  stage(P.c, '2.1.271')
  const pkg = join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '2.1.278' }))
  liveChat(process.pid, '2.1.275', 'old-chat')
  liveChat(process.pid, '2.1.280', 'new-chat')
})

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('reading versions', () => {
  test('compareVersion is numeric, not lexical', () => {
    expect(compareVersion('2.1.280', '2.1.28')).toBeGreaterThan(0)
    expect(compareVersion('2.2553.13', '2.2553.1')).toBeGreaterThan(0)
    expect(compareVersion('2.1', '2.1.0')).toBe(0)
  })

  test('the build comes off the command line: managed copy, Squirrel folder, or unknown', () => {
    expect(
      desktopBuildFromCmdline('"C:\\d\\claude-native\\2.2553.13-e65898aa776d\\claude.exe" --x'),
    ).toBe('2.2553.13')
    expect(desktopBuildFromCmdline('"C:\\L\\AnthropicClaude\\app-2.2553.1\\claude.exe"')).toBe(
      '2.2553.1',
    )
    expect(
      desktopBuildFromCmdline('"C:\\L\\AnthropicClaude\\claude.exe" --user-data-dir=x'),
    ).toBeNull()
  })

  test('the report names the target, every out-of-step thing, and nothing that is fine', async () => {
    const r = await checkVersionDrift(checkDeps())
    expect(r.desktop.newestInstalled).toBe('2.2553.13')
    expect(r.engine).toMatchObject({
      target: '2.1.280',
      targetSource: 'desktop-log',
      staleLiveChats: 1,
    })
    expect(r.cli).toEqual({ version: '2.1.278', behind: true })
    const rows = Object.fromEntries(r.instances.map((i) => [i.num, i]))
    expect(rows[3]).toMatchObject({
      running: true,
      build: '2.2553.13',
      stagedEngine: '2.1.280',
      engineBehind: false,
    })
    expect(rows[7]).toMatchObject({ running: true, build: '2.2553.1', engineBehind: true })
    expect(rows[13]).toMatchObject({ running: false, stagedEngine: '2.1.271', engineBehind: true })
    expect(rows[14]).toMatchObject({ stagedEngine: null, engineBehind: false })
    expect(r.flags.map((f) => f.key).sort()).toEqual(['cli', 'desktop-build:#7', 'live-engines'])
  })

  test('a long-lived profile whose start line scrolled away still answers from its spawn lines', async () => {
    writeFileSync(
      join(P.a, 'logs', 'main.log'),
      '2026-09-23 09:00:00 [info] [CCD] session spawn on required_version:2.1.280:65f52a7d: 1 plugin(s)\n',
    )
    const r = await checkVersionDrift(checkDeps())
    expect(r.engine).toMatchObject({ target: '2.1.280', targetSource: 'desktop-log' })
  })

  test('with no profile on the newest build, the target falls back to the newest staged copy', async () => {
    const r = await checkVersionDrift(checkDeps({ runningMains: async () => [] }))
    expect(r.engine).toMatchObject({ target: '2.1.280', targetSource: 'staged' })
  })

  test('a copy whose exe size disagrees with its own payload is not counted as staged', async () => {
    writeFileSync(join(P.c, 'claude-code', '2.1.271', 'claude.exe'), 'truncated')
    const r = await checkVersionDrift(checkDeps())
    expect(r.instances.find((i) => i.num === 13)?.stagedEngine).toBeNull()
  })
})

describe('fixing', () => {
  test('stages ONLY the closed profile that already uses Claude Code, byte-identical, no temp left', async () => {
    const r = await checkVersionDrift(checkDeps())
    const out = await fixVersionDrift(r, fixDeps())
    expect(out.staged).toEqual([13])
    const landed = join(P.c, 'claude-code', '2.1.280')
    for (const f of ['claude.exe', '.payload', '.verified'])
      expect(readFileSync(join(landed, f))).toEqual(
        readFileSync(join(P.a, 'claude-code', '2.1.280', f)),
      )
    expect(readdirSync(join(P.c, 'claude-code')).filter((n) => n.includes('staging'))).toEqual([])
    expect(existsSync(join(P.b, 'claude-code', '2.1.280'))).toBe(false) // open: never touched
    expect(existsSync(join(P.d, 'claude-code'))).toBe(false) // never used Code: not created
  })

  test('a source whose exe does not hash to its payload stages nothing', async () => {
    stage(P.a, '2.1.280', 'exe 2.1.280', true)
    const r = await checkVersionDrift(checkDeps())
    const out = await fixVersionDrift(r, fixDeps())
    expect(out.staged).toEqual([])
    expect(existsSync(join(P.c, 'claude-code', '2.1.280'))).toBe(false)
  })

  test('a profile that opened since the report, or a scan that failed, is not written to', async () => {
    const r = await checkVersionDrift(checkDeps())
    const opened = await fixVersionDrift(
      r,
      fixDeps({ runningDirs: async () => new Set([norm(P.c)]) }),
    )
    expect(opened.staged).toEqual([])
    const blind = await fixVersionDrift(r, fixDeps({ runningDirs: async () => null }))
    expect(blind.staged).toEqual([])
  })

  test('the CLI is pinned to the Desktop target, and left alone while something runs from it', async () => {
    const r = await checkVersionDrift(checkDeps())
    const free = fixDeps()
    expect((await fixVersionDrift(r, free)).cliUpdated).toBe('2.1.280')
    expect(free.installs).toEqual(['2.1.280'])
    const busy = fixDeps({ cliInUse: async () => true })
    const out = await fixVersionDrift(r, busy)
    expect(busy.installs).toEqual([])
    expect(out.cliFlag?.message).toContain('once no terminal chat is running')
  })

  test('a failed npm install is reported in the flag, not swallowed', async () => {
    const r = await checkVersionDrift(checkDeps())
    const out = await fixVersionDrift(
      r,
      fixDeps({ npmInstall: async () => ({ ok: false, detail: 'EBUSY' }) }),
    )
    expect(out.cliUpdated).toBeNull()
    expect(out.cliFlag?.message).toContain('EBUSY')
  })

  test('autofix off writes nothing and installs nothing', async () => {
    const r = await checkVersionDrift(checkDeps())
    const deps = fixDeps({ autofix: false })
    const out = await fixVersionDrift(r, deps)
    expect(out.staged).toEqual([])
    expect(deps.installs).toEqual([])
    expect(existsSync(join(P.c, 'claude-code', '2.1.280'))).toBe(false)
    expect(out.cliFlag?.key).toBe('cli')
  })
})

describe('incidents', () => {
  test('records every current flag and resolves only the ones that went away', async () => {
    const { deps, recorded, resolved } = incidentDeps([
      { id: 'i-cli', key: 'cli' },
      { id: 'i-old', key: 'desktop-build:#99' },
    ])
    const n = await syncDriftIncidents([{ key: 'cli', message: 'x' }], deps)
    expect(recorded).toEqual(['cli'])
    expect(resolved).toEqual(['i-old'])
    expect(n).toBe(1)
  })

  test('a full pass re-checks after fixing, so fixed things are not flagged', async () => {
    const { deps, recorded } = incidentDeps()
    const out = await runVersionDriftPass({ check: checkDeps(), fix: fixDeps(), incidents: deps })
    expect(out.fixed.staged).toEqual([13])
    expect(out.fixed.cliUpdated).toBe('2.1.280')
    // The CLI package.json is a fixture npm never touched, so the re-check still reads 2.1.278;
    // a successful install must not leave a flag behind anyway.
    expect(recorded.sort()).toEqual(['desktop-build:#7', 'live-engines'])
    expect(out.report.instances.find((i) => i.num === 13)?.engineBehind).toBe(false)
  })
})
