// The connectors registry with fake ConnectorDefs: what reaches a chat, the poll, the enabled flags, and the
// install and start transitions. Nothing here touches the real data home.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ConnectorId, ConnectorView } from '@shared/connectors'
import type { ChatSummary } from '@shared/protocol'
import { connectorsForChat, createRegistry, startConnectors } from '../../src/connectors/registry'
import type { ConnectorDef, Detected } from '../../src/connectors/types'
import type { ServerContext } from '../../src/context'
import { createClient } from '../../src/bridge/client'
import { ChatRuntime } from '../../src/engine/chat-runtime'
import { chatAddOns } from '../../src/engine/desk-prompt'
import { startFakeHydra } from '../bridge/fake-hydra'
import { ChatStore } from '../../src/engine/store'
import { DEFAULT_SETTINGS } from '../../src/settings'

const temps: string[] = []
const stops: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'desk-connectors-'))
  temps.push(d)
  return d
}

function fake(id: ConnectorId, o: Partial<ConnectorDef> & { state?: Detected['state'] } = {}): ConnectorDef & { set(s: Detected['state']): void } {
  let state: Detected['state'] = o.state ?? 'running'
  const def: ConnectorDef & { set(s: Detected['state']): void } = {
    info: { id, name: id, blurb: `${id} blurb`, homepage: 'https://example.com', installable: !!o.install, pane: false },
    detect: async () => ({ state, url: state === 'running' ? 'http://127.0.0.1:1' : null, version: '1.0.0' }),
    chat: () => ({ mcpServers: { [id]: { type: 'http', url: `http://127.0.0.1:1/${id}` } }, prompt: `Use ${id}.` }),
    ...o,
    set: (s) => {
      state = s
    }
  }
  return def
}

async function start(defs: ConnectorDef[], home = temp(), pollMs = 60_000) {
  const ctx = { home, deps: { connectors: defs, connectorsPollMs: pollMs }, onStop: (fn: () => void) => stops.push(fn) } as unknown as ServerContext
  const registry = await startConnectors(ctx)
  return { registry, home }
}

function runtime(servers: Record<string, unknown> | null) {
  const home = temp()
  const main = join(home, '.claude.json')
  if (servers) writeFileSync(main, JSON.stringify({ mcpServers: servers }))
  const chat = {
    id: 'c1', sessionId: null, title: 't', cwd: join(home, 'proj'), account: { id: 'a', label: 'A', configDir: null }, accountAuto: false, model: null, effort: null,
    permissionMode: 'default', delegateToCliMayte: false, status: 'closed', activity: null, turnStartedAt: null, lastError: null, limitResetsAt: null,
    unread: false, pinned: false, archived: false, group: null, forkedFrom: null, createdAt: 1, updatedAt: 1, costUsd: 0, contextPct: null,
    pendingCount: 0, queuedCount: 0, climayteActive: 0
  } as ChatSummary
  return new ChatRuntime({
    chat,
    store: new ChatStore(home, { debounceMs: 1 }),
    emit: () => {},
    queryImpl: () => ({}) as unknown as Query,
    env: {},
    settings: DEFAULT_SETTINGS,
    agentHydraMcp: null,
    mainClaudeJson: servers ? main : undefined
  })
}

const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

describe('what reaches a chat', () => {
  test('nothing before the plugin has started', () => {
    expect(connectorsForChat('C:/Users/me/proj')).toEqual({ mcpServers: {}, prompts: [] })
  })

  test('a running enabled connector gives its server and prompt to buildOptions, after Desk\'s own paragraph', async () => {
    await start([fake('devwebui'), fake('repoyeti', { state: 'absent' })])
    const o = runtime(null).buildOptions()
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['devwebui'])
    const sp = o.systemPrompt as { append: string }
    expect(sp.append.endsWith('Use devwebui.')).toBe(true)
    expect(sp.append).not.toContain('Use repoyeti.')
  })

  test('a disabled connector gives nothing, and enabling it again does', async () => {
    const { registry } = await start([fake('devwebui')])
    await registry.action('devwebui', 'disable')
    expect(registry.list()[0]).toMatchObject({ enabled: false, givesChats: false })
    expect(runtime(null).buildOptions().mcpServers).toBeUndefined()
    await registry.action('devwebui', 'enable')
    expect(registry.list()[0]).toMatchObject({ enabled: true, givesChats: true })
    expect(Object.keys(runtime(null).buildOptions().mcpServers ?? {})).toEqual(['devwebui'])
  })

  test("the person's own server of the same name wins", async () => {
    await start([fake('devwebui'), fake('repoyeti')])
    const own = { type: 'http' as const, url: 'http://own.invalid/mcp' }
    const o = runtime({ devwebui: own }).buildOptions()
    expect(o.mcpServers?.devwebui).toEqual(own)
    expect(o.mcpServers?.repoyeti).toMatchObject({ url: 'http://127.0.0.1:1/repoyeti' })
  })

  test('a CliMayte chat gets the same append and servers as the in-process one, from one function', async () => {
    await start([fake('devwebui'), fake('repoyeti', { state: 'absent' })])
    const hydra = await startFakeHydra()
    try {
      await createClient({ url: hydra.url }).startWorker({ prompt: 'p', cwd: 'C:/Users/me/proj', title: 't', group: 'g', desk: chatAddOns('C:/Users/me/proj', false) }).catch(() => {})
      const task = (hydra.posts.find((p) => p.path === '/api/corch/workers')?.body as { tasks: Array<Record<string, any>> }).tasks[0]
      const inProcess = runtime(null).buildOptions()
      expect(task.chat).toBe(true)
      expect(task.desk.append).toBe((inProcess.systemPrompt as { append: string }).append)
      expect(task.desk.append.endsWith('Use devwebui.')).toBe(true)
      expect(task.desk.mcpServers).toEqual(inProcess.mcpServers ?? {})
      expect(Object.keys(task.desk.mcpServers)).toEqual(['devwebui'])
    } finally {
      await hydra.stop()
    }
  })

  test('a worker started without desk add-ons sends none', async () => {
    const hydra = await startFakeHydra()
    try {
      await createClient({ url: hydra.url }).startWorker({ prompt: 'p', cwd: 'C:/Users/me/proj', title: 't', group: 'g' }).catch(() => {})
      const task = (hydra.posts.find((p) => p.path === '/api/corch/workers')?.body as { tasks: Array<Record<string, unknown>> }).tasks[0]
      expect('desk' in task).toBe(false)
    } finally {
      await hydra.stop()
    }
  })

  test('stopping the server takes it back to nothing', async () => {
    await start([fake('devwebui')])
    for (const s of stops.splice(0)) await s()
    expect(connectorsForChat('C:/Users/me/proj').prompts).toEqual([])
  })
})

