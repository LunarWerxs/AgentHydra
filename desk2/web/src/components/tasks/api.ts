// Opening the Background tasks panel from anywhere (the inline row, a workflow card): one window
// event the frame listens to, as the diff pane does.
import { ref, shallowRef } from 'vue'
import type { TranscriptItem } from '@shared/protocol'
import { loadDismissed, saveDismissed } from '@/components/climayte/dock'

/** The transcript of the outside session on view, published by ExternalSessionView for the Background tasks panel. */
export const outsideTasks = shallowRef<{ sessionId: string; items: TranscriptItem[] } | null>(null)

export const OPEN_TASKS_EVENT = 'hydra-desk:open-background-tasks'

export interface OpenTasksDetail {
  /** A unit id ('group:<name>', 'worker:<id>', 'task:<item id>') or a bare worker or task id to bring into view. */
  taskId: string | null
}

export function openBackgroundTasks(taskId?: string | null): void {
  window.dispatchEvent(new CustomEvent<OpenTasksDetail>(OPEN_TASKS_EVENT, { detail: { taskId: taskId ?? null } }))
}

/** Finished workers and tasks cleared from view (the panel's trash), shared with the agents chip. */
export const cleared = ref<Set<string>>(loadDismissed())

export function clearFinished(keys: string[]): void {
  const next = new Set(cleared.value)
  for (const k of keys) next.add(k)
  cleared.value = next
  saveDismissed(next)
}
