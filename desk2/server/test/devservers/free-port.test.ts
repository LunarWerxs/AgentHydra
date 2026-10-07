// devservers/free-port.ts over a port scan built here (no real process is read or ended): AgentHydra's own programs,
// an OS service and a tool daemon are refused by name, a server this manager runs is marked as its own, and a dev
// runtime or any other program is left to the person's confirm.

import { expect, test } from 'bun:test'
import type { LocalServerKind } from '@shared/devwebui'
import { portHolders, refusal } from '../../src/devservers/free-port'
import type { ProcInfo, Scan } from '../../src/localhost/ports'

const PORT = 5173
const ctx = { selfPids: [11], deskPid: 10, deskPort: 7798 }

const scanOf = (procs: ProcInfo[], holder: number): Scan => ({
  listeners: [{ address: '127.0.0.1', port: PORT, pid: holder }],
  procs: new Map(procs.map((p) => [p.pid, p])),
  error: null,
})
const proc = (pid: number, name: string, command: string, ppid = 1): ProcInfo => ({ pid, ppid, name, command, created: null })

test('a holder that is AgentHydra, an OS service or a tool daemon is refused, naming it', () => {
  const cases: [LocalServerKind, ProcInfo][] = [
    ['desk', proc(11, 'bun', 'bun service.ts --home C:/Users/me/.hydra-desk-2')],
    ['agenthydra', proc(20, 'AgentHydra', 'AgentHydra.exe')],
    ['system', proc(21, 'svchost', 'svchost.exe -k netsvcs')],
    ['service', proc(22, 'node', 'node C:/Users/me/tools/local-mcp/index.js')],
  ]
  for (const [kind, p] of cases) {
    const holders = portHolders(PORT, scanOf([p], p.pid), ctx, [], 0)
    expect(holders.map((h) => [h.pid, h.kind, h.managedId])).toEqual([[p.pid, kind, undefined]])
    expect(refusal(PORT, holders)).toContain(`held by ${p.name} (pid ${p.pid})`)
  }
})

test('a holder under a server this manager runs is marked as that server and is not refused', () => {
  // A dev server of ours whose own child looks like a tool daemon by its command line.
  const procs = [proc(200, 'bun', 'bun run dev'), proc(300, 'node', 'node mcp-playground/server.js', 200)]
  const holders = portHolders(PORT, scanOf(procs, 300), ctx, [{ id: 'p1.web', pid: 200 }], 0)
  expect(holders.map((h) => [h.pid, h.kind, h.managedId])).toEqual([[300, 'service', 'p1.web']])
  expect(refusal(PORT, holders)).toBeNull()
})

test('a dev runtime or another program is not refused (it needs a confirm instead)', () => {
  const cases: [LocalServerKind, ProcInfo][] = [
    ['dev', proc(30, 'node', 'node vite.js')],
    ['app', proc(31, 'example-app', 'example-app --serve')],
  ]
  for (const [kind, p] of cases) {
    const holders = portHolders(PORT, scanOf([p], p.pid), ctx, [], 0)
    expect(holders.map((h) => h.kind)).toEqual([kind])
    expect(refusal(PORT, holders)).toBeNull()
  }
})
