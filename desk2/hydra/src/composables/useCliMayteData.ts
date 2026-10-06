// CliMayte's data, one shared copy: the tab only reads it. lib/warm-data.ts keeps it fresh in the
// background (about every 2 minutes) and the tab asks again when it opens. Module scope, so the list
// is already there when the tab is first opened.
import { computed, ref, shallowRef } from 'vue'
import type { CliMayteRemotePc, CliMayteScorecard, CliMayteTotals, CliMayteWave, CliMayteWorkerView } from '@/lib/api'
import {
  getCliMayteRemote,
  getCliMayteScorecard,
  getCliMayteTotals,
  listCliMayteWaves,
  listCliMayteWorkers,
} from '@/lib/api'
import { reconcileList, sameData } from '@/lib/reconcile'
import { climayteRunningCount, isCliMayteActive } from '@/lib/climayte-status'

// Replaced whole by a read that brought a change (reconcileList), never edited in place, so Vue does
// not wrap every row in a proxy.
const workers = shallowRef<CliMayteWorkerView[]>([])
/** The finished tasks the list asks for (the daemon keeps every active one regardless): a busy queue
 *  is thousands of tasks. "Show older" asks for every one. */
const FINISHED_PAGE = 150
const finishedLimit = ref<number | undefined>(FINISHED_PAGE)
/** The list may hold more finished tasks than were read. */
const hasOlder = computed(
  () =>
    finishedLimit.value !== undefined &&
    workers.value.reduce((n, w) => n + (isCliMayteActive(w) ? 0 : 1), 0) >= finishedLimit.value,
)
/** Asks for every finished task from now on; the caller reads again. */
function showOlder(): void {
  finishedLimit.value = undefined
}
/** The other PCs' queue (GET /api/corch/remote); null before it was read or when the route is missing. */
const remote = shallowRef<{ enabled: boolean; pcs: CliMayteRemotePc[] } | null>(null)
/** The running count both the page's Running filter and the tree's node show (both PCs when sharing is on). */
const runningCount = computed(() => climayteRunningCount(workers.value, remote.value))
/** What CliMayte has offloaded so far. */
const totals = ref<CliMayteTotals | null>(null)
/** What passed per kind of task (GET /api/corch/scorecard); shown in the stats card. */
const scorecard = ref<CliMayteScorecard | null>(null)
/** Manager waves (GET /api/corch/waves; none when the route is missing). */
const waves = ref<CliMayteWave[]>([])
const loading = ref(false)
const loaded = ref(false)
/** The last read failed. Before anything loaded that is an error state; after, a banner over the last list. */
const unreachable = ref(false)
/** When the list was last read: a running task's `ranS` keeps growing from there until the next read. */
const listedAt = ref(Date.now())

// The totals, the scorecard, the other PCs' queue and the waves move slowly: a read that is not the
// user's own (refresh button) or the background cycle leaves them out when they are newer than this.
const SIDE_MS = 30_000
let sideAt = 0

let inflight: Promise<void> | null = null
/** The finished-task limit the running read asked for. */
let inflightLimit: number | undefined

/** One read at a time: an overlapping ask shares the running one, unless the limit changed since it
 *  started ("Show older"), which reads again once it is done. */
function refreshCliMayte(opts: { silent?: boolean; side?: boolean } = {}): Promise<void> {
  if (inflight) {
    if (inflightLimit === finishedLimit.value) return inflight
    return inflight.then(() => refreshCliMayte(opts))
  }
  inflightLimit = finishedLimit.value
  inflight = readCliMayte(opts).finally(() => {
    inflight = null
  })
  return inflight
}

async function readCliMayte(opts: { silent?: boolean; side?: boolean }): Promise<void> {
  if (!opts.silent) loading.value = true
  try {
    // The scorecard and the other PCs' queue are extra: a failed read keeps the last one and never
    // marks CliMayte unreachable.
    const side = !opts.silent || opts.side === true || Date.now() - sideAt >= SIDE_MS
    const [list, sums, score, rem, waveList] = await Promise.all([
      listCliMayteWorkers({ limit: finishedLimit.value }),
      side ? getCliMayteTotals() : null,
      side ? getCliMayteScorecard().catch(() => null) : null,
      side ? getCliMayteRemote().catch(() => null) : null,
      side ? listCliMayteWaves() : null,
    ])
    if (side) sideAt = Date.now()
    if (waveList && !sameData(waves.value, waveList)) waves.value = waveList
    workers.value = reconcileList(workers.value, list, (w) => w.id)
    if (rem && !sameData(remote.value, rem)) remote.value = rem
    if (sums && !sameData(totals.value, sums)) totals.value = sums
    if (score && !sameData(scorecard.value, score)) scorecard.value = score
    unreachable.value = false
    listedAt.value = Date.now()
    loaded.value = true
  } catch {
    unreachable.value = true
  } finally {
    if (!opts.silent) loading.value = false
  }
}

export function useCliMayteData() {
  return { workers, finishedLimit, hasOlder, showOlder, remote, runningCount, totals, scorecard, waves, loading, loaded, unreachable, listedAt, refreshCliMayte }
}
