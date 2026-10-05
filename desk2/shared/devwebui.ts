// The servers pane's contract: what GET /dw/status answers, the slice of DevWebUI's own shapes the pane reads
// (from ../devwebui/shared/dto.ts, which is its own project and not imported), and the one rule both sides share:
// which DevWebUI project belongs to a chat's folder. /dw/api/* is DevWebUI's REST API passed on as it is.

export const DW_BASE = '/dw'
export const DW_API = `${DW_BASE}/api`
export const DW_STATUS = `${DW_BASE}/status`

/** running: a daemon answers. starting: Desk 2 is bringing one up. stopped: none answers and none was asked for. */
export type DevWebState = 'running' | 'starting' | 'stopped' | 'failed'

export interface DevWebStatus {
  state: DevWebState
  /** The daemon's address while it answers (and after, for the last one seen); never carries a credential. */
  url: string | null
  /** Why it failed: the last line of what it printed, or what went wrong before it could print. */
  reason?: string
}

export type DevWebProcessStatus = 'stopped' | 'starting' | 'waiting' | 'running' | 'stopping' | 'crashed'

export interface DevWebProcess {
  id: string
  name: string
  command: string
  cwd: string
  port?: number
  url?: string
  status: DevWebProcessStatus
  exitCode: number | null
  projectId: string
}

export interface DevWebProject {
  id: string
  name: string
  /** The .devwebui file, absolute. */
  path: string
  processes: DevWebProcess[]
}

export interface DevWebLogLine {
  stream: 'stdout' | 'stderr'
  line: string
  ts: number
}

const sepNormalised = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()

/** Folder of a DevWebUI project: where its .devwebui file lives. */
export function projectDir(project: Pick<DevWebProject, 'path'>): string {
  const p = project.path.replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return cut > 0 ? p.slice(0, cut) : p
}

/** True when `inner` is `outer` or inside it. Windows paths: case-insensitive, either slash. */
export function folderContains(outer: string, inner: string): boolean {
  const o = sepNormalised(outer)
  const i = sepNormalised(inner)
  if (o === '') return false
  return i === o || i.startsWith(`${o}/`)
}

/** The project a chat in `cwd` belongs to: the one whose folder is the cwd, else the deepest one containing it. */
export function projectForCwd(projects: DevWebProject[], cwd: string): DevWebProject | null {
  let best: DevWebProject | null = null
  let bestLen = -1
  for (const p of projects) {
    const dir = projectDir(p)
    if (!folderContains(dir, cwd)) continue
    const len = sepNormalised(dir).length
    if (len > bestLen) {
      best = p
      bestLen = len
    }
  }
  return best
}

/** The address a running server answers on, or null when it has no port or url. */
export function processAddress(proc: Pick<DevWebProcess, 'port' | 'url'>): string | null {
  if (proc.url && /^https?:\/\//i.test(proc.url)) return proc.url
  if (proc.port) return `http://localhost:${proc.port}${proc.url?.startsWith('/') ? proc.url : ''}`
  return null
}
