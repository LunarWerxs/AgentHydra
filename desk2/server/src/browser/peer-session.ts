// Which Claude Code session is calling /mcp/browser over a TCP connection. Claude Code sends no session id and no
// folder to an http MCP entry, so the claude process that owns the peer socket is found, and its session file
// (<root>/sessions/<pid>.json) names the session and its folder. Ported from Connections' chat-owner-session.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionFileRoots } from './tab-sweep'

export interface PeerSession {
  sessionId: string
  cwd: string
}

export interface PeerDeps {
  roots?: string[]
  owningPid?: (peerPort: number, serverPort: number) => Promise<number | null>
  parentPidOf?: (pid: number) => Promise<number | null>
}

const MAX_PARENT_HOPS = 3
const LOOKUP_MS = 5_000
const CACHE_MS = 60_000
const CACHE_MAX = 500

export function parseNetstatPid(output: string, peerPort: number, serverPort: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+(\S+)\s+(\d+)\s*$/i.exec(line)
    if (!m) continue
    if (Number(m[1]) !== peerPort || Number(m[2]) !== serverPort) continue
    if (m[3].toUpperCase() !== 'ESTABLISHED') continue
    return Number(m[4])
  }
  return null
}

export function sessionForPid(roots: string[], pid: number): PeerSession | null {
  for (const root of roots) {
    const file = join(root, 'sessions', `${pid}.json`)
    if (!existsSync(file)) continue
    let parsed: { pid?: unknown; sessionId?: unknown; cwd?: unknown }
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (Number(parsed.pid) === pid && typeof parsed.sessionId === 'string' && parsed.sessionId && typeof parsed.cwd === 'string' && parsed.cwd)
      return { sessionId: parsed.sessionId, cwd: parsed.cwd }
  }
  return null
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', windowsHide: true })
    const timer = setTimeout(() => proc.kill(), LOOKUP_MS)
    try {
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function owningPidOfPeer(peerPort: number, serverPort: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const out = await run(['netstat', '-ano', '-p', 'tcp'])
    return out === null ? null : parseNetstatPid(out, peerPort, serverPort)
  }
  const out = await run(['lsof', '-nP', `-iTCP:${peerPort}`, '-sTCP:ESTABLISHED', '-Fp'])
  if (out === null) return null
  const pids = out
    .split('\n')
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)))
  return pids.find((p) => p && p !== process.pid) ?? null
}

export async function parentPidOf(pid: number): Promise<number | null> {
  const out =
    process.platform === 'win32'
      ? await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`])
      : await run(['ps', '-o', 'ppid=', '-p', String(pid)])
  const ppid = Number(out?.trim())
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null
}

async function claudeSessionForPeer(pid: number, roots: string[], parent: (pid: number) => Promise<number | null>): Promise<PeerSession | null> {
  let current: number | null = pid
  for (let hop = 0; current && hop <= MAX_PARENT_HOPS; hop++) {
    const session = sessionForPid(roots, current)
    if (session) return session
    current = await parent(current)
  }
  return null
}

export async function resolvePeerSession(peerPort: number, serverPort: number, deps: PeerDeps = {}): Promise<PeerSession | null> {
  const pid = await (deps.owningPid ?? owningPidOfPeer)(peerPort, serverPort)
  if (!pid) return null
  return claudeSessionForPeer(pid, deps.roots ?? sessionFileRoots(), deps.parentPidOf ?? parentPidOf)
}

/** Answers per peer port for CACHE_MS, so a keep-alive connection pays for one lookup. */
export function createPeerSessionLookup(
  resolve: (peerPort: number, serverPort: number) => Promise<PeerSession | null>,
  now: () => number = Date.now,
): (peerPort: number, serverPort: number) => Promise<PeerSession | null> {
  const cache = new Map<number, { at: number; value: Promise<PeerSession | null> }>()
  return (peerPort, serverPort) => {
    const hit = cache.get(peerPort)
    if (hit && now() - hit.at < CACHE_MS) return hit.value
    if (cache.size >= CACHE_MAX) cache.clear()
    const value = resolve(peerPort, serverPort)
    cache.set(peerPort, { at: now(), value })
    return value
  }
}
