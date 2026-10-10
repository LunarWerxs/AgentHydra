import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SyncBlock, SYNC_BLOCK_MS, setSyncBlockSink, timedSync } from '../../src/engine/sync-block'

const hold = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // the thread is busy: nothing else runs meanwhile
  }
}

describe('synchronous call probe', () => {
  test('a reported block names the call that held the thread, as path:line', () => {
    const blocks: SyncBlock[] = []
    setSyncBlockSink((b) => blocks.push(b))
    try {
      timedSync('slowWrite', () => hold(SYNC_BLOCK_MS + 30))
      expect(blocks).toHaveLength(1)
      const caller = blocks[0]!.caller ?? ''
      const m = /^server\/test\/engine\/sync-block\.test\.ts:(\d+)$/.exec(caller)
      expect(m).not.toBeNull()
      const line = readFileSync(join(import.meta.dir, 'sync-block.test.ts'), 'utf8').split('\n')[Number(m![1]) - 1] ?? ''
      expect(line).toContain("timedSync('slowWrite'")
    } finally {
      setSyncBlockSink(null)
    }
  })

  test('a fast call reports nothing', () => {
    const blocks: SyncBlock[] = []
    setSyncBlockSink((b) => blocks.push(b))
    try {
      expect(timedSync('quick', () => 7)).toBe(7)
      expect(blocks).toHaveLength(0)
    } finally {
      setSyncBlockSink(null)
    }
  })
})
