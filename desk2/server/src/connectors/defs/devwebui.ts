// DevWebUI: Desk carries its own copy (../devwebui), so there is nothing to install, only to find and start.
// Its UI is the Servers pane, so a chat gets no tools or prompt from it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEVWEBUI_DIR, DevWebDaemon, findDaemon } from '../../devwebui/daemon'
import type { ConnectorFactory } from '../types'

const factory: ConnectorFactory = ({ home }) => {
  const daemon = new DevWebDaemon({ home })
  return {
    info: {
      id: 'devwebui',
      name: 'DevWebUI',
      blurb: "Starts, stops and shows this chat's localhost servers in the Servers pane.",
      homepage: 'https://github.com/LunarWerxs/DevWebUI',
      installable: false,
      pane: true
    },
    async detect() {
      const url = await findDaemon()
      if (url) return { state: 'running', url, version: null }
      if (existsSync(join(DEVWEBUI_DIR, 'server', 'src', 'index.ts'))) return { state: 'installed', url: null, version: null }
      return { state: 'absent', url: null, version: null, reason: 'the copy beside Desk is missing' }
    },
    async start() {
      await daemon.ensure()
    }
  }
}

export default factory
