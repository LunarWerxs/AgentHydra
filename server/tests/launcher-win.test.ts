// The Windows launcher (launcher/windows/AgentHydra.cs, built by scripts/build-launcher.ts): the contract
// in docs/RELEASING.md, run for real. Release 2.0 ships no Bun: this exe repairs a bundle from the release
// archive, downloads the Bun the bundle pins, and then is the daemon's parent. A local server stands in for
// both GitHub release bases; every launcher run is headless, with a timeout of its own.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLauncher, findCsc } from '../../scripts/build-launcher'

setDefaultTimeout(90_000)

const VERSION = '9.8.7'
const PIN = '1.2.3'
const BUNDLE = `AgentHydra-${VERSION}-windows-x64`

const runnable = process.platform === 'win32' && findCsc() !== null
const suite = runnable ? describe : describe.skip

/** A zip with every entry stored: all the launcher's Framework unzipper needs, and no library for the test to carry. */
function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
    const crc = Bun.hash.crc32(data) >>> 0
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const l = new DataView(local.buffer)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, 20, true)
    l.setUint16(12, 0x21, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, data.length, true)
    l.setUint32(22, data.length, true)
    l.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    const entry = new Uint8Array(46 + nameBytes.length)
    const c = new DataView(entry.buffer)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(14, 0x21, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, data.length, true)
    c.setUint32(24, data.length, true)
    c.setUint16(28, nameBytes.length, true)
    c.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    parts.push(local)
    central.push(entry)
    offset += local.length
  }
  const directory = Buffer.concat(central)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, central.length, true)
  e.setUint16(10, central.length, true)
  e.setUint32(12, directory.length, true)
  e.setUint32(16, offset, true)
  return Buffer.concat([...parts, directory, end])
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

let root = ''
let launcherExe = ''
let hostBun = ''
let server: ReturnType<typeof Bun.serve>
/** What the stand-in GitHub serves, by URL path; every request is also noted in `requests`. */
const served = new Map<string, Uint8Array | string>()
const requests: string[] = []

const releaseBase = () => `http://127.0.0.1:${server.port}/release`
const bunBase = () => `http://127.0.0.1:${server.port}/bun`

beforeAll(async () => {
  if (!runnable) return
  root = mkdtempSync(join(tmpdir(), 'ah-launcher-test-'))
  launcherExe = await buildLauncher({
    outfile: join(root, 'build', 'AgentHydra.exe'),
    version: VERSION,
  })
  hostBun = join(root, 'host-bun.exe')
  copyFileSync(process.execPath, hostBun)
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      const body = served.get(path)
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
    },
  })
})

afterAll(() => {
  if (!runnable) return
  server?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  served.clear()
  requests.length = 0
})

/** The Bun release the pin names: both builds (the one this CPU asks for is the one that is hashed), and a stand-in exe inside. */
function serveBun(standIn: Uint8Array, opts: { sumOf?: Uint8Array } = {}) {
  const archive = zip({ 'bun-windows-x64/': '', 'bun-windows-x64/bun.exe': standIn })
  const lines: string[] = []
  for (const asset of ['bun-windows-x64.zip', 'bun-windows-x64-baseline.zip']) {
    served.set(`/bun/bun-v${PIN}/${asset}`, archive)
    lines.push(`${sha256(opts.sumOf ?? archive)}  ${asset}`)
  }
  served.set(`/bun/bun-v${PIN}/SHASUMS256.txt`, `${lines.join('\n')}\n`)
}

/** This version's release archive, as the packager lays it out: one bundle folder holding every part. */
function serveRelease(opts: { sumOf?: Uint8Array } = {}) {
  const archive = zip({
    [`${BUNDLE}/AgentHydra.exe`]: 'from the archive',
    [`${BUNDLE}/app/server.js`]: 'archive server',
    [`${BUNDLE}/app/release.json`]: '{"version":"archive"}',
    [`${BUNDLE}/app/bun-version`]: `${PIN}\n`,
    [`${BUNDLE}/desk2/hello.txt`]: 'desk2 from the archive',
    [`${BUNDLE}/orchestrator/archive-only.txt`]: 'archive',
    [`${BUNDLE}/misc/archive-only.txt`]: 'archive',
  })
  served.set(`/release/v${VERSION}/${BUNDLE}.zip`, archive)
  served.set(
    `/release/v${VERSION}/SHA256SUMS.txt`,
    `${sha256(opts.sumOf ?? archive)}  ${BUNDLE}.zip\n`,
  )
}

interface Install {
  dir: string
  logs: string
}

