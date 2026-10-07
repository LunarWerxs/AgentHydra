import type { FreeInstance, FreeJob, FreeResult, FreeProvider, FreeRequest, FreeSettings, FreeStatus, FreeThread, FreeUsage } from '@desk/shared/free-instances'
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
  remove: (id: string) => request<{ ok: true }>(`instances/${encodeURIComponent(id)}`, 'DELETE'),
  settings: () => request<FreeSettings>('settings'),
  updateSettings: (patch: Partial<FreeSettings>) => request<FreeSettings>('settings', 'PATCH', patch),
  threads: () => request<FreeThread[]>('threads'),
  forgetThread: (id: string) => request<{ ok: true }>(`threads/${encodeURIComponent(id)}`, 'DELETE'),
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

export type FreeVerdict = { state: 'alive' | 'dead' | 'unknown'; text: string; reason: string }

/** What a hand-started check says in one line (owner, 2026-10-07: "It just spun, and then it stopped"). `auth` is the
 *  login check's result (null when the request itself failed, then `error` says why), `usage` the latest reading. A
 *  login the provider answered "not signed in" is dead; no answer at all is unknown, never dead. */
export function freeCheckVerdict(
  who: string,
  auth: FreeResult | null,
  usage: FreeUsage | null | undefined,
  error: string,
  t: (key: string, params?: Record<string, unknown>) => string,
): FreeVerdict {
  const reason = auth?.error?.message || error
  if (auth?.ok && auth.authenticated) {
    const snap = freeUsageSnapshot(usage ?? null)
    const win = snap?.session ? 'verdictFiveHour' : 'verdictWeek'
    const used = snap?.session?.pct ?? snap?.weekAll?.pct
    const text = used == null
      ? t('freeInstances.verdictAlive', { who })
      : t('freeInstances.verdictAliveUsage', { who, left: Math.max(0, Math.round(100 - used)), window: t(`freeInstances.${win}`) })
    return { state: 'alive', text, reason: '' }
  }
  if (auth && auth.authenticated === false) {
    return { state: 'dead', text: t(reason ? 'freeInstances.verdictDeadWhy' : 'freeInstances.verdictDead', { who, reason }), reason }
  }
  const why = reason || t('freeInstances.verdictNoAnswer')
  return { state: 'unknown', text: t('freeInstances.verdictUnknown', { who, reason: why }), reason: why }
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
