// The servers pane's "Other localhost servers": what listens on this machine that no project's server entry accounts
// for, e.g. a dev server run from a terminal. Read only. The dev-servers service itself, the servers it lists as up
// and anything they started are left out (the pane already shows those with Start and Stop), and so is this window.

import type { DevWebCompany, LocalServer, LocalServers } from '@shared/devwebui'
import { commandDir, companyOf } from '../devservers/company'
import { classify, type ClassifyContext, isDescendant, type Listener, probeHttp, type ProcInfo, type Scan, scanPorts } from './ports'

/** What the dev-servers service accounts for right now: the port and pid of every server it lists as up (and its own). */
export interface DevWebOwned {
  ports: number[]
  pids: number[]
}

export interface LocalhostDeps {
  scan?: () => Promise<Scan>
  probe?: typeof probeHttp
  /** The service's ports and pids; null when the service does not run (nothing is left out then). */
  owned?: () => Promise<DevWebOwned | null>
  deskPid?: number
  deskPort?: number
  /** The project folder a command line names, and that folder's company (company.ts; the tests' own tree). */
  dirOf?: (command: string | null) => string | null
  companyOf?: (dir: string) => DevWebCompany
}

export class Localhost {
  private readonly scan: () => Promise<Scan>
  private readonly probe: typeof probeHttp
  private readonly owned: () => Promise<DevWebOwned | null>
  private readonly cls: ClassifyContext
  private readonly dirOf: (command: string | null) => string | null
  private readonly companyOf: (dir: string) => DevWebCompany
  private inflight: Promise<Scan> | null = null

  constructor(deps: LocalhostDeps = {}) {
    this.scan = deps.scan ?? scanPorts
    this.probe = deps.probe ?? probeHttp
    this.owned = deps.owned ?? (async () => null)
    this.dirOf = deps.dirOf ?? ((command) => commandDir(command))
    this.companyOf = deps.companyOf ?? companyOf
    this.cls = { deskPid: deps.deskPid ?? process.pid, deskPort: deps.deskPort ?? (Number(process.env.HYDRA_DESK_PORT) || 7798) }
  }

  /** One scan at a time: panes that refresh together share it. */
  private scanOnce(): Promise<Scan> {
    this.inflight ??= this.scan().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async list(all = false): Promise<LocalServers> {
    const [scan, owned] = await Promise.all([this.scanOnce(), this.owned()])
    const ports = new Set(owned?.ports ?? [])
    // A listed server's pid is whoever holds its port; what it runs hangs below that process or the listed ones.
    const roots = new Set(owned?.pids ?? [])
    for (const l of scan.listeners) if (ports.has(l.port)) roots.add(l.pid)
    const isOwned = (l: Listener) => ports.has(l.port) || [...roots].some((r) => r > 4 && isDescendant(l.pid, r, scan.procs))

    // One row per port: a wildcard and a loopback bind of the same port are one server.
    const byPort = new Map<number, Listener>()
    for (const l of scan.listeners) {
      if (isOwned(l)) continue
      const had = byPort.get(l.port)
      if (!had || (had.address !== '127.0.0.1' && l.address === '127.0.0.1')) byPort.set(l.port, l)
    }

    const rows: LocalServer[] = [...byPort.values()]
      .sort((a, b) => a.port - b.port)
      .map((l) => {
        const p: ProcInfo | undefined = scan.procs.get(l.pid)
        // The folder its command line names is what the sidebar's list groups it by (its company).
        const dir = this.dirOf(p?.command ?? null)
        return { port: l.port, address: l.address, pid: l.pid, process: p?.name || null, dir, company: dir ? this.companyOf(dir) : null, kind: classify(l, p, this.cls), url: `http://localhost:${l.port}/`, title: null, http: null }
      })

    // Probe what will be shown (with all, everything but system services: those are never asked over HTTP).
    await Promise.all(
      rows
        .filter((r) => (all ? r.kind !== 'system' : r.kind === 'dev'))
        .map(async (r) => {
          const res = await this.probe(r.port, r.address)
          r.http = res?.status ?? null
          r.title = res?.title ?? null
        })
    )
    // A dev runtime on an ephemeral port that does not speak HTTP is a helper (test runner, IPC), not a server.
    for (const r of rows) if (r.kind === 'dev' && r.port >= 49152 && r.http === null) r.kind = 'service'

    const servers = all ? rows : rows.filter((r) => r.kind === 'dev')
    return { servers, hidden: rows.length - servers.length, error: scan.error, scannedAt: Date.now() }
  }
}