/** A bundle folder: the launcher, and by default every part, with the app's own files. */
function makeInstall(opts: { parts?: boolean; server?: string } = {}): Install {
  const dir = mkdtempSync(join(root, 'install-'))
  copyFileSync(launcherExe, join(dir, 'AgentHydra.exe'))
  mkdirSync(join(dir, 'app'))
  writeFileSync(join(dir, 'app', 'server.js'), opts.server ?? '// the daemon')
  writeFileSync(join(dir, 'app', 'release.json'), `{"version":"${VERSION}"}`)
  writeFileSync(join(dir, 'app', 'bun-version'), `${PIN}\n`)
  if (opts.parts !== false) {
    for (const part of ['desk2', 'orchestrator', 'misc']) mkdirSync(join(dir, part))
  }
  return { dir, logs: `${dir}-logs` }
}

/** runtime\bun.exe as the host's own Bun (a hard link where the volume allows, so the copy costs nothing) with a stamp. */
function seedRuntime(install: Install, stamp = PIN) {
  const runtime = join(install.dir, 'runtime')
  mkdirSync(runtime)
  try {
    linkSync(hostBun, join(runtime, 'bun.exe'))
  } catch {
    copyFileSync(hostBun, join(runtime, 'bun.exe'))
  }
  writeFileSync(join(runtime, 'bun.version'), `${stamp}\n`)
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

function launch(
  install: Install,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; cwd?: string } = {},
) {
  return Bun.spawn([join(install.dir, 'AgentHydra.exe'), ...args], {
    cwd: opts.cwd ?? install.dir,
    env: {
      ...(process.env as Record<string, string>),
      AGENTHYDRA_HEADLESS: '1',
      AGENTHYDRA_RELEASE_BASE: releaseBase(),
      AGENTHYDRA_BUN_BASE: bunBase(),
      AGENTHYDRA_RUN_LOG_DIR: install.logs,
      ...opts.env,
    },
    stdin: opts.input === undefined ? 'ignore' : new TextEncoder().encode(opts.input),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
}

async function run(
  install: Install,
  args: string[],
  opts: Parameters<typeof launch>[2] = {},
): Promise<Run> {
  const proc = launch(install, args, opts)
  const timer = setTimeout(() => proc.kill(), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

const launcherLog = (install: Install) => {
  const file = join(install.logs, 'launcher.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

suite('AgentHydra.exe, the Windows launcher', () => {
  test('--version prints the baked-in version and touches nothing', async () => {
    const install = makeInstall({ parts: false })
    const before = readdirSync(install.dir).sort()
    const out = await run(install, ['--version'])
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe(VERSION)
    expect(readdirSync(install.dir).sort()).toEqual(before)
    expect(requests).toEqual([])
  })

  test('a fresh install gets the pinned bun downloaded, checked against its checksum list and stamped', async () => {
    const standIn = readFileSync(launcherExe)
    serveBun(standIn)
    const install = makeInstall()
    const out = await run(install, ['--ensure-bun'])
    expect(out.stderr).toBe('')
    expect(out.code).toBe(0)
    const bun = join(install.dir, 'runtime', 'bun.exe')
    expect(out.stdout.trim()).toBe(bun)
    expect(readFileSync(bun).equals(standIn)).toBe(true)
    expect(readFileSync(join(install.dir, 'runtime', 'bun.version'), 'utf8').trim()).toBe(PIN)
    // The work folder is gone and nothing from the release archive was needed.
    expect(readdirSync(join(install.dir, 'runtime')).sort()).toEqual(['bun.exe', 'bun.version'])
    expect(requests.some((p) => p.endsWith('/SHASUMS256.txt'))).toBe(true)
    expect(requests.every((p) => p.startsWith(`/bun/bun-v${PIN}/`))).toBe(true)
    expect(launcherLog(install)).toContain(`/bun/bun-v${PIN}/`)
  })

  test("a bun whose SHA-256 is not the checksum list's is refused and no runtime\\bun.exe is left", async () => {
    serveBun(readFileSync(launcherExe), { sumOf: new TextEncoder().encode('some other archive') })
    const install = makeInstall()
    const out = await run(install, ['--ensure-bun'])
    expect(out.code).not.toBe(0)
    expect(out.stdout).toBe('')
    expect(out.stderr.trim().split(/\r?\n/)).toHaveLength(1)
    expect(out.stderr).toContain('SHA-256')
    expect(existsSync(join(install.dir, 'runtime', 'bun.exe'))).toBe(false)
    expect(existsSync(join(install.dir, 'runtime', 'bun.version'))).toBe(false)
    expect(launcherLog(install)).toContain('failure')
  })

  test('a runtime whose stamp matches the pin downloads nothing', async () => {
    const install = makeInstall()
    seedRuntime(install)
    const out = await run(install, ['--ensure-bun'])
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe(join(install.dir, 'runtime', 'bun.exe'))
    expect(requests).toEqual([])
    expect(launcherLog(install)).toBe('')
  })

  test('a bun of another version that is running does not block the swap, and the new one is stamped', async () => {
    const standIn = readFileSync(launcherExe)
    serveBun(standIn)
    const install = makeInstall()
    seedRuntime(install, '0.0.1')
    const bun = join(install.dir, 'runtime', 'bun.exe')
    const running = Bun.spawn([bun, '-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    try {
      const out = await run(install, ['--ensure-bun'])
      expect(out.stderr).toBe('')
      expect(out.code).toBe(0)
      expect(readFileSync(bun).equals(standIn)).toBe(true)
      expect(readFileSync(join(install.dir, 'runtime', 'bun.version'), 'utf8').trim()).toBe(PIN)
      expect(alive(running.pid)).toBe(true)
    } finally {
      running.kill()
      await running.exited
    }
  })

  test('a missing desk2 and app file come back from the release archive; parts that are there are not overwritten', async () => {
    serveRelease()
    const install = makeInstall({ server: 'my own daemon' })
    rmSync(join(install.dir, 'desk2'), { recursive: true })
    rmSync(join(install.dir, 'app', 'release.json'))
    writeFileSync(join(install.dir, 'orchestrator', 'mine.txt'), 'mine')
    seedRuntime(install)
    const out = await run(install, ['--ensure-bun'])
    expect(out.stderr).toBe('')
    expect(out.code).toBe(0)
    expect(readFileSync(join(install.dir, 'desk2', 'hello.txt'), 'utf8')).toBe(
      'desk2 from the archive',
    )
    expect(readFileSync(join(install.dir, 'app', 'release.json'), 'utf8')).toBe(
      '{"version":"archive"}',
    )
    expect(readFileSync(join(install.dir, 'app', 'server.js'), 'utf8')).toBe('my own daemon')
    expect(existsSync(join(install.dir, 'orchestrator', 'archive-only.txt'))).toBe(false)
    expect(existsSync(join(install.dir, 'orchestrator', 'mine.txt'))).toBe(true)
    expect(
      readFileSync(join(install.dir, 'AgentHydra.exe')).equals(readFileSync(launcherExe)),
    ).toBe(true)
    expect(readdirSync(install.dir).filter((n) => n.startsWith('.repair-'))).toEqual([])
    expect(requests.every((p) => p.startsWith(`/release/v${VERSION}/`))).toBe(true)
    expect(requests).toContain(`/release/v${VERSION}/SHA256SUMS.txt`)
  })

  test('a release archive that does not match SHA256SUMS.txt restores nothing', async () => {
    serveRelease({ sumOf: new TextEncoder().encode('some other archive') })
    const install = makeInstall({ parts: false })
    seedRuntime(install)
    const out = await run(install, ['--ensure-bun'])
    expect(out.code).not.toBe(0)
    expect(out.stderr).toContain('SHA-256')
    expect(existsSync(join(install.dir, 'desk2'))).toBe(false)
  })

  test('a normal run gives app\\server.js every argument as written, stdin, stdout, the folder, the environment and the exit code', async () => {
    const install = makeInstall({
      server: `const input = await Bun.stdin.text()
console.log(JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), env: process.env.AH_LAUNCHER_PROBE }))
process.exit(7)`,
    })
    seedRuntime(install)
    const cwd = mkdtempSync(join(root, 'cwd-'))
    const args = ['--flag', 'two words', 'say "hi"', 'C:\\dir with space\\', '', 'a\\\\b', 'tail\\']
    const out = await run(install, args, {
      cwd,
      input: 'hello\n',
      env: { AH_LAUNCHER_PROBE: 'seen' },
    })
    expect(out.stderr).toBe('')
    expect(out.code).toBe(7)
    const seen = JSON.parse(out.stdout)
    expect(seen.argv).toEqual(args)
    expect(seen.input).toBe('hello\n')
    expect(seen.cwd.toLowerCase()).toBe(cwd.toLowerCase())
    expect(seen.env).toBe('seen')
    expect(requests).toEqual([])
  })

  test('killing the launcher kills the daemon but not what the daemon started', async () => {
    const install = makeInstall({
      server: `const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true })
child.unref()
console.log(JSON.stringify({ daemon: process.pid, started: child.pid }))
setInterval(() => {}, 1000)`,
    })
    seedRuntime(install)
    const proc = launch(install, [])
    let started = 0
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      let text = ''
      const decoder = new TextDecoder()
      const deadline = Date.now() + 30_000
      while (!text.includes('\n') && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      const { daemon, started: pid } = JSON.parse(text.split('\n')[0]!)
      started = pid
      expect(alive(daemon)).toBe(true)
      proc.kill()
      await proc.exited
      const until = Date.now() + 15_000
      while (alive(daemon) && Date.now() < until) await Bun.sleep(100)
      expect(alive(daemon)).toBe(false)
      expect(alive(started)).toBe(true)
    } finally {
      proc.kill()
      if (started) {
        try {
          process.kill(started)
        } catch {
          // already gone
        }
      }
    }
  })
})
