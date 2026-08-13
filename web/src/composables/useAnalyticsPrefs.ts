// web/src/composables/useAnalyticsPrefs.ts — the analytics tab's own remembered window.
//
// Module scope and mirrored through the daemon, for the same two reasons every preference in
// useUiPrefs.ts is: a view behind a tab unmounts the moment you switch away (so a ref owned by the
// component stops being the mirrored one), and the daemon hops ports when its preferred one is
// busy, which gives the browser a fresh origin and an empty localStorage.
//
// Separate from useUiPrefs.ts rather than added to it because this one belongs to a view that is
// lazily rendered, and keeping its registration beside its own useStorage is what the shared-prefs
// contract asks for.

import { useStorage } from '@vueuse/core'
import type { SessionPeriod } from '@/lib/api'
import { registerSharedPref } from './useSharedPrefs'

const PERIODS: readonly SessionPeriod[] = ['24h', '7d', '30d', 'all']

/** 30 days by default: a week is too short to show a weekly rhythm, and "all" on a long-lived store
 *  buries this month under a year of history. */
const analyticsPeriod = useStorage<SessionPeriod>('agenthydra.analytics.period', '30d')
registerSharedPref('agenthydra.analytics.period', analyticsPeriod, PERIODS)

export function useAnalyticsPrefs() {
  return { analyticsPeriod }
}
