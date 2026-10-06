// The Connections connector: the person's own Connections MCP server (set up in their main Claude config, so every
// chat already loads it). Desk installs and starts nothing; it only notices the server is there and puts the
// Connections chip (plugins/56-connections.ts, web components/connectors/ConnectionsChip.vue) on every chat's
// title bar. No pane, and no chat(): chats get the server from the person's config.

import type { ConnectorFactory } from '../types'
import { connectionsServer, loaderExists } from '../connections-client'

const factory: ConnectorFactory = () => ({
  info: {
    id: 'connections',
    name: 'Connections',
    blurb: "The workspace each chat's Connections tools act as, shown and switched on every chat.",
    homepage: 'https://studio.connections.icu',
    installable: false,
    pane: false
  },
  async detect() {
    const server = connectionsServer()
    return server && loaderExists(server)
      ? { state: 'running', url: null, version: null }
      : { state: 'absent', url: null, version: null, reason: 'the Connections server is not set up in the main Claude config' }
  }
})

export default factory
