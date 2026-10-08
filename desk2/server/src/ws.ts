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
  /** A window says whether it is on screen (ClientEvent 'visibility'). */
  setVisible(ws: WsClient, visible: boolean): void
  visibleCount(): number
  /** fn runs whenever visibleCount changes; returns its unsubscribe. */
  onVisibility(fn: (visible: number) => void): () => void
}

export function createWsHub(): WsHub {
  /** Each client and whether it is on screen: a new one is until it says otherwise. */
  const clients = new Map<WsClient, boolean>()
  const listeners = new Set<(visible: number) => void>()
  let visible = 0
  const send = (ws: WsClient, event: ServerEvent) => {
    try {
      ws.send(JSON.stringify(event))
    } catch {
      // A socket closing mid-send is dropped by its close handler; nothing to do here.
    }
  }
  const recount = () => {
    let n = 0
    for (const v of clients.values()) if (v) n++
    if (n === visible) return
    visible = n
    for (const fn of listeners) fn(n)
  }
  return {
    addClient(ws) {
      clients.set(ws, true)
      recount()
    },
    removeClient(ws) {
      clients.delete(ws)
      recount()
    },
    setVisible(ws, v) {
      if (!clients.has(ws)) return
      clients.set(ws, v)
      recount()
    },
    send,
    broadcast(event) {
      if (clients.size === 0) return
      const data = JSON.stringify(event)
      for (const ws of clients.keys()) {
        try {
          ws.send(data)
        } catch {
          // see send()
        }
      }
    },
    clientCount: () => clients.size,
    visibleCount: () => visible,
    onVisibility(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
}
