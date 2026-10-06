// Finding, starting and talking to the DevWebUI daemon (../devwebui, Desk 2's copy of it) for the servers pane.
//
// Found: DEVWEBUI_URL when set, else the pointer the daemon writes (runtime.json in DEVWEBUI_HOME, default
// ~/.devwebui), and either way only an address whose GET /api/health says it is DevWebUI. Started: only when
// the pane asks and nothing answers, headless and hidden (the daemon is a console program), its output in a log
// under Desk 2's own data home, never a second one while one is coming up, and never stopped by Desk 2: the dev
// servers it runs outlive this window, as they do with DevWebUI's own tray.
// Its local credential (the .cookie file in its data dir) is read here per request and goes only to a loopback
// daemon; nothing here logs it, returns it, or keeps it in memory.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DevWebStatus } from '@shared/devwebui'

/** The copy of DevWebUI beside AgentHydra and Desk. */
export const DEVWEBUI_DIR = resolve(import.meta.dir, '../../../../devwebui')
const START_WAIT_MS = 30_000
const HEALTH_MS = 1500

export const devwebuiHome = (): string => process.env.DEVWEBUI_HOME?.trim() || join(homedir(), '.devwebui')

/** True when `url` names this machine's loopback interface. */
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
  } catch {
    return false
  }
}

async function isDevWebUI(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(HEALTH_MS) })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: unknown; service?: unknown }
    return body.ok === true && body.service === 'devwebui'
  } catch {
    return false
  }
}

/** The address of the running daemon, or null. */
export async function findDaemon(): Promise<string | null> {
  const fixed = process.env.DEVWEBUI_URL?.trim().replace(/\/+$/, '')
  if (fixed) return (await isDevWebUI(fixed)) ? fixed : null
  let pointer: string | null = null
  try {
    const info = JSON.parse(readFileSync(join(devwebuiHome(), 'runtime.json'), 'utf8')) as { url?: unknown }
    if (typeof info.url === 'string') pointer = info.url.replace(/\/+$/, '')
  } catch {
    return null
  }
  return pointer && (await isDevWebUI(pointer)) ? pointer : null
}

/** The `Authorization` value for the daemon's local credential, or null (no cookie file, or a daemon off this machine). */
export function daemonAuth(url: string): string | null {
  if (!isLoopback(url)) return null
  try {
    const line = readFileSync(join(devwebuiHome(), '.cookie'), 'utf8').trim()
    return line.startsWith('__cookie__:') ? `Basic ${Buffer.from(line).toString('base64')}` : null
  } catch {
    return null
  }
}

/** Run a program hidden to its end, its output into `log`; the exit code (null when it could not start). */
function runHidden(cmd: string[], cwd: string, log: string): Promise<number | null> {
  return new Promise((done) => {
    const fd = openSync(log, 'a')
    try {
      const child = spawn(cmd[0] as string, cmd.slice(1), { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
      child.on('error', () => done(null))
      child.on('exit', (code) => done(code))
    } catch {
      done(null)
    } finally {
      closeSync(fd)
    }
  })
}

function lastLine(file: string): string | null {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    return lines.at(-1)?.slice(0, 300) ?? null
  } catch {
    return null
  }
}

export interface DaemonOptions {
  /** Desk 2's data home: the daemon's log goes under it. */
  home: string
  /** Replaces the real start (tests): resolves once the process was launched, or throws why not. */
  launch?: () => Promise<void> | void
}

export class DevWebDaemon {
  private starting: Promise<void> | null = null
  private failure: string | null = null
  private last: string | null = null

  constructor(private readonly opts: DaemonOptions) {}

  private get logFile(): string {
    return join(this.opts.home, 'logs', 'devwebui.log')
  }

  /** What GET /dw/status answers. */
  async status(): Promise<DevWebStatus> {
    const url = await findDaemon()
    if (url) {
      this.last = url
      this.failure = null
      return { state: 'running', url }
    }
    if (this.starting) return { state: 'starting', url: this.last }
    if (this.failure) return { state: 'failed', url: this.last, reason: this.failure }
    return { state: 'stopped', url: this.last }
  }

  /** Brings a daemon up when none answers; every caller at once shares the one start. */
  async ensure(): Promise<DevWebStatus> {
    if (this.starting) return this.status()
    if (await findDaemon()) return this.status()
    // Re-checked after the await: another pane may have begun while this one was probing.
    if (this.starting) return this.status()
    this.failure = null
    this.starting = this.start()
      .catch((err) => {
        this.failure = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        this.starting = null
      })
    return this.status()
  }

  private async start(): Promise<void> {
    mkdirSync(join(this.opts.home, 'logs'), { recursive: true })
    if (this.opts.launch) await this.opts.launch()
    else await this.launchReal()
    const deadline = Date.now() + START_WAIT_MS
    while (Date.now() < deadline) {
      if (await findDaemon()) return
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(lastLine(this.logFile) ?? `the server manager did not answer within ${START_WAIT_MS / 1000}s`)
  }

  private async launchReal(): Promise<void> {
    if (!existsSync(join(DEVWEBUI_DIR, 'server', 'src', 'index.ts'))) throw new Error(`the server manager is not at ${DEVWEBUI_DIR}`)
    // The bun that runs Desk 2's own server (desk2/runtime/bun.exe in a release bundle), never a PATH lookup: npm's
    // bun.cmd shim can come first on PATH, and spawn refuses a .cmd without a shell (EINVAL).
    const bun = process.execPath
    if (!existsSync(join(DEVWEBUI_DIR, 'node_modules'))) {
      const code = await runHidden([bun, 'install'], DEVWEBUI_DIR, this.logFile)
      if (code !== 0) throw new Error(lastLine(this.logFile) ?? 'bun install failed in the server manager folder')
    }
    const fd = openSync(this.logFile, 'a')
    try {
      // detached + windowsHide: no console window, and it is not tied to this process, so it survives Desk 2.
      const child = spawn(bun, [join('server', 'src', 'index.ts')], {
        cwd: DEVWEBUI_DIR,
        stdio: ['ignore', fd, fd],
        detached: true,
        windowsHide: true,
        env: { ...process.env, DEVWEBUI_NO_OPEN: '1' }
      })
      child.on('error', (err) => {
        this.failure = err.message
      })
      child.unref()
    } finally {
      closeSync(fd)
    }
  }
}
