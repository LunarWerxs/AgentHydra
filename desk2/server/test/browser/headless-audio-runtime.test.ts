import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserTab } from '@shared/browser'
import type { HeadlessAudioState } from '@shared/headless-audio'
import { HeadlessAudio, chatResolver, restartDelay, type HeadlessAudioDeps, type HelperPort, type PageAccess } from '../../src/browser/headless-audio-runtime'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function profileDir(tabs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hau-')).replace(/\\/g, '/')
  dirs.push(dir)
  writeFileSync(join(dir, '.connections-tabs.json'), JSON.stringify({ v: 1, tabs: Object.fromEntries(Object.entries(tabs).map(([id, chat]) => [id, { chat, at: 1 }])) }))
  return dir
}

const browser = (pid: number, dir: string) => [pid, 1, `chrome.exe --user-data-dir="${dir}" --remote-debugging-port=0`] as const
const audio = (pid: number, parent: number) => [pid, parent, 'chrome.exe --type=utility --utility-sub-type=audio.mojom.AudioService'] as const

function line(rows: [number, number][], procs: (readonly [number, number, string])[]): string {
  return JSON.stringify({
    t: 1,
    s: rows.map(([pid, peak]) => [pid, peak, false]),
    p: procs.map(([pid, ppid, cmd]) => [pid, ppid, cmd]),
  })
}

