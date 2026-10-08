import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const CHUNK_MAX_CHARS = 1_048_576

const aadChunk = (chatId: string, seq: number): Buffer =>
  Buffer.from(`desktop-chat:${chatId}:${seq}`, 'utf8')

const aadRecord = (chatId: string): Buffer => Buffer.from(`desktop-chat-record:${chatId}`, 'utf8')

/** Compress, encrypt, and base64 encode a chunk. The compression runs off the daemon's thread: zstd
 *  level 12 over a 4 MB range is 100-200 ms, and a long chat's send held the event loop for seconds
 *  (2026-10-08, the stall sampler's sealChunk frames). */
export async function sealChunk(
  key: Buffer,
  chatId: string,
  seq: number,
  bytes: Uint8Array,
): Promise<string> {
  const compressed = await Bun.zstdCompress(bytes, { level: 12 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadChunk(chatId, seq))
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, tag, encrypted])
  return payload.toString('base64')
}

/** Decrypt and decompress a chunk, or null on any failure. */
export function openChunk(
  key: Buffer,
  chatId: string,
  seq: number,
  blob: string,
): Uint8Array | null {
  try {
    const payload = Buffer.from(blob, 'base64')
    if (payload.length < 28) return null // iv(12) + tag(16) + at least empty ciphertext
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const encrypted = payload.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aadChunk(chatId, seq))
    decipher.setAuthTag(tag)
    const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const decompressed = Bun.zstdDecompressSync(compressed)
    return new Uint8Array(decompressed)
  } catch {
    return null
  }
}

/** Compress, encrypt, and base64 encode a JSON record. */
export function sealRecord(key: Buffer, chatId: string, record: unknown): string {
  const json = JSON.stringify(record)
  const bytes = Buffer.from(json, 'utf8')
  const compressed = Bun.zstdCompressSync(bytes, { level: 12 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadRecord(chatId))
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, tag, encrypted])
  return payload.toString('base64')
}

/** Decrypt and decompress a JSON record, or null on any failure. */
export function openRecord(key: Buffer, chatId: string, blob: string): unknown | null {
  try {
    const payload = Buffer.from(blob, 'base64')
    if (payload.length < 28) return null // iv(12) + tag(16) + at least empty ciphertext
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const encrypted = payload.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aadRecord(chatId))
    decipher.setAuthTag(tag)
    const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const decompressed = Bun.zstdDecompressSync(compressed)
    return JSON.parse(decompressed.toString('utf8'))
  } catch {
    return null
  }
}

/** Length including and up to the last newline (0x0A), or 0 if none. */
export function shareableEnd(buf: Uint8Array): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) return i + 1
  }
  return 0
}

interface Chunk {
  seq: number
  from: number
  length: number
  blob: string
}

/** Split bytes into ranges, seal each, and return ranges that fit CHUNK_MAX_CHARS. */
export async function cutChunks(
  key: Buffer,
  chatId: string,
  firstSeq: number,
  bytes: Uint8Array,
  rawTarget = 4 * 1024 * 1024,
): Promise<Chunk[]> {
  if (bytes.length === 0) return []

  const result: Chunk[] = []
  let from = 0
  let seq = firstSeq

  while (from < bytes.length) {
    let rangeLen = Math.min(rawTarget, bytes.length - from)
    let bestLen = 0
    let blob = ''

    while (rangeLen > 0) {
      // Try to end at a newline in the second half
      let endPos = from + rangeLen
      if (rangeLen > Math.floor(rangeLen / 2)) {
        const secondHalfStart = from + Math.floor(rangeLen / 2)
        for (let i = endPos - 1; i >= secondHalfStart; i--) {
          if (bytes[i] === 0x0a) {
            endPos = i + 1
            break
          }
        }
      }

      const range = bytes.subarray(from, endPos)
      blob = await sealChunk(key, chatId, seq, range)

      if (blob.length <= CHUNK_MAX_CHARS) {
        bestLen = endPos - from
        break
      }

      // Halve the range and retry
      rangeLen = Math.floor(rangeLen / 2)
    }

    if (bestLen === 0) {
      throw new Error('Range too incompressible to fit even at minimum size')
    }

    result.push({
      seq,
      from,
      length: bestLen,
      blob,
    })

    from += bestLen
    seq += 1
  }

  return result
}
