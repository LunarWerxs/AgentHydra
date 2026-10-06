// What the Connections chip decides, kept apart from the page so it is testable: whether it shows, what it says, which
// company is ticked and what the "This chat / Every chat in this folder" choice allows.
import type { ConnectionsCompany, ConnectionsWorkspace, ConnectorView } from '@shared/connectors'

export type SwitchScope = 'chat' | 'folder'

/** The Connections mark, loaded at run time (never copied into this repo); the chip falls back to an icon when it fails. */
export const CONNECTIONS_LOGO_URL = 'https://studio.connections.icu/favicon-32x32.png'

/** Connections Studio, where a person changes Bypass permissions (Desk only shows it). */
export const CONNECTIONS_STUDIO_URL = 'https://studio.connections.icu'

export const BYPASS_TIP = 'On: chats may switch workspace and act across your workspaces without asking. Change it in Connections Studio.'

/** The menu's read-only Bypass permissions row; null (row hidden) while Connections does not say. */
export const bypassText = (ws: ConnectionsWorkspace | null): string | null =>
  ws?.signedIn && typeof ws.bypassPermissions === 'boolean' ? `Bypass permissions: ${ws.bypassPermissions ? 'On' : 'Off'}` : null

/** The chip shows on a chat's title bar when the Connections connector is enabled and on this machine. */
export const showConnectionsChip = (list: readonly ConnectorView[] | null): boolean => {
  const c = list?.find((x) => x.id === 'connections')
  return !!c && c.enabled && c.state !== 'absent'
}

/** The pill's words: the workspace's name, "No workspace" (muted) when none, or the sign-in offer. */
export function chipText(ws: ConnectionsWorkspace | null): { text: string; muted: boolean; pinned: boolean } {
  if (!ws) return { text: 'Connections', muted: true, pinned: false }
  if (!ws.signedIn) return { text: 'Sign in', muted: true, pinned: false }
  if (!ws.company) return { text: 'No workspace', muted: true, pinned: false }
  return { text: ws.company.name, muted: false, pinned: ws.scope === 'chat' }
}

export const isCurrent = (ws: ConnectionsWorkspace | null, c: ConnectionsCompany): boolean => !!ws?.company && ws.company.companyId === c.companyId

/** "This chat" needs the chat's Claude session id, which exists once the chat has started. */
export const chatScopeAllowed = (sessionId: string | null): boolean => sessionId !== null

/** The scope a pick uses: the person's choice, or the folder when the chat cannot be pinned yet. */
export const effectiveScope = (picked: SwitchScope, sessionId: string | null): SwitchScope => (picked === 'chat' && !chatScopeAllowed(sessionId) ? 'folder' : picked)

/** "No workspace" clears a chat's pin; a folder's workspace cannot be cleared from the chip. */
export const canClear = (scope: SwitchScope): boolean => scope === 'chat'

/** The sign-in link the page still has to open: Connections opens it itself when it says so. */
export const pageShouldOpen = (r: { url: string | null; opened: boolean }): string | null => (r.url && !r.opened && /^https?:\/\//.test(r.url) ? r.url : null)
