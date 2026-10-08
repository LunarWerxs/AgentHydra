import { describe, expect, it } from 'bun:test'
import { detailsOn } from '../../src/components/shell/projectDetails'

describe('project details toggle', () => {
  it('stays hidden until the owner turns it on, so the tiles are short by default', () => {
    expect(detailsOn(null)).toBe(false)
    expect(detailsOn('0')).toBe(false)
    expect(detailsOn('1')).toBe(true)
  })
})
