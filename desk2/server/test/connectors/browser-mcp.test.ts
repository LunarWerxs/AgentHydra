import { describe, expect, test } from 'bun:test'
import type { BrowserAgentClient } from '../../src/browser/agent/client'
import type { CallResult, ToolCaller, ToolInfo } from '../../src/browser/agent/contract'
import { createBrowserMcp } from '../../src/browser/agent/mcp'
import { TOOL_DEFS } from '../../src/browser/agent/registry'
import { cachedLookup, sessionForRequest } from '../../src/plugins/68-mcp'

const TOOLS: ToolInfo[] = [{ name: 'browser_status', description: 'Where the browser is.', inputSchema: { type: 'object', properties: {} } }]

function fakeClient(call: (name: string, params: Record<string, unknown>, caller?: ToolCaller) => CallResult): BrowserAgentClient {
  return {
    probe: async () => null,
    ensure: async () => {
      throw new Error('not used')
    },
    tools: async () => TOOLS,
    call: async (name, params, caller) => call(name, params, caller),
    stop: async () => {},
  }
}

describe('the browser tools as MCP', () => {
  test('tools/list answers the service\'s list', async () => {
    const mcp = createBrowserMcp({ client: fakeClient(() => ({ ok: true, text: '' })), caller: {} })
    const res = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: ToolInfo[] } }
    expect(res.result.tools).toEqual(TOOLS)
  })

  test('tools/call runs the named tool for the caller the route gave', async () => {
    const seen: unknown[] = []
    const client = fakeClient((name, params, caller) => {
      seen.push({ name, params, caller })
      return { ok: true, text: 'answer' }
    })
    const mcp = createBrowserMcp({ client, caller: { chat: 'chat-1', cwd: 'C:/Users/me/proj' } })
    const res = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_status', arguments: { attachPort: 9222 } } })
    expect(res).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'answer' }] } })
    expect(seen).toEqual([{ name: 'browser_status', params: { attachPort: 9222 }, caller: { chat: 'chat-1', cwd: 'C:/Users/me/proj' } }])
  })

  test('a tool that returns an image answers the image item before its text', async () => {
    const client = fakeClient(() => ({ ok: true, text: 'screenshot jpeg 3KB', image: { data: 'AAAA', mimeType: 'image/jpeg' } }))
    const mcp = createBrowserMcp({ client, caller: {} })
    const res = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: {} } })
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: {
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
          { type: 'text', text: 'screenshot jpeg 3KB' },
        ],
      },
    })
  })

  test('a tool that fails answers isError with its message', async () => {
    const mcp = createBrowserMcp({ client: fakeClient(() => ({ ok: false, status: 400, error: 'pass profile' })), caller: {} })
    const res = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_frames', arguments: {} } })
    expect(res).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'pass profile' }], isError: true } })
  })

  test('a notification gets no answer and an unknown method is refused', async () => {
    const mcp = createBrowserMcp({ client: fakeClient(() => ({ ok: true, text: '' })), caller: {} })
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } })
  })
})

describe('the tool registry', () => {
  test('lists the twenty-nine browser tools, each with a description and an object schema', () => {
    expect(TOOL_DEFS.map((d) => d.name).sort()).toEqual([
      'browser_click',
      'browser_close',
      'browser_evaluate',
      'browser_frames',
      'browser_get_text',
      'browser_handoff',
      'browser_hover',
      'browser_navigate',
      'browser_press_key',
      'browser_profile_adopt',
      'browser_profile_claim',
      'browser_profile_find',
      'browser_profile_login',
      'browser_profile_note',
      'browser_profiles',
      'browser_read',
      'browser_resize',
      'browser_script',
      'browser_select',
      'browser_snapshot',
      'browser_status',
      'browser_tab',
      'browser_tab_errors',
      'browser_take_screenshot',
      'browser_targets',
      'browser_type',
      'browser_upload_file',
      'browser_wait_idle',
      'browser_wait_tab',
    ])
    for (const def of TOOL_DEFS) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.inputSchema.type).toBe('object')
    }
  })
})

describe('the caller session is looked up only for a tool call', () => {
  const rpc = (method: string) => ({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name: 'browser_status', arguments: {} } : {} })
  const countedWorkers = () => {
    const seen = { calls: 0 }
    const workers = cachedLookup(async () => {
      seen.calls++
      return [{ id: 'w-1', sessionId: 's-1' }]
    })
    return { seen, deps: { chatSessions: () => [], workers } }
  }

  test('initialize, tools/list and ping never reach the workers lookup', async () => {
    const { seen, deps } = countedWorkers()
    for (const method of ['initialize', 'tools/list', 'ping']) expect(await sessionForRequest(rpc(method), { worker: 'w-1' }, deps)).toBeUndefined()
    expect(seen.calls).toBe(0)
  })

  test('two tool calls within five seconds look the workers up once', async () => {
    const { seen, deps } = countedWorkers()
    expect(await sessionForRequest(rpc('tools/call'), { worker: 'w-1' }, deps)).toBe('s-1')
    expect(await sessionForRequest(rpc('tools/call'), { worker: 'w-1' }, deps)).toBe('s-1')
    expect(seen.calls).toBe(1)
  })
})
