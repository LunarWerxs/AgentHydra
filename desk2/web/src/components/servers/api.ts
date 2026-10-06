// The calls the servers pane makes: Desk 2's /dw/status, /dw/start and /dw/folder, and DevWebUI's own API behind /dw/api.
import { BROWSER_CLOSE, BROWSER_OPEN, BROWSER_PROFILES, type BrowserOpened, type BrowserProfiles } from '@shared/browser'
import { DW_API, DW_BASE, DW_FOLDER, DW_STATUS, type DevWebFolder, type DevWebLogLine, type DevWebProject, type DevWebStatus } from '@shared/devwebui'

/** Thrown when /dw/status is not there: a Desk 2 server started before the route existed. */
export class RouteMissing extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || `${res.status} ${res.statusText}`)
  }
  return body as T
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export async function devwebStatus(): Promise<DevWebStatus> {
  const res = await fetch(DW_STATUS)
  // The server answers /api/* it does not know with JSON 404, and the built window for any other path:
  // either way a missing route reads as "restart".
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) throw new RouteMissing()
  return (await res.json()) as DevWebStatus
}

export const devwebStart = (): Promise<DevWebStatus> => call(`${DW_BASE}/start`, post())

export const listProjects = (): Promise<DevWebProject[]> => call(`${DW_API}/projects`)

export function processAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<unknown> {
  return call(`${DW_API}/processes/${encodeURIComponent(id)}/${action}`, post())
}

export function projectAction(id: string, action: 'start' | 'stop'): Promise<unknown> {
  return call(`${DW_API}/projects/${encodeURIComponent(id)}/${action}`, post())
}

export async function processLogs(id: string): Promise<DevWebLogLine[]> {
  return (await call<{ lines: DevWebLogLine[] }>(`${DW_API}/processes/${encodeURIComponent(id)}/logs`)).lines
}

/** The chat folder's project, set up in the server manager when it is not yet (no Add step). */
export const setUpFolder = (cwd: string): Promise<DevWebFolder> => call(DW_FOLDER, post({ cwd }))

// ---- saved browsers (shared/browser.ts) ----
export const browserProfiles = (cwd: string): Promise<BrowserProfiles> => call(`${BROWSER_PROFILES}?${new URLSearchParams({ cwd })}`)

export const browserClose = (cwd: string, profile: string): Promise<{ closed: boolean }> => call(BROWSER_CLOSE, post({ cwd, profile }))

export const browserOpen = (cwd: string, profile: string, opts: { url?: string; login?: boolean } = {}): Promise<BrowserOpened> => call(BROWSER_OPEN, post({ cwd, profile, ...opts }))
