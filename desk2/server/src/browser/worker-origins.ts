// The Claude Code sessions of CliMayte workers, each mapped to the session that dispatched the worker, so a page a
// worker opens belongs to its parent chat's ecosystem. Read from the bridge at most every few seconds and shared by
// every browser plugin (one cache per bridge).

import type { Bridge } from '../bridge'

const TTL_MS = 5000

export type WorkerOrigins = ReadonlyMap<string, string>

const readers = new WeakMap<Bridge, () => Promise<WorkerOrigins>>()

export function workerOrigins(b: Bridge): () => Promise<WorkerOrigins> {
  let read = readers.get(b)
  if (!read) {
    let cached: { at: number; map: WorkerOrigins } | null = null
    read = async () => {
      if (cached && Date.now() - cached.at < TTL_MS) return cached.map
      const map = new Map<string, string>()
      for (const w of await b.workers({ all: true }).catch(() => [])) {
        if (!w.originSessionId) continue
        for (const s of w.sessions ?? []) map.set(s, w.originSessionId)
      }
      cached = { at: Date.now(), map }
      return map
    }
    readers.set(b, read)
  }
  return read
}

/** The sessions plus every worker session dispatched, directly or through other workers, by one of them. */
export function withWorkerSessions(sessions: readonly string[], origins: WorkerOrigins): string[] {
  const out = new Set(sessions)
  for (let grew = true; grew; ) {
    grew = false
    for (const [worker, origin] of origins) {
      if (out.has(origin) && !out.has(worker)) {
        out.add(worker)
        grew = true
      }
    }
  }
  return [...out]
}
