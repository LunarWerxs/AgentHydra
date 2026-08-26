// server/src/codex-orchestration.ts - Codex threads in the same attention feed as Claude ones.
//
// WHY. AgentHydra is a unified codebase manager, and the orchestrator was watching exactly one
// of the two agents the owner runs. A Codex thread that stopped mid-work, or finished and sat
// waiting, was invisible to the same machinery that babysits every Claude chat - so the feed
// answered "nothing needs attention" while half the fleet was unwatched.
//
// WHAT IS AND IS NOT POSSIBLE, stated plainly rather than discovered later. Codex has:
//   · a rollout store (`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl`), whose
//     FIRST record is `session_meta` carrying the cwd and the thread id;
//   · a per-turn event stream we can classify (`task_complete`, `turn_aborted`, `agent_message`);
//   · NO live-process registry like `~/.claude/sessions/<pid>.json`, and
//   · NO peer messaging and no desktop-app message channel.
// So this half OBSERVES. It can tell you a Codex thread finished 3 hours ago, or was
// interrupted, or stopped mid-turn - and it deliberately marks every item it produces
// `deliverable: false`, because the delivery ladder that drives Claude chats has no rung that
// reaches Codex. An item nobody can act on is still worth having (the owner can act), but a
// reviewer that believed it could message one would nudge into a void, which is precisely the
// failure mode the deaf-chat rail exists to prevent. Better to say so in the payload.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_HOME } from './config'

/** One Codex thread as the watcher sees it. */
export interface CodexThread {
  /** The rollout id (the `id` in session_meta, and the tail of the filename). */
  sessionId: string
  path: string
  cwd: string | null
  mtimeMs: number
}

/** How a Codex thread's last turn ended. Mirrors session-ending.ts's vocabulary where the two
 *  agents genuinely mean the same thing, so the feed reads consistently across both. */
export type CodexEnding = 'complete' | 'interrupted' | 'mid-turn' | 'unknown'

export interface CodexTail {
  ending: CodexEnding
  /** The last thing the agent SAID, which is what a human would read to decide what is next. */
  lastAgentText: string | null
  /** A "What I did / Am I 100% done" style recap is present. */
  recapDetected: boolean
  unreadable: boolean
}

const ROLLOUT_WINDOW_MS = 48 * 3600 * 1000

/**
 * Recent Codex rollouts, newest-first-ish. The store is date-partitioned, so only the last few
 * day-directories are ever opened - the equivalent Claude scan walks every project directory,
 * and this one is cheaper by construction.
 */
export function listRecentCodexThreads(nowMs: number, codexHome = CODEX_HOME): CodexThread[] {
  const root = join(codexHome, 'sessions')
  const out: CodexThread[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      if (depth < 3) {
        // yyyy / mm / dd. A directory whose name cannot be a date component is not the store's.
        if (/^\d{2,4}$/.test(name)) walk(p, depth + 1)
        continue
      }
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      try {
        const st = statSync(p)
        if (nowMs - st.mtimeMs > ROLLOUT_WINDOW_MS) continue
        // rollout-<iso-ish-timestamp>-<uuid>.jsonl — the id is the last 36 characters.
        const base = name.slice('rollout-'.length, -'.jsonl'.length)
        const sessionId = base.slice(-36)
        out.push({ sessionId, path: p, cwd: readCodexCwd(p), mtimeMs: st.mtimeMs })
      } catch {
        // A file deleted mid-scan is simply not recent.
      }
    }
  }
  walk(root, 0)
  return out
}

/** The cwd a Codex thread ran in, from its `session_meta` first record. */
export function readCodexCwd(path: string): string | null {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 64 * 1024)
    const first = head.split('\n', 1)[0]
    const ev = JSON.parse(first) as { type?: string; payload?: { cwd?: string } }
    if (ev?.type !== 'session_meta') return null
    return typeof ev.payload?.cwd === 'string' ? ev.payload.cwd : null
  } catch {
    return null
  }
}

/**
 * Classify a Codex rollout's tail. Pure, so the shapes can be pinned by tests without a store.
 *
 * The vocabulary comes from the rollout's own events, measured on this machine's store:
 * `task_complete` ends a turn normally, `turn_aborted` carries a reason (`interrupted` when the
 * human pressed stop), and `agent_message` is what the agent said. A tail whose newest event is
 * none of those is mid-turn: the model is working, or it stopped without saying so.
 */
export function parseCodexTail(raw: string): CodexTail {
  const info: CodexTail = {
    ending: 'unknown',
    lastAgentText: null,
    recapDetected: false,
    unreadable: true,
  }
  const lines = raw.split('\n').filter((l) => l.trim())
  let newest = true
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: {
      type?: string
      payload?: { type?: string; reason?: string; message?: string; content?: unknown }
    }
    try {
      ev = JSON.parse(lines[i])
    } catch {
      continue
    }
    const kind = ev?.payload?.type
    if (!kind) continue
    // token_count records are pure bookkeeping and land after the interesting events, so they
    // must never be read as "the newest thing that happened".
    if (kind === 'token_count') continue
    info.unreadable = false
    if (newest) {
      newest = false
      info.ending =
        kind === 'task_complete'
          ? 'complete'
          : kind === 'turn_aborted'
            ? ev.payload?.reason === 'interrupted'
              ? 'interrupted'
              : 'complete'
            : 'mid-turn'
    }
    if (info.lastAgentText === null && kind === 'agent_message') {
      const msg = ev.payload?.message
      if (typeof msg === 'string' && msg.trim()) info.lastAgentText = msg.trim().slice(-4000)
    }
    if (info.lastAgentText !== null && info.ending !== 'unknown') break
  }
  if (info.lastAgentText) {
    info.recapDetected = /##\s*(What I did|Am I 100% done|Do I recommend)/i.test(info.lastAgentText)
  }
  return info
}

/** Read the tail of a rollout file (bytes, not lines: rollouts carry very long single records,
 *  so reading the last N lines would mean reading the whole file). */
export function readCodexTail(path: string, bytes = 256 * 1024): CodexTail {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    return parseCodexTail(buf.toString('utf8'))
  } catch {
    return { ending: 'unknown', lastAgentText: null, recapDetected: false, unreadable: true }
  }
}
