// The globe button's REST calls (SPEC "Localhost"). Read through useLocalhostApi() so the gallery can
// provide fixture answers (provide(LOCALHOST_API, ...)) without a server.
import { inject, type InjectionKey } from 'vue'
import type { LocalhostLog, LocalhostState } from '@shared/protocol'

export interface LocalhostApi {
  state(folder: string | null, all?: boolean): Promise<LocalhostState>
  start(folder: string, id: string): Promise<unknown>
  stop(target: { folder?: string; id?: string; pid?: number }): Promise<unknown>
  restart(folder: string, id: string): Promise<unknown>
  log(folder: string, id: string): Promise<LocalhostLog>
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || text || `${res.status} ${res.statusText}`)
  }
  return body as T
}

const post = <T>(path: string, body: unknown) =>
  json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const httpLocalhostApi: LocalhostApi = {
  state: (folder, all) => {
    const q = new URLSearchParams()
    if (folder) q.set('folder', folder)
    if (all) q.set('all', '1')
    return json(`/localhost${q.size ? `?${q}` : ''}`)
  },
  start: (folder, id) => post('/localhost/start', { folder, id }),
  stop: (target) => post('/localhost/stop', target),
  restart: (folder, id) => post('/localhost/restart', { folder, id }),
  log: (folder, id) => json(`/localhost/log?folder=${encodeURIComponent(folder)}&id=${encodeURIComponent(id)}`)
}

export const LOCALHOST_API: InjectionKey<LocalhostApi> = Symbol('localhostApi')

export function useLocalhostApi(): LocalhostApi {
  return inject(LOCALHOST_API, httpLocalhostApi)
}
