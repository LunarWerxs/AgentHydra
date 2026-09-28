// server/src/version-drift.ts - the fleet's Claude versions: what is read, what is flagged, and what
// the fixing pass is (and is NOT) allowed to touch. Every path is a scratch fixture; nothing here
// reads a real profile, spawns npm or records into the real incidents table.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const scratch = `${process.env.TEMP ?? '/tmp'}/agenthydra-version-drift-test-${crypto.randomUUID()}`
process.env.AGENTHYDRA_HOME = join(scratch, 'home')

const {
  checkVersionDrift,
  compareVersion,
  desktopBuildFromCmdline,
  desktopFeedUrl,
  feedUrlFromDeviceId,
  feedUrlFromSquirrelLogs,
  fixVersionDrift,
  newestInReleases,
  releasesUrl,
  repairInstallLinks,
  retargetInstallPath,
  runVersionDriftPass,
  stageEngine,
  syncDriftIncidents,
} = await import('../src/version-drift')
const { desktopInstallSettled, whileDesktopInstallUpdates } = await import(
  '../src/desktop-install-lock'
)

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
    // Claude's update feed is never asked from a test; a case that needs it says what it offers.
    desktopFeed: async () => null,
    // A frozen clock far after every log line below, so it can never fall before them.
    now: () => new Date('2099-01-01T12:00:00Z'),
    ...overrides,
  }
}

