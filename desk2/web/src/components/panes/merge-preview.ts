// The Changes pane's one line about merging the base in (GET /api/git/merge-conflicts). Its own helper so the
// wording and the fetch sit apart from the pane's markup; the pane shows nothing when this has no line.
import type { MergeConflictPreview } from '@shared/protocol'

/** The line to show, or null when the preview has nothing to warn about. Only a conflict earns a line: work on
 *  main sits a commit or two from origin/main most of the time, and "merges cleanly" there would be on every pane. */
export function mergePreviewLine(p: MergeConflictPreview): string | null {
  if (p.state !== 'conflicts' || !p.base) return null
  const n = p.files.length
  return `Merging ${p.base} would conflict in ${n} ${n === 1 ? 'file' : 'files'}: ${p.files.join(', ')}`
}

/** The preview for a folder, or null when the server cannot answer; a pane line is never worth an error. */
export async function loadMergePreview(cwd: string): Promise<MergeConflictPreview | null> {
  try {
    const res = await fetch(`/api/git/merge-conflicts?cwd=${encodeURIComponent(cwd)}`)
    return res.ok ? ((await res.json()) as MergeConflictPreview) : null
  } catch {
    return null
  }
}
