// The browser tools: built into AgentHydra (server/src/browser/agent), so there is nothing to install. A chat gets the
// `browser` MCP server whenever the connector is enabled (it is on by default). It carries no prompt paragraph: the
// tool descriptions say what each tool is for.

import { createBrowserAgentClient } from '../../browser/agent/client'
import type { ConnectorFactory } from '../types'

const factory: ConnectorFactory = ({ home }) => {
  const client = createBrowserAgentClient({ home })
  return {
    info: {
      id: 'browser',
      name: 'Browser',
      blurb: "Built into AgentHydra: lets a chat see the saved browsers of its folder, the pages open in them and which chat owns each page.",
      homepage: 'https://github.com/LunarWerxs/AgentHydra',
      installable: false,
      pane: false,
    },
    async detect() {
      // Usable always: the service starts on demand, as the dev servers' does.
      return { state: 'running', url: null, version: null }
    },
    async start() {
      await client.ensure()
    },
    chat(cwd, _status, chatId) {
      const port = Number(process.env.HYDRA_DESK_PORT) || 7798
      const query = new URLSearchParams({ cwd })
      if (chatId) query.set('chat', chatId)
      return { mcpServers: { browser: { type: 'http', url: `http://127.0.0.1:${port}/mcp/browser?${query}` } } }
    },
  }
}

export default factory
