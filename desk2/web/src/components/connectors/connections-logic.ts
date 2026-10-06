// What the Connections chip decides, kept apart from the page so it is testable: whether it shows, what it says, which
// company is ticked, the search filter, the default-for-new-chats star and the Bypass row.
import type { ConnectionsCompany, ConnectionsWorkspace, ConnectorView } from '@shared/connectors'

/** The Connections mark, loaded at run time (never copied into this repo); the chip falls back to an icon when it fails. */
export const CONNECTIONS_LOGO_URL = 'https://studio.connections.icu/favicon-32x32.png'

/** Connections Studio, where a person changes Bypass permissions (Desk only shows it). */
export const CONNECTIONS_STUDIO_URL = 'https://studio.connections.icu'

export const BYPASS_TIP = 'On: chats may switch workspace and act across your workspaces without asking. Change it in Connections Studio.'

/** The menu's read-only Bypass permissions row (label, and On with a check or a muted Off); null (row hidden) while Connections does not say. */
export const bypassRow = (ws: ConnectionsWorkspace | null): { label: string; on: boolean; value: 'On' | 'Off' } | null =>
  ws?.signedIn && typeof ws.bypassPermissions === 'boolean' ? { label: 'Bypass permissions', on: ws.bypassPermissions, value: ws.bypassPermissions ? 'On' : 'Off' } : null

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

/** Picking a workspace pins this chat, which needs the chat's Claude session id (it exists once the chat has started). */
export const chatScopeAllowed = (sessionId: string | null): boolean => sessionId !== null

/** The menu's search: workspaces whose name contains what was typed, case-insensitive; blank shows all. */
export const filterCompanies = (list: readonly ConnectionsCompany[], query: string): ConnectionsCompany[] => {
  const q = query.trim().toLowerCase()
  return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : [...list]
}

export const STAR_TITLE = 'Set as default for new chats in this folder'
export const STAR_ON_TITLE = 'Default for new chats'

/** A row's star: filled (always visible) on the folder's default for new chats, outline (hover-visible) elsewhere. */
export const starState = (ws: ConnectionsWorkspace | null, c: ConnectionsCompany): { on: boolean; title: string } => {
  const on = !!ws?.defaultCompanyId && ws.defaultCompanyId === c.companyId
  return { on, title: on ? STAR_ON_TITLE : STAR_TITLE }
}

/** The sign-in link the page still has to open: Connections opens it itself when it says so. */
export const pageShouldOpen = (r: { url: string | null; opened: boolean }): string | null => (r.url && !r.opened && /^https?:\/\//.test(r.url) ? r.url : null)
