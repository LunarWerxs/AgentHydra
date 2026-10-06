// Connectors: outside apps Hydra Desk hooks in without copying their code. Desk finds each one (a runtime file
// it writes plus a health probe), installs it when asked (its GitHub release, checked against SHA256SUMS.txt),
// starts it hidden, shows its own page in a pane when it has one, and gives every chat its tools and one
// paragraph of prompt while it runs. This file is what the server answers and the page reads; the server side of
// each connector is server/src/connectors/<id>.ts (ConnectorDef in server/src/connectors/types.ts).

export const CONNECTORS = '/api/connectors'

export type ConnectorId = 'repoyeti' | 'redesign' | 'devwebui' | 'connections'
export const CONNECTOR_IDS: readonly ConnectorId[] = ['repoyeti', 'redesign', 'devwebui', 'connections']

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
