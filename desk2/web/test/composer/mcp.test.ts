import { describe, expect, it } from 'bun:test'
import type { McpServerInfo } from '@shared/protocol'
import { mcpRows, NOT_LIVE_TITLE } from '../../src/components/composer/mcp'

const SERVERS: McpServerInfo[] = [
  { name: 'codegraph', scope: 'user', transport: 'stdio' },
  { name: 'docs', scope: 'project', transport: 'http' },
  { name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' }
]

describe('Connectors rows', () => {
  it('only inform without a live session', () => {
    for (const status of [null, { live: false, servers: [] }]) {
      expect(mcpRows(SERVERS, status)).toEqual(
        SERVERS.map(({ name, transport }) => ({ name, transport, dot: null, toggleTo: null, title: NOT_LIVE_TITLE }))
      )
    }
  })

  it('show the live state and toggle to its opposite; a server the session did not load only informs', () => {
    const rows = mcpRows(SERVERS, {
      live: true,
      servers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'agenthydra', status: 'disabled' },
        { name: 'not-listed', status: 'failed' }
      ]
    })
    expect(rows.map((r) => [r.name, r.dot, r.toggleTo])).toEqual([
      ['codegraph', 'connected', false],
      ['docs', null, null],
      ['agenthydra', 'off', true]
    ])
    expect(rows[0]!.title).toBe('Connected. Click to turn it off in this chat')
    expect(rows[2]!.title).toBe('Off. Click to turn it on in this chat')
  })

  it('maps failed and needs-auth to red, pending to muted', () => {
    const rows = mcpRows(SERVERS.slice(0, 2).concat({ name: 'x', scope: 'user', transport: 'sse' }), {
      live: true,
      servers: [
        { name: 'codegraph', status: 'failed' },
        { name: 'docs', status: 'needs-auth' },
        { name: 'x', status: 'pending' }
      ]
    })
    expect(rows.map((r) => r.dot)).toEqual(['failed', 'failed', 'pending'])
  })

  it('an empty list stays empty', () => {
    expect(mcpRows([], { live: true, servers: [{ name: 'codegraph', status: 'connected' }] })).toEqual([])
  })
})
