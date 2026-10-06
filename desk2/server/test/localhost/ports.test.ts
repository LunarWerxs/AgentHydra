// The listening-port list as Windows prints it: netstat -ano (TCP and TCPv6) and Get-NetTCPConnection's JSON.

import { describe, expect, test } from 'bun:test'
import { classify, htmlTitle, isDescendant, parseLsof, parseNetTcpJson, parseNetstat, parseProcJson } from '../../src/localhost/ports'

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

describe('classify', () => {
  const ctx = { deskPid: 10512, deskPort: 7798 }
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
})

describe('parseLsof', () => {
  test('keeps the loopback and wildcard listeners, one per address and port', () => {
    const lsof = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     4120   me   23u  IPv4 0x1      0t0  TCP 127.0.0.1:5173 (LISTEN)
node     4120   me   24u  IPv6 0x2      0t0  TCP [::1]:5173 (LISTEN)
bun      5200   me   12u  IPv4 0x3      0t0  TCP *:3000 (LISTEN)
sshd      900 root    3u  IPv4 0x4      0t0  TCP 10.0.0.5:22 (LISTEN)`
    expect(parseLsof(lsof)).toEqual([
      { address: '127.0.0.1', port: 5173, pid: 4120 },
      { address: '::1', port: 5173, pid: 4120 },
      { address: '0.0.0.0', port: 3000, pid: 5200 },
    ])
  })
})

describe('htmlTitle', () => {
  test('decodes the common entities and folds whitespace; no title is null', () => {
    expect(htmlTitle('<html><head><title>\n  Example &amp; Co\n  &lt;app&gt; </title></head>')).toBe('Example & Co <app>')
    expect(htmlTitle('<p>no title here</p>')).toBeNull()
    expect(htmlTitle('<title>   </title>')).toBeNull()
  })
})

describe('isDescendant', () => {
  test('walks the parent chain, and a process is its own', () => {
    const procs = parseProcJson(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, Name: 'bun.exe', CommandLine: null, c: 0 },
        { ProcessId: 11, ParentProcessId: 10, Name: 'cmd.exe', CommandLine: null, c: 0 },
        { ProcessId: 12, ParentProcessId: 11, Name: 'node.exe', CommandLine: null, c: 0 },
      ])
    )
    expect(isDescendant(12, 10, procs)).toBe(true)
    expect(isDescendant(10, 10, procs)).toBe(true)
    expect(isDescendant(10, 12, procs)).toBe(false)
  })
})
