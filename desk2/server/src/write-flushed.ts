// A write that has reached the disk before the rename that publishes it.
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'

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
