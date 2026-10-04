// The globe button's data (SPEC "Localhost"): the dev servers listening on this machine, what the chat's folder
// can start, and DevWebUI's processes when its daemon answers. Starts, stops and restarts go to DevWebUI for
// what it manages and to ManagedServers for what Desk starts itself; nothing else is ever stopped.

import type { LocalhostState, LocalServer, LocalServerKind, StartableServer } from '@shared/protocol'
import { DevWebUI, type DevWebUIProcess } from './devwebui'
import { folderKey, ManagedServers, ownedBy, StopRefused, type ManagedRecord } from './managed'
import { probeHttp, scanPorts, type Listener, type ProcInfo, type Scan } from './ports'
import { detectStartable } from './startable'

export { StopRefused }

/** Process names that run dev servers: only these show without ?all=1. */
const DEV_RUNTIMES = new Set(
  ['node', 'bun', 'deno', 'python', 'python3', 'pythonw', 'py', 'ruby', 'php', 'php-cgi', 'java', 'javaw', 'dotnet', 'go', 'air', 'cargo', 'uvicorn', 'gunicorn', 'hugo', 'caddy', 'nginx', 'httpd', 'esbuild', 'vite', 'wrangler', 'workerd', 'docker', 'com.docker.backend', 'wslrelay', 'rails', 'flask', 'jekyll', 'zola'].map((n) => n.toLowerCase())
)

