// The dev servers Desk started (SPEC "Localhost"): <home>/localhost/managed.json holds each one's pid and the
// start time Windows reports for it, its log is <home>/localhost/<name>.log. Desk stops only what is in this
// record AND still has the same pid and start time (a reused pid belongs to someone else), and then the whole
// tree. Windows starts go through WMI like the chat hosts (host/launch.ts): hidden, outside Desk's process
// tree, so a server restart leaves them running.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { powershell, readProcs, type ProcInfo } from './ports'

export interface ManagedRecord {
  /** folderKey(folder) + '|' + start id: one running copy per folder and id. */
  key: string
  folder: string
  id: string
  name: string
  command: string
  /** The root process Desk started (cmd.exe on Windows, sh elsewhere). */
  pid: number
  /** Its start time as the OS reports it, epoch ms: the identity check before any stop. */
  created: number
  log: string
}

/** Start times within this many ms are the same process (WMI and CIM round differently). */
export const SAME_START_MS = 2000

export const folderKey = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

export class StopRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StopRefused'
  }
}

export interface ManagedDeps {
  /** Every process now (pid -> info); tests inject a fixed table. */
  procs?: () => Promise<Map<number, ProcInfo>>
  /** Ends a process tree. */
  kill?: (pid: number) => void
  /** Starts command hidden in cwd with its output appended to log; answers the root pid and its start time. */
  launch?: (command: string, cwd: string, log: string) => Promise<{ pid: number; created: number }>
}

