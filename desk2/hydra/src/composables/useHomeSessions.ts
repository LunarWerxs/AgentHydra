// The Instances landing page's session list (every source, archived hidden, last 24 hours): one shared
// copy, refreshed by lib/warm-data.ts and when the page opens. Not the sidebar list in useData.ts,
// which follows the filters the sidebar picked.
import { shallowRef } from 'vue'
import { getSessions } from '@/lib/api'

// The page only reads each session's last activity, so that is all that is kept. Replaced whole, and
// only when it changed, so a refresh with nothing new redraws nothing.
const sessionTimes = shallowRef<number[]>([])

async function refreshHomeSessions(): Promise<void> {
  const times = (await getSessions(1000, '', 'hide', '24h')).map((s) => s.last_activity_at)
  const old = sessionTimes.value
  if (times.length !== old.length || times.some((x, i) => x !== old[i])) sessionTimes.value = times
}

export function useHomeSessions() {
  return { sessionTimes, refreshHomeSessions }
}
