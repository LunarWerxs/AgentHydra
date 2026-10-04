// Client for the analytics toolkit's usage query (server/src/kit/query.ts, GET /api/kit/usage).

export type KitUsageRow = Record<string, string | number | null>

export interface KitUsageResult {
  rows: KitUsageRow[]
  totals: Record<string, number | null>
  coverage: { sources: Record<string, { events: number; firstTs: number; lastTs: number }> }
}

export type KitUsageQuery = Record<string, string | number | string[] | undefined>

export async function fetchKitUsage(query: KitUsageQuery): Promise<KitUsageResult> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) qs.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const response = await fetch(`/api/kit/usage?${qs}`)
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error ?? `kit usage ${response.status}`)
  return body as KitUsageResult
}

const DAY_MS = 86_400_000

/** Epoch ms of local midnight `days - 1` days back: a window of `days` calendar days ending now. */
export function localDaysFrom(days: number, now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return d.getTime()
}

/** `days` rolling days ending now. */
export const rollingDaysFrom = (days: number, now = Date.now()): number => now - days * DAY_MS

export const localTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