export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(-pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

const psLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Windows: WMI Win32_Process.Create of `cmd /d /s /c "<command> >> "<log>" 2>&1"`, hidden, in cwd; Start-Process
 *  -WindowStyle Hidden when WMI refuses. Prints {pid, c}. */
export function windowsLaunchScript(command: string, cwd: string, log: string): string {
  const line = `cmd.exe /d /s /c "${command} >> "${log}" 2>&1"`
  const args = `/d /s /c "${command} >> "${log}" 2>&1"`
  return [
    "$ErrorActionPreference = 'Stop'",
    '$id = 0',
    `try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(line)}; CurrentDirectory = ${psLiteral(cwd)}; ProcessStartupInformation = (New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0 }) }; if ($r.ReturnValue -eq 0) { $id = [int]$r.ProcessId } } catch { $id = 0 }`,
    `if ($id -eq 0) { $id = (Start-Process -FilePath 'cmd.exe' -ArgumentList ${psLiteral(args)} -WorkingDirectory ${psLiteral(cwd)} -WindowStyle Hidden -PassThru).Id }`,
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"',
    '$c = if ($p -and $p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }',
    "@{ pid = $id; c = $c } | ConvertTo-Json -Compress",
  ].join('; ')
}

async function defaultLaunch(command: string, cwd: string, log: string): Promise<{ pid: number; created: number }> {
  if (process.platform === 'win32') {
    const out = await powershell(windowsLaunchScript(command, cwd, log))
    const r = out ? (JSON.parse(out.trim()) as { pid?: number; c?: number }) : {}
    if (!r.pid) throw new Error('Windows did not start the process')
    return { pid: r.pid, created: r.c || Date.now() }
  }
  const fd = openSync(log, 'a')
  const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  if (!child.pid) throw new Error('the process did not start')
  const created = (await readProcs()).get(child.pid)?.created ?? Date.now()
  return { pid: child.pid, created }
}

/** A file name from folder and id: letters, digits, dot, dash, underscore. */
export function logName(folder: string, id: string): string {
  return `${basename(folder) || 'root'}-${id}`.replace(/[^\w.-]+/g, '-').slice(0, 80)
}

/** Is `pid` (as seen in procs) the process the record started, or one of its descendants? */
export function ownedBy(rec: ManagedRecord, pid: number, procs: Map<number, ProcInfo>): boolean {
  const root = procs.get(rec.pid)
  if (!root || root.created === null || Math.abs(root.created - rec.created) > SAME_START_MS) return false
  let cur = procs.get(pid)
  for (let hops = 0; cur && hops < 32; hops++) {
    if (cur.pid === rec.pid) return true
    const parent = procs.get(cur.ppid)
    // A parent younger than its child is a reused pid, not the parent.
    if (!parent || (parent.created !== null && cur.created !== null && parent.created > cur.created + SAME_START_MS)) return false
    cur = parent
  }
  return false
}

export class ManagedServers {
  readonly dir: string
  private readonly file: string
  private readonly deps: Required<ManagedDeps>

  constructor(home: string, deps: ManagedDeps = {}) {
    this.dir = join(home, 'localhost')
    this.file = join(this.dir, 'managed.json')
    this.deps = { procs: deps.procs ?? readProcs, kill: deps.kill ?? killTree, launch: deps.launch ?? defaultLaunch }
  }

  list(): ManagedRecord[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(data) ? (data as ManagedRecord[]).filter((r) => r && typeof r.pid === 'number' && typeof r.key === 'string') : []
    } catch {
      return []
    }
  }

  private save(records: ManagedRecord[]): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`)
    renameSync(tmp, this.file)
  }

  /** The records whose process is still the one Desk started; the rest are dropped from the file. */
  alive(procs: Map<number, ProcInfo>): ManagedRecord[] {
    const all = this.list()
    const live = all.filter((r) => ownedBy(r, r.pid, procs))
    if (live.length !== all.length) this.save(live)
    return live
  }

  find(folder: string, id: string): ManagedRecord | undefined {
    const key = `${folderKey(folder)}|${id}`
    return this.list().find((r) => r.key === key)
  }

  async start(folder: string, id: string, name: string, command: string, cwd: string): Promise<ManagedRecord> {
    const key = `${folderKey(folder)}|${id}`
    const procs = await this.deps.procs()
    if (this.alive(procs).some((r) => r.key === key)) throw new StopRefused(`${name} is already running`)
    mkdirSync(this.dir, { recursive: true })
    const log = join(this.dir, `${logName(folder, id)}.log`)
    appendFileSync(log, `\n--- ${new Date().toISOString()} Hydra Desk started: ${command} (in ${cwd})\n`)
    const { pid, created } = await this.deps.launch(command, cwd, log)
    const rec: ManagedRecord = { key, folder, id, name, command, pid, created, log }
    this.save([...this.list().filter((r) => r.key !== key), rec])
    return rec
  }

  /** Stops the server Desk started under folder+id, or the one whose tree holds `pid`. Anything else: refused. */
  async stop(target: { folder?: string; id?: string; pid?: number }): Promise<ManagedRecord> {
    const procs = await this.deps.procs()
    const records = this.list()
    let rec: ManagedRecord | undefined
    if (target.folder && target.id) rec = records.find((r) => r.key === `${folderKey(target.folder!)}|${target.id}`)
    else if (typeof target.pid === 'number') rec = records.find((r) => ownedBy(r, target.pid!, procs))
    if (!rec) throw new StopRefused('not started by Desk')
    if (!ownedBy(rec, rec.pid, procs)) {
      // Gone, or the pid now belongs to another process: never kill it, forget the record.
      this.save(records.filter((r) => r.key !== rec!.key))
      throw new StopRefused(`not started by Desk (pid ${rec.pid} is no longer the process Desk started)`)
    }
    this.deps.kill(rec.pid)
    this.save(this.list().filter((r) => r.key !== rec!.key))
    return rec
  }

  /** The last `lines` lines of a record's log. */
  tail(rec: Pick<ManagedRecord, 'log'>, lines = 80): string[] {
    try {
      const text = readFileSync(rec.log, 'utf8')
      return text.slice(-64 * 1024).split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1).slice(-lines)
    } catch {
      return []
    }
  }
}
