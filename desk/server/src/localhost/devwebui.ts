// DevWebUI (github.com/LunarWerxs/DevWebUI): a daemon on :4000 that runs the dev servers declared in .devwebui
// files. When it answers, Desk shows its processes and routes start/stop/restart through its API
// (POST /api/processes/:id/:action) instead of starting anything itself. Its routes, from shared/routes.ts:
// GET /api/health -> { ok, service: 'devwebui' }, GET /api/processes -> ProcessView[],
// GET /api/processes/:id/logs -> { id, lines: LogLine[] }.

import type { DevWebUIStatus } from '@shared/protocol'

/** The fields of DevWebUI's ProcessView that Desk reads. */
export interface DevWebUIProcess {
  id: string
  localId: string
  name: string
  command: string
  cwd: string
  port?: number
  url?: string
  projectName: string
  status: string
  pid: number | null
  startedAt: number | null
  cpu: number | null
  memory: number | null
}

export type DevWebUIAction = 'start' | 'stop' | 'restart'

export const DEFAULT_DEVWEBUI_URL = 'http://127.0.0.1:4000'

export function devwebuiUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.DEVWEBUI_URL || DEFAULT_DEVWEBUI_URL).replace(/\/+$/, '')
}

async function call(url: string, init: RequestInit = {}, timeoutMs = 1500): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`
}

export class DevWebUI {
  constructor(readonly url: string = devwebuiUrl()) {}

  /** Is DevWebUI answering, and its process list when it is. */
  async read(): Promise<{ status: DevWebUIStatus; processes: DevWebUIProcess[] }> {
    const down = (error: string) => ({ status: { up: false, url: this.url, error, processes: 0 }, processes: [] })
    try {
      const health = await call(`${this.url}/api/health`, {}, 800)
      const h = (await health.json().catch(() => null)) as { ok?: boolean; service?: string } | null
      if (!health.ok || !h?.ok || h.service !== 'devwebui') return down('something else answers there')
    } catch {
      return down('not running')
    }
    try {
      const res = await call(`${this.url}/api/processes`)
      if (res.status === 401 || res.status === 403) return down('it requires sign-in (DEVWEBUI_REQUIRE_AUTH)')
      if (!res.ok) return down(await errorText(res))
      const list = (await res.json()) as unknown
      const processes = Array.isArray(list) ? (list as DevWebUIProcess[]).filter((p) => p && typeof p.id === 'string') : []
      return { status: { up: true, url: this.url, error: null, processes: processes.length }, processes }
    } catch (err) {
      return down((err as Error).message)
    }
  }

  async action(id: string, action: DevWebUIAction): Promise<void> {
    const res = await call(`${this.url}/api/processes/${encodeURIComponent(id)}/${action}`, { method: 'POST' }, 15000)
    if (!res.ok) throw new Error(`DevWebUI refused ${action}: ${await errorText(res)}`)
  }

  async logs(id: string, lines = 80): Promise<string[]> {
    const res = await call(`${this.url}/api/processes/${encodeURIComponent(id)}/logs`)
    if (!res.ok) throw new Error(`DevWebUI logs: ${await errorText(res)}`)
    const body = (await res.json()) as { lines?: { line?: string }[] }
    return (body.lines ?? []).map((l) => String(l.line ?? '')).slice(-lines)
  }
}
