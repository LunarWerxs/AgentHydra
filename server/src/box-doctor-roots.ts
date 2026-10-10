// The machine doctor's roots check (box-doctor.ts runs it): a drive or folder agents work in that
// EXISTS but cannot be listed (permissions, a dead mapped drive, a mount whose disk is gone) reads as
// "nothing there" to every tool, and a dead drive does not fail, it hangs.
//
// So the listing runs in a short-lived child process, never in the daemon: a readdir stuck on a dead
// share holds one libuv pool thread until the drive answers, and four of them stall every file read
// the daemon makes. The child writes one line per path as each answers and is killed at the deadline;
// a path with no line did not answer, which is unknown, never empty.

import type { BoxFinding } from './box-doctor'
import { spawnCaptured } from './core/process'

export const ROOT_TIMEOUT_MS = 5_000

export interface RootTarget {
  /** `drive of recent agent work`, `search root`, `registry path <key>`, ... */
  role: string
  path: string
}

export type RootState = 'listed' | 'empty' | 'absent' | 'unreadable' | 'timeout'

export interface RootProbe extends RootTarget {
  state: RootState
  error?: string
}

// Plain JS for `<runtime> -e`: the targets come in through the environment, each answer goes out
// with a synchronous write so nothing is lost to the exit at the deadline.
const CHILD = `
const fs = require('node:fs')
const targets = JSON.parse(process.env.BOX_DOCTOR_ROOTS || '[]')
let left = targets.length
const say = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n')
const done = () => { if (--left <= 0) process.exit(0) }
if (!left) process.exit(0)
setTimeout(() => process.exit(0), ${ROOT_TIMEOUT_MS})
targets.forEach((p, i) => {
  fs.promises.opendir(p)
    .then(async (d) => { const e = await d.read(); await d.close(); say({ i, state: e ? 'listed' : 'empty' }) })
    .catch((err) => say({ i, state: err && err.code === 'ENOENT' ? 'absent' : 'unreadable', error: (err && err.code) || String(err) }))
    .finally(done)
})
`

/** Each target's state, or null when the child could not be started at all. */
export async function probeRoots(targets: readonly RootTarget[]): Promise<RootProbe[] | null> {
  if (targets.length === 0) return []
  const run = await spawnCaptured([process.execPath, '-e', CHILD], {
    timeoutMs: ROOT_TIMEOUT_MS + 3_000,
    env: {
      ...process.env,
      BOX_DOCTOR_ROOTS: JSON.stringify(targets.map((t) => t.path)),
      UV_THREADPOOL_SIZE: '16',
    },
  })
  if (run.code === null && !run.timedOut) return null
  const answers = new Map<number, { state: RootState; error?: string }>()
  for (const line of run.stdout.split(/\r?\n/)) {
    try {
      const a = JSON.parse(line) as { i: number; state: RootState; error?: string }
      if (typeof a.i === 'number') answers.set(a.i, a)
    } catch {
      // a partial last line at the kill
    }
  }
  return targets.map((t, i) => ({ ...t, ...(answers.get(i) ?? { state: 'timeout' as const }) }))
}

/** Findings from the probes, and `checked`: the `root:<path>` key of every path that gave a real
 *  answer. A path that did not answer is not checked, so its open incident holds. Null when the
 *  probes could not be taken at all. */
export function rootFindings(
  probes: readonly RootProbe[] | null,
): { findings: BoxFinding[]; checked: string[] } | null {
  if (!probes) return null
  const out: BoxFinding[] = []
  for (const p of probes) {
    if (p.state === 'unreadable')
      out.push({
        key: `root:${p.path.toLowerCase()}`,
        level: 'problem',
        message: `${p.path} (${p.role}) exists but cannot be listed, so everything under it reads as "nothing there" to every agent and tool. Check its permissions, or reconnect the drive.`,
        detail: p.error,
      })
    else if (p.state === 'timeout')
      out.push({
        key: `root-slow:${p.path.toLowerCase()}`,
        level: 'note',
        message: `${p.path} (${p.role}) did not answer a listing within ${ROOT_TIMEOUT_MS / 1000} s: a sleeping or dead drive.`,
      })
    else if (p.state === 'empty' && p.role === 'search root')
      out.push({
        key: `root-empty:${p.path.toLowerCase()}`,
        level: 'note',
        message: `Search root ${p.path} exists and lists nothing: a mount point whose disk is gone looks exactly like this.`,
      })
  }
  const checked = probes
    .filter((p) => p.state !== 'timeout')
    .map((p) => `root:${p.path.toLowerCase()}`)
  return { findings: out, checked }
}

/** The drive (or share) under each folder agents worked in recently: `D:\\`, `\\\\nas\\share\\`. */
export function driveRoots(cwds: readonly string[]): string[] {
  const roots = new Map<string, string>()
  for (const cwd of cwds) {
    const unc = /^(\\\\[^\\]+\\[^\\]+\\?)/.exec(cwd)
    const drive = /^([A-Za-z]:)[\\/]?/.exec(cwd)
    const root = unc?.[1]
      ? `${unc[1].replace(/\\?$/, '')}\\`
      : drive?.[1]
        ? `${drive[1].toUpperCase()}\\`
        : null
    if (root && !roots.has(root.toLowerCase())) roots.set(root.toLowerCase(), root)
  }
  return [...roots.values()]
}
