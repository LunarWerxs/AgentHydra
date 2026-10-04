// The listening-port list as Windows prints it: netstat -ano (TCP and TCPv6) and Get-NetTCPConnection's JSON.

import { describe, expect, test } from 'bun:test'
import { parseNetTcpJson, parseNetstat, parseProcJson } from '../../src/localhost/ports'
import { classify, guessProject } from '../../src/localhost'

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       992
  TCP    0.0.0.0:1219           0.0.0.0:0              LISTENING       62392
  TCP    127.0.0.1:4175         0.0.0.0:0              LISTENING       64260
  TCP    127.0.0.1:7795         0.0.0.0:0              LISTENING       10512
  TCP    127.0.0.1:7795         127.0.0.1:51234        ESTABLISHED     10512
  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:51234        127.0.0.1:7795         ESTABLISHED     8044

Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    [::]:135               [::]:0                 LISTENING       992
  TCP    [::1]:49669            [::]:0                 LISTENING       4904
  TCP    [fe80::1%5]:5357       [::]:0                 LISTENING       4
`

describe('parseNetstat', () => {
  test('keeps the listening rows loopback reaches, one per address and port', () => {
    expect(parseNetstat(NETSTAT)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 992 },
      { address: '0.0.0.0', port: 1219, pid: 62392 },
      { address: '127.0.0.1', port: 4175, pid: 64260 },
      { address: '127.0.0.1', port: 7795, pid: 10512 },
      { address: '::', port: 135, pid: 992 },
      { address: '::1', port: 49669, pid: 4904 },
    ])
  })

  test('reads a localized netstat (the state word is never parsed)', () => {
    const de = '  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         4120\n  TCP    127.0.0.1:5173         127.0.0.1:60001        HERGESTELLT     4120'
    expect(parseNetstat(de)).toEqual([{ address: '127.0.0.1', port: 5173, pid: 4120 }])
  })
})

describe('parseNetTcpJson', () => {
  test('an array of rows, non-loopback addresses dropped', () => {
    const json = JSON.stringify([
      { LocalAddress: '127.0.0.1', LocalPort: 8188, OwningProcess: 24612 },
      { LocalAddress: '::', LocalPort: 445, OwningProcess: 4 },
      { LocalAddress: '10.0.0.5', LocalPort: 139, OwningProcess: 4 },
    ])
    expect(parseNetTcpJson(json)).toEqual([
      { address: '127.0.0.1', port: 8188, pid: 24612 },
      { address: '::', port: 445, pid: 4 },
    ])
  })

  test('a single row comes as one object; garbage is an empty list', () => {
    expect(parseNetTcpJson('{"LocalAddress":"::1","LocalPort":3000,"OwningProcess":7}')).toEqual([{ address: '::1', port: 3000, pid: 7 }])
    expect(parseNetTcpJson('not json')).toEqual([])
  })
})

describe('classify and guessProject', () => {
  const ctx = { deskPid: 10512, deskPort: 7795, home: 'C:\\Users\\me\\.hydra-desk' }
  const procs = parseProcJson(
    JSON.stringify([
      { ProcessId: 62392, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'C:\\Users\\me\\nodejs\\node.exe C:\\Users\\me\\Projects\\site\\node_modules\\vite\\bin\\vite.js', c: 1000 },
      { ProcessId: 992, ParentProcessId: 1, Name: 'svchost.exe', CommandLine: 'C:\\WINDOWS\\system32\\svchost.exe -k RPCSS', c: 1000 },
      { ProcessId: 7790, ParentProcessId: 1, Name: 'pythonw.exe', CommandLine: 'pythonw.exe zswarm.py mcp --http --port 7790', c: 1000 },
      { ProcessId: 45848, ParentProcessId: 1, Name: 'bun.exe', CommandLine: 'bun.exe "C:\\desk\\server\\src\\host\\chat-host.ts" --spec C:\\Users\\me\\.hydra-desk\\hosts\\a.spec.json', c: 1000 },
    ])
  )

  test('dev runtimes show; Desk, MCP helpers, AgentHydra and Windows services do not', () => {
    expect(classify({ address: '0.0.0.0', port: 1219, pid: 62392 }, procs.get(62392), ctx)).toBe('dev')
    expect(classify({ address: '0.0.0.0', port: 135, pid: 992 }, procs.get(992), ctx)).toBe('system')
    expect(classify({ address: '127.0.0.1', port: 7790, pid: 7790 }, procs.get(7790), ctx)).toBe('service')
    expect(classify({ address: '127.0.0.1', port: 51275, pid: 45848 }, procs.get(45848), ctx)).toBe('desk')
    expect(classify({ address: '127.0.0.1', port: 7787, pid: 1 }, undefined, ctx)).toBe('agenthydra')
  })

  test('the project is the longest known folder the arguments name, never the runtime folder', () => {
    const cmd = procs.get(62392)!.command
    expect(guessProject(['C:\\Users\\me', 'C:\\Users\\me\\Projects\\site'], null, cmd)).toBe('C:\\Users\\me\\Projects\\site')
    expect(guessProject(['C:\\Users\\me\\nodejs'], null, cmd)).toBeNull()
  })
})
