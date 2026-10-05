// DeepSeek Harness instances: one DSH_HOME per entry, shared by everything that shows them.
//
// Module state, like useCodexInstances: the rows in the combined Instances table and anything else
// that counts or filters DeepSeek homes read the SAME list, so they cannot disagree and one poll
// serves them all.
import { ref } from 'vue'
import { type DshInstance, listDshInstances } from '@/lib/api'
import { reconcileList } from '@/lib/reconcile'
import { visibleInterval } from '@/lib/visible-poll'

const instances = ref<DshInstance[]>([])
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

// Reference-counted: every caller that starts polling stops it again, and the timer runs while at
// least one of them is mounted, so two views on screen share one timer instead of doubling it.
let stopPoll: (() => void) | null = null
let pollers = 0

function startPolling(): void {
  pollers++
  if (stopPoll) return
  void refresh()
  // Slow on purpose: nothing here changes without a person doing something, and the only live fact
  // (is a server up) costs a connect probe per home.
  stopPoll = visibleInterval(() => void refresh(), 15_000)
}

function stopPolling(): void {
  pollers = Math.max(0, pollers - 1)
  if (pollers > 0 || !stopPoll) return
  stopPoll()
  stopPoll = null
}

export function useDshInstances() {
  return { instances, loading, refresh, startPolling, stopPolling }
}
