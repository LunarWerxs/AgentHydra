// The browser tools as an MCP server: tools/list asks the browser-tools service, tools/call runs one there for the
// chat or worker that asked. Served by Desk at /mcp/browser (plugins/68-mcp.ts) through connectors/mcp-http.ts.

import type { McpHandler, RpcMessage } from '../../connectors/mcp-http'
import type { BrowserAgentClient } from './client'
import type { ToolCaller } from './contract'

export interface BrowserMcpDeps {
  client: BrowserAgentClient
  caller: ToolCaller
  /** Set when the caller could not be identified: a call that has no attachPort then answers this error. */
  unidentified?: string
}

export function createBrowserMcp({ client, caller, unidentified }: BrowserMcpDeps): McpHandler {
  const handle = async (msg: RpcMessage): Promise<unknown | null> => {
    if (msg.id === undefined || msg.id === null) return null
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
    try {
      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'browser', version: '1' },
          })
        case 'ping':
          return reply({})
        case 'tools/list':
          return reply({ tools: await client.tools() })
        case 'tools/call': {
          const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
          if (unidentified && args.attachPort === undefined) return reply({ content: [{ type: 'text', text: unidentified }], isError: true })
          const res = await client.call(name, args, caller)
          if (res.ok)
            return reply({
              content: [
                ...(res.image ? [{ type: 'image', data: res.image.data, mimeType: res.image.mimeType }] : []),
                { type: 'text', text: res.text },
              ],
            })
          return reply({ content: [{ type: 'text', text: res.error }], isError: true })
        }
        default:
          return fail(-32601, `method not found: ${msg.method ?? ''}`)
      }
    } catch (err) {
      return fail(-32603, err instanceof Error ? err.message : String(err))
    }
  }
  return { handle }
}
