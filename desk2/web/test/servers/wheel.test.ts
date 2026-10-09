import { describe, expect, it } from 'bun:test'
import { wheelCoalescer, type WheelDelta } from '../../src/components/servers/logic'

function harness() {
  const sent: WheelDelta[] = []
  const frames: (() => void)[] = []
  const wheel = wheelCoalescer(
    (w) => sent.push(w),
    (run) => frames.push(run),
  )
  const nextFrame = () => frames.splice(0).forEach((run) => run())
  return { sent, frames, wheel, nextFrame }
}

describe('wheelCoalescer', () => {
  it('ticks within one frame become one message with the deltas summed, at the latest point', () => {
    const { sent, wheel, nextFrame } = harness()
    wheel.add({ x: 10, y: 20, deltaX: 0, deltaY: 100 })
    wheel.add({ x: 12, y: 22, deltaX: 5, deltaY: 40 })
    wheel.add({ x: 14, y: 24, deltaX: -5, deltaY: 60 })
    expect(sent).toEqual([])
    nextFrame()
    expect(sent).toEqual([{ x: 14, y: 24, deltaX: 0, deltaY: 200 }])
  })

  it('asks for one animation frame however many ticks arrive before it', () => {
    const { frames, wheel } = harness()
    wheel.add({ x: 1, y: 1, deltaX: 0, deltaY: 1 })
    wheel.add({ x: 1, y: 1, deltaX: 0, deltaY: 1 })
    expect(frames.length).toBe(1)
  })

  it('a frame with no ticks sends nothing, and the next tick starts a new frame', () => {
    const { sent, frames, wheel, nextFrame } = harness()
    nextFrame()
    expect(sent).toEqual([])
    wheel.add({ x: 2, y: 2, deltaX: 0, deltaY: 30 })
    expect(frames.length).toBe(1)
    nextFrame()
    expect(sent).toEqual([{ x: 2, y: 2, deltaX: 0, deltaY: 30 }])
  })

  it('flush sends the pending ticks now and clears them, so the frame that follows sends nothing', () => {
    const { sent, wheel, nextFrame } = harness()
    wheel.add({ x: 3, y: 3, deltaX: 0, deltaY: 50 })
    wheel.flush()
    expect(sent).toEqual([{ x: 3, y: 3, deltaX: 0, deltaY: 50 }])
    nextFrame()
    expect(sent.length).toBe(1)
  })
})
