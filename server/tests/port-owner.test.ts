// server/tests/port-owner.test.ts — reading the OS connection table (server/src/core/process.ts).
//
// This is how the daemon answers "who just called me?" for MCP over HTTP: the caller's peer port,
// looked up in the connection table, names the process that opened the socket - which is the
// Claude Code engine, under its own instance directory. A parser over another program's text is
// exactly the code that rots without anyone noticing, so it is pinned here against REAL
// `netstat -ano` output (Windows 11, 2026-09-11), including the lines around it.

import { describe, expect, test } from 'bun:test'
import { netstatOwnerPid } from '../src/core/process'

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104',
  '  TCP    127.0.0.1:7787         0.0.0.0:0              LISTENING       23152',
  '  TCP    127.0.0.1:54321        127.0.0.1:7787         ESTABLISHED     66800',
  '  TCP    127.0.0.1:7787         127.0.0.1:54321        ESTABLISHED     23152',
  '  TCP    127.0.0.1:54399        127.0.0.1:7787         TIME_WAIT       0',
  '  TCP    [::1]:2869             [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:5353           *:*                                    3112',
].join('\r\n')

describe('netstatOwnerPid', () => {
  test('names the process that opened the connection, not the one that accepted it', () => {
    // 54321 is the CALLER's own local port; 7787 is ours. The row we want is the caller's.
    expect(netstatOwnerPid(NETSTAT, 54321)).toBe(66800)
  })

  test('a port with no established row is null, never a guess', () => {
    expect(netstatOwnerPid(NETSTAT, 54399)).toBeNull() // TIME_WAIT: not a live caller
    expect(netstatOwnerPid(NETSTAT, 9999)).toBeNull()
    expect(netstatOwnerPid('', 54321)).toBeNull()
  })

  test('a LISTENING socket on the same port number is not an answer', () => {
    // 7787 appears as our own listener AND as the far end of the caller's row. Neither makes
    // the daemon the caller, and answering 23152 here would identify every agent as the tray.
    expect(netstatOwnerPid(NETSTAT, 7787)).toBe(23152)
    const listenerOnly = [
      '  TCP    127.0.0.1:7787         0.0.0.0:0              LISTENING       23152',
    ].join('\r\n')
    expect(netstatOwnerPid(listenerOnly, 7787)).toBeNull()
  })

  test('two processes claiming one local port answers null rather than picking one', () => {
    const ambiguous = [
      '  TCP    127.0.0.1:54321        127.0.0.1:7787         ESTABLISHED     66800',
      '  TCP    10.0.0.5:54321         10.0.0.9:443           ESTABLISHED     4242',
    ].join('\r\n')
    expect(netstatOwnerPid(ambiguous, 54321)).toBeNull()
  })

  test('UDP rows and garbage are ignored', () => {
    expect(netstatOwnerPid(NETSTAT, 5353)).toBeNull()
    expect(netstatOwnerPid('not a table at all', 54321)).toBeNull()
  })
})
