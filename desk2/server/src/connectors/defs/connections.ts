// The Connections connector: the person's own Connections MCP server (set up in their main Claude config, so every
// chat already loads it). Desk installs and starts nothing; it only notices the server is there and puts the
// Connections chip (plugins/56-connections.ts, web components/connectors/ConnectionsChip.vue) on every chat's
// title bar. The entry is either stdio (one node loader per chat, running when its loader file exists) or http (one
// shared local server for every chat, running when its /health answers). No chat(): chats get the server from the
// person's config.

import type { ConnectorFactory } from '../types'
import { connectionsEntry, loaderExists } from '../connections-client'
import { probeHttp } from '../connections-http'

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
    const entry = connectionsEntry()
    if (!entry) return { state: 'absent', url: null, version: null, reason: 'the Connections server is not set up in the main Claude config' }
    if (entry.kind === 'stdio') {
      return loaderExists(entry)
        ? { state: 'running', url: null, version: null }
        : { state: 'absent', url: null, version: null, reason: "the Connections server's loader file is not on this machine" }
    }
    const probe = await probeHttp(entry.url)
    return probe.up ? { state: 'running', url: entry.url, version: probe.version } : { state: 'absent', url: entry.url, version: null, reason: probe.why }
  }
})

export default factory
