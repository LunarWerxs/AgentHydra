// A write that has reached the disk before the rename that publishes it.
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'

/**
 * writeFileSync, then a flush to the disk. A temp file renamed over the real one without the flush can have its rename
 * reach the disk before its data does, and an unclean shutdown then leaves the real file its full length in NUL bytes:
 * Free's accounts.json and the built window both came back that way on 2026-10-08. Every temp-then-rename store
 * writes its temp with this.
 */
export function writeFlushed(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
  const fd = openSync(path, 'w', options?.mode)
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A temp file written some other way (a copy), flushed to the disk before its rename. */
export function flushFile(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const RENAME_LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_WINDOW_MS = 2000

/**
 * renameSync over a file another program holds open. On Windows that fails while the holder (an antivirus scan, the
 * search indexer, a reader) has it open without delete sharing, so this waits the holder out for up to two seconds and
 * then throws the last error.
 */
export function renameOver(from: string, to: string): void {
  const deadline = Date.now() + RENAME_WINDOW_MS
  for (;;) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !RENAME_LOCKED.has(code) || Date.now() >= deadline) throw err
      Bun.sleepSync(20)
    }
  }
}
