// Tokens a running CliMayte worker has spent so far. AgentHydra charges an attempt's tokens to the
// worker only when the attempt ends (climayte.ts charge()), so while it runs the view's `tokens` lags
// by the whole live attempt. This reads the worker's own Claude Code transcripts instead
// (<configDir>/projects/<cwd slug>/<session>.jsonl under the CLI instance it ran on) and sums the
// usage on its assistant messages: input + output + cache write, each message once (Claude Code
// writes one line per content block, all carrying the message's usage). Cache reads are left out:
// the whole context is re-read every turn, so counting them reports a long worker in the hundreds
// of millions.
//
// Bounded and incremental: a file is read from where the last read stopped, at most CHUNK_BYTES per
// refresh, and only when the worker's updatedAt moved. A transcript that cannot be found leaves the
// settled figure (or null): the window shows a dash, never a guess.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CliMayteWorker } from '@shared/protocol'
import type { AhWorker } from './client'

const CHUNK_BYTES = 16 * 1024 * 1024

interface Tally {
  path: string
  offset: number
  rest: string
  byMessage: Map<string, number>
  total: number
}

export const usageTotal = (u: Record<string, unknown> | undefined): number => {
  if (!u) return 0
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens')
}

/** Adds one transcript line's usage to the tally; a message seen again keeps its largest figure. */
export function addLine(t: Pick<Tally, 'byMessage' | 'total'>, line: string): void {
  if (!line.includes('"usage"')) return
  let e: { type?: string; uuid?: string; message?: { id?: string; usage?: Record<string, unknown> } }
  try {
    e = JSON.parse(line)
  } catch {
    return
  }
  if (e.type !== 'assistant' || !e.message?.usage) return
  const key = e.message.id ?? e.uuid ?? line
  const v = usageTotal(e.message.usage)
  const prev = t.byMessage.get(key) ?? 0
  if (v <= prev) return
  t.byMessage.set(key, v)
  t.total += v - prev
}

/** How long a transcript that was not found is not looked for again. */
const MISS_MS = 15_000

export function createWorkerTokens(o: { chunkBytes?: number; now?: () => number } = {}) {
  const chunk = o.chunkBytes ?? CHUNK_BYTES
  const now = o.now ?? Date.now
  /** Sessions whose transcript was not found, and when: the scan of every project folder is not repeated at each refresh. */
  const misses = new Map<string, number>()
  const tallies = new Map<string, Tally>()
  const seen = new Map<string, { updatedAt: number; tokens: number | null }>()

  function locate(sessionId: string, dirs: Iterable<string>): string | null {
    for (const dir of dirs) {
      const root = join(dir, 'projects')
      let subs: string[] = []
      try {
        subs = readdirSync(root)
      } catch {
        continue
      }
      for (const d of subs) {
        const file = join(root, d, `${sessionId}.jsonl`)
        if (existsSync(file)) return file
      }
    }
    return null
  }

  function read(t: Tally): void {
    let size = 0
    try {
      size = statSync(t.path).size
    } catch {
      return
    }
    if (size <= t.offset) return
    const len = Math.min(size - t.offset, chunk)
    const buf = Buffer.alloc(len)
    const fd = openSync(t.path, 'r')
    try {
      readSync(fd, buf, 0, len, t.offset)
    } finally {
      closeSync(fd)
    }
    t.offset += len
    const lines = (t.rest + buf.toString('utf8')).split('\n')
    t.rest = lines.pop() ?? ''
    for (const line of lines) addLine(t, line)
  }

  function sessionTokens(sessionId: string, dirs: string[]): number | null {
    let t = tallies.get(sessionId)
    if (!t) {
      const missed = misses.get(sessionId)
      if (missed !== undefined && now() - missed < MISS_MS) return null
      const path = locate(sessionId, dirs)
      if (!path) {
        misses.set(sessionId, now())
        return null
      }
      misses.delete(sessionId)
      t = { path, offset: 0, rest: '', byMessage: new Map(), total: 0 }
      tallies.set(sessionId, t)
    }
    read(t)
    return t.total
  }

  /** The worker's tokens: the larger of what AgentHydra charged and what its transcripts show. */
  function live(w: AhWorker, configDirs: ReadonlyMap<string, string>, settled: number | null): number | null {
    const dirs = [
      ...new Set(
        [w.accountId, ...(w.attempts ?? []).map((a) => a.account.id)]
          .map((id) => (id ? configDirs.get(id) : undefined))
          .filter((d): d is string => !!d),
      ),
    ]
    const sessions = [...new Set([...(w.sessions ?? []), ...(w.sessionId ? [w.sessionId] : [])])]
    let sum: number | null = null
    for (const s of sessions) {
      const n = sessionTokens(s, dirs)
      if (n !== null) sum = (sum ?? 0) + n
    }
    if (sum === null) return settled
    return settled === null ? sum : Math.max(settled, sum)
  }

  return {
    /** Fills `tokens` on the active workers in `list` (mapped from `raw`), in place. */
    apply(list: CliMayteWorker[], raw: readonly AhWorker[], configDirs: ReadonlyMap<string, string>): void {
      const byId = new Map(raw.map((w) => [w.id, w]))
      const activeIds = new Set<string>()
      const activeSessions = new Set<string>()
      for (const w of list) {
        const r = byId.get(w.id)
        if (!w.active || !r || (!r.sessionId && !r.sessions?.length)) continue
        activeIds.add(w.id)
        for (const s of r.sessions ?? []) activeSessions.add(s)
        if (r.sessionId) activeSessions.add(r.sessionId)
        const last = seen.get(w.id)
        if (last && last.updatedAt === r.updatedAt) {
          w.tokens = last.tokens ?? w.tokens
          continue
        }
        w.tokens = live(r, configDirs, w.tokens)
        seen.set(w.id, { updatedAt: r.updatedAt, tokens: w.tokens })
      }
      // A worker that finished or is no longer listed keeps nothing: its settled figure comes from AgentHydra.
      for (const id of seen.keys()) if (!activeIds.has(id)) seen.delete(id)
      for (const id of tallies.keys()) if (!activeSessions.has(id)) tallies.delete(id)
      for (const id of misses.keys()) if (!activeSessions.has(id)) misses.delete(id)
    },
  }
}

export type WorkerTokens = ReturnType<typeof createWorkerTokens>
