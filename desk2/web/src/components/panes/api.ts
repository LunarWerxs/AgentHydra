// The REST calls the panes and the accounts popover make. Components read them through
// usePaneApi(), so the gallery can provide fixture answers (provide(PANE_API, ...)) without a server.
import { inject, type InjectionKey } from 'vue'
import type {
  AccountInfo,
  AccountRef,
  DeskSettings,
  GitStatus,
  ModelChoice,
  TranscriptItem
} from '@shared/protocol'
import type { BabysitterStatus } from '@shared/babysitter'
import type { OrchestratorModelStatus } from '@shared/orchestrator'
import type { FreeSettings } from '@shared/free-instances'

export interface PaneApi {
  gitStatus(cwd: string): Promise<GitStatus>
  gitDiff(cwd: string, path: string): Promise<string>
  models(): Promise<ModelChoice[]>
  health(): Promise<{ ok: boolean; version: string }>
  bridgeStatus(): Promise<{ up: boolean; url: string }>
  /** GET /api/babysitter: the chats a usage limit stopped and what the babysitter did (plugins/72-babysitter.ts). */
  babysitter(): Promise<BabysitterStatus>
  /** GET /api/orchestrator/model: the model the orchestrator's judge asks, and what the SDK reported it resolves to. */
  orchestratorModel(): Promise<OrchestratorModelStatus>
  getSettings(): Promise<DeskSettings>
  putSettings(patch: Partial<DeskSettings>): Promise<DeskSettings>
  accounts(): Promise<AccountInfo[]>
  pickAccount(): Promise<AccountRef>
  externalItems(sessionId: string): Promise<TranscriptItem[]>
  /** GET /api/diagnostics/<name>?<params>: every Diagnostics section reads its data through this; with `body`, a
   *  POST of it (the orchestrator's Arm). */
  diagnostics<T>(name: string, params?: Record<string, string | number | undefined>, body?: unknown): Promise<T>
  /** AgentHydra's own API through Desk's /ah/api proxy (its settings in this dialog, agenthydra.ts). */
  agentHydra<T>(path: string, init?: RequestInit): Promise<T>
  /** GET /api/free/settings: the Free table's keepalive (Settings > Instances > Free, instances.ts). */
  freeSettings(): Promise<FreeSettings>
  /** PATCH /api/free/settings with what changed; answers the saved settings. */
  patchFreeSettings(patch: Partial<FreeSettings>): Promise<FreeSettings>
}

async function json<T>(path: string, init?: RequestInit, base = '/api'): Promise<T> {
  const res = await fetch(base + path, init)
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

export const httpPaneApi: PaneApi = {
  gitStatus: (cwd) => json(`/git?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: async (cwd, path) =>
    (await json<{ diff: string }>(`/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)).diff,
  models: () => json('/models'),
  health: () => json('/health'),
  bridgeStatus: () => json('/bridge/status'),
  babysitter: () => json('/babysitter'),
  orchestratorModel: () => json('/orchestrator/model'),
  getSettings: () => json('/settings'),
  putSettings: (patch) =>
    json('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  accounts: () => json('/accounts'),
  pickAccount: () => json('/accounts/pick'),
  externalItems: (sessionId) => json(`/external/sessions/${encodeURIComponent(sessionId)}/items`),
  diagnostics: (name, params = {}, body) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
    const init = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    return json(`/diagnostics/${encodeURIComponent(name)}${q.size ? `?${q}` : ''}`, init)
  },
  agentHydra: (path, init) =>
    json(path, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } } : init, '/ah/api'),
  freeSettings: () => json('/free/settings'),
  patchFreeSettings: (patch) =>
    json('/free/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
}

export const PANE_API: InjectionKey<PaneApi> = Symbol('paneApi')

export function usePaneApi(): PaneApi {
  return inject(PANE_API, httpPaneApi)
}
