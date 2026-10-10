// The shared MCP hub serves one stdio child to every Claude session. These tests pin the three things a
// multiplexer gets wrong: a client's id colliding with another's, initialize run once per client instead of once
// per child, and a dead child never coming back. The config rewrite is covered too, since it decides what the hub
// may take over.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SharedServer, shareableSpec, sharedUrl, syncSharedMcp } from '../server/src/mcp-hub'

type Json = Record<string, unknown>

const CHILD = resolve(import.meta.dir, 'fixtures/mcp-echo-child.mjs')
const quiet = () => {}
const spec = { command: process.execPath, args: [CHILD], env: {} }

let dir: string
let hub: SharedServer | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-hub-'))
})

afterEach(() => {
  hub?.stop()
  hub = null
  rmSync(dir, { recursive: true, force: true })
})

const call = (id: number, name: string, n: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, n },
})

const resultOf = <T>(reply: Json | null | undefined): T => reply?.result as T

describe('id remapping', () => {
  test('two clients both sending id 1 each get their own reply back', async () => {
    hub = new SharedServer('echo', spec, quiet)
    const [a, b] = await Promise.all([
      hub.handle(call(1, 'echo', 'a')),
      hub.handle(call(1, 'echo', 'b')),
    ])
    expect(a?.id).toBe(1)
    expect(b?.id).toBe(1)
    expect(resultOf<{ params: { n: string } }>(a).params.n).toBe('a')
    expect(resultOf<{ params: { n: string } }>(b).params.n).toBe('b')
  })

  test('a client id that is a string comes back as the same string', async () => {
    hub = new SharedServer('echo', spec, quiet)
    const reply = await hub.handle({ jsonrpc: '2.0', id: 'req-7', method: 'tools/list' })
    expect(reply?.id).toBe('req-7')
    expect(resultOf<{ method: string }>(reply).method).toBe('tools/list')
  })

  test('a notification gets no reply and is not sent as a request', async () => {
    hub = new SharedServer('echo', spec, quiet)
    expect(await hub.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull()
  })
})

describe('initialize caching', () => {
  test('every client gets the one cached initialize result from the same child', async () => {
    hub = new SharedServer('echo', spec, quiet)
    const first = await hub.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const second = await hub.handle({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} })
    expect(first?.result).toEqual(second?.result)
    expect(second?.id).toBe(9)
    const pid = resultOf<{ serverInfo: { pid: number } }>(first).serverInfo.pid
    const later = await hub.handle(call(4, 'echo', 'x'))
    expect(resultOf<{ pid: number }>(later).pid).toBe(pid)
  })
})

describe('child restart', () => {
  test('a child that dies answers its waiting client with an error, and the next request starts a new one', async () => {
    hub = new SharedServer('echo', spec, quiet)
    const before = await hub.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const pidBefore = resultOf<{ serverInfo: { pid: number } }>(before).serverInfo.pid
    const died = await hub.handle(call(2, 'die', ''))
    expect(died?.id).toBe(2)
    expect(died?.error).toBeDefined()
    const after = await hub.handle(call(3, 'echo', 'again'))
    expect(after?.id).toBe(3)
    expect(resultOf<{ pid: number }>(after).pid).not.toBe(pidBefore)
  })
})

describe('shareableSpec', () => {
  test('accepts a plain stdio entry with an empty env', () => {
    expect(
      shareableSpec({ type: 'stdio', command: 'quickdictate.exe', args: ['--mcp'], env: {} }),
    ).toEqual({
      command: 'quickdictate.exe',
      args: ['--mcp'],
      env: {},
    })
  })

  test('refuses an entry that could carry a credential or is not stdio', () => {
    expect(shareableSpec({ type: 'http', url: 'http://127.0.0.1:7787/api/mcp' })).toBeNull()
    expect(shareableSpec({ command: 'x', headersHelper: 'helper.exe' })).toBeNull()
    expect(shareableSpec({ command: 'x', env: { API_KEY: 'v' } })).toBeNull()
    expect(shareableSpec({ command: 'x', args: ['--token', 'v'] })).toBeNull()
    expect(shareableSpec({ command: 'x', cwd: 'C:/somewhere' })).toBeNull()
  })
})

