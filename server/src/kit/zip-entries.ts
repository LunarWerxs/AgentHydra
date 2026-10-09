// Read-only access to the files inside a .zip, for Codex rollouts that were packed to save space
// (`<CODEX_HOME>/archived_sessions/_packed/codex-sessions-YYYY-MM.zip`: 3,852 rollouts and ~250B tokens on
// the owner's PC that the usage store never saw). Nothing is extracted to disk: the central directory names
// each entry, and an entry's bytes are inflated as a stream and split into lines. Stored (0) and deflated (8)
// entries are read; zip64 sizes and offsets are honoured. Any other method, and a damaged archive, reads as
// nothing rather than throwing into the sweep.
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs'
import { createInflateRaw } from 'node:zlib'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  /** Uncompressed bytes: the entry's "size" for an ingest cursor. */
  size: number
  /** Where the entry's local header starts. */
  headerOffset: number
}

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_EOCD_SEARCH = 22 + 0xffff

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len)
  const n = readSync(fd, buf, 0, len, pos)
  return buf.subarray(0, n)
}

const u64 = (b: Buffer, at: number): number => Number(b.readBigUInt64LE(at))

/** The central directory's offset, size and entry count, from the end record (zip64's when it is set). */
function centralDirectory(fd: number, fileSize: number) {
  const tailLen = Math.min(fileSize, MAX_EOCD_SEARCH)
  const tail = readAt(fd, fileSize - tailLen, tailLen)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === EOCD) {
      at = i
      break
    }
  if (at < 0) return null
  let count = tail.readUInt16LE(at + 10)
  let size = tail.readUInt32LE(at + 12)
  let offset = tail.readUInt32LE(at + 16)
  const locAt = at - 20
  if (locAt >= 0 && tail.readUInt32LE(locAt) === EOCD64_LOCATOR) {
    const rec = readAt(fd, u64(tail, locAt + 8), 56)
    if (rec.length === 56 && rec.readUInt32LE(0) === EOCD64) {
      count = u64(rec, 32)
      size = u64(rec, 40)
      offset = u64(rec, 48)
    }
  }
  return { count, size, offset }
}

/** One central-directory record at `p`, with its zip64 extra applied; null at a bad signature. */
function centralEntry(cd: Buffer, p: number): { entry: ZipEntry; next: number } | null {
  if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) return null
  const nameLen = cd.readUInt16LE(p + 28)
  const extraLen = cd.readUInt16LE(p + 30)
  const commentLen = cd.readUInt16LE(p + 32)
  const entry: ZipEntry = {
    name: cd.toString('utf8', p + 46, p + 46 + nameLen),
    method: cd.readUInt16LE(p + 10),
    compressedSize: cd.readUInt32LE(p + 20),
    size: cd.readUInt32LE(p + 24),
    headerOffset: cd.readUInt32LE(p + 42),
  }
  applyZip64(entry, cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen))
  return { entry, next: p + 46 + nameLen + extraLen + commentLen }
}

/** The zip64 extra field (id 1) carries, in order, whichever of the three values overflowed 32 bits. */
function applyZip64(e: ZipEntry, extra: Buffer): void {
  for (let q = 0; q + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(q)
    const len = extra.readUInt16LE(q + 2)
    if (id === 1) {
      let r = q + 4
      const take = (v: number) => {
        if (v !== 0xffffffff || r + 8 > q + 4 + len) return v
        const big = u64(extra, r)
        r += 8
        return big
      }
      e.size = take(e.size)
      e.compressedSize = take(e.compressedSize)
      e.headerOffset = take(e.headerOffset)
      return
    }
    q += 4 + len
  }
}

/** Every file entry in the archive (directories left out), or [] when it cannot be read as a zip. */
export function zipEntries(path: string): ZipEntry[] {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    const dir = centralDirectory(fd, fstatSync(fd).size)
    if (!dir) return []
    const cd = readAt(fd, dir.offset, dir.size)
    const out: ZipEntry[] = []
    let p = 0
    for (let i = 0; i < dir.count; i++) {
      const rec = centralEntry(cd, p)
      if (!rec) break
      if (!rec.entry.name.endsWith('/')) out.push(rec.entry)
      p = rec.next
    }
    return out
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}

/** Where an entry's compressed bytes start: past its local header, whose name and extra lengths differ
 *  from the central record's. */
function dataStart(path: string, e: ZipEntry): number | null {
  const fd = openSync(path, 'r')
  try {
    const h = readAt(fd, e.headerOffset, 30)
    if (h.length < 30 || h.readUInt32LE(0) !== LOCAL) return null
    return e.headerOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28)
  } finally {
    closeSync(fd)
  }
}

/** The entry's uncompressed bytes as a stream, or null for a method this reader does not know. */
export function zipEntryStream(path: string, e: ZipEntry): AsyncIterable<Buffer> | null {
  if (e.method !== 0 && e.method !== 8) return null
  const start = dataStart(path, e)
  if (start === null) return null
  if (e.compressedSize === 0) return (async function* () {})()
  const raw = createReadStream(path, { start, end: start + e.compressedSize - 1 })
  return e.method === 0 ? raw : raw.pipe(createInflateRaw())
}
