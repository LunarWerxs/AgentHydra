// The "Other localhost servers" list on fixture scans: the dev-servers service's own ports and processes are left out, the rest is
// classified, a dev runtime on an ephemeral port that never answers HTTP is a helper, and the hidden count is what
// the dev-server filter dropped. No real ports are read.

import { expect, test } from 'bun:test'
import { Localhost } from '../../src/localhost/servers'
import { parseProcJson, type Listener } from '../../src/localhost/ports'

const listeners: Listener[] = [
  { address: '127.0.0.1', port: 5173, pid: 100 }, // a dev server run from a terminal
  { address: '::1', port: 5173, pid: 100 }, // the same port on IPv6: one row
  { address: '127.0.0.1', port: 4100, pid: 200 }, // the dev-servers service
  { address: '127.0.0.1', port: 3000, pid: 300 }, // a server the service lists, by port
  { address: '127.0.0.1', port: 3100, pid: 401 }, // a child of one the service started, by pid
  { address: '0.0.0.0', port: 135, pid: 992 }, // Windows
  { address: '127.0.0.1', port: 8081, pid: 500 }, // a program that is not a dev runtime
  { address: '127.0.0.1', port: 51000, pid: 600 }, // a node helper on an ephemeral port, no HTTP
  { address: '127.0.0.1', port: 7798, pid: 700 } // this window
]
const procs = parseProcJson(
  JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node vite.js', c: 0 },
    { ProcessId: 200, ParentProcessId: 1, Name: 'bun.exe', CommandLine: 'bun service.ts', c: 0 },
    { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node server.js', c: 0 },
    { ProcessId: 400, ParentProcessId: 300, Name: 'cmd.exe', CommandLine: null, c: 0 },
    { ProcessId: 401, ParentProcessId: 400, Name: 'node.exe', CommandLine: 'node worker.js', c: 0 },
    { ProcessId: 992, ParentProcessId: 1, Name: 'svchost.exe', CommandLine: 'C:\\WINDOWS\\system32\\svchost.exe -k RPCSS', c: 0 },
    { ProcessId: 500, ParentProcessId: 1, Name: 'example-app.exe', CommandLine: null, c: 0 },
    { ProcessId: 600, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node test-runner.js', c: 0 },
    { ProcessId: 700, ParentProcessId: 1, Name: 'bun.exe', CommandLine: 'bun server/src/index.ts', c: 0 }
  ])
)

const probed: number[] = []
const make = (owned: { ports: number[]; pids: number[] } | null) =>
  new Localhost({
    scan: async () => ({ listeners, procs, error: null }),
    probe: async (port) => {
      probed.push(port)
      return port === 5173 ? { status: 200, title: 'Example App' } : null
    },
    owned: async () => owned,
    deskPid: 700,
    deskPort: 7798
  })

test('leaves out the service, its servers and this window, shows dev runtimes, counts what it hides', async () => {
  const r = await make({ ports: [4100, 3000], pids: [] }).list()
  expect(r.servers.map((s) => [s.port, s.process, s.kind, s.title])).toEqual([[5173, 'node', 'dev', 'Example App']])
  expect(r.servers[0]!.url).toBe('http://localhost:5173/')
  // 135 (system), 8081 (app), 51000 (helper) and 7798 (this window); the service's 4100, 3000 and 3100 are not counted.
  expect(r.hidden).toBe(4)
})

test('a process the service lists hides what it started further down', async () => {
  const r = await make({ ports: [4100], pids: [300] }).list()
  expect(r.servers.map((s) => s.port)).toEqual([5173])
  const all = await make({ ports: [4100], pids: [300] }).list(true)
  expect(all.servers.map((s) => s.port)).toEqual([135, 5173, 7798, 8081, 51000])
  expect(all.hidden).toBe(0)
})

test('without a running service its ports are ordinary ones, and system services are never probed', async () => {
  probed.length = 0
  const r = await make(null).list(true)
  expect(r.servers.map((s) => s.port)).toContain(4100)
  expect(probed).not.toContain(135)
  expect(r.servers.find((s) => s.port === 51000)?.kind).toBe('service')
})

test('a recent scan is reused only while the service owns the same servers; a failed scan and a Refresh scan again', async () => {
  let scans = 0
  let failing = false
  let owned = { ports: [4100, 3000], pids: [] as number[] }
  const local = new Localhost({
    scan: async () => {
      scans++
      return failing ? { listeners: [], procs: new Map(), error: 'netstat failed' } : { listeners, procs, error: null }
    },
    probe: async () => null,
    owned: async () => owned,
    deskPid: 700,
    deskPort: 7798
  })
  await local.list()
  await local.list(true)
  expect(scans).toBe(1)
  // The service stopped its server on 3000: a scan from before the stop would list it as someone else's.
  owned = { ports: [4100], pids: [] }
  await local.list()
  expect(scans).toBe(2)
  await local.list(false, true)
  expect(scans).toBe(3)
  failing = true
  await local.list(false, true)
  failing = false
  expect((await local.list()).error).toBeNull()
  expect(scans).toBe(5)
})
