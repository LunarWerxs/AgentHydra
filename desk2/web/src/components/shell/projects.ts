import type { ProjectEntry, ProjectGit } from '@shared/protocol'

/** The sync chip's words for a checkout's git state, or null when it is not a repo. */
export function syncLabel(git: ProjectGit | null): string | null {
  if (!git) return null
  const parts: string[] = []
  if (git.behind) parts.push(`${git.behind} behind`)
  if (git.ahead) parts.push(`${git.ahead} ahead`)
  if (git.dirty) parts.push(`${git.dirty} uncommitted`)
  return parts.length ? parts.join(' · ') : 'up to date'
}

/** The projects whose name or path holds the query (any case), in the order given. */
export function filterProjects(list: ProjectEntry[], query: string): ProjectEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
}
