import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  CHUNK_MAX_CHARS,
  cutChunks,
  openChunk,
  openRecord,
  sealChunk,
  sealRecord,
  shareableEnd,
} from '../src/core/chat-sync-codec'

describe('chat-sync-codec', () => {
  const key = randomBytes(32)
  const wrongKey = randomBytes(32)
  const chatId = 'test-chat-123'
  const wrongChatId = 'wrong-chat'

  describe('chunk round trip', () => {
    it('seals and opens a chunk', () => {
      const data = new Uint8Array(Buffer.from('Hello, World!\n{"key": "value"}\n'))
      const blob = sealChunk(key, chatId, 1, data)
      expect(typeof blob).toBe('string')
      expect(blob.length).toBeGreaterThan(0)

      const opened = openChunk(key, chatId, 1, blob)
      expect(opened).toEqual(data)
    })

    it('returns null with wrong key', () => {
      const data = new Uint8Array(Buffer.from('test data'))
      const blob = sealChunk(key, chatId, 1, data)
      const opened = openChunk(wrongKey, chatId, 1, blob)
      expect(opened).toBeNull()
    })

    it('returns null with different chatId', () => {
      const data = new Uint8Array(Buffer.from('test data'))
      const blob = sealChunk(key, chatId, 1, data)
      const opened = openChunk(key, wrongChatId, 1, blob)
      expect(opened).toBeNull()
    })

    it('returns null with different seq', () => {
      const data = new Uint8Array(Buffer.from('test data'))
      const blob = sealChunk(key, chatId, 1, data)
      const opened = openChunk(key, chatId, 2, blob)
      expect(opened).toBeNull()
    })

    it('returns null for corrupt data', () => {
      const blob = 'aW52YWxpZA==' // "invalid" in base64, too short
      const opened = openChunk(key, chatId, 1, blob)
      expect(opened).toBeNull()
    })

    it('returns null for invalid base64', () => {
      const opened = openChunk(key, chatId, 1, '!!!invalid base64!!!')
      expect(opened).toBeNull()
    })
  })

  describe('record round trip', () => {
    it('seals and opens a JSON record', () => {
      const record = { id: 123, title: 'Test Chat', messages: 42 }
      const blob = sealRecord(key, chatId, record)
      expect(typeof blob).toBe('string')

      const opened = openRecord(key, chatId, blob)
      expect(opened).toEqual(record)
    })

    it('handles nested structures', () => {
      const record = { nested: { data: [1, 2, 3], flag: true } }
      const blob = sealRecord(key, chatId, record)
      const opened = openRecord(key, chatId, blob)
      expect(opened).toEqual(record)
    })

    it('returns null with wrong key', () => {
      const record = { test: 'data' }
      const blob = sealRecord(key, chatId, record)
      const opened = openRecord(wrongKey, chatId, blob)
      expect(opened).toBeNull()
    })

    it('returns null with different chatId', () => {
      const record = { test: 'data' }
      const blob = sealRecord(key, chatId, record)
      const opened = openRecord(key, wrongChatId, blob)
      expect(opened).toBeNull()
    })

    it('returns null for corrupt data', () => {
      const opened = openRecord(key, chatId, 'aW52YWxpZA==')
      expect(opened).toBeNull()
    })
  })

  describe('shareableEnd', () => {
    it('finds newline at end', () => {
      const buf = new Uint8Array(Buffer.from('line1\nline2\n'))
      expect(shareableEnd(buf)).toBe(12)
    })

    it('finds last newline when there is one after mid-line', () => {
      const buf = new Uint8Array(Buffer.from('line1\nline2\npartial'))
      expect(shareableEnd(buf)).toBe(12)
    })

    it('returns 0 when no newline', () => {
      const buf = new Uint8Array(Buffer.from('no newline here'))
      expect(shareableEnd(buf)).toBe(0)
    })

    it('handles empty buffer', () => {
      const buf = new Uint8Array([])
      expect(shareableEnd(buf)).toBe(0)
    })

    it('handles single newline', () => {
      const buf = new Uint8Array([0x0a])
      expect(shareableEnd(buf)).toBe(1)
    })

    it('handles newline in middle', () => {
      const buf = new Uint8Array(Buffer.from('before\nafter'))
      expect(shareableEnd(buf)).toBe(7)
    })
  })

  describe('cutChunks', () => {
    it('returns empty for empty input', () => {
      const result = cutChunks(key, chatId, 1, new Uint8Array([]))
      expect(result).toEqual([])
    })

    it('handles single small chunk', () => {
      const data = new Uint8Array(Buffer.from('single line\n'))
      const result = cutChunks(key, chatId, 10, data)

      expect(result.length).toBe(1)
      expect(result[0].seq).toBe(10)
      expect(result[0].from).toBe(0)
      expect(result[0].length).toBe(data.length)

      const opened = openChunk(key, chatId, 10, result[0].blob)
      expect(opened).toEqual(data)
    })

    it('splits large incompressible data across multiple chunks', () => {
      // 3 MB of random bytes (incompressible)
      const incompressible = randomBytes(3 * 1024 * 1024)
      const result = cutChunks(key, chatId, 1, new Uint8Array(incompressible), 1024 * 1024)

      // Verify structure
      expect(result.length).toBeGreaterThan(1)
      expect(result[0].seq).toBe(1)
      for (let i = 1; i < result.length; i++) {
        expect(result[i].seq).toBe(result[i - 1].seq + 1)
      }

      // Verify coverage: no gaps or overlaps
      expect(result[0].from).toBe(0)
      for (let i = 1; i < result.length; i++) {
        expect(result[i].from).toBe(result[i - 1].from + result[i - 1].length)
      }
      expect(result[result.length - 1].from + result[result.length - 1].length).toBe(
        incompressible.length,
      )

      // Verify each blob fits
      for (const chunk of result) {
        expect(chunk.blob.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
      }

      // Verify round trip
      const reopened = Buffer.concat(result.map((c) => openChunk(key, chatId, c.seq, c.blob)!))
      expect(reopened).toEqual(incompressible)
    })

    it('handles mixed incompressible and repetitive data', () => {
      // 3 MB incompressible + 6 MB repetitive JSONL text
      const incompressible = randomBytes(3 * 1024 * 1024)
      const repetitive = Buffer.alloc(6 * 1024 * 1024)
      const line = '{"user":"test","msg":"hello world","time":1234567890}\n'
      for (let i = 0; i < repetitive.length; i += line.length) {
        repetitive.write(line, i)
      }

      const combined = Buffer.concat([incompressible, repetitive])
      const result = cutChunks(key, chatId, 100, new Uint8Array(combined), 2 * 1024 * 1024)

      // Verify consecutive seqs
      for (let i = 1; i < result.length; i++) {
        expect(result[i].seq).toBe(result[i - 1].seq + 1)
      }

      // Verify coverage and no overlaps
      expect(result[0].from).toBe(0)
      for (let i = 1; i < result.length; i++) {
        expect(result[i].from).toBe(result[i - 1].from + result[i - 1].length)
      }
      expect(result[result.length - 1].from + result[result.length - 1].length).toBe(
        combined.length,
      )

      // Verify each blob fits
      for (const chunk of result) {
        expect(chunk.blob.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
      }

      // Verify round trip
      const reopened = Buffer.concat(
        result.map((c) => {
          const opened = openChunk(key, chatId, c.seq, c.blob)
          expect(opened).not.toBeNull()
          return opened!
        }),
      )
      expect(reopened).toEqual(combined)
    })

    it('prefers to end at newlines in the second half', () => {
      const data = Buffer.alloc(10000)
      const line = 'line content\n'
      for (let i = 0; i < data.length; i += line.length) {
        data.write(line, i)
      }

      const result = cutChunks(key, chatId, 1, new Uint8Array(data), 5000)

      // Each chunk except possibly the last should end at a newline
      for (let i = 0; i < result.length - 1; i++) {
        const chunk = result[i]
        const endByte = data[chunk.from + chunk.length - 1]
        expect(endByte).toBe(0x0a) // newline
      }

      // Verify round trip
      const reopened = Buffer.concat(result.map((c) => openChunk(key, chatId, c.seq, c.blob)!))
      expect(reopened).toEqual(data)
    })
  })
})
