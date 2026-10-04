// Rows of the plus menu's Connectors submenu: the MCP servers a chat here loads, with the live
// session's state of each when the chat has one.

import type { McpServerInfo, McpStatus } from '@shared/protocol'

export type McpDot = 'connected' | 'failed' | 'pending' | 'off'
type SessionState = McpStatus['servers'][number]['status']

export interface McpRow {
  name: string
  transport: McpServerInfo['transport']
  /** The live session's state; null without a live session or when the session did not load it. */
  dot: McpDot | null
  /** What a click sets (true = turn on); null when the row only informs. */
  toggleTo: boolean | null
  title: string
}

export const NOT_LIVE_TITLE = 'Applies to every new chat'

const DOT: Record<SessionState, McpDot> = { connected: 'connected', failed: 'failed', 'needs-auth': 'failed', pending: 'pending', disabled: 'off' }
const STATE: Record<SessionState, string> = {
  connected: 'Connected',
  failed: 'Failed to connect',
  'needs-auth': 'Needs authentication',
  pending: 'Connecting',
  disabled: 'Off',
}

export function mcpRows(servers: McpServerInfo[], status: McpStatus | null): McpRow[] {
  const live = status?.live ? new Map(status.servers.map((s) => [s.name, s.status])) : null
  return servers.map(({ name, transport }) => {
    const state = live?.get(name)
    if (!live) return { name, transport, dot: null, toggleTo: null, title: NOT_LIVE_TITLE }
    if (!state) return { name, transport, dot: null, toggleTo: null, title: 'Not loaded in this chat' }
    const off = state === 'disabled'
    return { name, transport, dot: DOT[state], toggleTo: off, title: `${STATE[state]}. Click to turn it ${off ? 'on' : 'off'} in this chat` }
  })
}
