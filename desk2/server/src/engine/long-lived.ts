// Background tasks that never finish by themselves, like a local server. A chat whose turn ended with
// other background work running is still working (the work wakes it when it ends), so its sidebar dot
// stays orange; these would hold it orange forever, so they do not count (Jacob, 2026-10-04). The list
// holds one pattern per long-lived kind of task; when another kind keeps a finished chat orange, its
// pattern is added here. Each pattern is tried on the task's command and on its description.
import type { TranscriptItem } from '@shared/protocol'

type TaskItem = Extract<TranscriptItem, { kind: 'task' }>

export const LONG_LIVED: RegExp[] = [
  // Anything serving on this machine: localhost:5173, 127.0.0.1:8000, "local host"
  /\blocal\s?host\b|\b127\.0\.0\.1\b/i,
]

/** True when the task is a kind that never ends by itself, so it must not keep its chat looking busy. */
export function isLongLived(task: Pick<TaskItem, 'command' | 'description'>): boolean {
  const texts = [task.command ?? '', task.description ?? ''].filter(Boolean)
  return texts.some((t) => LONG_LIVED.some((re) => re.test(t)))
}