const SYSTEM_NAMES = new Set(['system', 'idle', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv', 'smss', 'csrss', 'winlogon', 'jhi_service', 'msmpeng', 'searchhost', 'searchindexer', 'registry', 'memory compression'])

/** Tool daemons that listen on loopback but are not dev servers (MCP servers, caches, indexers). */
const SERVICE_COMMAND = /\bmcp\b|local-mcp|hswarm|zswarm|codegraph|sccache|language-?server|[\\/]\.claude[\\/]hooks[\\/]/i

export interface ClassifyContext {
  /** Desk's own pid and port. */
  deskPid: number
  deskPort: number
  /** Desk's data home: its chat hosts run with a spec under <home>/hosts. */
  home: string
}

export function classify(l: Listener, p: ProcInfo | undefined, c: ClassifyContext): LocalServerKind {
  const name = (p?.name ?? '').toLowerCase()
  const cmd = p?.command ?? ''
  if (l.pid === c.deskPid || l.port === c.deskPort || l.port === 7795) return 'desk'
  // A chat host of this Desk or of another Desk home (a test server, a second copy).
  if (/chat-host\.ts/.test(cmd) && /--spec/.test(cmd)) return 'desk'
  if (name === 'agenthydra' || l.port === 7787) return 'agenthydra'
  if (l.pid === 0 || l.pid === 4 || SYSTEM_NAMES.has(name) || /^"?[a-z]:\\windows\\/i.test(cmd)) return 'system'
  if (SERVICE_COMMAND.test(cmd)) return 'service'
  if (DEV_RUNTIMES.has(name)) return 'dev'
  return 'app'
}

/** The command line without its program (so a folder that holds the runtime, like C:\Users\me, does not match it). */
export function commandArgs(cmd: string): string {
  const s = cmd.trim()
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    return end < 0 ? '' : s.slice(end + 1)
  }
  const sp = s.search(/\s/)
  return sp < 0 ? '' : s.slice(sp)
}

/** The longest known folder that holds cwd or is named in the command's arguments. */
export function guessProject(known: string[], cwd: string | null, command: string | null): string | null {
  const c = cwd ? `${folderKey(cwd)}/` : null
  const args = command ? folderKey(commandArgs(command)) : ''
  let best: string | null = null
  for (const f of known) {
    const k = folderKey(f)
    if (!k) continue
    const hit = (c !== null && c.startsWith(`${k}/`)) || (args && (args.includes(`${k}/`) || args.includes(`${k}"`) || args.endsWith(k) || args.includes(`${k} `)))
    if (hit && (!best || k.length > folderKey(best).length)) best = f
  }
  return best
}

const within = (dir: string, folder: string) => `${folderKey(dir)}/`.startsWith(`${folderKey(folder)}/`)

export interface LocalhostDeps {
  scan?: () => Promise<Scan>
  probe?: typeof probeHttp
  devwebui?: DevWebUI
  managed?: ManagedServers
  /** The chats' folders and Recent: what a project guess may answer. */
  knownFolders?: () => string[]
  deskPid?: number
  deskPort?: number
}

export class Localhost {
  readonly managed: ManagedServers
  readonly devwebui: DevWebUI
  private readonly scan: () => Promise<Scan>
  private readonly probe: typeof probeHttp
  private readonly known: () => string[]
  private readonly cls: ClassifyContext
  private inflight: Promise<Scan> | null = null

  constructor(home: string, deps: LocalhostDeps = {}) {
    this.managed = deps.managed ?? new ManagedServers(home)
    this.devwebui = deps.devwebui ?? new DevWebUI()
    this.scan = deps.scan ?? scanPorts
    this.probe = deps.probe ?? probeHttp
    this.known = deps.knownFolders ?? (() => [])
    this.cls = { deskPid: deps.deskPid ?? process.pid, deskPort: deps.deskPort ?? (Number(process.env.HYDRA_DESK_PORT) || 7795), home }
  }

  /** One scan at a time: windows that refresh together share it. */
  private scanOnce(): Promise<Scan> {
    this.inflight ??= this.scan().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async state(folder: string | null, all = false): Promise<LocalhostState> {
    const [scan, dw] = await Promise.all([this.scanOnce(), this.devwebui.read()])
    const live = this.managed.alive(scan.procs)
    const known = [...this.known(), ...(folder ? [folder] : [])]

    const deskOwner = (pid: number): ManagedRecord | undefined => live.find((r) => ownedBy(r, pid, scan.procs))
    const dwOwner = (l: Listener): DevWebUIProcess | undefined =>
      dw.processes.find((p) => p.pid !== null && (p.pid === l.pid || isDescendant(l.pid, p.pid, scan.procs))) ??
      dw.processes.find((p) => p.port === l.port && p.status === 'running')

    // One row per port: a wildcard and a loopback bind of the same port are one server.
    const byPort = new Map<number, Listener>()
    for (const l of scan.listeners) {
      const had = byPort.get(l.port)
      if (!had || (had.address !== '127.0.0.1' && l.address === '127.0.0.1')) byPort.set(l.port, l)
    }

    const rows: LocalServer[] = []
    for (const l of [...byPort.values()].sort((a, b) => a.port - b.port)) {
      const p = scan.procs.get(l.pid)
      const mine = deskOwner(l.pid)
      const theirs = mine ? undefined : dwOwner(l)
      let kind = classify(l, p, this.cls)
      if (mine || theirs) kind = 'dev'
      const cwd = mine?.folder ?? theirs?.cwd ?? null
      rows.push({
        port: l.port,
        address: l.address,
        pid: l.pid,
        process: p?.name ?? null,
        command: p?.command ?? null,
        cwd,
        project: guessProject(known, cwd, p?.command ?? null),
        url: `http://localhost:${l.port}/`,
        http: null,
        kind,
        startedAt: mine ? mine.created : (theirs?.startedAt ?? p?.created ?? null),
        managed: mine ? 'desk' : theirs ? 'devwebui' : null,
        managedId: mine ? mine.id : theirs ? `devwebui:${theirs.id}` : null,
        ...(theirs ? { status: theirs.status, cpu: theirs.cpu, memory: theirs.memory } : {}),
      })
    }

    // Probe what will be shown (everything but system services with ?all=1).
    const probed = rows.filter((r) => (all ? r.kind !== 'system' : r.kind === 'dev'))
    await Promise.all(probed.map(async (r) => (r.http = await this.probe(r.port, r.address))))
    // A dev runtime on an ephemeral port that does not speak HTTP is a helper (test runner, IPC), not a server.
    for (const r of rows) if (r.kind === 'dev' && !r.managed && r.port >= 49152 && !r.http) r.kind = 'service'

    const servers = all ? rows : rows.filter((r) => r.kind === 'dev')
    return {
      servers,
      hidden: rows.length - servers.length,
      folder,
      startable: folder ? this.startable(folder, rows, dw.processes, live) : [],
      devwebui: dw.status,
      error: scan.error,
      scannedAt: Date.now(),
    }
  }

  private startable(folder: string, rows: LocalServer[], dwProcs: DevWebUIProcess[], live: ManagedRecord[]): StartableServer[] {
    const out: StartableServer[] = []
    const fromDaemon = dwProcs.filter((p) => p.cwd && within(p.cwd, folder))
    for (const p of fromDaemon) {
      const running = p.status !== 'stopped' && p.status !== 'crashed'
      out.push({
        id: `devwebui:${p.id}`,
        name: p.name,
        command: p.command,
        cwd: p.cwd,
        source: 'devwebui',
        port: p.port ?? null,
        running: running ? { pid: p.pid, port: p.port ?? null, startedAt: p.startedAt, status: p.status } : null,
        managed: 'devwebui',
      })
    }
    const daemonIds = new Set(fromDaemon.map((p) => p.localId))
    for (const s of detectStartable(folder)) {
      // DevWebUI already runs this .devwebui process: its row above is the one to drive.
      if (s.source === '.devwebui' && daemonIds.has(s.id.slice('devwebui-file:'.length))) continue
      const rec = live.find((r) => r.key === `${folderKey(folder)}|${s.id}`)
      const row = rec ? rows.find((r) => r.managed === 'desk' && r.managedId === s.id && r.cwd && folderKey(r.cwd) === folderKey(folder)) : undefined
      out.push({
        ...s,
        running: rec ? { pid: rec.pid, port: row?.port ?? null, startedAt: rec.created, status: 'running' } : null,
        managed: rec ? 'desk' : null,
      })
    }
    return out
  }

  /** Resolves a start id against what the folder offers right now (never a command from the caller). */
  private async resolve(folder: string, id: string): Promise<StartableServer> {
    if (id.startsWith('devwebui:')) {
      const dw = await this.devwebui.read()
      if (!dw.status.up) throw new StopRefused(`DevWebUI is ${dw.status.error ?? 'not running'}`)
      const p = dw.processes.find((x) => `devwebui:${x.id}` === id)
      if (!p) throw new NotFound(`DevWebUI has no process ${id.slice(9)}`)
      return { id, name: p.name, command: p.command, cwd: p.cwd, source: 'devwebui', port: p.port ?? null, running: null, managed: 'devwebui' }
    }
    const s = detectStartable(folder).find((x) => x.id === id)
    if (!s) throw new NotFound(`${folder} has no startable ${id}`)
    return { ...s, running: null, managed: null }
  }

  async start(folder: string, id: string): Promise<{ ok: true; id: string; pid: number | null; log: string | null }> {
    const s = await this.resolve(folder, id)
    if (s.source === 'devwebui') {
      await this.devwebui.action(id.slice(9), 'start')
      return { ok: true, id, pid: null, log: null }
    }
    const rec = await this.managed.start(folder, id, s.name, s.command, s.cwd)
    return { ok: true, id, pid: rec.pid, log: rec.log }
  }

  async stop(target: { folder?: string; id?: string; pid?: number }): Promise<{ ok: true; by: 'desk' | 'devwebui' }> {
    if (target.id?.startsWith('devwebui:')) {
      await this.resolve(target.folder ?? '', target.id)
      await this.devwebui.action(target.id.slice(9), 'stop')
      return { ok: true, by: 'devwebui' }
    }
    await this.managed.stop(target)
    return { ok: true, by: 'desk' }
  }

  async restart(folder: string, id: string): Promise<{ ok: true; id: string }> {
    if (id.startsWith('devwebui:')) {
      await this.resolve(folder, id)
      await this.devwebui.action(id.slice(9), 'restart')
      return { ok: true, id }
    }
    if (!this.managed.find(folder, id)) throw new StopRefused('not started by Desk')
    await this.managed.stop({ folder, id })
    await this.start(folder, id)
    return { ok: true, id }
  }

  async log(folder: string, id: string, lines = 80): Promise<{ id: string; lines: string[]; source: 'desk' | 'devwebui' }> {
    if (id.startsWith('devwebui:')) return { id, lines: await this.devwebui.logs(id.slice(9), lines), source: 'devwebui' }
    const rec = this.managed.find(folder, id)
    if (!rec) throw new NotFound('Desk has no log for that server')
    return { id, lines: this.managed.tail(rec, lines), source: 'desk' }
  }
}

export class NotFound extends Error {}

function isDescendant(pid: number, ancestor: number, procs: Map<number, ProcInfo>): boolean {
  let cur = procs.get(pid)
  for (let hops = 0; cur && hops < 32; hops++) {
    if (cur.ppid === ancestor) return true
    cur = procs.get(cur.ppid)
  }
  return false
}
