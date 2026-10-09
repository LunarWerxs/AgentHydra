// The working mark's slot picker (transcript/lib/working-mark.ts): one look for the whole window per
// five-minute slot, read as pure functions of the slot so the tests need no timers.
import { describe, it, expect } from 'bun:test'
import { WORKING_MARKS, WORKING_MARK_PERIOD_MS, workingMark, workingMarkForSlot } from '../../src/components/transcript/lib/working-mark'

describe('the working mark slot', () => {
  it('is deterministic: a slot always picks the same look', () => {
    for (const slot of [0, 1, 7, 12345, 987654321]) expect(workingMarkForSlot(slot)).toBe(workingMarkForSlot(slot))
  })

  it('never shows the previous slot\'s look', () => {
    for (let slot = 0; slot < 200; slot++) expect(workingMarkForSlot(slot)).not.toBe(workingMarkForSlot(slot - 1))
  })

  it('reaches every look over 200 slots', () => {
    const seen = new Set<string>()
    for (let slot = 0; slot < 200; slot++) seen.add(workingMarkForSlot(slot))
    expect([...seen].sort()).toEqual([...WORKING_MARKS].sort())
  })

  it('the shared ref holds one of the looks, and the slot lasts five minutes', () => {
    expect(WORKING_MARKS).toContain(workingMark.value)
    expect(WORKING_MARK_PERIOD_MS).toBe(5 * 60 * 1000)
  })
})
