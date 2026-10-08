// Loaded with `bun --preload` into a throwaway Desk server by e2e/perf.e2e.ts: appends one JSON line to PERF_COUNT_FILE
// per process the server starts (the program's file name only, never its arguments) and per outbound fetch (origin and
// path, never the query), with the time. Counting from outside the code means an old tree is measured the same way.

import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

const file = process.env.PERF_COUNT_FILE
if (file) {
  const note = (kind: string, what: string) => {
    try {
      appendFileSync(file, `${JSON.stringify({ t: Date.now(), kind, what })}\n`)
    } catch {}
  }
  const program = (cmd: unknown): string => {
    const first = Array.isArray(cmd) ? cmd[0] : (cmd as { cmd?: unknown[] } | undefined)?.cmd?.[0]
    return typeof first === 'string' ? basename(first).toLowerCase() : '?'
  }
  const spawn = Bun.spawn
  const spawnSync = Bun.spawnSync
  ;(Bun as { spawn: unknown }).spawn = (...a: unknown[]) => {
    note('spawn', program(a[0]))
    return (spawn as (...b: unknown[]) => unknown)(...a)
  }
  ;(Bun as { spawnSync: unknown }).spawnSync = (...a: unknown[]) => {
    note('spawn', program(a[0]))
    return (spawnSync as (...b: unknown[]) => unknown)(...a)
  }
  const fetch0 = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const u = new URL(raw)
      note('fetch', `${u.host}${u.pathname}`)
    } catch {}
    return (fetch0 as (a: unknown, b?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
}
