import { normalizeClaudeNativeProfile } from './claude-native-settings'
import {
  type ClaudeInspectorClient,
  type ClaudeInspectorIdentity,
  connectClaudeInspector,
} from './core/claude-native/inspector-client'
import { type CMProcessInfo, isPidAlive, scanClaudeProcesses } from './core/process'

export interface NativeLaunchReadyOptions {
  profileDir: string
  binary: string
  port: number
  timeoutMs?: number
  startupLogCursor?: NativeLaunchLogCursor
}

export interface NativeLaunchLogCursor {
  path: string
  position: number
}

export function captureNativeLaunchLogCursor(profileDir: string): NativeLaunchLogCursor {
  const path = join(profileDir, 'logs', 'main.log')
  try {
    return { path, position: statSync(path).size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { path, position: 0 }
  }
}

export function nativeHostStartupState(text: string): 'complete' | 'skipped' | 'failed' | null {
  if (text.includes('[Chrome Extension MCP] Native host sync complete')) return 'complete'
  if (
    text.includes(
      '[Chrome Extension MCP] Skipping native host setup: local MCP is disabled by managed config',
    ) ||
    text.includes('[Chrome Extension MCP] Skipping native host setup: binary not found at ')
  )
    return 'skipped'
  if (
    text.includes('[Chrome Extension MCP] Failed to initialize browser automation: ') ||
    text.includes('[Chrome Extension MCP] Failed to sync native host: ')
  )
    return 'failed'
  return null
}

function newStartupLog(cursor: NativeLaunchLogCursor): string {
  let descriptor: number | undefined
  try {
    const size = statSync(cursor.path).size
    const start = Math.max(size < cursor.position ? 0 : cursor.position, size - 65536)
    const buffer = Buffer.alloc(size - start)
    descriptor = openSync(cursor.path, 'r')
    const bytes = readSync(descriptor, buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytes).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

interface ReadyDeps {
  scan?: typeof scanClaudeProcesses
  connect?: typeof connectClaudeInspector
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  /** Whether a pid is still running (signal 0 by default); injected by tests. */
  alive?: (pid: number) => boolean
}

/** Only a changed identity or a failed host setup is worth abandoning the whole wait for. */
function isFatalLaunchReason(message: string): boolean {
  return (
    message.includes('identity mismatch') ||
    message.includes('does not match the requested') ||
    message.includes('host setup failed')
  )
}

type LaunchProbe =
  | { kind: 'ready'; pid: number; identity: ClaudeInspectorIdentity }
  | { kind: 'retry'; reason: string }
  | { kind: 'fatal'; error: unknown }

/**
 * One readiness attempt against the single main process already owning the profile. Retryable
 * outcomes come back as data so the caller keeps its budget and its last-seen explanation.
 */
async function probeNativeLaunchOwner(
  owner: { pid: number },
  profile: string,
  binary: string,
  options: NativeLaunchReadyOptions,
  deps: ReadyDeps,
  deadline: number,
  now: () => number,
): Promise<LaunchProbe> {
  let client: ClaudeInspectorClient | undefined
  try {
    client = await (deps.connect ?? connectClaudeInspector)({
      pid: owner.pid,
      profile,
      port: options.port,
      connectTimeoutMs: Math.max(1, Math.min(2000, deadline - now())),
      callTimeoutMs: Math.max(1, Math.min(2000, deadline - now())),
    })
    const state = await client.evaluate<{
      ready?: boolean
      pid?: number
      executable?: string
      profile?: string
    }>(nativeLaunchReadyExpression)
    if (
      state.pid !== owner.pid ||
      typeof state.executable !== 'string' ||
      normalizeClaudeNativeProfile(state.executable) !== binary ||
      typeof state.profile !== 'string' ||
      normalizeClaudeNativeProfile(state.profile) !== profile
    ) {
      throw Error('Native launch identity mismatch: PID, executable or profile changed')
    }
    const hostState = options.startupLogCursor
      ? nativeHostStartupState(newStartupLog(options.startupLogCursor))
      : 'complete'
    if (hostState === 'failed') {
      throw Error('Native launch host setup failed before registration recovery')
    }
    if (state.ready === true && hostState !== null) {
      return { kind: 'ready', pid: owner.pid, identity: client.identity }
    }
    return {
      kind: 'retry',
      reason:
        state.ready === true
          ? 'Claude has not finished its browser registration startup task'
          : 'Claude has not finished loading its main window',
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return isFatalLaunchReason(reason) ? { kind: 'fatal', error } : { kind: 'retry', reason }
  } finally {
    client?.close()
  }
}

// Reads an already-running app only. No window input, foreground changes or module loading
// beyond Electron's builtin API; registry restoration follows confirmed main-window loading.
export const nativeLaunchReadyExpression = `(() => {
  const req = typeof require === 'function' ? require : process.mainModule?.require?.bind(process.mainModule);
  if (!req) return {ready:false};
  const {app, BrowserWindow, webContents} = req('electron');
  const loaded = app.isReady() && webContents.getAllWebContents().some(contents => {
    if (contents.isDestroyed() || contents.isLoadingMainFrame()) return false;
    if (contents.getType() !== 'window' || !BrowserWindow.fromWebContents(contents)) return false;
    try { return new URL(contents.getURL()).origin === 'https://claude.ai'; } catch { return false; }
  });
  return {ready:loaded, pid:process.pid, executable:process.execPath, profile:app.getPath('userData')};
})()`

interface LaunchWait {
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  deadline: number
}

function nativeLaunchWait(options: NativeLaunchReadyOptions, deps: ReadyDeps): LaunchWait {
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  return { now, sleep, deadline: now() + (options.timeoutMs ?? 30_000) }
}

export async function waitForNativeLaunchReady(
  options: NativeLaunchReadyOptions,
  deps: ReadyDeps = {},
): Promise<{
  pid: number
  identity: ClaudeInspectorIdentity
  ready: boolean
  /** The process row the ready pid came from (carries its start time). */
  owner: CMProcessInfo
}> {
  const profile = normalizeClaudeNativeProfile(options.profileDir)
  const binary = normalizeClaudeNativeProfile(options.binary)
  const { now, sleep, deadline } = nativeLaunchWait(options, deps)
  const alive = deps.alive ?? isPidAlive
  let last = 'the launched profile has not appeared'
  // ONE SCAN FINDS THE OWNER; ITS PID IS THEN WATCHED DIRECTLY (2026-09-25, owner: "why is Agent
  // Hydra so friggin slow at opening instances"). Every lap used to run a fresh full scan - a
  // powershell + CIM round trip of 1.0-1.5s on this box - so readiness was noticed up to ~1.5s
  // late, and the scans competed for CPU with the very Claude startup being waited on. The probe
  // below re-proves pid, executable and profile through the inspector on every lap, so a pid that
  // is still alive needs no rescan; a new scan runs only until the owner appears or once it dies.
  let owner: CMProcessInfo | undefined
  while (now() < deadline) {
    if (!owner || !alive(owner.pid)) {
      const scan = await (deps.scan ?? scanClaudeProcesses)({ fresh: true })
      if (!scan.ok) throw Error(`Native launch process discovery failed: ${scan.reason}`)
      if (now() >= deadline) break
      const owners = scan.processes.filter(
        (row) => row.isMain && row.dir && normalizeClaudeNativeProfile(row.dir) === profile,
      )
      if (owners.length > 1)
        throw Error('Native launch has multiple processes for the exact profile')
      owner = owners[0]
    }
    if (owner) {
      const probe = await probeNativeLaunchOwner(
        owner,
        profile,
        binary,
        options,
        deps,
        deadline,
        now,
      )
      if (probe.kind === 'fatal') throw probe.error
      if (probe.kind === 'ready') {
        return { pid: probe.pid, identity: probe.identity, ready: true, owner }
      }
      last = probe.reason
    }
    if (now() < deadline) await sleep(Math.min(300, deadline - now()))
  }
  throw Error(`Native debugger launch was not verified before the deadline: ${last}`)
}

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
