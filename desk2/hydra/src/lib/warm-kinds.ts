// Hydra Desk 2: what each kind of warm data (lib/warm-data.ts) refreshes. Every entry calls the
// shared store's own refresh function, so the pages and the background read the same copy. Imported
// once by App.vue.
import { useAnalyticsData } from '@/composables/useAnalyticsData'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCliInstances } from '@/composables/useCliInstances'
import { useCliMayteData } from '@/composables/useCliMayteData'
import { useFreeInstances } from '@/composables/useFreeInstances'
import { useCodexInstances } from '@/composables/useCodexInstances'
import { useDshInstances } from '@/composables/useDshInstances'
import { useInstances } from '@/composables/useInstances'
import { refreshDesktopAccountTokens } from '@/composables/useTokenWindow'
import { useUsage } from '@/composables/useUsage'
import { useHswarmApi } from '@/lib/hswarm-api'
import { refreshRouting } from '@/lib/routing-cost'
import { acquirePoll, fetchKitUsage, kitQueryString } from '@/lib/kit'
import { loadStats, statsKey } from '@/lib/swarm-stats'
import { registerWarm, startWarm, viewOnScreen } from '@/lib/warm-data'

const settled = (jobs: Promise<unknown>[]) => Promise.allSettled(jobs)

const { codexDesktopEnabled, codexCliEnabled, dshEnabled } = useAppSettings()

// CLI instances (Claude and Codex), their usage and the Dsh homes.
registerWarm('cli', () =>
  settled([
    useCliInstances().refreshCliInstances({ silent: true }),
    // A provider switched off in Settings has no rows to fill.
    ...(codexDesktopEnabled.value || codexCliEnabled.value ? [useCodexInstances().refresh({ silent: true })] : []),
    ...(dshEnabled.value ? [useDshInstances().refresh()] : []),
    useUsage().hydrate(true),
  ]),
)

// Desktop instances, their usage and per-account tokens. Identities are resolved in full (the profile
// calls) only while the Instances tab is on screen; any other moment reads them from the cache.
registerWarm('desktop', () =>
  settled([
    useInstances().refreshInstances({ silent: true, resolve: viewOnScreen() === 'instances' ? 'full' : 'cache' }),
    useUsage().hydrate(true),
    refreshDesktopAccountTokens(),
  ]),
)

registerWarm('analytics', () => useAnalyticsData().loadAnalytics(true))

registerWarm('hswarm', () => useHswarmApi().refreshHswarm())

registerWarm('routing', () => refreshRouting())

registerWarm('climayte', () => useCliMayteData().refreshCliMayte({ silent: true }))

// Free logins and their private chats' metadata (Desk's own /api/free, not the daemon).
registerWarm('free', () => useFreeInstances().refreshFree({ silent: true }))

// The HSwarm savings feed and CliMayte's all-time tokens are shared 2-minute polls (lib/kit.ts
// acquirePoll, one per key, none while the document is hidden). Holding one for the life of the window
// keeps them filled between visits instead of starting cold when a card mounts.
const KIT_CLIMAYTE = { source: 'climayte', last: 'all', measures: 'tokens' } as const
function holdKitPolls(): void {
  acquirePoll(statsKey(14), () => loadStats(14))
  acquirePoll(`kit:${kitQueryString(KIT_CLIMAYTE)}`, () => fetchKitUsage(KIT_CLIMAYTE))
}

/** After the window's first paint: the first load of every kind, then the 2-minute cycle. */
export function startWarmData(): void {
  holdKitPolls()
  startWarm()
}
