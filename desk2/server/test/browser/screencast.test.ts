import { describe, expect, test } from 'bun:test'
import { clampDpr, parseLiveIn, screencastCap } from '../../src/browser/cdp'

describe('clampDpr', () => {
  test('keeps the ratio between 1 and 3 and passes a sensible one through', () => {
    expect(clampDpr(0.5)).toBe(1)
    expect(clampDpr(1.25)).toBe(1.25)
    expect(clampDpr(2)).toBe(2)
    expect(clampDpr(9)).toBe(3)
  })
})

describe('screencastCap', () => {
  test('caps the screencast at the canvas real pixels: the CSS size times the ratio', () => {
    expect(screencastCap({ width: 1280, height: 800 }, 2)).toEqual({ maxWidth: 2560, maxHeight: 1600 })
    expect(screencastCap({ width: 1000, height: 700 }, 1.5)).toEqual({ maxWidth: 1500, maxHeight: 1050 })
  })

  test('a ratio of 1 leaves the CSS size as it is', () => {
    expect(screencastCap({ width: 1280, height: 800 }, 1)).toEqual({ maxWidth: 1280, maxHeight: 800 })
  })
})

describe('the viewport message ratio', () => {
  test('is clamped to 1 to 3 when sent', () => {
    expect(parseLiveIn('{"type":"viewport","width":1000,"height":700,"devicePixelRatio":9}')).toEqual({
      type: 'viewport',
      width: 1000,
      height: 700,
      devicePixelRatio: 3,
    })
    expect(parseLiveIn('{"type":"viewport","width":1000,"height":700,"devicePixelRatio":0.5}')).toEqual({
      type: 'viewport',
      width: 1000,
      height: 700,
      devicePixelRatio: 1,
    })
  })

  test('is left out when absent or not a number', () => {
    const plain = { type: 'viewport' as const, width: 1000, height: 700 }
    expect(parseLiveIn('{"type":"viewport","width":1000,"height":700}')).toEqual(plain)
    expect(parseLiveIn('{"type":"viewport","width":1000,"height":700,"devicePixelRatio":"2"}')).toEqual(plain)
    expect(parseLiveIn('{"type":"viewport","width":1000,"height":700}')).not.toHaveProperty('devicePixelRatio')
  })
})
