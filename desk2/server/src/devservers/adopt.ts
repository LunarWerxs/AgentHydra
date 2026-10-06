// One copy per server: who already runs what (owner 2026-10-06: "not double or triple them ... another one should
// understand it exists and attempt to leverage that"). Pure decisions over a port scan, so the manager and its tests
// feed them captured scans and no real port is read.
//
// - A server WITH a port: something answers there. The listener is looked up and classified: a dev runtime or app is
//   that server, run by someone else (`outside`); anything else (Desk, AgentHydra, an OS service, a tool daemon) is a
//   `conflict`, and a start is refused rather than killing it.
// - A server WITHOUT a port: a listening dev process whose command line, or that of one of its 3 nearest ancestors,
//   contains the server's absolute folder.
// Nothing here ever ends a process.

import { classify, isDescendant, type Listener, type ProcInfo, type Scan } from '../localhost/ports'

export interface AdoptContext {
  /** This service's and Desk's pids, and Desk's port: none of them is ever a dev server. */
  selfPids: number[]
  deskPid: number
  deskPort: number
  /** Pids of the servers this manager started: what runs under them is theirs, not an outside server. */
  ownPids: number[]
}

export type PortVerdict =
  | { kind: 'outside'; pid: number; name: string | null }
  | { kind: 'conflict'; text: string }
  /** The port answers but the scan has no listener for it (a race, or the scan failed). */
  | { kind: 'unknown'; text: string }

const nameOf = (procs: Map<number, ProcInfo>, pid: number): string | null => procs.get(pid)?.name || null

function kindOf(l: Listener, scan: Scan, ctx: AdoptContext) {
  if (ctx.selfPids.includes(l.pid) || l.pid === ctx.deskPid || l.port === ctx.deskPort) return 'desk' as const
  return classify(l, scan.procs.get(l.pid), { deskPid: ctx.deskPid, deskPort: ctx.deskPort })
}

const underOwn = (pid: number, scan: Scan, ctx: AdoptContext): boolean => ctx.ownPids.some((own) => isDescendant(pid, own, scan.procs))

/** What holds `port`, from a scan taken after a probe saw it answer. */
export function judgePort(port: number, scan: Scan, ctx: AdoptContext): PortVerdict {
  const rows = scan.listeners.filter((l) => l.port === port)
  if (!rows.length) return { kind: 'unknown', text: `port ${port} is in use by a program that could not be identified` }
  // One program can listen on several addresses; a dev one among them decides, else the first row is named.
  const dev = rows.find((l) => ['dev', 'app'].includes(kindOf(l, scan, ctx)) && !underOwn(l.pid, scan, ctx))
  if (dev) return { kind: 'outside', pid: dev.pid, name: nameOf(scan.procs, dev.pid) }
  const l = rows[0]!
  const kind = kindOf(l, scan, ctx)
  const label = kind === 'desk' || kind === 'agenthydra' ? 'AgentHydra' : (nameOf(scan.procs, l.pid) ?? 'another program')
  const own = underOwn(l.pid, scan, ctx) ? ' (a server started here)' : ''
  return { kind: 'conflict', text: `port ${port} is in use by ${label}${own} (pid ${l.pid})` }
}

const slashed = (s: string): string => s.replace(/\\/g, '/').toLowerCase()

/** True when `command` names `cwd` as a whole path (not the front of a longer folder name). */
export function commandInFolder(command: string | null, cwd: string): boolean {
  if (!command) return false
  const hay = slashed(command)
  const needle = slashed(cwd).replace(/\/+$/, '')
  if (!needle) return false
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const next = hay[at + needle.length]
    if (next === undefined || !/[\w.-]/.test(next)) return true
  }
  return false
}

/** True when the process or one of its 3 nearest ancestors runs from `cwd`. */
function runsFrom(pid: number, cwd: string, procs: Map<number, ProcInfo>): boolean {
  let cur = procs.get(pid)
  for (let hop = 0; cur && hop < 4; hop++) {
    if (commandInFolder(cur.command, cwd)) return true
    cur = procs.get(cur.ppid)
  }
  return false
}

/**
 * The listener of a server with no port: a dev process running from its folder. `claimed` holds ports and pids that
 * belong to other servers (declared ports, already adopted listeners) and are skipped, so one listener is never two servers.
 */
export function findByFolder(cwd: string, scan: Scan, ctx: AdoptContext, claimed: { ports: Set<number>; pids: Set<number> }): { pid: number; port: number } | null {
  for (const l of scan.listeners) {
    if (claimed.ports.has(l.port) || claimed.pids.has(l.pid) || underOwn(l.pid, scan, ctx)) continue
    const kind = kindOf(l, scan, ctx)
    if (kind !== 'dev' && kind !== 'app') continue
    if (runsFrom(l.pid, cwd, scan.procs)) return { pid: l.pid, port: l.port }
  }
  return null
}
