// server/src/fleet.ts - PIECE 1 of the orchestrator rebuild (owner-led, 2026-08-29): the
// deterministic fleet observation. Which Claude sessions are live on this machine, and what
// state is each one in - answered entirely from disk, with zero AI, zero tokens, zero writes.
//
// REBUILD DOCTRINE (owner directive, 2026-08-29, binding on every piece that follows): features
// are added ONE AT A TIME, comprehensively verified before the next, and are as PROGRAMMATIC as
// humanly possible - deterministic code over AI inference wherever a rule can be stated. This
// module is 100% deterministic: registry files + transcript bytes in, facts out. Anything that
// needs judgment (what to DO about a session's state) belongs to a later piece, not here.
//
// What "state" means here, and where each fact comes from:
//   - live sessions: ~/.claude/sessions/<pid>.json via live-registry.ts (pid-validated).
//   - ending: the last classifiable record of the session's transcript, through the same
//     classifyEnding vocabulary the session list already trusts (complete / interrupted /
//     usage-limit / overload / refused / error). No new taxonomy; one vocabulary fleet-wide.
//   - quietSecs: transcript mtime vs now - how long since the session last wrote anything.
//
// The usage probe is filtered out by construction: usage.ts runs its `/usage` reads in a
// dedicated scratch cwd (usageProbeCwd), and a probe is a child process asking a question, not a
// conversation anyone babysits. Matching on that one cwd is exact, not heuristic.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { instanceRefForSession } from './instance-sessions'
import { type LiveSession, readLiveRegistry } from './live-registry'
import { samePathKey } from './path-key'
import { classifyEnding, endingEventText, type SessionEnding } from './session-ending'
import { usageProbeCwd } from './usage'

/** What the transcript on disk says about a live session's most recent state. */
export interface FleetTranscriptState {
  path: string
  mtimeMs: number
  /** Seconds since the transcript last changed - "how long has this session been quiet". */
  quietSecs: number
  /** The last classifiable record's verdict, or null when no record in the tail says anything
   *  (brand-new transcript, or a tail of pure tool traffic). */
  ending: SessionEnding | null
  /** True when the file could not be read or parsed at all - reported, never hidden. */
  unreadable: boolean
}

export interface FleetSession {
  /** Peer-messaging address (SendMessage target). */
  name: string
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  /** Which desktop instance hosts this session ('desktop:<dir>'), when the desktop metadata
   *  says so; null for terminal/CLI sessions with no desktop home. Identity attribution
   *  (piece 4): joins a live session to the account it runs on via fleet-instances refs. */
  instanceRef: string | null
  /** null when the registry entry carries no transcript path (nothing to read yet). */
  transcript: FleetTranscriptState | null
}

export interface FleetStatus {
  at: string
  count: number
  sessions: FleetSession[]
}

// The tail window starts small and grows because real transcripts carry multi-MB single lines
// (measured on this machine's store, 2026-08-25..28): a fixed small window can land INSIDE one
// giant record and see nothing parseable, which must widen the read rather than end it.
const TAIL_WINDOW_START = 64 * 1024
const TAIL_WINDOW_CAP = 4 * 1024 * 1024

/**
 * The ending verdict for a blob of transcript-tail text.
 *
 * `wholeFile` says whether the text starts at byte 0: when it does not, the first line is
 * (statistically always) a partial record sliced mid-line by the window and is dropped rather
 * than fed to JSON.parse as garbage. Exported pure so tests can pin the classification without
 * touching a filesystem.
 */
export function endingFromTailText(text: string, wholeFile: boolean): SessionEnding | null {
  const lines = text.split('\n')
  if (!wholeFile && lines.length > 0) lines.shift()
  let ending: SessionEnding | null = null
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let ev: unknown
    try {
      ev = JSON.parse(t)
    } catch {
      continue // a torn or non-JSON line says nothing; the records around it still count
    }
    ending = classifyEnding(ev, endingEventText(ev)) ?? ending
  }
  return ending
}

/**
 * Read a transcript's tail and classify how it currently ends.
 *
 * Adaptive window: start at {@link TAIL_WINDOW_START}, and while nothing classifiable is found
 * and the file is bigger than the window, grow it (x4) up to {@link TAIL_WINDOW_CAP}. A file
 * that yields nothing within the cap honestly reports `ending: null` rather than guessing.
 */
export function classifyTranscriptTail(
  path: string,
  nowMs: number,
): Omit<FleetTranscriptState, 'path'> {
  let size: number
  let mtimeMs: number
  try {
    const st = statSync(path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return { mtimeMs: 0, quietSecs: 0, ending: null, unreadable: true }
  }
  const quietSecs = Math.max(0, Math.round((nowMs - mtimeMs) / 1000))
  let window = TAIL_WINDOW_START
  for (;;) {
    const start = Math.max(0, size - window)
    const len = size - start
    let text: string
    try {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(len)
        const read = readSync(fd, buf, 0, len, start)
        text = buf.subarray(0, read).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return { mtimeMs, quietSecs, ending: null, unreadable: true }
    }
    const ending = endingFromTailText(text, start === 0)
    if (ending !== null || start === 0 || window >= TAIL_WINDOW_CAP) {
      return { mtimeMs, quietSecs, ending, unreadable: false }
    }
    window *= 4
  }
}

export interface FleetDeps {
  claudeHome?: string
  nowMs?: number
  /** Seam for tests; the default is the real registry read. */
  registry?: (claudeHome: string) => LiveSession[]
  /** Seam for tests; the default is the real usage-probe scratch dir. */
  probeCwd?: () => string | null
  /** Seam for tests; the default is the real desktop-metadata attribution. */
  attribute?: (sessionId: string) => string | null
}

/** The whole fleet, observed fresh. Read-only and cheap: one registry scan plus one tail read
 *  per live session. */
export function fleetStatus(deps: FleetDeps = {}): FleetStatus {
  const claudeHome = deps.claudeHome ?? join(homedir(), '.claude')
  const nowMs = deps.nowMs ?? Date.now()
  const registry = deps.registry ?? readLiveRegistry
  const probe = (deps.probeCwd ?? usageProbeCwd)()
  const attribute = deps.attribute ?? instanceRefForSession
  const sessions: FleetSession[] = []
  for (const s of registry(claudeHome)) {
    if (samePathKey(s.cwd, probe)) continue
    let instanceRef: string | null = null
    try {
      instanceRef = attribute(s.sessionId)
    } catch {
      // Attribution is a join, not a gate: an unreadable metadata store must not hide a session.
    }
    sessions.push({
      name: s.name,
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      startedAt: s.startedAt,
      instanceRef,
      transcript: s.transcriptPath
        ? { path: s.transcriptPath, ...classifyTranscriptTail(s.transcriptPath, nowMs) }
        : null,
    })
  }
  // Quietest first: the session most likely to need a look sits on top, deterministically.
  sessions.sort((a, b) => (b.transcript?.quietSecs ?? -1) - (a.transcript?.quietSecs ?? -1))
  return { at: new Date(nowMs).toISOString(), count: sessions.length, sessions }
}
