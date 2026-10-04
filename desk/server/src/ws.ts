// The /ws hub: every connected window gets every ServerEvent.

import type { ServerWebSocket } from 'bun'
import type { ServerEvent } from '@shared/protocol'

export type WsClient = ServerWebSocket<unknown>

export interface WsHub {
  addClient(ws: WsClient): void
  removeClient(ws: WsClient): void
  broadcast(event: ServerEvent): void
  send(ws: WsClient, event: ServerEvent): void
  clientCount(): number
}

export function createWsHub(): WsHub {
  const clients = new Set<WsClient>()
  const send = (ws: WsClient, event: ServerEvent) => {
    try {
      ws.send(JSON.stringify(event))
    } catch {
      // A socket closing mid-send is dropped by its close handler; nothing to do here.
    }
  }
  return {
    addClient: (ws) => void clients.add(ws),
    removeClient: (ws) => void clients.delete(ws),
    send,
    broadcast(event) {
      if (clients.size === 0) return
      const data = JSON.stringify(event)
      for (const ws of clients) {
        try {
          ws.send(data)
        } catch {
          // see send()
        }
      }
    },
    clientCount: () => clients.size,
  }
}
