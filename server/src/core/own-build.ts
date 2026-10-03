// server/src/core/own-build.ts — which AgentHydra build this daemon is, as the queue snapshot shares it.
// Read once and kept: the commit comes from build-info.ts (the release stamp, or the checkout's HEAD),
// its date from one `git show` (a release binary has no checkout, so its build time stands in).

import { buildInfo } from '../build-info'
import type { QueueBuild } from '../climayte-remote'

let cached: QueueBuild | null | undefined

export function ownBuild(): QueueBuild | null {
  if (cached !== undefined) return cached
  try {
    const info = buildInfo()
    let date: string | null = info.builtAt
    if (info.commit && !info.release) {
      const proc = Bun.spawnSync(['git', 'show', '-s', '--format=%cI', info.commit], {
        cwd: import.meta.dir,
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const out = proc.exitCode === 0 ? proc.stdout.toString().trim() : ''
      if (out && !Number.isNaN(Date.parse(out))) date = new Date(out).toISOString()
    }
    cached = { version: info.version, commit: info.commit?.slice(0, 7) ?? null, date }
  } catch {
    cached = null
  }
  return cached
}
