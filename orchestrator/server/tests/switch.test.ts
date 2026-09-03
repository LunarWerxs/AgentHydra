import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from '../src/config.ts'
import { trayStatus, watchTray } from '../src/switch.ts'

const beat = (agoMs: number, paused = false) => ({ pid: 1, at: Date.now() - agoMs, paused })

describe('trayStatus reads the same heartbeat armlib does', () => {
  const path = join(STATE_DIR, 'tray-test.json')

  test('a fresh beat is up; a paused beat is up but paused; a stale beat is gone', () => {
    writeFileSync(path, JSON.stringify(beat(0)))
    expect(trayStatus(Date.now(), path)).toMatchObject({ up: true, paused: false })

    writeFileSync(path, JSON.stringify(beat(0, true)))
    expect(trayStatus(Date.now(), path)).toMatchObject({ up: true, paused: true })

    writeFileSync(path, JSON.stringify(beat(120_000)))
    const stale = trayStatus(Date.now(), path)
    expect(stale.up).toBe(false)
    expect(stale.why).toContain('old')
  })

  test("a missing or corrupt file is 'not running', never an exception", () => {
    expect(trayStatus(Date.now(), join(STATE_DIR, 'nope.json'))).toMatchObject({ up: false })
    const bad = join(STATE_DIR, 'tray-bad.json')
    writeFileSync(bad, '{not json')
    expect(trayStatus(Date.now(), bad)).toMatchObject({ up: false })
  })
})

describe('watchTray - the gateway dies with the icon', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('fires after the grace period once the beat is gone', async () => {
    // An array rather than a `let`: TypeScript narrows a closure-assigned variable to its
    // initial type and then rejects the assertion, which says nothing about the runtime.
    const lost: string[] = []
    const w = watchTray(
      (why) => {
        lost.push(why)
      },
      {
        intervalMs: 5,
        graceTicks: 2,
        read: () => ({ up: false, paused: false, pid: null, ageSecs: 99, why: 'icon gone' }),
      },
    )
    await tick(40)
    w.stop()
    expect(lost[0]).toBe('icon gone')
    // ...and it fires ONCE: the interval is cleared as it fires, so a slow shutdown cannot
    // stack a second teardown on top of the first.
    expect(lost).toHaveLength(1)
  })

  test('a PAUSED icon keeps the gateway alive - otherwise pausing from a phone would cut the line you need to un-pause', async () => {
    let lost = false
    const w = watchTray(
      () => {
        lost = true
      },
      {
        intervalMs: 5,
        graceTicks: 2,
        read: () => ({
          up: true,
          paused: true,
          pid: 1,
          ageSecs: 1,
          why: "paused from the icon's menu",
        }),
      },
    )
    await tick(40)
    w.stop()
    expect(lost).toBe(false)
  })

  test('one missed beat is not enough - a busy machine must not sever remote access', async () => {
    let lost = false
    let n = 0
    // up, DOWN, up, up... - the single dip must reset the counter rather than accumulate.
    const w = watchTray(
      () => {
        lost = true
      },
      {
        intervalMs: 5,
        graceTicks: 2,
        read: () => ({ up: n++ !== 1, paused: false, pid: 1, ageSecs: 1, why: 'blip' }),
      },
    )
    await tick(60)
    w.stop()
    expect(lost).toBe(false)
  })

  test('stop() disarms it', async () => {
    let lost = false
    const w = watchTray(
      () => {
        lost = true
      },
      {
        intervalMs: 5,
        graceTicks: 1,
        read: () => ({ up: false, paused: false, pid: null, ageSecs: 99, why: 'gone' }),
      },
    )
    w.stop()
    await tick(30)
    expect(lost).toBe(false)
  })
})
