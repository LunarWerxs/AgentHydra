// The bar's RepoYeti-backed git actions: what each one shows and when, and the calls to Desk's server (which calls RepoYeti).
// Kept apart from the component so the "which actions show when" rules are tested without a page.

import {
  REPOYETI_GIT,
  chatFileUndo,
  type ChatUndoPlan,
  type ChatUndoRequest,
  type ChatUndoResult,
  type ConnectorView,
  type RepoYetiDraft,
  type RepoYetiGitAction,
  type RepoYetiGitRequest,
  type RepoYetiGitResult,
  type RepoYetiGitState
} from '@shared/connectors'

/** What the bar knows without asking RepoYeti: GitStatus's branch, ahead, behind and the changed files. */
export interface BarGit {
  branch: string | null
  ahead: number
  behind: number
  /** Files changed in the work tree (GitStatus.files.length). */
  changed: number
}

export type BarKey = 'commit' | 'push' | 'pull' | 'create-pr' | 'new-branch' | 'undo' | 'redo' | 'undo-chat' | 'open'

export interface BarItem {
  key: BarKey
  label: string
  /** Muted text after the label (the counts, why it is off). */
  hint?: string
  enabled: boolean
}

/** What is on the bar when RepoYeti is not running: today's Create PR, plus one small item that gets RepoYeti going. */
export interface InstallItem {
  action: 'install' | 'start' | null
  label: string
  enabled: boolean
}

export function installItem(c: ConnectorView | null): InstallItem | null {
  if (!c || c.state === 'running') return null
  switch (c.state) {
    case 'absent':
      return { action: c.installable ? 'install' : null, label: 'Install RepoYeti', enabled: c.installable }
    case 'installing':
      return { action: null, label: 'Installing RepoYeti…', enabled: false }
    case 'starting':
      return { action: null, label: 'Starting RepoYeti…', enabled: false }
    case 'failed':
      return c.installable ? { action: 'install', label: 'Install RepoYeti again', enabled: true } : { action: 'start', label: 'Start RepoYeti', enabled: true }
    default:
      return { action: 'start', label: 'Start RepoYeti', enabled: true }
  }
}

/** RepoYeti runs, so the bar's git actions go through it. */
export const yetiRuns = (c: ConnectorView | null): boolean => c?.state === 'running'

const count = (arrow: string, n: number): string | undefined => (n > 0 ? `${arrow}${n}` : undefined)

/** The menu, in order. `state` is RepoYeti's read (null until it answers: undo and redo then stay off). */
export function barItems(git: BarGit, state: RepoYetiGitState | null, hasChat: boolean): BarItem[] {
  const dirty = git.changed > 0
  const onDefault = !!state?.defaultBranch && git.branch === state.defaultBranch
  return [
    { key: 'commit', label: 'Commit…', hint: dirty ? `${git.changed} ${git.changed === 1 ? 'file' : 'files'}` : 'nothing to commit', enabled: dirty },
    { key: 'push', label: 'Push', hint: count('↑', git.ahead) ?? 'nothing to push', enabled: git.ahead > 0 },
    { key: 'pull', label: 'Pull', hint: count('↓', git.behind) ?? 'up to date', enabled: git.behind > 0 },
    {
      key: 'create-pr',
      label: 'Create PR',
      hint: state && !state.remote ? 'origin is not on GitHub' : onDefault ? 'on a new branch' : undefined,
      enabled: !!git.branch && !!state?.remote
    },
    { key: 'new-branch', label: 'New branch…', enabled: !!git.branch },
    { key: 'undo', label: 'Undo last git action', hint: state?.undo ? undefined : (state?.undoWhy ?? 'nothing to undo'), enabled: !!state?.undo },
    { key: 'redo', label: 'Redo', hint: state?.redo ? undefined : 'nothing to redo', enabled: !!state?.redo },
    { key: 'undo-chat', label: "Undo this chat's changes…", enabled: hasChat },
    { key: 'open', label: 'Open in RepoYeti', enabled: true }
  ]
}

/** The button the bar leads with: the next step the repo is waiting for. */
export function primaryItem(git: BarGit): { key: 'commit' | 'push' | 'pull' | 'create-pr'; label: string } {
  if (git.changed > 0) return { key: 'commit', label: 'Commit' }
  if (git.ahead > 0) return { key: 'push', label: `Push ${count('↑', git.ahead)}` }
  if (git.behind > 0) return { key: 'pull', label: `Pull ${count('↓', git.behind)}` }
  return { key: 'create-pr', label: 'Create PR' }
}

/** The commit box's text: RepoYeti's draft, else what the person typed last. */
export const commitText = (draft: string | null, typed: string): string => (typed.trim() ? typed : (draft ?? ''))

/** The confirm text before an undo or redo, from RepoYeti's own preview. */
export const gitStepText = (verb: 'Undo' | 'Redo', what: string | null): string => (what ? `${verb}: ${what}` : `Nothing to ${verb.toLowerCase()}`)

/** "src/a.ts  +4 −1" as the confirm lists a file. */
export const undoLine = (f: { path: string; added: number; removed: number }): string => `${f.path}  +${f.added} −${f.removed}`

// Calls

async function asJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body
}

const postJson = (url: string, body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const yetiState = async (cwd: string, signal?: AbortSignal): Promise<RepoYetiGitState> => asJson(await fetch(`${REPOYETI_GIT}/state?cwd=${encodeURIComponent(cwd)}`, { signal }))
export const yetiDraft = async (cwd: string): Promise<string | null> => (await asJson<RepoYetiDraft>(await postJson(`${REPOYETI_GIT}/draft`, { cwd }))).message
export const yetiAct = async (action: RepoYetiGitAction, req: RepoYetiGitRequest): Promise<RepoYetiGitResult> => asJson(await postJson(`${REPOYETI_GIT}/${action}`, req))
export const chatUndoPlan = async (chatId: string): Promise<ChatUndoPlan> => asJson(await fetch(chatFileUndo(chatId)))
export const chatUndoApply = async (chatId: string, paths: string[]): Promise<ChatUndoResult> => asJson(await postJson(chatFileUndo(chatId), { paths } satisfies ChatUndoRequest))
