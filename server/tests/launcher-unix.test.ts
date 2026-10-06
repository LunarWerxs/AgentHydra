import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { writePosixLauncher } from '../../scripts/launcher-posix'

// The POSIX launcher (launcher/posix/agenthydra) is a shell script, so it is tested by running it
// with a real sh against a local server standing in for GitHub's two download hosts. The bun it
// downloads is a small sh script inside a zip, so nothing here needs the network or a real bun.
// A subprocess that hangs must fail its test instead of the suite, so each one has a timeout.
setDefaultTimeout(90_000)
const RUN_TIMEOUT_MS = 60_000

const VERSION = '2.0.0'
const PIN = '1.4.2'
const TARGET = 'linux-x64'
const BUN_ASSETS = [
  'bun-linux-x64',
  'bun-linux-x64-baseline',
  'bun-linux-x64-musl',
  'bun-linux-x64-musl-baseline',
]

/** A POSIX sh: /bin/sh on Linux and macOS, Git for Windows' sh.exe on Windows. */
function findSh(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : null
  const candidates: string[] = []
  const exec = Bun.spawnSync(['git', '--exec-path'], { timeout: 15_000 })
  if (exec.exitCode === 0) {
    // <root>/mingw64/libexec/git-core
    const root = join(exec.stdout.toString().trim(), '..', '..', '..')
    candidates.push(join(root, 'bin', 'sh.exe'), join(root, 'usr', 'bin', 'sh.exe'))
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'sh.exe'))
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

const SH = findSh()

/** Git for Windows' sh sees `C:\x` as `/c/x` (and its /tmp as the temp dir): a path it printed has to
 * be turned back with its own cygpath to be read here. */
function native(path: string): string {
  if (process.platform !== 'win32' || !SH) return path
  const out = Bun.spawnSync([SH, '-c', 'cygpath -m "$1"', 'sh', path], { timeout: 15_000 })
  return out.stdout.toString().trim()
}

const STAND_IN_BUN = `#!/bin/sh
for a in "$@"; do echo "arg:$a"; done
echo "env:$STANDIN_MARK"
cat
exit "\${STANDIN_EXIT:-0}"
`

