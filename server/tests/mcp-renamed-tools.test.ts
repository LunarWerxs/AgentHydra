// A chat that started before a tool rename keeps calling the old names (mcp.ts withRenamedTools).
// 2026-10-01: Corch became CliMayte; a live orchestrator's MCP process restarted onto the new code
// and every corch_* call failed with "Unknown tool" while its tool list still showed them.
import { expect, test } from 'bun:test'
import { RENAMED_TOOLS, withRenamedTools } from '../src/mcp'
import { handleRpc } from '../src/mcp-stdio.mjs'

type Rpc = {
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }
  error?: { message: string }
}

test('an old tool name is answered by the renamed tool and listed only once', async () => {
  expect(RENAMED_TOOLS.corch_send).toBe('climayte_send')
  const ctx = {
    serverInfo: { name: 't', version: '1' },
    tools: withRenamedTools(
      [{ name: 'climayte_send', description: 'd', inputSchema: {}, run: () => ({ sent: true }) }],
      { corch_send: 'climayte_send' },
    ),
  }
  const call = (await handleRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'corch_send', arguments: {} } },
    ctx,
  )) as Rpc
  expect(call.error).toBeUndefined()
  expect(call.result?.content?.[0]?.text).toBe('{"sent":true}')
  const list = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)) as Rpc
  expect(list.result?.tools?.map((t) => t.name)).toEqual(['climayte_send'])
})