function fakeHelper() {
  let onLine: ((l: string) => void) | undefined
  let finish: ((code: number) => void) | undefined
  const sent: string[] = []
  const port: HelperPort = {
    onLine: (fn) => {
      onLine = fn
    },
    send: (l) => {
      sent.push(l)
    },
    exited: new Promise<number>((r) => {
      finish = r
    }),
    kill: () => finish?.(0),
  }
  return { port, sent, emit: (l: string) => onLine?.(l), exit: () => finish?.(0) }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const at = Date.now()
  while (!cond()) {
    if (Date.now() - at > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

interface Rig {
  rt: HeadlessAudio
  helper: ReturnType<typeof fakeHelper>
  states: HeadlessAudioState[]
  calls: { probed: number[]; tabs: number[]; sound: string[]; mute: string[] }
  failMute: Set<string>
  audibleIds: Set<string>
  pages: Map<number, BrowserTab[]>
  spawns: number[]
}

function rig(opts: { platform?: string; ports: Record<string, number>; chats: Record<string, string>; workerOrigin?: Record<string, string> }): Rig {
  const helper = fakeHelper()
  const states: HeadlessAudioState[] = []
  const calls: Rig['calls'] = { probed: [], tabs: [], sound: [], mute: [] }
  const failMute = new Set<string>()
  const audibleIds = new Set<string>()
  const pages = new Map<number, BrowserTab[]>()
  const spawns: number[] = []
  const direct = (s: string) => opts.chats[s] ?? null
  const page: PageAccess = {
    tabs: async (port) => {
      calls.tabs.push(port)
      return pages.get(port) ?? []
    },
    sound: async (port, id) => {
      calls.probed.push(port)
      calls.sound.push(id)
      return audibleIds.has(id) ? { audible: 1, contexts: 0 } : { audible: 0, contexts: 0 }
    },
    mute: async (_port, id, on) => {
      calls.mute.push(`${on ? 'mute' : 'unmute'}:${id}`)
      if (on && failMute.has(id)) throw new Error('refused')
    },
  }
  const deps: HeadlessAudioDeps = {
    platform: opts.platform ?? 'win32',
    compile: async () => 'C:/cache/HeadlessAudioHelper.exe',
    spawn: () => {
      spawns.push(Date.now())
      return helper.port
    },
    page,
    readPort: (dir) => opts.ports[dir] ?? null,
    chatOf: async () => chatResolver(direct, new Map(Object.entries(opts.workerOrigin ?? {}))),
    broadcast: (s) => states.push(s),
  }
  return { rt: new HeadlessAudio(deps), helper, states, calls, failMute, audibleIds, pages, spawns }
}

describe('attribution', () => {
  test('audible pages map to their chat; a worker session maps to its parent chat; others are unattributed', async () => {
    const a = profileDir({ T1: 'sess-a', T2: 'sess-w', T3: 'mcp:x' })
    const r = rig({ ports: { [a]: 9001 }, chats: { 'sess-a': 'chat-1', 'sess-p': 'chat-2' }, workerOrigin: { 'sess-w': 'sess-p' } })
    r.pages.set(9001, [
      { id: 'T1', url: 'https://example.test/one', title: '' },
      { id: 'T2', url: 'https://example.test/two', title: '' },
      { id: 'T3', url: 'https://example.test/three', title: '' },
      { id: 'T4', url: 'https://example.test/four', title: '' },
    ])
    for (const id of ['T1', 'T2', 'T3', 'T4']) r.audibleIds.add(id)
    r.rt.start()
    await until(() => r.spawns.length === 1)
    r.helper.emit(line([[11, 0.5]], [browser(10, a), audio(11, 10)]))
    await until(() => r.rt.state().unattributed.length === 2)
    const st = r.rt.state()
    expect(st.audible).toEqual(['chat-1', 'chat-2'])
    expect(st.unattributed).toEqual([
      { profile: a, url: 'https://example.test/three' },
      { profile: a, url: 'https://example.test/four' },
    ])
    await r.rt.stop()
  })

  test('a silent profile is never probed, only listed', async () => {
    const s = profileDir({ T9: 'sess-a' })
    const r = rig({ ports: { [s]: 9002 }, chats: { 'sess-a': 'chat-1' } })
    r.pages.set(9002, [{ id: 'T9', url: 'https://example.test/quiet', title: '' }])
    r.audibleIds.add('T9')
    r.rt.start()
    await until(() => r.spawns.length === 1)
    r.helper.emit(line([[21, 0]], [browser(20, s), audio(21, 20)]))
    await new Promise((res) => setTimeout(res, 50))
    expect(r.calls.tabs).toEqual([])
    expect(r.calls.probed).toEqual([])
    expect(r.rt.state()).toEqual({ audible: [], muted: [], unattributed: [] })
    await r.rt.stop()
  })
})

describe('mute bookkeeping', () => {
  test('mute silences only that chat; re-applies on the next tick; unmute restores only what the mute changed', async () => {
    const a = profileDir({ T1: 'sess-a', T2: 'sess-b' })
    const r = rig({ ports: { [a]: 9003 }, chats: { 'sess-a': 'chat-1', 'sess-b': 'chat-2' } })
    r.pages.set(9003, [
      { id: 'T1', url: 'https://example.test/a', title: '' },
      { id: 'T2', url: 'https://example.test/b', title: '' },
    ])
    r.audibleIds.add('T1')
    r.audibleIds.add('T2')
    r.rt.start()
    await until(() => r.spawns.length === 1)
    r.helper.emit(line([[11, 0.5]], [browser(10, a), audio(11, 10)]))
    await until(() => r.rt.state().audible.length === 2)

    const muted = await r.rt.setMuted('chat-1', true)
    expect(muted.muted).toEqual(['chat-1'])
    expect(r.calls.mute).toEqual(['mute:T1'])

    r.helper.emit(line([[11, 0.5]], [browser(10, a), audio(11, 10)]))
    await until(() => r.calls.mute.length === 2)
    expect(r.calls.mute).toEqual(['mute:T1', 'mute:T1'])
    expect(r.rt.state().audible).toEqual(['chat-1', 'chat-2'])

    const off = await r.rt.setMuted('chat-1', false)
    expect(off.muted).toEqual([])
    expect(r.calls.mute.at(-1)).toBe('unmute:T1')
    expect(r.calls.mute.filter((c) => c.endsWith('T2'))).toEqual([])
    await r.rt.stop()
  })

  test('when the page mute fails and the profile is only that chat, the helper mutes the session; unmute undoes it', async () => {
    const a = profileDir({ T1: 'sess-a', T3: 'mcp:x' })
    const b = profileDir({ T5: 'sess-a' })
    const r = rig({ ports: { [a]: 9004, [b]: 9005 }, chats: { 'sess-a': 'chat-1' } })
    r.pages.set(9004, [{ id: 'T1', url: 'https://example.test/a', title: '' }])
    r.pages.set(9005, [{ id: 'T5', url: 'https://example.test/b', title: '' }])
    r.audibleIds.add('T1')
    r.audibleIds.add('T5')
    r.failMute.add('T5')
    r.rt.start()
    await until(() => r.spawns.length === 1)
    r.helper.emit(line([[11, 0.5], [31, 0.7]], [browser(10, a), audio(11, 10), browser(30, b), audio(31, 30)]))
    await until(() => r.rt.state().audible.includes('chat-1'))

    await r.rt.setMuted('chat-1', true)
    expect(r.helper.sent).toContain(JSON.stringify({ op: 'mute', pid: 31, on: true }))
    expect(r.helper.sent).not.toContain(JSON.stringify({ op: 'mute', pid: 11, on: true }))

    await r.rt.setMuted('chat-1', false)
    expect(r.helper.sent).toContain(JSON.stringify({ op: 'mute', pid: 31, on: false }))
    await r.rt.stop()
  })
})

describe('supervision', () => {
  test('restart delays double from one second and cap at thirty', () => {
    expect([0, 1, 2, 3].map(restartDelay)).toEqual([1000, 2000, 4000, 8000])
    expect(restartDelay(20)).toBe(30000)
  })

  test('a helper that exits is restarted after the backoff', async () => {
    const r = rig({ ports: {}, chats: {} })
    r.rt.start()
    await until(() => r.spawns.length >= 1)
    r.helper.exit()
    await until(() => r.spawns.length >= 2, 3000)
    expect(r.spawns[1]! - r.spawns[0]!).toBeGreaterThanOrEqual(900)
    await r.rt.stop()
  })

  test('off Windows the runtime never compiles or starts a helper', async () => {
    const r = rig({ platform: 'linux', ports: {}, chats: {} })
    r.rt.start()
    await new Promise((res) => setTimeout(res, 30))
    expect(r.spawns).toEqual([])
    expect(r.rt.state()).toEqual({ audible: [], muted: [], unattributed: [] })
  })
})
