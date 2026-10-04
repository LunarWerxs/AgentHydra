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

export interface PaneApi {
  gitStatus(cwd: string): Promise<GitStatus>
  gitDiff(cwd: string, path: string): Promise<string>
  models(): Promise<ModelChoice[]>
  health(): Promise<{ ok: boolean; version: string }>
  bridgeStatus(): Promise<{ up: boolean; url: string }>
  getSettings(): Promise<DeskSettings>
  putSettings(patch: Partial<DeskSettings>): Promise<DeskSettings>
  accounts(): Promise<AccountInfo[]>
  pickAccount(): Promise<AccountRef>
  externalItems(sessionId: string): Promise<TranscriptItem[]>
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

export const httpPaneApi: PaneApi = {
  gitStatus: (cwd) => json(`/git?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: async (cwd, path) =>
    (await json<{ diff: string }>(`/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)).diff,
  models: () => json('/models'),
  health: () => json('/health'),
  bridgeStatus: () => json('/bridge/status'),
  getSettings: () => json('/settings'),
  putSettings: (patch) =>
    json('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }),
  accounts: () => json('/accounts'),
  pickAccount: () => json('/accounts/pick'),
  externalItems: (sessionId) => json(`/external/sessions/${encodeURIComponent(sessionId)}/items`)
}

export const PANE_API: InjectionKey<PaneApi> = Symbol('paneApi')

export function usePaneApi(): PaneApi {
  return inject(PANE_API, httpPaneApi)
}
