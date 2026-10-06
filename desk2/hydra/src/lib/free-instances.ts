import type { FreeInstance, FreeJob, FreeProvider, FreeRequest, FreeStatus, FreeThread, FreeUsage } from '@desk/shared/free-instances'
import { ref } from 'vue'
import type { LogoProvider } from '@/components/ProviderLogo.vue'
import type { UsageLimit, UsageSnapshot } from '@/lib/api'

/** App shows HSwarm → CliMayte; its task view consumes this request. */
export const freeThreadAsk = ref<{ instanceId: string; chatId?: string } | null>(null)
export function openFreeThread(instanceId: string, chatId?: string): void { freeThreadAsk.value = { instanceId, chatId } }

export class FreeApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

/** Desk's own API; /ah/api is the separate Desktop/CLI daemon. Never retry a POST. */
async function request<T>(path: string, method = 'GET', body?: unknown, timeout = 15_000): Promise<T> {
  const response = await fetch(`/api/free/${path}`, {
    method, cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const value = await response.json()
  if (!response.ok) throw new FreeApiError(value.error || `Request failed (${response.status})`, response.status)
  return value as T
}

export const freeApi = {
  status: () => request<FreeStatus>('status'),
  create: (provider: FreeProvider) => request<FreeInstance>('instances', 'POST', { provider }),
  rename: (id: string, name: string) => request<FreeInstance>(`instances/${encodeURIComponent(id)}`, 'PATCH', { name }),
  // The server may first set up the runtime and stop a live ChatGPT worker (its forget waits up to 4 minutes).
  logout: (id: string) => request<FreeInstance>(`instances/${encodeURIComponent(id)}/logout`, 'POST', undefined, 300_000),
  threads: () => request<FreeThread[]>('threads'),
  start: (operation: FreeRequest) => request<FreeJob>('jobs', 'POST', operation),
  job: (id: string) => request<FreeJob>(`jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<{ ok: true }>(`jobs/${encodeURIComponent(id)}`, 'DELETE'),
}

/** A Free reading as the snapshot every instance table's usage cells draw (UsageBadge, UsageBar):
 *  the harness's `five_hour` window is the 5-hour one, `seven_day` the weekly one. Null when the
 *  provider exposed neither, so the cell offers a check instead of a number. */
export function freeUsageSnapshot(usage: FreeUsage | null): UsageSnapshot | null {
  if (!usage) return null
  const limit = (prefix: string): UsageLimit | null => {
    const w = usage.windows.find(x => x.id === prefix) ?? usage.windows.find(x => x.id.startsWith(prefix))
    const pct = w?.used_percent ?? (w?.remaining_percent == null ? null : 100 - w.remaining_percent)
    if (!w || pct == null) return null
    const at = w.resets_at ? new Date(w.resets_at) : null
    return { pct, resetsAt: w.resets_at, resets: at ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '' }
  }
  const session = limit('five_hour')
  const weekAll = limit('seven_day')
  if (!session && !weekAll) return null
  return { account: null, session, weekAll, weekModel: null, capturedAt: usage.observed_at ?? new Date().toISOString() }
}

/** The provider's mark on a Free row (ProviderLogo). */
export const freeLogo = (provider: FreeProvider): LogoProvider => (provider === 'claude' ? 'claude' : 'chatgpt')

/** Storage contains only a job UUID, never prompts, replies or credentials. */
export function rememberedJob(instanceId: string, id?: string | null): string | null {
  try {
    const key = `hydra.free.job.${instanceId}`
    if (id === null) sessionStorage.removeItem(key)
    else if (id !== undefined) sessionStorage.setItem(key, id)
    return sessionStorage.getItem(key)
  } catch { return null }
}
