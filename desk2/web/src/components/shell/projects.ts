import type { ProjectChoiceKind, ProjectEntry, ProjectGit } from '@shared/protocol'

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

export type ProjectAction = 'reveal' | 'newChat' | 'copy' | 'hide'

/** A project tile's right-click menu, in order. */
export const PROJECT_ACTIONS: { action: ProjectAction; label: string }[] = [
  { action: 'reveal', label: 'Open file location' },
  { action: 'newChat', label: 'New chat here' },
  { action: 'copy', label: 'Copy path' },
  { action: 'hide', label: 'Hide from Projects' },
]

export interface ProjectMenuApi {
  reveal(path: string): Promise<unknown>
  newChat(path: string): void
  copy(path: string): Promise<unknown>
  hide(path: string): Promise<unknown>
}

export function runProjectAction(action: ProjectAction, path: string, api: ProjectMenuApi): Promise<unknown> {
  switch (action) {
    case 'reveal':
      return api.reveal(path)
    case 'newChat':
      api.newChat(path)
      return Promise.resolve()
    case 'copy':
      return api.copy(path)
    case 'hide':
      return api.hide(path)
  }
}

export interface ProjectFoldersApi {
  pickFolder(): Promise<string | null>
  changeProjectChoice(kind: ProjectChoiceKind, path: string, on: boolean): Promise<unknown>
}

/** Asks for a folder and adds it under `kind`; resolves to the folder added, or null when the picker was cancelled. */
export async function addProjectFolder(kind: 'folders' | 'roots', api: ProjectFoldersApi): Promise<string | null> {
  const picked = await api.pickFolder()
  if (!picked) return null
  await api.changeProjectChoice(kind, picked, true)
  return picked
}
