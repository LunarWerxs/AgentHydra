import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relaunchWithHandoff, writeRelaunchAck } from '../src/relaunch-handoff'

// Regression for 2026-09-25: the daemon exited 0.8s after a relaunch whose successor never
// started (on Windows the spawn is a transient powershell that exits 0 whatever WMI does), and
// nothing listened on the port for 90 minutes. The old daemon must stay up until a successor
// reports in, and stay up for good when none does.
describe('relaunchWithHandoff', () => {
  const cleanups: (() => void)[] = []
  const dirs: string[] = []
  // The rmSync is spelled out in the afterEach body itself so the hook that owns the directory
  // is the hook that reaps it; a closure pushed onto `cleanups` is not visible as the reaper.
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function daemon() {
    const dir = mkdtempSync(join(tmpdir(), 'ah-relaunch-'))
    dirs.push(dir)
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('up') })
    let shutdowns = 0
    const shutdown = () => {
      shutdowns++
      server.stop(true)
    }
    cleanups.push(() => {
      if (shutdowns === 0) server.stop(true)
    })
    return { dir, server, shutdown, shutdowns: () => shutdowns }
  }

  it('keeps the old daemon listening when the spawned successor never reports in', async () => {
    const d = daemon()
    const handedOver = await relaunchWithHandoff({
      spawnSuccessor: () => {}, // "spawned" with no error, and no successor ever starts
      ackDir: d.dir,
      selfPid: process.pid,
      shutdown: d.shutdown,
      timeoutMs: 300,
      pollMs: 20,
      log: () => {},
      error: () => {},
    })
    expect(handedOver).toBe(false)
    expect(d.shutdowns()).toBe(0)
    const res = await fetch(`http://127.0.0.1:${d.server.port}/`)
    expect(await res.text()).toBe('up')
  })

  it('hands over once the successor reports in', async () => {
    const d = daemon()
    const handedOver = await relaunchWithHandoff({
      spawnSuccessor: () => {
        setTimeout(() => writeRelaunchAck(d.dir, process.pid + 1), 50)
      },
      ackDir: d.dir,
      selfPid: process.pid,
      shutdown: d.shutdown,
      timeoutMs: 5_000,
      pollMs: 20,
      log: () => {},
      error: () => {},
    })
    expect(handedOver).toBe(true)
    expect(d.shutdowns()).toBe(1)
  })
})
