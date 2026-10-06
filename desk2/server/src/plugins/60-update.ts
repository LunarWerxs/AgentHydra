// Restart to update (SPEC "Launcher"): the window learns when the server's own code changed on disk after
// it started, and its Menu restarts the server onto that code with launcher/restart.ps1, the chats running
// on. 2026-10-05: Send now, Fork and the servers pane each "did not work" for the owner only because the
// server still ran the code from before they landed, and nothing in the window said so.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import type { ServerUpdate } from '@shared/protocol'
import type { ServerContext } from '../context'
import { detachedCommand } from '../host/launch'

const DESK = resolve(import.meta.dir, '..', '..', '..')
/** What the server runs: a change here needs a restart. The window's own build needs none (stale-bundle.ts). */
const CODE_DIRS = [join(DESK, 'server', 'src'), join(DESK, 'shared')]
const RESTART_SCRIPT = join(DESK, 'launcher', 'restart.ps1')

/** The newest change and the number of .ts files under the server's code. */
export interface CodeStamp {
  newest: number
  count: number
}

/** What the plugin reads from the machine; tests give fakes (createServer deps.update). */
export interface UpdateDeps {
  /** When this server started, ms since the epoch. */
  bootedAt: number
  stamp(): CodeStamp
  platform: NodeJS.Platform
  pid: number
  /** Starts argv hidden and outside the server's process tree (stop.ps1 ends that tree). */
  start(argv: string[]): void
}

export function codeStamp(dirs: string[] = CODE_DIRS): CodeStamp {
  let newest = 0
  let count = 0
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name.endsWith('.ts')) {
        count++
        newest = Math.max(newest, statSync(path).mtimeMs)
      }
    }
  }
  for (const dir of dirs) if (existsSync(dir)) walk(dir)
  return { newest, count }
}

/** True when the launcher started this very server: server.pid (PowerShell writes it with a BOM) names it. */
export function startedByLauncher(home: string, pid: number): boolean {
  try {
    const info = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8').replace(/^﻿/, '')) as { serverPid?: unknown }
    return Number(info.serverPid) === pid
  } catch {
    return false
  }
}

function realDeps(): UpdateDeps {
  return {
    bootedAt: performance.timeOrigin,
    stamp: () => codeStamp(),
    platform: process.platform,
    pid: process.pid,
    start(argv) {
      const plan = detachedCommand(process.platform, argv)
      const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true, detached: plan.detached })
      child.on('error', (err) => console.error('[update] could not start the restart:', err))
      child.unref()
    },
  }
}

export default async function plugin(app: Hono, ctx: ServerContext): Promise<void> {
  const deps = (ctx.deps.update as UpdateDeps | undefined) ?? realDeps()
  const atBoot = deps.stamp()
  const restartable = () => deps.platform === 'win32' && startedByLauncher(ctx.home, deps.pid)

  app.get('/api/server/update', (c) => {
    const now = deps.stamp()
    // A file saved after the start may or may not be what the server loaded: it counts as new.
    const stale = now.newest > deps.bootedAt || now.count !== atBoot.count
    return c.json({ stale, restartable: restartable() } satisfies ServerUpdate)
  })

  app.post('/api/server/restart', (c) => {
    if (!restartable())
      return c.json({ error: "This server was not started by AgentHydra's window launcher, so it cannot restart itself: run desk2/launcher/restart.ps1" }, 409)
    mkdirSync(join(ctx.home, 'logs'), { recursive: true })
    const log = join(ctx.home, 'logs', 'restart.log')
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
    deps.start(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${quote(RESTART_SCRIPT)} *>> ${quote(log)}`])
    return c.json({ ok: true }, 202)
  })
}
