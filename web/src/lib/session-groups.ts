// web/src/lib/session-groups.ts - a list of chats, grouped by the project they belong to.
//
// A move dialog that lists eighteen titles tells you how many, not what: three of those may be
// Connections work, ten AgentHydra, five something else, and the owner reading the list before
// clicking "move" wants to see that shape. Groups are ordered largest first so the bulk of what
// is moving is at the top, ties by name so the order is stable across renders, and rows inside a
// group keep the order they arrived in.
//
// THE LABEL IS THE FOLDER, NOT SessionSummary.project. That field is Claude's projects-store slug
// for the working directory - `C--Users-jacob-Desktop-Project-Connections` - which is an identity,
// not a name; the first live render of this dialog showed exactly that string as a header. The
// sessions list itself labels a row by the last segment of its cwd ("Connections"), so the groups
// use the same, and the slug is only the fallback for a session with no cwd at all.

export interface ProjectGroup<T> {
  project: string
  sessions: T[]
}

/** The last path segment of a working directory, Windows or POSIX, trailing separator or not. */
function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

export function groupByProject<T extends { project: string; cwd: string }>(
  rows: readonly T[],
): ProjectGroup<T>[] {
  const byProject = new Map<string, T[]>()
  for (const row of rows) {
    const key = lastSegment(row.cwd?.trim() ?? '') || row.project?.trim() || '?'
    const list = byProject.get(key)
    if (list) list.push(row)
    else byProject.set(key, [row])
  }
  return [...byProject.entries()]
    .map(([project, sessions]) => ({ project, sessions }))
    .sort((a, b) => b.sessions.length - a.sessions.length || a.project.localeCompare(b.project))
}
