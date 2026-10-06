// One copy per server, decided on captured scans: who counts as the server that already runs, who is only a conflict,
// and what is never taken. No real port or process is read.

import { describe, expect, test } from 'bun:test'
import { type Listener, type ProcInfo, type Scan } from '../../src/localhost/ports'
import { type AdoptContext, commandInFolder, findByFolder, judgePort } from '../../src/devservers/adopt'

const proc = (pid: number, ppid: number, name: string, command: string | null): [number, ProcInfo] => [pid, { pid, ppid, name, command, created: 1_700_000_000_000 }]
const scanOf = (listeners: Listener[], procs: Array<[number, ProcInfo]>): Scan => ({ listeners, procs: new Map(procs), error: null })
const lis = (port: number, pid: number): Listener => ({ address: '127.0.0.1', port, pid })

const ctx: AdoptContext = { selfPids: [10, 11], deskPid: 11, deskPort: 7798, ownPids: [500] }

describe('commandInFolder', () => {
  test('matches the folder as a whole path, either slash, any case', () => {
    expect(commandInFolder('node C:\\Users\\me\\App\\node_modules\\vite\\bin\\vite.js', 'c:/users/me/app')).toBe(true)
    expect(commandInFolder('"C:/Users/me/app" --x', 'C:\\Users\\me\\app')).toBe(true)
    expect(commandInFolder('node c:/users/me/app', 'C:/Users/me/app/')).toBe(true)
  })

  test('is not fooled by a longer folder name or a missing command', () => {
    expect(commandInFolder('node C:/Users/me/app2/server.js', 'C:/Users/me/app')).toBe(false)
    expect(commandInFolder('node C:/Users/me/app-old/server.js', 'C:/Users/me/app')).toBe(false)
    expect(commandInFolder(null, 'C:/Users/me/app')).toBe(false)
  })
})

describe('judgePort: what holds a port that answers', () => {
  test('a dev runtime is the server, run by someone else', () => {
    const scan = scanOf([lis(4173, 900)], [proc(900, 1, 'node', 'node C:/Users/me/app/vite.js')])
    expect(judgePort(4173, scan, ctx)).toEqual({ kind: 'outside', pid: 900, name: 'node' })
  })

  test('an OS service or a tool daemon is a conflict that names it', () => {
    const scan = scanOf([lis(4173, 4321), lis(4174, 4322)], [proc(4321, 1, 'svchost', 'C:\\Windows\\System32\\svchost.exe -k x'), proc(4322, 1, 'node', 'node C:/tools/codegraph/serve.js')])
    expect(judgePort(4173, scan, ctx)).toEqual({ kind: 'conflict', text: 'port 4173 is in use by svchost (pid 4321)' })
    expect(judgePort(4174, scan, ctx)).toEqual({ kind: 'conflict', text: 'port 4174 is in use by node (pid 4322)' })
  })

  test('Desk, this service and Desk\'s own port are never a dev server', () => {
    const scan = scanOf([lis(7798, 900), lis(5000, 10), lis(5001, 11)], [proc(900, 1, 'bun', 'bun server'), proc(10, 1, 'bun', 'bun service.ts'), proc(11, 1, 'bun', 'bun desk')])
    for (const port of [7798, 5000, 5001]) {
      const v = judgePort(port, scan, ctx)
      expect(v.kind).toBe('conflict')
      expect((v as { text: string }).text).toContain('AgentHydra')
    }
  })

  test('what runs under a server this manager started is not an outside server', () => {
    const scan = scanOf([lis(4173, 502)], [proc(500, 1, 'cmd', 'cmd /c npm run dev'), proc(501, 500, 'node', 'node npm-cli.js'), proc(502, 501, 'node', 'node vite.js')])
    const v = judgePort(4173, scan, ctx)
    expect(v.kind).toBe('conflict')
    expect((v as { text: string }).text).toContain('started here')
  })

  test('a port the scan does not list is unknown, never taken for a dev server', () => {
    expect(judgePort(4173, scanOf([], []), ctx).kind).toBe('unknown')
  })
})

describe('findByFolder: a server with no port', () => {
  const claimed = () => ({ ports: new Set<number>(), pids: new Set<number>() })
  const cwd = 'C:/Users/me/app'

  test('finds the dev listener whose command line, or its parent\'s, is in the folder', () => {
    const scan = scanOf([lis(5173, 700), lis(6000, 710)], [proc(700, 699, 'node', 'node vite.js'), proc(699, 1, 'cmd', 'cmd /c "cd C:\\Users\\me\\app && npm run dev"'), proc(710, 1, 'node', 'node C:/other/server.js')])
    expect(findByFolder(cwd, scan, ctx, claimed())).toEqual({ pid: 700, port: 5173 })
  })

  test('skips a listener that belongs to another server (its declared port, or already adopted)', () => {
    const scan = scanOf([lis(5173, 700)], [proc(700, 1, 'node', 'node C:/Users/me/app/vite.js')])
    expect(findByFolder(cwd, scan, ctx, { ports: new Set([5173]), pids: new Set() })).toBeNull()
    expect(findByFolder(cwd, scan, ctx, { ports: new Set(), pids: new Set([700]) })).toBeNull()
  })

  test('never takes a system process, a tool daemon or this service\'s own children', () => {
    const scan = scanOf(
      [lis(1, 800), lis(2, 801), lis(3, 502)],
      [proc(800, 1, 'svchost', 'C:\\Windows\\svchost.exe C:/Users/me/app'), proc(801, 1, 'node', 'node C:/Users/me/app/mcp-server.js'), proc(500, 1, 'cmd', 'cmd /c C:/Users/me/app'), proc(502, 500, 'node', 'node C:/Users/me/app/x.js')]
    )
    expect(findByFolder(cwd, scan, ctx, claimed())).toBeNull()
  })
})