/** A stored (uncompressed) zip: enough to serve bun's release zip without a zip tool. */
function zip(files: { name: string; data: Uint8Array; mode: number }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = enc.encode(file.name)
    const crc = Bun.hash.crc32(file.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(12, 0x21, true) // 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, file.data.length, true)
    lv.setUint32(22, file.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local, file.data)

    const entry = new Uint8Array(46 + name.length)
    const cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, (3 << 8) | 20, true) // made by Unix, so the mode below is read
    cv.setUint16(6, 20, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, file.data.length, true)
    cv.setUint32(24, file.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(38, ((0o100000 | file.mode) << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    entry.set(name, 46)
    central.push(entry)
    offset += local.length + file.data.length
  }
  const centralSize = central.reduce((n, e) => n + e.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  return Buffer.concat([...parts, ...central, end])
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

const WRONG = '0'.repeat(64)

const scratch: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  scratch.push(dir)
  return dir
}

let archive: Uint8Array
let bunZip: Uint8Array
let fixtures: string
let unameStandIn: string

beforeAll(async () => {
  fixtures = temp('ah-launcher-fixtures')
  const top = `AgentHydra-${VERSION}-${TARGET}`
  const files: Record<string, string> = {
    'app/server.js': 'console.log("from the archive")\n',
    'app/release.json': `{"version":"${VERSION}"}\n`,
    'app/bun-version': `${PIN}\n`,
    'desk2/marker.txt': 'desk2 from the archive\n',
    'orchestrator/marker.txt': 'orchestrator from the archive\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtures, top, rel)), { recursive: true })
    writeFileSync(join(fixtures, top, rel), text)
  }
  const tar = Bun.spawn(['tar', '-czf', 'bundle.tar.gz', top], {
    cwd: fixtures,
    timeout: RUN_TIMEOUT_MS,
  })
  expect(await tar.exited).toBe(0)
  archive = readFileSync(join(fixtures, 'bundle.tar.gz'))
  bunZip = zip([
    { name: 'bun-linux-x64/bun', data: new TextEncoder().encode(STAND_IN_BUN), mode: 0o755 },
  ])

  // The launcher reads the machine with uname; a stand-in (AGENTHYDRA_UNAME) makes every host look
  // like linux-x64, so one set of served files fits Linux, macOS and Windows alike.
  const toolDir = temp('ah-launcher-tools')
  writeFileSync(
    join(toolDir, 'uname'),
    '#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n',
  )
  chmodSync(join(toolDir, 'uname'), 0o755)
  unameStandIn = join(toolDir, 'uname').replaceAll('\\', '/')
})

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface World {
  requests: string[]
  install: string
  run(args: string[], opts?: { stdin?: string; env?: Record<string, string> }): Promise<Run>
}
interface Run {
  code: number
  stdout: string
  stderr: string
}

const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** One install folder holding the launcher, plus a server that answers for both release hosts. */
function world(opts: { bunSums?: string; archiveSums?: string } = {}): World {
  const requests: string[] = []
  const bunHash = opts.bunSums ?? sha256(bunZip)
  const archiveName = `AgentHydra-${VERSION}-${TARGET}.tar.gz`
  const answers = new Map<string, Uint8Array | string>([
    [`/release/v${VERSION}/${archiveName}`, archive],
    // The release's own file is made by `sha256sum out/*`, so its paths carry the folder.
    [
      `/release/v${VERSION}/SHA256SUMS.txt`,
      `${opts.archiveSums ?? sha256(archive)}  out/${archiveName}\n${WRONG}  out/other.tar.gz\n`,
    ],
    [
      `/bun/bun-v${PIN}/SHASUMS256.txt`,
      BUN_ASSETS.map((name) => `${bunHash}  ${name}.zip\n`).join(''),
    ],
  ])
  for (const name of BUN_ASSETS) answers.set(`/bun/bun-v${PIN}/${name}.zip`, bunZip)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      const body = answers.get(path)
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
    },
  })
  servers.push(server)

  const install = temp('ah-launcher-install')
  writePosixLauncher({ outfile: join(install, 'agenthydra'), version: VERSION })
  const base = `http://127.0.0.1:${server.port}`

  async function run(
    args: string[],
    runOpts: { stdin?: string; env?: Record<string, string> } = {},
  ) {
    if (!SH) throw new Error('no sh')
    const env: Record<string, string | undefined> = { ...process.env }
    Object.assign(env, {
      AGENTHYDRA_HEADLESS: '1',
      AGENTHYDRA_UNAME: unameStandIn,
      AGENTHYDRA_RELEASE_BASE: `${base}/release`,
      AGENTHYDRA_BUN_BASE: `${base}/bun`,
      ...runOpts.env,
    })
    const proc = Bun.spawn([SH, join(install, 'agenthydra').replaceAll('\\', '/'), ...args], {
      cwd: install,
      env,
      stdin: runOpts.stdin === undefined ? 'ignore' : new Blob([runOpts.stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RUN_TIMEOUT_MS,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  }
  return { requests, install, run }
}

/** The parts of a complete install; `skip` leaves some out. */
function seedParts(install: string, skip: string[] = []): void {
  const files: Record<string, string> = {
    'app/server.js': 'console.log("local server")\n',
    'app/release.json': '{"version":"local"}\n',
    'app/bun-version': `${PIN}\n`,
    'desk2/marker.txt': 'local desk2\n',
    'orchestrator/local.txt': 'local orchestrator\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue
    mkdirSync(dirname(join(install, rel)), { recursive: true })
    writeFileSync(join(install, rel), text)
  }
}

function seedBun(install: string, version: string, text: string): void {
  mkdirSync(join(install, 'runtime'), { recursive: true })
  writeFileSync(join(install, 'runtime', 'bun'), text)
  chmodSync(join(install, 'runtime', 'bun'), 0o755)
  writeFileSync(join(install, 'runtime', 'bun.version'), `${version}\n`)
}

describe.skipIf(!SH)('POSIX launcher', () => {
  test('--version prints the baked-in version and touches nothing', async () => {
    const w = world()
    const out = await w.run(['--version'])
    expect(out).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' })
    expect(readdirSync(w.install)).toEqual(['agenthydra'])
    expect(w.requests).toEqual([])
  })

  test('a fresh folder gets bun downloaded, verified and stamped, and --ensure-bun prints its path', async () => {
    const w = world()
    seedParts(w.install)
    const out = await w.run(['--ensure-bun'])
    expect(out.code).toBe(0)
    const printed = native(out.stdout.trim())
    expect(printed.endsWith('/runtime/bun')).toBe(true)
    expect(out.stdout.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(printed, 'utf8')).toBe(STAND_IN_BUN)
    expect(readFileSync(join(w.install, 'runtime', 'bun.version'), 'utf8').trim()).toBe(PIN)
    expect(w.requests).toHaveLength(2)
    expect(w.requests).toContain(`/bun/bun-v${PIN}/SHASUMS256.txt`)
    expect(
      w.requests.filter((p) => /^\/bun\/bun-v[^/]+\/bun-linux-x64.*\.zip$/.test(p)),
    ).toHaveLength(1)
  })

  test('a SHA-256 mismatch is refused and leaves no runtime/bun', async () => {
    const w = world({ bunSums: WRONG })
    seedParts(w.install)
    const out = await w.run(['--ensure-bun'])
    expect(out.code).not.toBe(0)
    expect(out.stdout).toBe('')
    expect(out.stderr.trim().split('\n').pop()).toMatch(/SHA-256/)
    const left = existsSync(join(w.install, 'runtime'))
      ? readdirSync(join(w.install, 'runtime'))
      : []
    expect(left).toEqual([])
  })

  test('a matching stamp downloads nothing', async () => {
    const w = world()
    seedParts(w.install)
    seedBun(w.install, PIN, '#!/bin/sh\necho seeded\n')
    const out = await w.run(['--ensure-bun'])
    expect(out.code).toBe(0)
    expect(readFileSync(native(out.stdout.trim()), 'utf8')).toBe('#!/bin/sh\necho seeded\n')
    expect(w.requests).toEqual([])
  })

  test('a new pin moves the old bun aside and stamps the new one last', async () => {
    const w = world()
    seedParts(w.install)
    seedBun(w.install, '1.0.0', 'OLD BUN')
    const out = await w.run(['--ensure-bun'])
    expect(out.code).toBe(0)
    const runtime = join(w.install, 'runtime')
    const aside = readdirSync(runtime).filter((f) => f.startsWith('bun.old-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(runtime, aside[0] as string), 'utf8')).toBe('OLD BUN')
    expect(readFileSync(join(runtime, 'bun'), 'utf8')).toBe(STAND_IN_BUN)
    expect(readFileSync(join(runtime, 'bun.version'), 'utf8').trim()).toBe(PIN)
    expect(readdirSync(runtime).some((f) => f.startsWith('.new-'))).toBe(false)
  })

  test('a missing desk2/ is restored from the release archive and present parts are not overwritten', async () => {
    const w = world()
    seedParts(w.install, ['desk2', 'app/release.json'])
    seedBun(w.install, PIN, '#!/bin/sh\n')
    const out = await w.run(['--ensure-bun'])
    expect(out.code).toBe(0)
    expect(readFileSync(join(w.install, 'desk2', 'marker.txt'), 'utf8')).toBe(
      'desk2 from the archive\n',
    )
    // A missing file inside a present app/ is completed on its own.
    expect(readFileSync(join(w.install, 'app', 'release.json'), 'utf8')).toBe(
      `{"version":"${VERSION}"}\n`,
    )
    expect(readFileSync(join(w.install, 'app', 'server.js'), 'utf8')).toBe(
      'console.log("local server")\n',
    )
    expect(readdirSync(join(w.install, 'orchestrator'))).toEqual(['local.txt'])
    expect(readdirSync(w.install).filter((f) => f.startsWith('.repair-'))).toEqual([])
    expect(w.requests.sort()).toEqual([
      `/release/v${VERSION}/AgentHydra-${VERSION}-${TARGET}.tar.gz`,
      `/release/v${VERSION}/SHA256SUMS.txt`,
    ])
  })

  test('an archive that does not match SHA256SUMS.txt is refused and restores nothing', async () => {
    const w = world({ archiveSums: WRONG })
    seedParts(w.install, ['desk2'])
    seedBun(w.install, PIN, '#!/bin/sh\n')
    const out = await w.run(['--ensure-bun'])
    expect(out.code).not.toBe(0)
    expect(out.stderr.trim().split('\n').pop()).toMatch(/SHA-256/)
    expect(existsSync(join(w.install, 'desk2'))).toBe(false)
  })

  test('a lock left by a launcher that is gone is broken', async () => {
    const w = world()
    seedParts(w.install)
    seedBun(w.install, '1.0.0', 'OLD BUN')
    const lock = join(w.install, '.agenthydra-launcher.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), `2147483646 ${Math.floor(Date.now() / 1000)}\n`)
    const out = await w.run(['--ensure-bun'])
    expect(out.code).toBe(0)
    expect(readFileSync(join(w.install, 'runtime', 'bun.version'), 'utf8').trim()).toBe(PIN)
    expect(existsSync(lock)).toBe(false)
  })

  test('a normal run hands arguments, stdin, stdout and the exit code to the daemon, and prints nothing of its own', async () => {
    const w = world()
    seedParts(w.install)
    const out = await w.run(['serve', 'two words', '--flag'], {
      stdin: 'hello from stdin\n',
      env: { STANDIN_MARK: 'inherited', STANDIN_EXIT: '7' },
    })
    expect(out.code).toBe(7)
    const lines = out.stdout.split('\n')
    expect(lines[0]).toMatch(/^arg:.*\/app\/server\.js$/)
    expect(lines.slice(1)).toEqual([
      'arg:serve',
      'arg:two words',
      'arg:--flag',
      'env:inherited',
      'hello from stdin',
      '',
    ])
  })
})