function fixDeps(
  overrides: Partial<FixDeps> = {},
): FixDeps & { installs: string[]; desktopRuns: string[]; linkRuns: string[] } {
  const installs: string[] = []
  const desktopRuns: string[] = []
  const linkRuns: string[] = []
  return {
    installs,
    desktopRuns,
    linkRuns,
    repairLinks: async (newest) => {
      linkRuns.push(newest)
      return { repaired: [], failed: [] }
    },
    updateDesktop: async (installed) => {
      desktopRuns.push(installed)
      return { ok: true, detail: '' }
    },
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

describe('the Claude Desktop install behind its own update feed', () => {
  const DEVICE = '2ef35f69-cf02-4515-851a-c5b0c659cae5'
  const FEED = `https://api.anthropic.com/api/desktop/win32/x64/squirrel/update?device_id=${DEVICE}&version=2.9939.2&os_version=10.0.26200`

  test('only the Anthropic Windows feed with a device id is accepted, asking about what is installed', () => {
    expect(desktopFeedUrl(FEED, '2.9939.4')).toBe(
      FEED.replace('version=2.9939.2', 'version=2.9939.4'),
    )
    for (const bad of [
      FEED.replace('https:', 'http:'),
      FEED.replace('api.anthropic.com', 'api.anthropic.com.evil.test'),
      FEED.replace('api.anthropic.com', 'api.anthropic.com:8443'),
      FEED.replace('/squirrel/update', '/squirrel/other'),
      FEED.replace(DEVICE, 'not-a-uuid'),
      'not a url',
    ])
      expect(desktopFeedUrl(bad, '2.9939.2')).toBeNull()
    expect(desktopFeedUrl(FEED, '2.9939.2 --evil')).toBeNull()
  })

  test('the feed URL comes from the newest Squirrel log that names one', () => {
    writeFileSync(
      join(install, 'Squirrel-CheckForUpdate.log'),
      `[27/09/26 05:37:19] info: Program: Starting Squirrel Updater: --checkForUpdate ${FEED}\n[27/09/26 05:37:20] info: Program: Finished Squirrel Updater\n`,
    )
    expect(feedUrlFromSquirrelLogs(install, '2.9939.2')).toBe(FEED)
    writeFileSync(
      join(install, 'Squirrel-Update.log'),
      '[28/09/26 01:00:00] info: Program: Starting Squirrel Updater: --update https://example.test/squirrel/update?device_id=x\n',
    )
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(install, 'Squirrel-Update.log'), later, later)
    // The newest log names a foreign host: refused outright, never swapped for an older one.
    expect(feedUrlFromSquirrelLogs(install, '2.9939.2')).toBeNull()
    rmSync(join(install, 'Squirrel-Update.log'))
    rmSync(join(install, 'Squirrel-CheckForUpdate.log'))
    expect(feedUrlFromSquirrelLogs(install, '2.9939.2')).toBeNull()
  })

  test('with no log, the default profile base64 device id builds the URL', () => {
    const did = join(root, 'ant-did')
    writeFileSync(did, Buffer.from(DEVICE).toString('base64'))
    expect(feedUrlFromDeviceId(did, '2.9939.2', 'x64', '10.0.26200')).toBe(FEED)
    writeFileSync(did, Buffer.from('garbage').toString('base64'))
    expect(feedUrlFromDeviceId(did, '2.9939.2', 'x64', '10.0.26200')).toBeNull()
    expect(feedUrlFromDeviceId(join(root, 'missing'), '2.9939.2')).toBeNull()
  })

  test('RELEASES is read at the address Squirrel reads, and its newest build wins', () => {
    const url = new URL(releasesUrl(FEED))
    expect(url.pathname).toBe('/api/desktop/win32/x64/squirrel/update/RELEASES')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      device_id: DEVICE,
      version: '2.9939.2',
      id: 'AnthropicClaude',
      localVersion: '2.9939.2',
      arch: 'amd64',
    })
    expect(
      newestInReleases(
        [
          'AAA https://downloads.claude.ai/releases/win32/x64/AnthropicClaude-2.9939.4-full.nupkg 255832775',
          'BBB AnthropicClaude-2.10000.1-delta.nupkg 1000',
          'CCC AnthropicClaude-2.9939.10-full.nupkg 1000',
        ].join('\n'),
      ),
    ).toBe('2.10000.1')
    expect(newestInReleases('{"type":"error"}')).toBeNull()
  })

  test('an install behind the feed is flagged; level with it, or an unreachable feed, is not', async () => {
    const behind = await checkVersionDrift(checkDeps({ desktopFeed: async () => '2.9939.4' }))
    expect(behind.desktop).toMatchObject({
      newestInstalled: '2.2553.13',
      available: '2.9939.4',
      installBehind: true,
    })
    expect(behind.flags.find((f) => f.key === 'desktop-install')?.message).toContain('2.9939.4')
    const feeds = [
      async () => '2.2553.13',
      async () => null,
      async (): Promise<string | null> => {
        throw Error('offline')
      },
    ]
    for (const desktopFeed of feeds) {
      const r = await checkVersionDrift(checkDeps({ desktopFeed }))
      expect(r.desktop.installBehind).toBe(false)
      expect(r.flags.some((f) => f.key === 'desktop-install')).toBe(false)
    }
  })

  test('a folder an interrupted update left half-written is not counted, so the update runs again', async () => {
    mkdirSync(join(install, 'app-2.9939.4'), { recursive: true })
    writeFileSync(
      join(install, 'packages', 'RELEASES'),
      'ABC AnthropicClaude-2.2553.13-full.nupkg 100\n',
    )
    const r = await checkVersionDrift(checkDeps({ desktopFeed: async () => '2.9939.4' }))
    expect(r.desktop).toMatchObject({ newestInstalled: '2.2553.13', installBehind: true })
    writeFileSync(
      join(install, 'packages', 'RELEASES'),
      'DEF AnthropicClaude-2.9939.4-full.nupkg 100\n',
    )
    const done = await checkVersionDrift(checkDeps({ desktopFeed: async () => '2.9939.4' }))
    expect(done.desktop).toMatchObject({ newestInstalled: '2.9939.4', installBehind: false })
  })

  test('the fixing pass runs the updater for the installed build, and never with autofix off', async () => {
    const r = await checkVersionDrift(checkDeps({ desktopFeed: async () => '2.9939.4' }))
    const on = fixDeps()
    expect((await fixVersionDrift(r, on)).desktopUpdated).toBe('2.9939.4')
    expect(on.desktopRuns).toEqual(['2.2553.13'])
    const off = fixDeps({ autofix: false })
    const out = await fixVersionDrift(r, off)
    expect(off.desktopRuns).toEqual([])
    expect(out.desktopFlag?.key).toBe('desktop-install')
    const level = fixDeps()
    await fixVersionDrift(await checkVersionDrift(checkDeps()), level)
    expect(level.desktopRuns).toEqual([])
  })

  test('a pass that lands the update clears its flag and flags each open instance on the old build', async () => {
    const { deps, recorded } = incidentDeps()
    const out = await runVersionDriftPass({
      check: checkDeps({ desktopFeed: async () => '2.9939.4' }),
      fix: fixDeps({
        // Nothing else is fixed in this pass, so only the Desktop update can cause the re-check.
        runningDirs: async () => null,
        cliInUse: async () => true,
        updateDesktop: async () => {
          mkdirSync(join(install, 'app-2.9939.4'), { recursive: true })
          return { ok: true, detail: '' }
        },
      }),
      incidents: deps,
    })
    expect(out.fixed.desktopUpdated).toBe('2.9939.4')
    expect(out.report.desktop).toMatchObject({ newestInstalled: '2.9939.4', installBehind: false })
    expect(recorded).not.toContain('desktop-install')
    expect(recorded).toEqual(expect.arrayContaining(['desktop-build:#3', 'desktop-build:#7']))
  })

  test('a failed updater keeps its reason; one that claims success but changed nothing stays flagged', async () => {
    const failed = incidentDeps()
    const a = await runVersionDriftPass({
      check: checkDeps({ desktopFeed: async () => '2.9939.4' }),
      fix: fixDeps({ updateDesktop: async () => ({ ok: false, detail: 'Update.exe exited 1' }) }),
      incidents: failed.deps,
    })
    expect(a.flags.find((f) => f.key === 'desktop-install')?.message).toContain(
      'Update.exe exited 1',
    )
    const silent = incidentDeps()
    const b = await runVersionDriftPass({
      check: checkDeps({ desktopFeed: async () => '2.9939.4' }),
      fix: fixDeps(),
      incidents: silent.deps,
    })
    expect(b.fixed.desktopUpdated).toBe('2.9939.4')
    expect(silent.recorded).toContain('desktop-install')
  })

  test('a managed launch waits for an update in flight, and a failed update does not wedge it', async () => {
    let finish!: () => void
    const order: string[] = []
    const update = whileDesktopInstallUpdates(() =>
      new Promise<void>((r) => {
        finish = r
      }).then(() => {
        order.push('update')
      }),
    )
    const launch = desktopInstallSettled().then(() => {
      order.push('launch')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    finish()
    await Promise.all([update, launch])
    expect(order).toEqual(['update', 'launch'])
    await expect(
      whileDesktopInstallUpdates(async () => {
        throw Error('boom')
      }),
    ).rejects.toThrow('boom')
    await desktopInstallSettled()
  })
})

describe('the install registrations an update leaves behind', () => {
  const ROOT = 'C:\\Users\\x\\AppData\\Local\\AnthropicClaude'

  test('only a path into an OLDER app folder of this install is moved, and only its build part', () => {
    expect(retargetInstallPath(`"${ROOT}\\app-2.7032.0\\claude.exe" "%1"`, ROOT, '2.9939.4')).toBe(
      `"${ROOT}\\app-2.9939.4\\claude.exe" "%1"`,
    )
    expect(
      retargetInstallPath(
        `${ROOT.toLowerCase()}\\app-2.7032.0\\resources\\chrome-native-host.exe`,
        ROOT,
        '2.9939.4',
      ),
    ).toBe(`${ROOT}\\app-2.9939.4\\resources\\chrome-native-host.exe`)
    for (const untouched of [
      `"${ROOT}\\app-2.9939.4\\claude.exe" "%1"`, // already newest
      `"${ROOT}\\app-3.0.0\\claude.exe" "%1"`, // newer than what is installed
      `"C:\\Users\\x\\.agenthydra\\data\\claude-native\\2.9939.2-abc\\claude.exe" "%1"`, // mid-launch
      `"${ROOT}\\claude.exe" "%1"`, // the stub
      `"D:\\Other\\AnthropicClaude\\app-2.7032.0\\claude.exe" "%1"`, // another install
      `cmd /c "${ROOT}\\app-2.7032.0\\claude.exe"`, // not a plain path or command
    ])
      expect(retargetInstallPath(untouched, ROOT, '2.9939.4')).toBeNull()
  })

  test('both registrations move onto the newest build, and only when that build holds the file', async () => {
    const newest = join(install, 'app-2.9939.4')
    mkdirSync(join(newest, 'resources'), { recursive: true })
    writeFileSync(join(newest, 'claude.exe'), 'exe')
    writeFileSync(join(newest, 'resources', 'chrome-native-host.exe'), 'host')
    const manifestPath = join(root, 'host.json')
    const oldHost = `${install}\\app-2.7032.0\\resources\\chrome-native-host.exe`
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'com.anthropic.claude_browser_extension',
        path: oldHost,
        type: 'stdio',
      }),
    )
    let handler: string | null = `"${install}\\app-2.7032.0\\claude.exe" "%1"`
    const io = {
      readHandler: async () => handler,
      writeHandler: async (v: string) => {
        handler = v
        return true
      },
      manifestPath,
    }
    const out = await repairInstallLinks(install, '2.9939.4', io)
    expect(out).toEqual({
      repaired: ['claude:// link handler', 'browser extension host'],
      failed: [],
    })
    expect(handler).toBe(`"${join(newest, 'claude.exe')}" "%1"`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest).toEqual({
      name: 'com.anthropic.claude_browser_extension',
      path: join(newest, 'resources', 'chrome-native-host.exe'),
      type: 'stdio',
    })
    // A second pass finds nothing to do; a newest build missing the file is never pointed at.
    expect(await repairInstallLinks(install, '2.9939.4', io)).toEqual({ repaired: [], failed: [] })
    handler = `"${install}\\app-2.7032.0\\claude.exe" "%1"`
    expect(await repairInstallLinks(install, '2.9940.0', io)).toEqual({ repaired: [], failed: [] })
    expect(handler).toBe(`"${install}\\app-2.7032.0\\claude.exe" "%1"`)
  })

  test('a write that does not read back, or a manifest for something else, is not claimed as fixed', async () => {
    const newest = join(install, 'app-2.9939.4')
    mkdirSync(join(newest, 'resources'), { recursive: true })
    writeFileSync(join(newest, 'claude.exe'), 'exe')
    writeFileSync(join(newest, 'resources', 'chrome-native-host.exe'), 'host')
    const manifestPath = join(root, 'other.json')
    const foreign = {
      name: 'com.example.other',
      path: `${install}\\app-2.7032.0\\resources\\chrome-native-host.exe`,
    }
    writeFileSync(manifestPath, JSON.stringify(foreign))
    const out = await repairInstallLinks(install, '2.9939.4', {
      readHandler: async () => `"${install}\\app-2.7032.0\\claude.exe" "%1"`,
      writeHandler: async () => false,
      manifestPath,
    })
    expect(out).toEqual({ repaired: [], failed: ['claude:// link handler'] })
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(foreign)
  })

  test('the pass repairs onto the build it just installed, flags a failed repair, and never runs with autofix off', async () => {
    const r = await checkVersionDrift(checkDeps({ desktopFeed: async () => '2.9939.4' }))
    const on = fixDeps()
    await fixVersionDrift(r, on)
    expect(on.linkRuns).toEqual(['2.9939.4'])
    const off = fixDeps({ autofix: false })
    await fixVersionDrift(r, off)
    expect(off.linkRuns).toEqual([])
    const { deps, recorded } = incidentDeps()
    await runVersionDriftPass({
      check: checkDeps(),
      fix: fixDeps({
        repairLinks: async () => ({ repaired: [], failed: ['claude:// link handler'] }),
      }),
      incidents: deps,
    })
    expect(recorded).toContain('desktop-links')
  })
})
