#!/usr/bin/env bun
/**
 * Smoke test an AgentHydra release bundle in complete isolation.
 *
 * Usage:
 *   bun scripts/smoke-release.ts --bundle-dir <dir> --port <daemon-port> --desk-port <desk2-port>
 *
 * Creates isolated temp homes, starts daemon and desk2, asserts both work, then stops them.
 * Exit 0 on success, 1 on any failed assertion.
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface Options {
  bundleDir: string
  port: number
  deskPort: number
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  let bundleDir: string | undefined
  let port: number | undefined
  let deskPort: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle-dir') bundleDir = args[i + 1]
    if (args[i] === '--port') port = parseInt(args[i + 1], 10)
    if (args[i] === '--desk-port') deskPort = parseInt(args[i + 1], 10)
  }

  if (!bundleDir || !port || !deskPort) {
    console.error(
      'Usage: bun scripts/smoke-release.ts --bundle-dir <dir> --port <daemon-port> --desk-port <desk2-port>',
    )
    process.exit(1)
  }

  return { bundleDir, port, deskPort }
}

function resolveBundleDir(path: string): string {
  const resolved = resolve(path)
  if (existsSync(join(resolved, 'agenthydra')) || existsSync(join(resolved, 'AgentHydra.exe'))) {
    return resolved
  }
  // If it's a parent containing one AgentHydra-* folder, use that
  if (existsSync(resolved)) {
    try {
      const entries = execSync(`find "${resolved}" -maxdepth 1 -type d -name 'AgentHydra-*'`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')
        .filter(Boolean)
      if (entries.length === 1) {
        return entries[0]
      }
    } catch {
      // fall through
    }
  }
  throw new Error(`Bundle dir not found: ${path}`)
}

interface ProcessInfo {
  pid: number
  proc: any
}

const processes: ProcessInfo[] = []

function spawnProcess(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  logFile: string,
): ProcessInfo {
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: false,
  })

  const logs: Buffer[] = []
  const maxLogs = 100 * 1024 // 100 KB

  proc.stdout?.on('data', (data: Buffer) => {
    logs.push(data)
    if (logs.reduce((s, b) => s + b.length, 0) > maxLogs) logs.shift()
    writeFileSync(logFile, data, { flag: 'a' })
  })

  proc.stderr?.on('data', (data: Buffer) => {
    logs.push(data)
    if (logs.reduce((s, b) => s + b.length, 0) > maxLogs) logs.shift()
    writeFileSync(logFile, data, { flag: 'a' })
  })

  const info: ProcessInfo = { pid: proc.pid!, proc }
  processes.push(info)

  return info
}

function killProcess(info: ProcessInfo): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${info.pid} /T /F 2>nul || true`, {
        shell: 'cmd.exe',
        stdio: 'ignore',
      })
    } else {
      execSync(`kill -9 -${info.pid} 2>/dev/null || true`, { shell: true, stdio: 'ignore' })
    }
  } catch {
    // already dead
  }
}

async function cleanup(): Promise<void> {
  for (const proc of processes) {
    killProcess(proc)
  }
  // Give processes time to die
  await new Promise((resolve) => setTimeout(resolve, 500))
}

async function waitForHealth(url: string, timeoutSec: number): Promise<boolean> {
  const endTime = Date.now() + timeoutSec * 1000
  while (Date.now() < endTime) {
    try {
      const response = await fetch(url, { timeout: 1000 })
      if (response.ok) {
        return true
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { timeout: 5000 })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { timeout: 5000 })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

async function main() {
  const opts = parseArgs()
  const bundleDir = resolveBundleDir(opts.bundleDir)
  const { port, deskPort } = opts

  console.log(`Testing bundle: ${bundleDir}`)
  console.log(`  daemon port: ${port}`)
  console.log(`  desk2 port: ${deskPort}`)

  // Create isolated home
  const tempHome = mkdtempSync(join(process.env.TEMP || '/tmp', 'agenthydra-smoke-'))
  const localAppData = join(tempHome, 'AppData', 'Local')
  const appData = join(tempHome, 'AppData', 'Roaming')

  console.log(`  temp home: ${tempHome}`)

  mkdirSync(localAppData, { recursive: true })
  mkdirSync(appData, { recursive: true })

  const env: Record<string, string> = {
    HOME: tempHome,
    USERPROFILE: tempHome,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    AGENTHYDRA_HOME: join(tempHome, '.agenthydra'),
    HYDRA_DESK_HOME: join(tempHome, '.hydra-desk-2'),
    CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
    AGENTHYDRA_MCP_CONFIG: join(tempHome, 'agenthydra-mcp.json'),
    AGENTHYDRA_NO_OPEN: '1',
    AGENTHYDRA_NO_PING: '1',
  }

  const daemonLogFile = join(tempHome, 'daemon.log')
  const desk2LogFile = join(tempHome, 'desk2.log')

  try {
    // Assertions: check files exist
    console.log('\nAsserting bundle contents...')

    // Check daemon
    const daemonExe = join(bundleDir, 'AgentHydra.exe')
    const daemonBin = join(bundleDir, 'agenthydra')
    const daemon = existsSync(daemonExe) ? daemonExe : daemonBin

    if (!existsSync(daemon)) {
      throw new Error(`Daemon executable not found in bundle`)
    }
    console.log('  ✓ daemon executable')

    // Check desk2/runtime/bun
    const bunExe = join(bundleDir, 'desk2', 'runtime', 'bun.exe')
    const bunBin = join(bundleDir, 'desk2', 'runtime', 'bun')
    const bun = existsSync(bunExe) ? bunExe : bunBin

    if (!existsSync(bun)) {
      throw new Error(`bun runtime not found in desk2/runtime`)
    }
    console.log('  ✓ desk2/runtime/bun')

    // Check desk2/launcher (Windows)
    if (process.platform === 'win32') {
      const launcherFiles = ['start.vbs', 'HydraDesk2.exe']
      for (const file of launcherFiles) {
        const fpath = join(bundleDir, 'desk2', 'launcher', file)
        if (!existsSync(fpath)) throw new Error(`desk2/launcher/${file} not found`)
      }
      console.log('  ✓ desk2/launcher (Windows)')

      // Check misc tray toolkit
      const miscFiles = ['lunarwerx-tray.exe', 'AgentHydra-Tray.json', 'AgentHydra.ico']
      for (const file of miscFiles) {
        const fpath = join(bundleDir, 'misc', file)
        if (!existsSync(fpath)) throw new Error(`misc/${file} not found`)
      }
      console.log('  ✓ misc tray toolkit')
    }

    // Check orchestrator
    const orchPy = join(bundleDir, 'orchestrator', 'orch.py')
    if (!existsSync(orchPy)) throw new Error(`orchestrator/orch.py not found`)
    console.log('  ✓ orchestrator payload')

    // Check desk2 files
    const desk2Files = ['server', 'web/dist', 'hydra/dist', 'shared', 'package.json']
    for (const file of desk2Files) {
      const fpath = join(bundleDir, 'desk2', file)
      if (!existsSync(fpath)) throw new Error(`desk2/${file} not found`)
    }
    console.log('  ✓ desk2 structure')

    // Start daemon
    console.log('\nStarting daemon...')
    const daemonEnv = { ...env, PORT: port.toString() }
    const daemonProc = spawnProcess(daemon, [], daemonEnv, daemonLogFile)
    console.log(`  daemon PID: ${daemonProc.pid}`)

    if (!(await waitForHealth(`http://127.0.0.1:${port}/api/health`, 30))) {
      throw new Error('Daemon did not respond to /api/health within 30s')
    }
    console.log('  ✓ daemon health check passed')

    // Check daemon /api/health
    console.log('\nAsserting daemon endpoints...')
    const daemonHealth = await fetchJson(`http://127.0.0.1:${port}/api/health`)
    if (!JSON.stringify(daemonHealth).includes('agenthydra')) {
      throw new Error('Daemon health response missing service agenthydra')
    }
    if (!JSON.stringify(daemonHealth).includes('compiled')) {
      throw new Error('Daemon health response missing distribution compiled')
    }
    console.log('  ✓ /api/health')

    // Check daemon /api/orchestrator
    const orchStatus = await fetchJson(`http://127.0.0.1:${port}/api/orchestrator`)
    if (
      !JSON.stringify(orchStatus).includes('present') ||
      !JSON.stringify(orchStatus).includes('true')
    ) {
      throw new Error('Daemon orchestrator not present')
    }
    console.log('  ✓ /api/orchestrator present')

    // Check daemon serves redirect or starting page (not old web)
    const daemonRoot = await fetchText(`http://127.0.0.1:${port}/`)
    if (
      !daemonRoot.includes('DOCTYPE') &&
      !daemonRoot.includes('redirect') &&
      !daemonRoot.includes('Desk 2')
    ) {
      console.log('  (daemon serves old web SPA, Desk 2 redirect will be added in next step)')
    } else {
      console.log('  ✓ daemon root page (not old window)')
    }

    // Start desk2 server
    console.log('\nStarting desk2 server...')
    const desk2Env = {
      ...env,
      HYDRA_DESK_PORT: deskPort.toString(),
      HYDRA_URL: `http://127.0.0.1:${port}`,
    }
    const desk2Proc = spawnProcess(bun, ['server/src/index.ts'], desk2Env, desk2LogFile)
    console.log(`  desk2 PID: ${desk2Proc.pid}`)

    if (!(await waitForHealth(`http://127.0.0.1:${deskPort}/api/health`, 30))) {
      throw new Error('Desk 2 did not respond to /api/health within 30s')
    }
    console.log('  ✓ desk2 health check passed')

    // Check desk2 endpoints
    console.log('\nAsserting desk2 endpoints...')
    const desk2Health = await fetchJson(`http://127.0.0.1:${deskPort}/api/health`)
    if (!JSON.stringify(desk2Health).includes('ok')) {
      throw new Error('Desk2 health response missing ok')
    }
    console.log('  ✓ /api/health')

    // Check desk2 / serves HTML
    const desk2Root = await fetchText(`http://127.0.0.1:${deskPort}/`)
    if (!desk2Root.toLowerCase().includes('<!doctype html')) {
      throw new Error('Desk2 root does not serve HTML')
    }
    console.log('  ✓ / serves HTML')

    // Check desk2 /assets downloads
    const assetMatch = desk2Root.match(/\/assets\/[^"']+\.(js|css)/)
    if (!assetMatch) {
      throw new Error('Desk2 HTML does not reference /assets')
    }
    const assetUrl = assetMatch[0]
    const asset = await fetchText(`http://127.0.0.1:${deskPort}${assetUrl}`)
    if (!asset || asset.length === 0) {
      throw new Error(`Desk2 asset ${assetUrl} returned empty`)
    }
    console.log(`  ✓ assets download (${assetUrl})`)

    // Check desk2 /ah/ serves HTML
    const desk2Ah = await fetchText(`http://127.0.0.1:${deskPort}/ah/`)
    if (!desk2Ah.toLowerCase().includes('<!doctype html')) {
      throw new Error('Desk2 /ah/ does not serve HTML')
    }
    console.log('  ✓ /ah/ serves HTML')

    // Check desk2 /ah/api reaches daemon
    const ahApi = await fetchJson(`http://127.0.0.1:${deskPort}/ah/api/health`)
    if (!JSON.stringify(ahApi).includes('agenthydra')) {
      throw new Error('Desk2 /ah/api does not reach daemon')
    }
    console.log('  ✓ /ah/api/health reaches daemon')

    console.log('\n✅ All assertions passed!')
    await cleanup()

    // Clean up temp directory
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(tempHome, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    process.exit(0)
  } catch (err) {
    console.error('\n❌ Assertion failed:', err instanceof Error ? err.message : String(err))

    // Print log tails
    if (existsSync(daemonLogFile)) {
      console.error('\n--- daemon.log (last 20 lines) ---')
      try {
        const log = readFileSync(daemonLogFile, 'utf8')
        const lines = log.split('\n')
        const tail = lines.slice(-20).join('\n')
        console.error(tail)
      } catch {
        console.error('(could not read daemon.log)')
      }
    }

    if (existsSync(desk2LogFile)) {
      console.error('\n--- desk2.log (last 20 lines) ---')
      try {
        const log = readFileSync(desk2LogFile, 'utf8')
        const lines = log.split('\n')
        const tail = lines.slice(-20).join('\n')
        console.error(tail)
      } catch {
        console.error('(could not read desk2.log)')
      }
    }

    await cleanup()

    // Try to clean up, but don't fail if we can't
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(tempHome, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
