// server/tests/mcp-caller-identity.test.ts — WHO IS ASKING, over HTTP.
//
// ⛔ THE BUG (live, 2026-09-11). mcp-register.ts registers the HTTP transport for every client, so
// `whoami` ran INSIDE the daemon: it read the daemon's environment, walked the daemon's parents
// (the tray, and whatever started that), found no --user-data-dir and no claude-code path, and
// told a Claude Desktop agent on instance #8 that "this process does not look like it is running
// under Claude Code at all". Everything downstream inherited that: `move_chat to:"here"` is
// refused unless the identity is exact, and check_my_usage reported the machine's default login.
//
// The caller was never unknowable - it opened a loopback socket - so the route that owns the
// socket now hands the identity tools a way to ask who that was. These tests pin that seam: the
// binding reaches only the identity tools, a client cannot forge it, and a lookup that fails
// degrades to "could not tell" rather than to an exception.

import { describe, expect, test } from 'bun:test'
import { callerPidFromArgs, TOOLS, toolsForCaller } from '../src/mcp'

const CALLER_PID = 66800

describe('toolsForCaller', () => {
  test('returns the whole tool set, same names in the same order', () => {
    const bound = toolsForCaller(async () => CALLER_PID)
    expect(bound.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
  })

  test('only the identity tools are rebound - every other tool is the SAME object', () => {
    const bound = toolsForCaller(async () => CALLER_PID)
    const rebound = bound.filter((t, i) => t !== TOOLS[i]).map((t) => t.name)
    expect(rebound.sort()).toEqual(['check_my_usage', 'whoami'])
  })

  test('the binding is a function, which is what makes it unforgeable', async () => {
    const bound = toolsForCaller(async () => CALLER_PID)
    const whoami = bound.find((t) => t.name === 'whoami')
    expect(whoami).toBeDefined()
    // The tool reads its caller through callerPidFromArgs, and that only ever honours a callable.
    expect(await callerPidFromArgs({ callerPid: async () => CALLER_PID })).toBe(CALLER_PID)
  })
})

describe('callerPidFromArgs', () => {
  test('a client-supplied callerPid in the JSON arguments is ignored', async () => {
    // JSON cannot carry a function, so anything a client sends under this name is data - and data
    // is never an identity here. Otherwise "which account am I" would be answerable by asking.
    expect(await callerPidFromArgs({ callerPid: 1234 })).toBeNull()
    expect(await callerPidFromArgs({ callerPid: '1234' })).toBeNull()
    expect(await callerPidFromArgs({ callerPid: { pid: 1234 } })).toBeNull()
  })

  test('no binding at all (the stdio transport) is a null, not an error', async () => {
    expect(await callerPidFromArgs({})).toBeNull()
    expect(await callerPidFromArgs({ fresh: true })).toBeNull()
  })

  test('a lookup that throws degrades to "could not tell"', async () => {
    const angry = async () => {
      throw new Error('netstat is not on this machine')
    }
    expect(await callerPidFromArgs({ callerPid: angry })).toBeNull()
  })

  test('a resolved pid comes through as the number it is', async () => {
    expect(await callerPidFromArgs({ callerPid: async () => CALLER_PID })).toBe(CALLER_PID)
    expect(await callerPidFromArgs({ callerPid: async () => null })).toBeNull()
  })
})
