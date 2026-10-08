#!/usr/bin/env bun
/**
 * End to end, headless: a real AgentHydra 1.13.0 Windows install applies its own update to this
 * checkout's version (package.json).
 *
 *   bun scripts/upgrade-e2e-1x.ts [--scenario 1|2|both] [--rebuild] [--reuse-package] [--keep]
 *
 * Run it before a release that 1.x installs will update to (every 2.x moves them off the
 * compiled 1.x layout). Windows only: it needs git, csc.exe and openssl (Git for Windows has one).
 * ROOT is %TEMP%/ah-upgrade-e2e unless AH_UPGRADE_E2E_ROOT says otherwise; heavy steps go through
 * ~/.claude/tools/fairjob.cmd when that exists.
 *
 * Nothing is published and no system setting is touched (no hosts file, certificate store, proxy or
 * registry change). Everything it builds, serves or installs lives under ROOT.
 *
 *  - 1.13.0 is BUILT from its tag (git worktree, cached in ROOT/build-1.13), never downloaded.
 *  - The new version is packaged from the checkout (scripts/package-release.ts) into ROOT/rel-2.0.
 *  - 1.13 asks api.github.com for releases/latest. A CONNECT proxy (HTTPS_PROXY on the 1.13 process)
 *    tunnels that one host to a local HTTPS server with a self-signed certificate
 *    (NODE_TLS_REJECT_UNAUTHORIZED=0 on the 1.13 process); its asset URLs point back at the same fake.
 *  - The 2.0 launcher is started by 1.13 through WMI, and WMI does NOT carry the environment, so
 *    AGENTHYDRA_RELEASE_BASE / AGENTHYDRA_BUN_BASE / AGENTHYDRA_HEADLESS cannot reach it. The harness
 *    instead drops AhRedirect.dll + AgentHydra.exe.config next to the install's exe (the .NET config
 *    file loads an AppDomainManager that registers a web-request module for the two GitHub prefixes). That redirects the
 *    launcher's two download hosts to local servers and hides its progress window. The launcher's own
 *    code is untouched and 1.13's swap leaves the extra files alone.
 *
 * Exits 0 only when every check passes. Log: ROOT/upgrade-e2e.log.
 */
import { Database } from 'bun:sqlite'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRepoRoot } from '../tests/repo-root'
import { findCsc } from './build-launcher'

const ROOT = (process.env.AH_UPGRADE_E2E_ROOT ?? join(tmpdir(), 'ah-upgrade-e2e')).replaceAll(
  '\\',
  '/',
)
const REPO = findRepoRoot(import.meta.dir).replaceAll('\\', '/')
const NEW_VERSION: string = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const LOG = join(ROOT, 'upgrade-e2e.log')
const OLD_TAG = 'v1.13.0'
const OLD_NAME = 'AgentHydra-1.13.0-windows-x64'
const BUILD113 = join(ROOT, 'build-1.13')
const REL2 = join(ROOT, 'rel-2.0')
const INSTALL = join(ROOT, 'install')
const BUN_CACHE = join(ROOT, 'bun-cache')
const FAIRJOB = join(homedir(), '.claude', 'tools', 'fairjob.cmd')
const GIT_OPENSSL = join(
  process.env.ProgramFiles ?? 'C:/Program Files',
  'Git',
  'usr',
  'bin',
  'openssl.exe',
)
const OPENSSL = existsSync(GIT_OPENSSL) ? GIT_OPENSSL : 'openssl'
const CSC = findCsc() ?? 'csc.exe'
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined)
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

