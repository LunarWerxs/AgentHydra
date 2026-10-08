import type { FreeStatRow } from '@desk/shared/free-instances'
import { ref, shallowRef } from 'vue'
import { freeApi } from '@/lib/free-instances'

/** The days the Usage history card shows of Desk's daily Free record (server/src/free-instances/stats.ts). */
export const FREE_STAT_DAYS = 14

// One copy for the card's header and its open body. A read is one small local file, so it is asked again whenever an
// account's numbers move (useFreeInstances' poll), never on a timer of its own.
const rows = shallowRef<FreeStatRow[] | null>(null)
const failed = ref(false)
let reading: Promise<void> | null = null

export function refreshFreeStats(): Promise<void> {
  reading ??= freeApi.stats(FREE_STAT_DAYS)
    .then((next) => { if (JSON.stringify(next) !== JSON.stringify(rows.value)) rows.value = next; failed.value = false })
    .catch(() => { failed.value = rows.value === null })
    .finally(() => { reading = null })
  return reading
}

export const useFreeStats = () => ({ rows, failed })