describe('the poll and the enabled flags', () => {
  test('the status follows the connector, polled on the interval', async () => {
    const d = fake('devwebui', { state: 'installed' })
    const { registry } = await start([d], undefined, 20)
    expect(registry.list()[0]).toMatchObject({ state: 'installed', givesChats: false })
    d.set('running')
    await until(() => registry.list()[0]?.state === 'running')
    expect(registry.list()[0]?.givesChats).toBe(true)
  })

  test('the list is in CONNECTOR_IDS order, a connector with no chat() gives nothing', () => {
    const r = createRegistry({ home: temp(), defs: [fake('connections'), fake('devwebui', { chat: undefined }), fake('repoyeti')] })
    r.stop()
    expect(r.list().map((v) => v.id)).toEqual(['repoyeti', 'devwebui', 'connections'])
  })

  test('disabled flags persist in connectors.json and are read back', async () => {
    const home = temp()
    const r1 = createRegistry({ home, defs: [fake('devwebui'), fake('repoyeti')] })
    await r1.action('repoyeti', 'disable')
    r1.stop()
    expect(JSON.parse(readFileSync(join(home, 'connectors.json'), 'utf8'))).toEqual({ disabled: ['repoyeti'] })
    const r2 = createRegistry({ home, defs: [fake('devwebui'), fake('repoyeti')] })
    r2.stop()
    expect(r2.list().map((v) => v.enabled)).toEqual([false, true])
  })

  test('an unknown id and an action the connector has no method for are told apart', async () => {
    const r = createRegistry({ home: temp(), defs: [fake('devwebui')] })
    r.stop()
    expect(await r.action('nope', 'enable')).toBe('unknown')
    expect(await r.action('devwebui', 'install')).toBe('unsupported')
    expect(await r.action('devwebui', 'start')).toBe('unsupported')
  })
})

describe('install and start', () => {
  const one = (r: { list(): ConnectorView[] }): ConnectorView => r.list()[0] as ConnectorView

  test('install shows its progress lines, then the re-detected state', async () => {
    let release: () => void = () => {}
    const d = fake('repoyeti', {
      state: 'absent',
      install: async (progress) => {
        progress('Downloading 1 / 2 MB')
        await new Promise<void>((r) => (release = r))
        d.set('running')
      }
    })
    const r = createRegistry({ home: temp(), defs: [d] })
    stops.push(() => r.stop())
    const first = await r.action('repoyeti', 'install')
    expect(first).toMatchObject({ state: 'installing' })
    expect(one(r).reason).toBe('Downloading 1 / 2 MB')
    release()
    await until(() => one(r).state === 'running')
    expect(one(r).reason).toBeUndefined()
  })

  test("a failed install is state 'failed' with the error's first line, until the connector answers", async () => {
    const d = fake('repoyeti', {
      state: 'absent',
      install: async () => {
        throw new Error('app.exe failed its checksum\nmore detail')
      }
    })
    const r = createRegistry({ home: temp(), defs: [d] })
    stops.push(() => r.stop())
    await r.action('repoyeti', 'install')
    await until(() => one(r).state === 'failed')
    expect(one(r).reason).toBe('app.exe failed its checksum')
    d.set('running')
    await r.refresh()
    expect(one(r).state).toBe('running')
  })

  test('start is starting until detect says running', async () => {
    const d = fake('devwebui', {
      state: 'installed',
      start: async () => {
        setTimeout(() => d.set('running'), 50)
      }
    })
    const r = createRegistry({ home: temp(), defs: [d] })
    stops.push(() => r.stop())
    expect(await r.action('devwebui', 'start')).toMatchObject({ state: 'starting' })
    await until(() => one(r).state === 'running')
  })

  test('a start that never answers fails after the wait', async () => {
    const d = fake('devwebui', { state: 'installed', start: async () => {} })
    const r = createRegistry({ home: temp(), defs: [d], startWaitMs: 60 })
    stops.push(() => r.stop())
    await r.action('devwebui', 'start')
    await until(() => one(r).state === 'failed')
    expect(one(r).reason).toMatch(/did not answer/)
  })
})
