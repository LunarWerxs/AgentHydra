// The servers pane's decisions, pure so the tests and the component share them: what the pane shows for the
// daemon's status and the project list, a server's dot, the address bar's input, and the pane's width.
import { type DevWebProcess, type DevWebProcessStatus, type DevWebProject, type DevWebStatus, projectForCwd } from '@shared/devwebui'

/** What the pane draws. */
export type PaneView =
  | { kind: 'loading' }
  /** /dw/status answered 404: the live Desk 2 server was started before the route existed. */
  | { kind: 'restart-desk' }
  | { kind: 'starting' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }
  /** The daemon runs but its project list could not be read. */
  | { kind: 'unreachable'; reason: string }
  | { kind: 'not-a-project' }
  | { kind: 'project'; project: DevWebProject }

export interface PaneInput {
  /** null until the first answer. */
  status: DevWebStatus | null
  statusMissing: boolean
  /** null until a daemon answered the list; undefined = not asked yet. */
  projects: DevWebProject[] | null
  projectsError: string | null
  cwd: string
}

export function paneView(i: PaneInput): PaneView {
  if (i.statusMissing) return { kind: 'restart-desk' }
  if (!i.status) return { kind: 'loading' }
  if (i.status.state === 'starting') return { kind: 'starting' }
  if (i.status.state === 'failed') return { kind: 'failed', reason: i.status.reason ?? 'it did not start' }
  if (i.status.state === 'stopped') return { kind: 'stopped' }
  if (i.projectsError) return { kind: 'unreachable', reason: i.projectsError }
  if (!i.projects) return { kind: 'loading' }
  const project = projectForCwd(i.projects, i.cwd)
  return project ? { kind: 'project', project } : { kind: 'not-a-project' }
}

export type Dot = 'run' | 'wait' | 'bad' | 'off'

export function statusDot(s: DevWebProcessStatus): Dot {
  if (s === 'running') return 'run'
  if (s === 'starting' || s === 'waiting' || s === 'stopping') return 'wait'
  if (s === 'crashed') return 'bad'
  return 'off'
}

export const statusWord = (p: Pick<DevWebProcess, 'status' | 'exitCode'>): string =>
  p.status === 'crashed' && p.exitCode !== null ? `crashed (exit ${p.exitCode})` : p.status

/** A server that is up or coming up is stopped by its button; one that is not is started by it. */
export const isUp = (s: DevWebProcessStatus): boolean => s === 'running' || s === 'starting' || s === 'waiting'

/** The last `n` non-empty lines, for a server that failed. */
export function tailLines(lines: { line: string }[], n = 6): string[] {
  return lines
    .map((l) => l.line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
}

/** What the address bar's text means: a full address, a bare host[:port][/path], or a bare port; null when neither. */
export function parseAddress(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}/`
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** DevWebUI's own address for a server, for when the page refuses to be framed straight. */
export function proxyAddress(daemonUrl: string, proc: Pick<DevWebProcess, 'id'>): string {
  return `${daemonUrl.replace(/\/+$/, '')}/proxy/${proc.id}/`
}

export const PANE_MIN = 420
export const PANE_MAX = 900
export const PANE_DEFAULT = 520
export const PANE_KEY = 'hydra-desk.servers.width'

export const clampPane = (w: number, room = Number.POSITIVE_INFINITY): number => Math.round(Math.min(Math.max(w, PANE_MIN), Math.min(PANE_MAX, Math.max(PANE_MIN, room))))

export function loadPaneWidth(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): number {
  const n = Number(storage?.getItem(PANE_KEY))
  return n >= PANE_MIN && n <= PANE_MAX ? n : PANE_DEFAULT
}
