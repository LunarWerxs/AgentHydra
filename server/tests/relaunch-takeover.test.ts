import { describe, expect, it } from 'bun:test'
import { type TakeoverDeps, takeOverFromPredecessor } from '../src/relaunch-handoff'
import { relaunchRefusal } from '../src/relaunch-identity'

// The old daemon kept the port because the new launcher was still downloading when its ack
// deadline passed. The successor must end it (and only it) and then be able to bind the port.
function world(holder: { pid: number; port: number } | null, fromPid: number, heldAnyway = false) {
  let held = holder !== null || heldAnyway
  const ended: Array<[number, boolean]> = []
  const deps: TakeoverDeps = {
    port: 7787,
    isHeld: async () => held,
    waitFree: async () => {},
    owner: holder,
    isPredecessor: (o) =>
      relaunchRefusal({ argv: ['x', '--from-pid', String(fromPid)], selfPid: 999, owner: o }) ===
      null,
    endProcess: (pid, force) => {
      ended.push([pid, force])
      held = false
    },
    log: () => {},
  }
  return { ended, held: () => held, deps }
}

describe('relaunch successor takeover', () => {
  it('ends a predecessor that kept the port after the ack deadline, so the port can be bound', async () => {
    const w = world({ pid: 100, port: 7787 }, 100)
    expect(await takeOverFromPredecessor(w.deps)).toBe('took-over')
    expect(w.ended).toEqual([[100, false]])
    expect(w.held()).toBe(false)
  })

  it('forces the predecessor when a polite exit leaves the port held', async () => {
    const w = world({ pid: 100, port: 7787 }, 100)
    w.deps.endProcess = (pid, force) => {
      w.ended.push([pid, force])
      if (force) w.deps.isHeld = async () => false
    }
    expect(await takeOverFromPredecessor(w.deps)).toBe('took-over')
    expect(w.ended).toEqual([
      [100, false],
      [100, true],
    ])
  })

  it('does not end a holder that is not its predecessor', async () => {
    const w = world({ pid: 555, port: 7787 }, 100)
    expect(await takeOverFromPredecessor(w.deps)).toBe('left-alone')
    expect(w.ended).toEqual([])
    expect(w.held()).toBe(true)
  })

  it('does not end a holder that is not an AgentHydra daemon', async () => {
    const w = world(null, 100, true)
    expect(await takeOverFromPredecessor(w.deps)).toBe('left-alone')
    expect(w.ended).toEqual([])
  })
})