describe('syncSharedMcp', () => {
  const original = { type: 'stdio', command: 'quickdictate.exe', args: ['--mcp'], env: {} }
  const paths = () => ({
    configPath: join(dir, 'claude.json'),
    storePath: join(dir, 'shared-mcp.json'),
    primary: true,
    env: {},
  })
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>

  test('rewrites a shareable entry to the hub URL, keeps the original, and is idempotent', () => {
    const p = paths()
    writeFileSync(
      p.configPath,
      JSON.stringify({
        mcpServers: { quickdictate: original, other: { type: 'http', url: 'http://x/y' } },
      }),
    )
    const url = 'http://127.0.0.1:7787'
    const first = syncSharedMcp({ daemonUrl: url, ...p })
    expect(first.error).toBeNull()
    expect(first.changed).toEqual(['quickdictate'])
    expect(read(p.configPath).mcpServers.quickdictate).toEqual({
      type: 'http',
      url: sharedUrl(url, 'quickdictate'),
    })
    expect(read(p.configPath).mcpServers.other).toEqual({ type: 'http', url: 'http://x/y' })
    expect(read(p.storePath).quickdictate).toEqual(original)
    expect(syncSharedMcp({ daemonUrl: url, ...p }).changed).toEqual([])
  })

  test('follows a port change by rewriting the hub URL', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p })
    const moved = syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7790', ...p })
    expect(moved.changed).toEqual(['quickdictate'])
    expect(read(p.configPath).mcpServers.quickdictate.url).toBe(
      sharedUrl('http://127.0.0.1:7790', 'quickdictate'),
    )
  })

  test('leaves credential-bearing entries alone', () => {
    const p = paths()
    const headered = { type: 'stdio', command: 'x', env: { API_KEY: 'v' } }
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { connections: headered } }))
    expect(syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p }).changed).toEqual([])
    expect(read(p.configPath).mcpServers.connections).toEqual(headered)
  })

  test('disabling restores the exact original entry', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p })
    const undone = syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', enabled: false, ...p })
    expect(undone.changed).toEqual(['quickdictate'])
    expect(read(p.configPath).mcpServers.quickdictate).toEqual(original)
    expect(read(p.storePath)).toEqual({})
  })

  test('an unreadable config is never rewritten', () => {
    const p = paths()
    writeFileSync(p.configPath, '{not json')
    const r = syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p })
    expect(r.error).toContain('not valid JSON')
    expect(readFileSync(p.configPath, 'utf8')).toBe('{not json')
  })

  const instanceFile = (entries: Json, extra: Json = {}) => {
    const file = join(dir, 'instance.claude.json')
    writeFileSync(file, JSON.stringify({ ...extra, mcpServers: entries }))
    return file
  }

  test('a CLI instance entry equal to its original is moved to the hub', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    const instance = instanceFile({ quickdictate: original })
    const url = 'http://127.0.0.1:7787'
    const r = syncSharedMcp({ daemonUrl: url, ...p, instancePaths: [instance] })
    expect(r.instances).toBe(1)
    expect(read(instance).mcpServers.quickdictate).toEqual({
      type: 'http',
      url: sharedUrl(url, 'quickdictate'),
    })
  })

  test('a CLI instance entry that differs from its original is left alone and never stored', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    const differs = { ...original, args: ['--other'] }
    const instance = instanceFile({ quickdictate: differs, solo: original })
    const r = syncSharedMcp({
      daemonUrl: 'http://127.0.0.1:7787',
      ...p,
      instancePaths: [instance],
    })
    expect(r.instances).toBe(0)
    expect(read(instance).mcpServers).toEqual({ quickdictate: differs, solo: original })
    expect(read(p.storePath)).not.toHaveProperty('solo')
  })

  test('a CLI instance hub entry follows a port change', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    const instance = instanceFile({ quickdictate: original })
    syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p, instancePaths: [instance] })
    const moved = syncSharedMcp({
      daemonUrl: 'http://127.0.0.1:7790',
      ...p,
      instancePaths: [instance],
    })
    expect(moved.instances).toBe(1)
    expect(read(instance).mcpServers.quickdictate.url).toBe(
      sharedUrl('http://127.0.0.1:7790', 'quickdictate'),
    )
  })

  test('disabling restores the CLI instance entries before the store forgets them', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    const instance = instanceFile({ quickdictate: original })
    syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p, instancePaths: [instance] })
    const undone = syncSharedMcp({
      daemonUrl: 'http://127.0.0.1:7787',
      enabled: false,
      ...p,
      instancePaths: [instance],
    })
    expect(undone.instances).toBe(1)
    expect(read(instance).mcpServers.quickdictate).toEqual(original)
    expect(read(p.storePath)).toEqual({})
  })

  test('only mcpServers changes in a CLI instance file', () => {
    const p = paths()
    writeFileSync(p.configPath, JSON.stringify({ mcpServers: { quickdictate: original } }))
    const projects = { 'C:/Users/me/work': { allowedTools: [] } }
    const instance = instanceFile({ quickdictate: original }, { numStartups: 7, projects })
    syncSharedMcp({ daemonUrl: 'http://127.0.0.1:7787', ...p, instancePaths: [instance] })
    const after = read(instance)
    expect(after.numStartups).toBe(7)
    expect(after.projects).toEqual(projects)
    expect(after.mcpServers.quickdictate.type).toBe('http')
  })
})
