// server/src/live-registry.ts - the live-session registry: which Claude sessions are running
// on this machine right now, joined to their transcripts.
//
// `~/.claude/sessions/<pid>.json` is the CLI's own live registry - `name` is the peer address,
// `sessionId` is the transcript id, plus cwd and pid. This module validates the pid is alive
// and joins the registry world to the transcript store. Extracted from the retired v1
// retired subsystem because "who is live" is general infrastructure:
// the chat dossier answers "is a process hosting this chat right now" from it.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  /** The peer-messaging address (SendMessage target). */
  name: string
  startedAt: number
  transcriptPath: string | null
  /** The Claude Code version the session's engine runs, as the engine wrote it on start. Absent on
   *  records too old to carry one. version-drift.ts reads it to find chats left on an old engine. */
  version?: string
  /** The desktop chat id (`local_...`) whose app hosts this engine. A moved chat keeps its
   *  sessionId on BOTH accounts, so the sessionId alone cannot say which account's copy is
   *  running; this can. Absent on CLI engines and on records too old to carry one. */
  hostSessionId?: string
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Is this REGISTRY RECORD's session alive — not merely "some process owns that pid"?
 *
 *  A pid alone cannot answer that. The registry is written on start and never cleaned on crash,
 *  so a session that died un-gracefully leaves `<pid>.json` behind, and the OS is free to hand
 *  that number to something else: measured 2026-09-13, a dead session's pid had been recycled by
 *  an unrelated instance's Electron renderer, so `list_chats` reported the chat live, the move
 *  gates would have refused it, and `terminate_live` would have killed a STRANGER'S process tree.
 *
 *  `messagingSocketPath` is the session's own named pipe (Windows) / unix socket (POSIX), and it
 *  names THAT session, so a recycled pid cannot answer for it. It is an ADDITIONAL requirement,
 *  never a substitute: on POSIX a crash can leave the socket file on disk, so the pid check still
 *  carries the verdict there and this only narrows it. A record too old to carry a socket path
 *  falls back to the pid alone, which is exactly what every record used to get. */
function sessionAlive(reg: { pid: number; messagingSocketPath?: unknown }): boolean {
  if (!pidAlive(reg.pid)) return false
  const sock = reg.messagingSocketPath
  if (typeof sock !== 'string' || sock === '') return true
  return existsSync(sock)
}

/** The CLI's transcript-store encoding of a cwd: every non-alphanumeric character becomes '-'. */
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function transcriptPathFor(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = join(claudeHome, 'projects', projectKeyForCwd(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // The key preserves the cwd's casing as the session recorded it, which is not always the casing
  // in the registry (drive letters wander between 'D:' and 'd:'). The sessionId is globally unique,
  // so a bounded search across project dirs settles it.
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all — reported as unreadable per-session by the caller.
  }
  return null
}

/** A registry file that outlived its process: the session died un-gracefully (computer
 *  restart, crash, kill) - a graceful exit deletes its own `<pid>.json`. Restored from the
 *  archived v1 (piece 8 needs it as crash evidence): mid-process death is a resumable
 *  scenario, so these are surfaced, never silently dropped. */
export interface OrphanSession extends LiveSession {
  registryPath: string
}

export function readOrphanedRegistry(claudeHome: string): OrphanSession[] {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: OrphanSession[] = []
  for (const f of files) {
    try {
      const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof reg?.sessionId !== 'string' || typeof reg?.cwd !== 'string') continue
      if (typeof reg.pid !== 'number' || sessionAlive(reg)) continue
      out.push({
        pid: reg.pid,
        sessionId: reg.sessionId,
        cwd: reg.cwd,
        name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
        startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
        transcriptPath: transcriptPathFor(claudeHome, reg.cwd, reg.sessionId),
        registryPath: join(dir, f),
      })
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return out
}

/** Find a transcript by session id alone (no cwd known - e.g. gating a non-live chat): the
 *  sessionId is globally unique, so a bounded scan across project dirs settles it. */
export function findTranscriptById(claudeHome: string, sessionId: string): string | null {
  try {
    for (const dir of readdirSync(join(claudeHome, 'projects'))) {
      const p = join(claudeHome, 'projects', dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // No projects dir at all.
  }
  return null
}

export function readLiveRegistry(claudeHome: string): LiveSession[] {
  const dir = join(claudeHome, 'sessions')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const live: LiveSession[] = []
  for (const f of files) {
    try {
      const reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (typeof reg?.sessionId !== 'string' || typeof reg?.cwd !== 'string') continue
      if (typeof reg.pid !== 'number') continue
      if (!sessionAlive(reg)) continue
      live.push({
        pid: reg.pid,
        sessionId: reg.sessionId,
        cwd: reg.cwd,
        name: typeof reg.name === 'string' ? reg.name : reg.sessionId.slice(0, 8),
        startedAt: typeof reg.startedAt === 'number' ? reg.startedAt : 0,
        transcriptPath: transcriptPathFor(claudeHome, reg.cwd, reg.sessionId),
        ...(typeof reg.version === 'string' ? { version: reg.version } : {}),
        ...(typeof reg.hostSessionId === 'string' && reg.hostSessionId !== ''
          ? { hostSessionId: reg.hostSessionId }
          : {}),
      })
    } catch {
      // One unreadable registry entry must not hide the others.
    }
  }
  return live
}