mkdirSync(ROOT, { recursive: true })
writeFileSync(LOG, '')
function log(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`
  console.log(line)
  appendFileSync(LOG, `${line}\n`)
}

// ---- checks ----------------------------------------------------------------------------------
let failures = 0
function check(ok: unknown, name: string, detail = ''): boolean {
  if (!ok) failures++
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  return Boolean(ok)
}

// ---- helpers ---------------------------------------------------------------------------------
function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): number {
  log(`$ ${cmd} ${args.join(' ')}   (cwd ${cwd})`)
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env } as Record<string, string>,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
  if (out) appendFileSync(LOG, `${out.split('\n').slice(-40).join('\n')}\n`)
  return r.status ?? 1
}

/** CPU-heavy work goes through the fair-job wrapper where there is one (exit 75 = did not start). */
function heavy(command: string, cwd: string): number {
  if (!existsSync(FAIRJOB)) return run('cmd.exe', ['/c', command], cwd)
  const code = run('cmd.exe', ['/c', FAIRJOB, '-Weight', '3', '-Run', command], cwd)
  if (code === 75) throw new Error(`fairjob refused to start (low memory): ${command}`)
  return code
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function freePorts(n: number): Promise<number[]> {
  const out: number[] = []
  for (let p = 7921; p <= 7939 && out.length < n; p++) {
    const ok = await new Promise<boolean>((res) => {
      const s = createServer()
      s.once('error', () => res(false))
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)))
    })
    if (ok) out.push(p)
  }
  if (out.length < n) throw new Error(`need ${n} free ports in 7921-7939, found ${out.length}`)
  return out
}

interface Proc {
  pid: number
  name: string
  path: string
}
/** Every process whose image lives under ROOT. Only these are ever killed. */
function procsUnderRoot(): Proc[] {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  let rows: { ProcessId: number; Name: string; ExecutablePath: string }[] = []
  // An unreadable list must fail the run: read as empty, "no 1.13 process is left" would pass unchecked.
  try {
    const j = JSON.parse(r.stdout || '[]')
    rows = Array.isArray(j) ? j : [j]
  } catch (e) {
    throw new Error(
      `the process list did not parse (${String(e)}): ${String(r.stdout).slice(0, 300)}`,
    )
  }
  const root = `${norm(ROOT)}/`
  return rows
    .filter((x) => norm(x.ExecutablePath).startsWith(root))
    .map((x) => ({ pid: x.ProcessId, name: x.Name, path: x.ExecutablePath }))
}
function killUnderRoot(why: string): void {
  for (const p of procsUnderRoot()) {
    log(`kill pid ${p.pid} ${p.path} (${why})`)
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
  }
}

async function health(
  port: number,
): Promise<{ version?: string; distribution?: string; service?: string; pid?: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return r.ok ? ((await r.json()) as never) : null
  } catch {
    return null
  }
}

// ---- 1. build 1.13.0 from its tag -----------------------------------------------------------
function build113(): void {
  const done = join(BUILD113, OLD_NAME, 'AgentHydra.exe')
  if (existsSync(done) && !flag('--rebuild')) {
    log(`1.13.0 build cached: ${done}`)
    return
  }
  log('building 1.13.0 from the tag (worktree)')
  const wt = join(ROOT, 'src-1.13')
  rmSync(BUILD113, { recursive: true, force: true })
  if (existsSync(wt)) run('git', ['worktree', 'remove', '--force', wt], REPO)
  rmSync(wt, { recursive: true, force: true })
  run('git', ['worktree', 'prune'], REPO)
  if (run('git', ['worktree', 'add', '--detach', wt, OLD_TAG], REPO) !== 0)
    throw new Error('worktree add failed')
  try {
    if (heavy('bun install --frozen-lockfile', wt) !== 0) throw new Error('bun install failed')
    if (heavy('bun run --cwd web build', wt) !== 0) throw new Error('web build failed')
    const stage = join(BUILD113, OLD_NAME)
    mkdirSync(join(stage, 'orchestrator'), { recursive: true })
    for (const f of ['orch.py', 'orch_cli.py', 'README.md'])
      cpSync(join(wt, 'orchestrator', f), join(stage, 'orchestrator', f))
    for (const d of ['scripts', 'docs'])
      cpSync(join(wt, 'orchestrator', d), join(stage, 'orchestrator', d), { recursive: true })
    rmSync(join(stage, 'orchestrator', 'scripts', 'tests'), { recursive: true, force: true })
    const prune = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        if (e.name === '__pycache__') rmSync(join(dir, e.name), { recursive: true, force: true })
        else prune(join(dir, e.name))
      }
    }
    prune(join(stage, 'orchestrator'))
    const exe = join(stage, 'AgentHydra.exe')
    if (
      heavy(`bun run scripts/build.ts --skip-web --target windows-x64 --outfile ${exe}`, wt) !== 0
    )
      throw new Error('compile failed')
    const v = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true })
    log(`1.13 exe --version: ${v.stdout.trim()}`)
    mkdirSync(join(stage, 'misc'), { recursive: true })
    for (const f of [
      'AgentHydra-Tray.exe',
      'AgentHydra-Tray.json',
      'AgentHydra.ico',
      'Create-Shortcut.ps1',
      'New-TrayShortcut.ps1',
      'Instance-Launch.vbs',
      'Tray-Host.ps1',
      'AgentHydra-Tray.ps1',
      'Tray-Launch.vbs',
    ])
      cpSync(join(wt, 'misc', f), join(stage, 'misc', f))
  } finally {
    run('git', ['worktree', 'remove', '--force', wt], REPO)
    run('git', ['worktree', 'prune'], REPO)
  }
}

// ---- 2. package the new version ------------------------------------------------------------------------
let ZIP2 = ''
let BUN_PIN = ''
function package2(): void {
  if (!flag('--reuse-package') || !existsSync(join(REL2, 'SHA256SUMS.txt'))) {
    for (const d of ['desk2/web/dist', 'desk2/hydra/dist']) {
      if (!existsSync(join(REPO, d))) {
        log(`${d} missing: building desk2`)
        if (heavy('bun run build', join(REPO, 'desk2')) !== 0) throw new Error('desk2 build failed')
      }
    }
    rmSync(REL2, { recursive: true, force: true })
    mkdirSync(REL2, { recursive: true })
    if (heavy(`bun scripts/package-release.ts --target windows-x64 --out ${REL2}`, REPO) !== 0)
      throw new Error('package-release failed')
    // release.yml: `sha256sum out/* > out/SHA256SUMS.txt` run from the directory above out/, so each
    // line is "<hash>  out/<name>" (text mode: two spaces).
    const lines = readdirSync(REL2, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(zip|exe|tar\.gz)$/.test(e.name))
      .map((e) => `${sha256(join(REL2, e.name))}  out/${e.name}`)
    writeFileSync(join(REL2, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
  }
  ZIP2 = readdirSync(REL2).find((n) => n.endsWith('-windows-x64.zip')) ?? ''
  if (!ZIP2) throw new Error('no windows zip in rel-2.0')
  const bundle = join(REL2, ZIP2.replace(/\.zip$/, ''))
  BUN_PIN = readFileSync(join(bundle, 'app', 'bun-version'), 'utf8').trim()
  log(
    `2.0 packaged: ${ZIP2} (${(statSync(join(REL2, ZIP2)).size / 1048576).toFixed(1)} MB), bun pin ${BUN_PIN}`,
  )
}

// ---- 3. fake release: TLS cert, https api, release http, bun mirror, CONNECT proxy ------------
const certDir = join(ROOT, 'cert')
function makeCert(): void {
  if (existsSync(join(certDir, 'cert.pem'))) return
  mkdirSync(certDir, { recursive: true })
  const code = run(
    OPENSSL,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(certDir, 'key.pem'),
      '-out',
      join(certDir, 'cert.pem'),
      '-days',
      '30',
      '-subj',
      '/CN=api.github.com',
      '-addext',
      'subjectAltName=DNS:api.github.com',
    ],
    certDir,
    { MSYS_NO_PATHCONV: '1' },
  )
  if (code !== 0) throw new Error('openssl could not make the certificate')
}

let bunDelayMs = 0
const servers: { stop: () => void }[] = []
const sockets = new Set<Socket>()

function serveFile(path: string): Response {
  if (!existsSync(path)) return new Response('not found', { status: 404 })
  return new Response(Bun.file(path))
}

async function startFakes(ports: { api: number; rel: number; bun: number; proxy: number }) {
  const apiBase = `https://api.github.com`
  const assetNames = readdirSync(REL2).filter((n) => /\.(zip|exe)$/.test(n))
  const releaseJson = () => ({
    tag_name: `v${NEW_VERSION}`,
    name: `AgentHydra ${NEW_VERSION}`,
    draft: false,
    prerelease: false,
    assets: [...assetNames, 'SHA256SUMS.txt'].map((name) => ({
      name,
      size: statSync(join(REL2, name)).size,
      browser_download_url: `${apiBase}/dl/${name}`,
    })),
  })
  // the https "api.github.com"
  const api = Bun.serve({
    port: ports.api,
    hostname: '127.0.0.1',
    tls: { key: Bun.file(join(certDir, 'key.pem')), cert: Bun.file(join(certDir, 'cert.pem')) },
    fetch(req) {
      const u = new URL(req.url)
      log(`[api.github.com] ${req.method} ${u.pathname}`)
      if (/^\/repos\/lunarwerxs\/agenthydra\/releases\/latest$/i.test(u.pathname))
        return Response.json(releaseJson())
      if (u.pathname.startsWith('/dl/'))
        return serveFile(join(REL2, decodeURIComponent(u.pathname.slice(4))))
      return new Response('not found', { status: 404 })
    },
  })
  servers.push({ stop: () => api.stop(true) })
  // the plain-http release host the 2.0 launcher is redirected to: /v<version>/<file>
  const rel = Bun.serve({
    port: ports.rel,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      log(`[release] ${req.method} ${u.pathname}`)
      const prefix = `/v${NEW_VERSION}/`
      const file = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : ''
      return file && !file.includes('/')
        ? serveFile(join(REL2, file))
        : new Response('not found', { status: 404 })
    },
  })
  servers.push({ stop: () => rel.stop(true) })
  // the bun mirror: real bun zips fetched once from oven-sh and cached; the zip is held back
  // `bunDelayMs` (headers at once, then the body in pieces under the launcher's 60 s read timeout).
  const bun = Bun.serve({
    port: ports.bun,
    hostname: '127.0.0.1',
    idleTimeout: 0, // Bun's default 10 s would cut the held-back download
    async fetch(req) {
      const u = new URL(req.url)
      const m = /^\/bun-v([^/]+)\/([^/]+)$/.exec(u.pathname)
      if (!m) return new Response('not found', { status: 404 })
      const [, ver, file] = m
      const cached = join(BUN_CACHE, `v${ver}`, file!)
      if (!existsSync(cached)) {
        const upstream = `https://github.com/oven-sh/bun/releases/download/bun-v${ver}/${file}`
        log(`[bun mirror] fetching ${upstream} once`)
        const r = await fetch(upstream, { redirect: 'follow' })
        if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502 })
        mkdirSync(join(BUN_CACHE, `v${ver}`), { recursive: true })
        writeFileSync(cached, new Uint8Array(await r.arrayBuffer()))
      }
      if (!file!.endsWith('.zip') || bunDelayMs <= 0) {
        log(`[bun mirror] ${u.pathname} served at once`)
        return serveFile(cached)
      }
      log(`[bun mirror] ${u.pathname} held back ${bunDelayMs / 1000}s`)
      const data = readFileSync(cached)
      const head = Math.min(262144, data.length - 16)
      const delay = bunDelayMs
      return new Response(
        new ReadableStream({
          async start(ctl) {
            ctl.enqueue(data.subarray(0, head))
            let pos = head
            const t0 = Date.now()
            while (Date.now() - t0 < delay) {
              await sleep(Math.min(20_000, delay - (Date.now() - t0)))
              ctl.enqueue(data.subarray(pos, pos + 1))
              pos += 1
            }
            ctl.enqueue(data.subarray(pos))
            ctl.close()
            log(
              `[bun mirror] ${u.pathname} finished after ${Math.round((Date.now() - t0) / 1000)}s`,
            )
          },
        }),
        { headers: { 'content-length': String(data.length), 'content-type': 'application/zip' } },
      )
    },
  })
  servers.push({ stop: () => bun.stop(true) })
  // the CONNECT proxy: api.github.com:443 is tunnelled to the fake https server, anything else refused
  const proxy = createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => {})
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      client.off('data', onData)
      const first = buf.subarray(0, buf.indexOf('\r\n')).toString()
      const m = /^CONNECT ([^ ]+) /.exec(first)
      if (m && /^api\.github\.com:443$/i.test(m[1]!)) {
        const up = connect(ports.api, '127.0.0.1')
        sockets.add(up)
        up.on('error', () => client.destroy())
        client.on('error', () => up.destroy())
        up.once('connect', () => {
          log(`[proxy] CONNECT ${m[1]} -> fake api`)
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          const rest = buf.subarray(end + 4)
          if (rest.length) up.write(rest)
          client.pipe(up)
          up.pipe(client)
        })
      } else {
        log(`[proxy] refused: ${first}`)
        client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      }
    }
    client.on('data', onData)
  })
  await new Promise<void>((ok) => proxy.listen(ports.proxy, '127.0.0.1', ok))
  servers.push({
    stop: () => {
      for (const s of sockets) s.destroy()
      proxy.close()
    },
  })
}

// ---- harness for the 2.0 launcher (see the header) -------------------------------------------
function buildRedirectDll(): string {
  const dir = join(ROOT, 'redirect')
  const dll = join(dir, 'AhRedirect.dll')
  if (existsSync(dll)) return dll
  mkdirSync(dir, { recursive: true })
  const src = `using System;
using System.IO;
using System.Net;
using System.Reflection;
namespace AhE2E {
  public class Mgr : AppDomainManager {
    public override void InitializeNewDomain(AppDomainSetup setup) {
      InitializationFlags = AppDomainManagerInitializationOptions.None;
      WebRequest.RegisterPrefix("https://github.com/LunarWerxs/AgentHydra/releases/download/", new Redirect());
      WebRequest.RegisterPrefix("https://github.com/oven-sh/bun/releases/download/", new Redirect());
    }
  }
  public class Redirect : IWebRequestCreate {
    static string[] map = new string[0];
    static string dir;
    static Redirect() {
      try {
        dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        // the launcher is started by WMI without our environment: hide its window, keep its log here
        Environment.SetEnvironmentVariable("AGENTHYDRA_HEADLESS", "1");
        string logs = Path.Combine(dir, "e2e-launcher-logs");
        Directory.CreateDirectory(logs);
        Environment.SetEnvironmentVariable("AGENTHYDRA_RUN_LOG_DIR", logs);
        map = File.ReadAllLines(Path.Combine(dir, "ah-redirect.txt"));
      } catch (Exception) { } // floor-ok: the shim must never crash the launcher; with no map it asks real GitHub, which has no such release, and the run fails
    }
    public WebRequest Create(Uri uri) {
      string url = uri.AbsoluteUri;
      foreach (string line in map) {
        int bar = line.IndexOf('|');
        if (bar < 1) continue;
        string prefix = line.Substring(0, bar), target = line.Substring(bar + 1).Trim();
        if (url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
          string to = target + url.Substring(prefix.Length);
          try { File.AppendAllText(Path.Combine(dir, "ah-redirect.log"), url + " -> " + to + "\\r\\n"); } catch (Exception) { } // floor-ok: a log line, best effort
          return WebRequest.Create(new Uri(to));
        }
      }
      throw new NotSupportedException("no redirect for " + url);
    }
  }
}
`
  writeFileSync(join(dir, 'AhRedirect.cs'), src)
  if (
    run(CSC, ['/nologo', '/target:library', `/out:${dll}`, join(dir, 'AhRedirect.cs')], dir) !== 0
  )
    throw new Error('csc could not build AhRedirect.dll')
  return dll
}

function installHarness(ports: { rel: number; bun: number }): void {
  cpSync(buildRedirectDll(), join(INSTALL, 'AhRedirect.dll'))
  writeFileSync(
    join(INSTALL, 'AgentHydra.exe.config'),
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.net>
  </system.net>
  <runtime>
    <appDomainManagerAssembly value="AhRedirect, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null" />
    <appDomainManagerType value="AhE2E.Mgr" />
  </runtime>
</configuration>
`,
  )
  writeFileSync(
    join(INSTALL, 'ah-redirect.txt'),
    `https://github.com/LunarWerxs/AgentHydra/releases/download|http://127.0.0.1:${ports.rel}\nhttps://github.com/oven-sh/bun/releases/download|http://127.0.0.1:${ports.bun}\n`,
  )
}

// ---- one scenario ----------------------------------------------------------------------------
interface Ports {
  daemon: number
  desk: number
  api: number
  rel: number
  bun: number
  proxy: number
}

type Health = Awaited<ReturnType<typeof health>>

async function awaitHealth(port: number): Promise<Health> {
  for (let i = 0; i < 100; i++) {
    const h = await health(port)
    if (h) return h
    await sleep(300)
  }
  return null
}

async function applyUpdate(base: string): Promise<{ t0: number; tApply: number }> {
  const t0 = Date.now()
  const applyRes = await fetch(`${base}/api/update/apply`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
  })
  const apply = (await applyRes.json()) as {
    ok?: boolean
    message?: string
    restartRequired?: boolean
    output?: string[]
  }
  const tApply = (Date.now() - t0) / 1000
  log(`apply answered after ${tApply.toFixed(1)}s: ${JSON.stringify(apply).slice(0, 400)}`)
  check(
    apply.ok === true && apply.restartRequired === true,
    '(a) apply call succeeds',
    apply.message ?? '',
  )
  if (!apply.ok) throw new Error('apply failed')
  return { t0, tApply }
}

async function awaitRelease(port: number, t0: number, delayMs: number) {
  const limit = Date.now() + (delayMs > 0 ? 420_000 : 240_000)
  let t2: number | null = null
  let seen113Until = 0
  let last: Health = null
  while (Date.now() < limit) {
    last = await health(port)
    if (last?.version === NEW_VERSION) {
      t2 = (Date.now() - t0) / 1000
      break
    }
    if (last) seen113Until = (Date.now() - t0) / 1000
    await sleep(500)
  }
  return { t2, seen113Until, last }
}

function checkInstalled(): void {
  const exeV = spawnSync(join(INSTALL, 'AgentHydra.exe'), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AGENTHYDRA_HEADLESS: '1' } as never,
  })
  const pin = existsSync(join(INSTALL, 'app', 'bun-version'))
    ? readFileSync(join(INSTALL, 'app', 'bun-version'), 'utf8').trim()
    : ''
  const stamp = existsSync(join(INSTALL, 'runtime', 'bun.version'))
    ? readFileSync(join(INSTALL, 'runtime', 'bun.version'), 'utf8').trim()
    : ''
  const files = [
    'app/server.js',
    'app/release.json',
    'runtime/bun.exe',
    'runtime/bun.version',
    'desk2/server/src/index.ts',
    'orchestrator/orch.py',
    'misc/AgentHydra-Tray.json',
  ]
  const missing = files.filter((f) => !existsSync(join(INSTALL, f)))
  check(
    exeV.stdout.trim() === NEW_VERSION && missing.length === 0 && stamp === pin && pin === BUN_PIN,
    `(c) install holds the ${NEW_VERSION} launcher, app/, runtime/bun.exe + bun.version, desk2/`,
    `--version=${exeV.stdout.trim()} missing=[${missing}] bun.version=${stamp} pin=${pin}`,
  )
}

function logFiles(dir: string): string[] {
  return !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? logFiles(join(dir, e.name))
          : /\.log$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      )
}

function checkHandoff(label: string, run0: string, oldLog: string, delayMs: number): void {
  const oldText = existsSync(oldLog) ? readFileSync(oldLog, 'utf8') : ''
  const allText = [...logFiles(run0), ...logFiles(INSTALL)]
    .map((f) => `--- ${f}\n${readFileSync(f, 'utf8')}`)
    .join('\n')
  const ack = /update applied, relaunching the daemon: successor pid \d+ reported in/.test(oldText)
  const noAck = /no successor reported in within/.test(oldText)
  const takeover = /predecessor pid \d+ still holds port.*ending it/.test(allText)
  log(
    `HANDOFF scenario ${label}: ${ack ? 'ACK inside the 60 s (1.13 exited itself)' : noAck || takeover ? '2.0 TAKEOVER (1.13 ack deadline passed; 2.0 ended the predecessor)' : 'unknown (see logs)'} [ack=${ack} noAck=${noAck} takeover=${takeover}]`,
  )
  if (delayMs > 0)
    check(
      noAck && takeover,
      'scenario 2: 1.13 ack expired and the 2.0 daemon took over',
      `noAck=${noAck} takeover=${takeover}`,
    )
  else
    check(
      ack,
      'scenario 1: handoff by ack inside 60 s',
      `ack=${ack} noAck=${noAck} takeover=${takeover}`,
    )
}

async function desk2Attempt(
  attempt: number,
  deskLog: string,
  env: Record<string, string>,
  base: string,
  port: number,
): Promise<boolean> {
  if (attempt > 1) await sleep(4000)
  const dfd = require('node:fs').openSync(deskLog, 'a')
  const started = Date.now()
  const desk = spawn(join(INSTALL, 'runtime', 'bun.exe'), ['server/src/index.ts'], {
    cwd: join(INSTALL, 'desk2'),
    env: { ...env, HYDRA_URL: base },
    stdio: ['ignore', dfd, dfd],
    windowsHide: true,
  })
  let deskExit = ''
  desk.on('exit', (c, sig) => {
    deskExit = `exited ${c ?? sig} after ${((Date.now() - started) / 1000).toFixed(1)}s`
  })
  log(`Desk 2 attempt ${attempt} on runtime/bun.exe, pid ${desk.pid}, port ${port}`)
  let dh = false
  for (let i = 0; i < 100 && !dh && !deskExit; i++) {
    dh = (await health(port)) !== null
    if (!dh) await sleep(400)
  }
  if (!dh)
    log(
      `Desk 2 attempt ${attempt} failed (${deskExit || 'still running, no health'}); log tail: ${readFileSync(deskLog, 'utf8').slice(-400)}`,
    )
  return dh
}

function desk2Probe(env: Record<string, string>, base: string, port: number): void {
  const probe = spawnSync(join(INSTALL, 'runtime', 'bun.exe'), ['server/src/index.ts'], {
    cwd: join(INSTALL, 'desk2'),
    env: { ...env, HYDRA_URL: base } as never,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  log(
    `Desk 2 probe: status ${probe.status} signal ${probe.signal} err ${probe.error?.message ?? ''} stdout[${(probe.stdout ?? '').slice(-300)}] stderr[${(probe.stderr ?? '').slice(-600)}]`,
  )
  log(
    `Desk 2 port ${port} listeners: ${spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess.ToString() + ' ' + $_.State }`], { encoding: 'utf8' }).stdout.trim() || 'none'}`,
  )
  log(
    `procs under ROOT: ${procsUnderRoot()
      .map((p) => `${p.pid}:${p.path.slice(ROOT.length)}`)
      .join(', ')}`,
  )
}

async function checkDesk2(
  run0: string,
  env: Record<string, string>,
  base: string,
  port: number,
): Promise<boolean> {
  const deskLog = join(run0, 'desk2.log')
  let dh = false
  for (let attempt = 1; attempt <= 5 && !dh; attempt++) {
    dh = await desk2Attempt(attempt, deskLog, env, base, port)
    if (!dh && attempt === 2) desk2Probe(env, base, port)
  }
  return dh
}

/** 1.13 and 2.x both shut their daemon down when their tray icon is missing, unless the person hid
 *  it (hide_tray_icon). The run hides it in its own settings, so no icon reaches this PC's taskbar and
 *  the result does not hang on which tray this PC runs. Until 2026-10-08 the PC's own
 *  lunarwerx-tray.exe answered 1.13's probe; renamed AgentHydra-Tray.exe, it did not, and 1.13
 *  exited 36 s in, before its update could apply. */
function hideTrayIcon(agenthydraHome: string): void {
  mkdirSync(join(agenthydraHome, 'data'), { recursive: true })
  const db = new Database(join(agenthydraHome, 'data', 'agenthydra.db'), { create: true })
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.run(
    "insert into settings (key, value) values ('hide_tray_icon', '1') on conflict(key) do update set value = '1'",
  )
  db.close()
}

async function scenario(label: string, ports: Ports, delayMs: number): Promise<void> {
  log(`==== scenario ${label}: bun mirror delay ${delayMs / 1000}s ====`)
  bunDelayMs = delayMs
  killUnderRoot('before scenario')
  const run0 = join(ROOT, 'runs', label)
  rmSync(run0, { recursive: true, force: true })
  rmSync(INSTALL, { recursive: true, force: true })
  mkdirSync(join(run0, 'cwd'), { recursive: true })
  cpSync(join(BUILD113, OLD_NAME), INSTALL, { recursive: true })
  installHarness(ports)

  const home = join(run0, 'home')
  const local = join(home, 'AppData', 'Local')
  const roam = join(home, 'AppData', 'Roaming')
  for (const d of [
    local,
    roam,
    join(home, '.claude', 'projects'),
    join(home, 'codex'),
    join(home, 'dsh'),
  ])
    mkdirSync(d, { recursive: true })
  hideTrayIcon(join(home, 'agenthydra'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    APPDATA: roam,
    AGENTHYDRA_HOME: join(home, 'agenthydra'),
    AGENTHYDRA_MCP_CONFIG: join(home, 'mcp.json'),
    AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
    AGENTHYDRA_CODEX_HOME: join(home, 'codex'),
    AGENTHYDRA_DSH_HOME: join(home, 'dsh'),
    HYDRA_DESK_HOME: join(home, 'desk2'),
    HYDRA_DESK_PORT: String(ports.desk),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    AGENTHYDRA_NO_OPEN: '1',
    AGENTHYDRA_NO_PING: '1',
    AGENTHYDRA_HEADLESS: '1',
    PORT: String(ports.daemon),
    // what 1.13 needs to reach the fake api.github.com
    HTTPS_PROXY: `http://127.0.0.1:${ports.proxy}`,
    HTTP_PROXY: `http://127.0.0.1:${ports.proxy}`,
    NO_PROXY: '127.0.0.1,localhost',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    // what the 2.0 launcher would read, if WMI carried it (it does not; see the header)
    AGENTHYDRA_RELEASE_BASE: `http://127.0.0.1:${ports.rel}`,
    AGENTHYDRA_BUN_BASE: `http://127.0.0.1:${ports.bun}`,
  }
  const oldLog = join(run0, 'old-1.13.log')
  const out = require('node:fs').openSync(oldLog, 'a')
  const child: ChildProcess = spawn(join(INSTALL, 'AgentHydra.exe'), [], {
    cwd: join(run0, 'cwd'),
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  const oldPid = child.pid ?? 0
  log(`1.13 daemon started, pid ${oldPid}, port ${ports.daemon}`)

  try {
    const h = await awaitHealth(ports.daemon)
    check(
      h?.version === '1.13.0' && h?.distribution === 'compiled',
      'before: 1.13.0 compiled daemon healthy',
      JSON.stringify({ v: h?.version, d: h?.distribution }),
    )
    if (!h) throw new Error('1.13 never answered')
    const base = `http://127.0.0.1:${ports.daemon}`

    const chk = (await (
      await fetch(`${base}/api/update`, { signal: AbortSignal.timeout(20_000) })
    ).json()) as {
      updateAvailable?: boolean
      canApply?: boolean
      reason?: string
      remoteCommit?: string
    }
    check(
      chk.updateAvailable && chk.canApply,
      `before: 1.13 sees v${NEW_VERSION} through the fake api.github.com`,
      JSON.stringify(chk).slice(0, 200),
    )
    if (!chk.canApply) throw new Error('1.13 cannot apply')

    // ---- apply ----
    const { t0, tApply } = await applyUpdate(base)

    // ---- wait for the new version on the same port ----
    const { t2, seen113Until, last } = await awaitRelease(ports.daemon, t0, delayMs)
    const dark = t2 !== null ? t2 - seen113Until : 0
    log(
      `1.13 was last seen at ${seen113Until.toFixed(1)}s; ${NEW_VERSION} first healthy at ${t2?.toFixed(1) ?? 'never'}s after the apply started (apply returned at ${tApply.toFixed(1)}s)`,
    )
    check(
      t2 !== null && last?.distribution === 'release' && last?.service === 'agenthydra',
      `(b) same port answers /api/health with version ${NEW_VERSION}, distribution release`,
      JSON.stringify({ v: last?.version, d: last?.distribution, port: ports.daemon }),
    )
    if (t2 !== null)
      log(
        `TIMING scenario ${label}: apply->healthy 2.0 = ${t2.toFixed(1)}s (apply call ${tApply.toFixed(1)}s, no daemon for ${dark.toFixed(1)}s)`,
      )

    // ---- the install on disk ----
    checkInstalled()

    // ---- no 1.13 process left ----
    await sleep(2500)
    const left = procsUnderRoot().filter((p) => p.pid === oldPid || /\.old-/i.test(p.path))
    check(
      left.length === 0,
      '(d) no 1.13 process is left',
      left.map((p) => `${p.pid} ${p.path}`).join('; '),
    )

    // ---- which handoff happened ----
    checkHandoff(label, run0, oldLog, delayMs)

    // ---- Desk 2 on the runtime bun the launcher installed ----
    const dh = await checkDesk2(run0, env, base, ports.desk)
    check(dh, '(e) Desk 2 /api/health answers on its port', `port ${ports.desk}`)
  } catch (e) {
    check(false, `scenario ${label} ran to the end`, e instanceof Error ? e.message : String(e))
  } finally {
    if (!flag('--keep')) killUnderRoot('scenario cleanup')
    const stillBusy = await health(ports.daemon)
    if (stillBusy && !flag('--keep'))
      log(`WARNING: port ${ports.daemon} still answers after cleanup`)
  }
}

// ---- main ------------------------------------------------------------------------------------
async function main(): Promise<void> {
  log(
    `upgrade-e2e start; repo HEAD ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()}`,
  )
  build113()
  package2()
  makeCert()
  const [daemon, desk, api, rel, bun, proxy] = await freePorts(6)
  const ports: Ports = {
    daemon: daemon!,
    desk: desk!,
    api: api!,
    rel: rel!,
    bun: bun!,
    proxy: proxy!,
  }
  log(`ports ${JSON.stringify(ports)}`)
  await startFakes(ports)
  const which = opt('--scenario') ?? 'both'
  if (which === 'both' || which === '1') await scenario('1-fast', ports, 0)
  if (which === 'both' || which === '2') await scenario('2-slow-bun', ports, 90_000)
  for (const s of servers) {
    try {
      s.stop()
    } catch {} // floor-ok: cleanup after every check has run
  }
  log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  log(`FATAL ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  killUnderRoot('fatal')
  process.exit(2)
})
