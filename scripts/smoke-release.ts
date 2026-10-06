#!/usr/bin/env bun
/**
 * Boot an unpacked release bundle, isolated and headless, and assert it works.
 *
 *   bun scripts/smoke-release.ts --bundle-dir <dir with one AgentHydra-* folder, or the folder> --port <daemon> --desk-port <desk2>
 *
 * Starts the bundle's daemon and Desk 2's server (on the bundle's own desk2/runtime/bun), never the
 * launcher, window host or tray. Kills exactly what it started, by pid and child tree. Exit 1 on any
 * failed assertion, with the tails of both logs.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const isWin = process.platform === 'win32'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const bundleArg = arg('--bundle-dir')
const port = Number(arg('--port'))
const deskPort = Number(arg('--desk-port'))
if (!bundleArg || !port || !deskPort) {
  console.error('usage: bun scripts/smoke-release.ts --bundle-dir <dir> --port <n> --desk-port <n>')
  process.exit(1)
}

function findBundle(dir: string): string {
  const d = resolve(dir)
  if (existsSync(join(d, 'orchestrator'))) return d
  const found = readdirSync(d, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.startsWith('AgentHydra-'),
  )
  if (found.length !== 1)
    throw new Error(`expected exactly one AgentHydra-* folder in ${d}, found ${found.length}`)
  return join(d, found[0].name)
}

const bundle = findBundle(bundleArg)
const scratch = mkdtempSync(join(tmpdir(), 'agenthydra-smoke-'))
const daemonLog = join(scratch, 'daemon.log')
const deskLog = join(scratch, 'desk2.log')
const pids: number[] = []
let failed = 0

function ok(msg: string): void {
  console.log(`PASS ${msg}`)
}
function check(cond: unknown, msg: string): boolean {
  if (cond) ok(msg)
  else {
    failed++
    console.log(`FAIL ${msg}`)
  }
  return Boolean(cond)
}

function tail(file: string, lines = 30): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

function start(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  log: string,
): number {
  const fd = openSync(log, 'a')
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true })
  closeSync(fd)
  if (!child.pid) throw new Error(`could not start ${cmd}`)
  pids.push(child.pid)
  return child.pid
}

function killTree(pid: number): void {
  if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' })
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
}

async function waitHealth(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await get(url)).ok) return true
    } catch {}
    await Bun.sleep(300)
  }
  return false
}

async function assetOf(base: string, html: string, label: string): Promise<void> {
  const rel = html.match(/(?:src|href)=["']([^"']*\/assets\/[^"'?#]+\.(?:js|css))["']/i)?.[1]
  if (!check(rel, `${label} names an /assets/ file`) || !rel) return
  const url = new URL(rel, base).toString()
  const res = await get(url)
  check(res.ok && (await res.arrayBuffer()).byteLength > 0, `${label} asset downloads (${rel})`)
}

try {
  const exe = join(bundle, isWin ? 'AgentHydra.exe' : 'agenthydra')
  const bun = join(bundle, 'desk2', 'runtime', isWin ? 'bun.exe' : 'bun')

  const required = [exe, bun, join(bundle, 'desk2/server/src/index.ts')]
  if (isWin) {
    required.push(
      join(bundle, 'desk2/launcher/start.vbs'),
      join(bundle, 'desk2/launcher/HydraDesk2.exe'),
    )
    for (const f of [
      'lunarwerx-tray.exe',
      'AgentHydra-Tray.json',
      'AgentHydra.ico',
      'Create-Shortcut.ps1',
      'New-TrayShortcut.ps1',
      'Tray-Host.ps1',
      'AgentHydra-Tray.ps1',
      'Tray-Launch.vbs',
      'Instance-Launch.vbs',
    ])
      required.push(join(bundle, 'misc', f))
  }
  const missing = required.filter((f) => !existsSync(f))
  check(
    missing.length === 0,
    `bundle files present${missing.length ? `; missing ${missing.map((m) => m.slice(bundle.length + 1)).join(', ')}` : ''}`,
  )

  const orch = join(bundle, 'orchestrator')
  const pyTools =
    existsSync(join(orch, 'scripts')) &&
    readdirSync(join(orch, 'scripts')).some((f) => f.endsWith('.py'))
  const hasPycache = spawnSync(
    isWin ? 'powershell' : 'find',
    isWin
      ? [
          '-NoProfile',
          '-Command',
          `if (Get-ChildItem -LiteralPath '${orch}' -Recurse -Directory -Filter __pycache__) { exit 1 }`,
        ]
      : [orch, '-name', '__pycache__'],
    { encoding: 'utf8' },
  )
  const pycache = isWin ? hasPycache.status === 1 : Boolean(hasPycache.stdout.trim())
  const state = existsSync(join(orch, 'state')) && readdirSync(join(orch, 'state')).length > 0
  check(
    existsSync(join(orch, 'orch.py')) &&
      existsSync(join(orch, 'scripts/lib/hydralib.py')) &&
      pyTools &&
      !existsSync(join(orch, 'scripts/tests')) &&
      !pycache &&
      !state,
    'orchestrator payload (orch.py, hydralib.py, a scripts/*.py tool; no tests, __pycache__ or state)',
  )

  const bunV = spawnSync(bun, ['--version'], { encoding: 'utf8' })
  check(bunV.status === 0, `desk2/runtime/bun --version (${bunV.stdout.trim()})`)
  const dv = spawnSync(exe, ['--version'], { encoding: 'utf8' })
  check(dv.status === 0 && dv.stdout.trim().length > 0, `daemon --version (${dv.stdout.trim()})`)
  if (failed) throw new Error('bundle is incomplete')

  const home = join(scratch, 'home')
  const local = join(home, 'AppData', 'Local')
  const roam = join(home, 'AppData', 'Roaming')
  for (const d of [local, roam, join(home, '.claude')]) mkdirSync(d, { recursive: true })
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    APPDATA: roam,
    AGENTHYDRA_HOME: join(home, 'agenthydra'),
    HYDRA_DESK_HOME: join(home, 'desk2'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    AGENTHYDRA_MCP_CONFIG: join(home, 'mcp.json'),
    AGENTHYDRA_NO_OPEN: '1',
    AGENTHYDRA_NO_PING: '1',
  }
  const daemonUrl = `http://127.0.0.1:${port}`
  const deskUrl = `http://127.0.0.1:${deskPort}`

  start(exe, [], bundle, { ...env, PORT: String(port) }, daemonLog)
  start(
    bun,
    ['server/src/index.ts'],
    join(bundle, 'desk2'),
    { ...env, HYDRA_DESK_PORT: String(deskPort), HYDRA_URL: daemonUrl },
    deskLog,
  )

  const daemonUp = await waitHealth(`${daemonUrl}/api/health`, 40_000)
  if (check(daemonUp, 'daemon /api/health answers')) {
    const h = (await (await get(`${daemonUrl}/api/health`)).json()) as {
      service?: string
      distribution?: string
    }
    check(
      h.service === 'agenthydra' && h.distribution === 'compiled',
      `daemon health is agenthydra/compiled (${h.service}/${h.distribution})`,
    )
    const o = (await (await get(`${daemonUrl}/api/orchestrator`)).json()) as { present?: boolean }
    check(o.present === true, '/api/orchestrator present:true')
  }

  const deskUp = await waitHealth(`${deskUrl}/api/health`, 40_000)
  if (check(deskUp, 'Desk 2 /api/health ok')) {
    const root = await get(`${deskUrl}/`)
    const html = await root.text()
    check(root.ok && /<!doctype html/i.test(html), 'Desk 2 / is html')
    await assetOf(`${deskUrl}/`, html, 'Desk 2 /')
    const ah = await get(`${deskUrl}/ah/`)
    const ahHtml = await ah.text()
    check(ah.ok && /<!doctype html/i.test(ahHtml), 'Desk 2 /ah/ is html')
    await assetOf(`${deskUrl}/ah/`, ahHtml, 'Desk 2 /ah/')
    const ahApi = await get(`${deskUrl}/ah/api/health`)
    const ahBody = (ahApi.ok ? await ahApi.json() : {}) as { service?: string }
    check(ahBody.service === 'agenthydra', 'Desk 2 /ah/api/health reaches the daemon')
  }

  if (daemonUp) {
    const r = await get(`${daemonUrl}/`, { redirect: 'manual' })
    const loc = r.headers.get('location') ?? ''
    const body = r.status >= 300 && r.status < 400 ? '' : await r.text()
    const toDesk =
      r.status >= 300 && r.status < 400
        ? /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(loc)
        : /desk|7798|refresh|location/i.test(body)
    check(toDesk, `daemon GET / goes to Desk 2, not the old window (${r.status} ${loc || 'page'})`)
  }
} catch (err) {
  failed++
  console.log(`FAIL ${err instanceof Error ? err.message : String(err)}`)
} finally {
  for (const pid of pids) killTree(pid)
  await Bun.sleep(1000)
  if (failed) {
    console.log(
      `\n--- daemon log tail ---\n${tail(daemonLog)}\n--- desk2 log tail ---\n${tail(deskLog)}`,
    )
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      break
    } catch {
      await Bun.sleep(300)
    }
  }
}
console.log(failed ? `\nsmoke FAILED (${failed})` : '\nsmoke passed')
process.exit(failed ? 1 : 0)
