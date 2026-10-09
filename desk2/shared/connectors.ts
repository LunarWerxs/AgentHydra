// Connectors: outside apps Hydra Desk hooks in without copying their code. Desk finds each one (a runtime file
// it writes plus a health probe), installs it when asked (its GitHub release, checked against SHA256SUMS.txt),
// starts it hidden, shows its own page in a pane when it has one, and gives every chat its tools and one
// paragraph of prompt while it runs. This file is what the server answers and the page reads; the server side of
// each connector is server/src/connectors/<id>.ts (ConnectorDef in server/src/connectors/types.ts).

export const CONNECTORS = '/api/connectors'

export type ConnectorId = 'repoyeti' | 'redesign' | 'devwebui' | 'connections' | 'browser'
export const CONNECTOR_IDS: readonly ConnectorId[] = ['repoyeti', 'redesign', 'devwebui', 'connections', 'browser']

/**
 * running: it answers. installed: on this machine, not answering. absent: not on this machine.
 * installing / starting: Desk is doing that now. failed: the last install or start went wrong (`reason`).
 */
export type ConnectorState = 'running' | 'installed' | 'absent' | 'installing' | 'starting' | 'failed'

export type ConnectorAction = 'install' | 'start' | 'enable' | 'disable'

/** POST here runs the action; the answer is the connector's new ConnectorView. */
export const connectorAction = (id: ConnectorId, action: ConnectorAction): string => `${CONNECTORS}/${id}/${action}`

/** What a connector is: the same on every machine. */
export interface ConnectorInfo {
  id: ConnectorId
  name: string
  /** One line: what it gives a chat. */
  blurb: string
  /** Its public home page (the GitHub repository). */
  homepage: string
  /** Desk can install it itself (a release asset for this platform, checked against the release's SHA256SUMS.txt). */
  installable: boolean
  /** It has its own page, which Desk shows in a pane while it runs. */
  pane: boolean
}

/** Where a connector stands on this machine now. */
export interface ConnectorStatus {
  id: ConnectorId
  state: ConnectorState
  /** Its loopback address while it answers; never carries a credential. */
  url: string | null
  version: string | null
  /** Chats get its tools and prompt paragraph (Settings → Connectors). Default true. */
  enabled: boolean
  /** Chats started now get something from it: enabled and in a state its chat() gives for. */
  givesChats: boolean
  /** Why it failed or is absent, or the install's progress line while installing. Short, one line. */
  reason?: string
  /** When Desk last looked (ms). */
  checkedAt: number
}

export type ConnectorView = ConnectorInfo & ConnectorStatus

/** What GET /api/connectors answers, in CONNECTOR_IDS order. */
export interface ConnectorsResponse {
  connectors: ConnectorView[]
}

// The Connections chip on every chat: which Connections workspace the chat's tools act as, and switching it.

/** GET ?chat=<chat id>: the ConnectionsWorkspace of that chat (its folder's when it has no pin of its own). */
export const CONNECTIONS_WORKSPACE = `${CONNECTORS}/connections/workspace`
/** GET: { companies: ConnectionsCompany[] }, every workspace the signed-in account belongs to. */
export const CONNECTIONS_COMPANIES = `${CONNECTORS}/connections/companies`
/** POST ConnectionsSwitch: answers the chat's new ConnectionsWorkspace. */
export const CONNECTIONS_SWITCH = `${CONNECTORS}/connections/switch`

/** POST ConnectionsDefaultSet: the folder's default workspace for NEW chats (Desk's own setting, not Connections'); answers the chat's ConnectionsWorkspace. */
export const CONNECTIONS_DEFAULT = `${CONNECTORS}/connections/default`

export interface ConnectionsDefaultSet {
  chat: string
  /** companyId (or name) to make the default for new chats in the chat's folder; null clears the default. */
  company: string | null
}

export interface ConnectionsCompany {
  companyId: string
  projectId?: string
  name: string
}

export interface ConnectionsWorkspace {
  /** This machine is signed in to Connections. False: the chip offers Sign in. */
  signedIn: boolean
  /** The workspace the chat's Connections tools act as; null is "No workspace". */
  company: ConnectionsCompany | null
  /** chat: pinned for this chat alone. folder: the workspace of the chat's folder. null: none. */
  scope: 'chat' | 'folder' | null
  /** Connections' Bypass permissions, read from whoami; null when it does not say. Desk never writes it: only Studio changes it. */
  bypassPermissions?: boolean | null
  /** companyId of the default for NEW chats in the chat's folder (Desk's own setting); absent when none. */
  defaultCompanyId?: string
}

