// DeepSeek Harness instances: one DSH_HOME per entry, shared by everything that shows them.
//
// Module state, like useCodexInstances: the rows in the combined Instances table and anything else
// that counts or filters DeepSeek homes read the SAME list, so they cannot disagree and one poll
// serves them all.
import { ref, shallowRef } from 'vue'
import { type DshInstance, listDshInstances } from '@/lib/api'
import { reconcileList } from '@/lib/reconcile'

const instances = shallowRef<DshInstance[]>([])
/** True until the first read settles, so a table can show skeletons rather than "none found". */
const loading = ref(true)

async function refresh(): Promise<void> {
  try {
    // Reconciled, so a poll that brings nothing new redraws nothing.
    instances.value = reconcileList(instances.value, await listDshInstances(), (i) => i.id)
  } catch {
    // A failed poll leaves the last good list on screen: a table that empties itself on one dropped
    // request reads as "your instances are gone".
  } finally {
    loading.value = false
  }
}

/** The first load when a table opens; later refreshes are lib/warm-data.ts's. */
function startPolling(): void {
  void refresh()
}

export function useDshInstances() {
  return { instances, loading, refresh, startPolling }
}
