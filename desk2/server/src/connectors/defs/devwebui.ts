// Dev servers: built into AgentHydra (server/src/devservers), so there is nothing to install or find. The id stays
// `devwebui` because people's saved connector preferences use it. A chat gets the `devservers` MCP server and one
// paragraph of prompt whenever the connector is enabled, whether or not the service runs right now: the service is
// AgentHydra's own process, which Desk starts the moment a tool or the pane asks (client.ts), so it counts as usable
// as long as Desk can start it.

import { devServicesClient } from '../../devservers/client'
import type { ConnectorFactory } from '../types'

const PROMPT =
  'Dev servers here are run by AgentHydra, one copy of each for every chat and person on this PC. To run or open one (vite, next, `bun run dev`, `npm run dev`, a preview), call `dev_server_start`: it answers with the address of the copy already running, whoever started it, or starts it and waits until it answers. Never start a dev server from the shell: a second copy fights the first for its port. `dev_servers` lists this folder\'s servers and the other dev servers running on this PC; stop one only when asked.'

const factory: ConnectorFactory = ({ home }) => {
  const client = devServicesClient(home)
  return {
    info: {
      id: 'devwebui',
      name: 'Dev servers',
      blurb: "Built into AgentHydra: runs each folder's dev servers once for every chat, and gives chats tools to use a running one instead of starting another.",
      homepage: 'https://github.com/LunarWerxs/AgentHydra',
      installable: false,
      pane: true
    },
    async detect() {
      // Usable always: a service that is not running starts on demand. `running` carries no address (it is no page).
      return { state: 'running', url: null, version: null }
    },
    async start() {
      await client.ensure()
    },
    chat(cwd) {
      const port = Number(process.env.HYDRA_DESK_PORT) || 7798
      return {
        mcpServers: {
          // Served by Desk itself (plugins/68-mcp.ts): one handler for every chat, no bun child per chat.
          devservers: { type: 'http', url: `http://127.0.0.1:${port}/mcp/devservers?cwd=${encodeURIComponent(cwd)}` }
        },
        prompt: PROMPT
      }
    }
  }
}

export default factory