export interface ConnectionsSwitch {
  chat: string
  /** companyId (or name) to use; null clears it. */
  company: string | null
  /** chat: this chat alone. folder: every chat in this folder, and the folder's default from now on. */
  scope: 'chat' | 'folder'
}

/** POST { chat }: starts Connections' browser sign-in for this machine; answers ConnectionsSignin. */
export const CONNECTIONS_SIGNIN = `${CONNECTORS}/connections/signin`

export interface ConnectionsSignin {
  /** The approval page to open; null when the machine is already signed in. */
  url: string | null
  /** Connections already opened `url` in the system browser itself, so the page does not open it again. */
  opened: boolean
  signedIn: boolean
}

// The RepoYeti pane: Desk adds the chat's folder to RepoYeti, server-side (RepoYeti's loopback guard refuses a browser).

/** POST RepoYetiRegisterRequest: answers RepoYetiRegisterResult, or { error } with a status. */
export const REPOYETI_REGISTER = '/api/repoyeti/register'

export interface RepoYetiRegisterRequest {
  /** The chat's folder (absolute). A folder inside a work tree adds that work tree's root. */
  cwd: string
}

export interface RepoYetiRegisterResult {
  ok: true
  /** False: RepoYeti already listed it. */
  added: boolean
  repoId?: string
}

// The bar above the message box when RepoYeti runs: commit, push, pull, branches, undo and Create PR go through
// RepoYeti's REST API, called by Desk's server (RepoYeti's loopback guard refuses a browser's cross-site request).
// Own page only, and only while the repoyeti connector runs. Errors answer { error } with a short readable line.

/** GET ?cwd=: RepoYetiGitState. POST <base>/draft { cwd }: RepoYetiDraft. POST <base>/<RepoYetiGitAction> RepoYetiGitRequest: RepoYetiGitResult. */
export const REPOYETI_GIT = '/api/repoyeti/git'

export type RepoYetiGitAction = 'commit' | 'push' | 'pull' | 'checkout' | 'branch' | 'undo' | 'redo' | 'create-pr'
export const REPOYETI_GIT_ACTIONS: readonly RepoYetiGitAction[] = ['commit', 'push', 'pull', 'checkout', 'branch', 'undo', 'redo', 'create-pr']

export interface RepoYetiRemote {
  owner: string
  repo: string
}

export interface RepoYetiGitState {
  repoId: string
  branch: string | null
  /** origin's default branch (origin/HEAD, else main or master when it exists); null when unknown. */
  defaultBranch: string | null
  /** Local branches, the current one first. */
  branches: string[]
  /** The GitHub owner/repo of origin; null when origin is missing or not on GitHub. */
  remote: RepoYetiRemote | null
  /** What an undo of the last git action would do, in RepoYeti's words; null when it would refuse (see undoWhy). */
  undo: string | null
  undoWhy?: string
  redo: string | null
}

export interface RepoYetiDraft {
  /** RepoYeti's AI-drafted commit message; null when it has no AI provider or nothing changed. */
  message: string | null
}

export interface RepoYetiGitRequest {
  cwd: string
  /** commit, create-pr: the commit message. */
  message?: string
  /** commit: amend the last commit. */
  amend?: boolean
  /** checkout: the branch to switch to. branch: the new branch's name (switched to at once). */
  branch?: string
}

export interface RepoYetiGitResult {
  ok: true
  /** One line of what happened. */
  message: string
  /** create-pr: GitHub's compare page for the pushed branch. */
  compareUrl?: string
}

// "Undo this chat's changes": every file the chat changed goes back to how it was before the chat touched it.

/** GET: ChatUndoPlan (nothing changes). POST ChatUndoRequest: ChatUndoResult. */
export const chatFileUndo = (chatId: string): string => `/api/chats/${encodeURIComponent(chatId)}/file-undo`

export interface ChatUndoFile {
  /** Relative to the chat's folder, forward slashes. */
  path: string
  /** Lines the chat added and removed in this file, net (before the chat -> now). */
  added: number
  removed: number
  /** restore: write the old content back. delete: the chat created it. */
  kind: 'restore' | 'delete'
  /** ready: untouched since the chat last wrote it. changed: someone else changed it since. unknown: the transcript cannot prove its old content. */
  state: 'ready' | 'changed' | 'unknown'
  reason?: string
}

export interface ChatUndoPlan {
  files: ChatUndoFile[]
}

export interface ChatUndoRequest {
  /** The ready files to undo (paths of the plan); any other path is ignored. */
  paths: string[]
}

export interface ChatUndoResult {
  done: string[]
  skipped: { path: string; reason: string }[]
}
