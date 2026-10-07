// A server's CPU and memory history for the info pane's charts: the service's last ~10 minutes of samples
// (GET processes/:id/metrics), read when the server's view opens and again with the client's poll, at most every
// 2.5 s (the service samples every 3 s). What it last read per server is kept, so picking a server again draws its
// chart at once instead of an empty one.
import { onBeforeUnmount, shallowRef, watch, type ShallowRef } from 'vue'
import type { DevWebMetricsHistory } from '@shared/devwebui'
import { processMetrics } from '../api'
import { useDevServers } from '../store'
import { memo } from './nav'

const seen = memo<DevWebMetricsHistory>()
const EVERY_MS = 2500

export function useMetrics(id: string): ShallowRef<DevWebMetricsHistory | null> {
  const servers = useDevServers()
  const data = shallowRef<DevWebMetricsHistory | null>(seen.get(id) ?? null)
  let at = 0
  let inflight = false
  let gone = false
  async function load(force = false) {
    if (inflight || gone || (!force && Date.now() - at < EVERY_MS)) return
    inflight = true
    at = Date.now()
    try {
      const h = await processMetrics(id, { start: false })
      if (gone) return
      data.value = h
      seen.set(id, h)
    } catch {
      // floor-ok: a missed read keeps the chart as it was; the next poll asks again
    } finally {
      inflight = false
    }
  }
  watch(servers.answered, () => void load())
  void load(true)
  onBeforeUnmount(() => (gone = true))
  return data
}
