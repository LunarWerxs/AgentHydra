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

/** A name or query as the search compares it: lower case, accents dropped, every run of punctuation or spaces one space. */
const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * The menu's search: every word typed must appear in the name, in any order, ignoring case, accents and punctuation
 * ("acme corp" finds "Acme-Corp" and "corp acme" finds "Acme Corp"); blank shows all. Names that start with the first
 * word come first, then the rest in the account's own order.
 */
export const filterCompanies = (list: readonly ConnectionsCompany[], query: string): ConnectionsCompany[] => {
  const words = fold(query).split(' ').filter(Boolean)
  if (!words.length) return [...list]
  const hits = list.map((c, i) => ({ c, i, n: fold(c.name) })).filter(({ n }) => words.every((w) => n.includes(w)))
  const rank = (n: string): number => (n.startsWith(words[0]!) ? 0 : n.includes(` ${words[0]}`) ? 1 : 2)
  return hits.sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map(({ c }) => c)
}

/** What Enter in the search box picks: the top match, and nothing while the box is blank (Enter must never switch by accident). */
export const enterPick = (list: readonly ConnectionsCompany[], query: string): ConnectionsCompany | null => (fold(query) ? (filterCompanies(list, query)[0] ?? null) : null)

export const STAR_TITLE = 'Set as default for new chats in this folder'
export const STAR_ON_TITLE = 'Default for new chats'

/** A row's star: filled (always visible) on the folder's default for new chats, outline (hover-visible) elsewhere. */
export const starState = (ws: ConnectionsWorkspace | null, c: ConnectionsCompany): { on: boolean; title: string } => {
  const on = !!ws?.defaultCompanyId && ws.defaultCompanyId === c.companyId
  return { on, title: on ? STAR_ON_TITLE : STAR_TITLE }
}

/** The sign-in link the page still has to open: Connections opens it itself when it says so. */
export const pageShouldOpen = (r: { url: string | null; opened: boolean }): string | null => (r.url && !r.opened && /^https?:\/\//.test(r.url) ? r.url : null)

/** The Connections server this Desk talks to, as the pane shows it: how (stdio or HTTP), where, and whether it answers. */
export interface ConnectionsServerInfo {
  transport: 'HTTP' | 'stdio'
  url: string | null
  stateText: string
  running: boolean
  version: string | null
}

export function connectionsServerInfo(list: readonly ConnectorView[] | null): ConnectionsServerInfo | null {
  const c = list?.find((x) => x.id === 'connections')
  if (!c || !c.enabled || c.state === 'absent') return null
  const running = c.state === 'running'
  const text = running ? 'Running' : c.state === 'failed' ? (c.reason ? `Not answering: ${c.reason}` : 'Not answering') : c.state === 'installed' ? 'Not running' : c.state
  return { transport: c.url ? 'HTTP' : 'stdio', url: c.url ?? null, stateText: text, running, version: c.version ?? null }
}

/** The pane's sign-in line for this chat's workspace read. */
export const signInLine = (ws: ConnectionsWorkspace | null): string => (!ws ? 'Checking' : ws.signedIn ? 'Signed in' : 'Signed out')
