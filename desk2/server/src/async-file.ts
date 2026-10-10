// One JSON file written off the server's thread: a temp file flushed to the disk, then renamed over the real one.
// Writes to a file are serialized and coalesced, so the newest content always lands last. A failed write is retried.
import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameOver, renameOverAsync, writeFlushed, writeFlushedAsync } from './write-flushed'

export interface AsyncFileOptions {
  /** Wait before a failed write is tried again, ms. */
  retryMs?: number
  /** The rename onto the file; a test holds it here. */
  rename?: typeof renameOverAsync
}

export class AsyncFile {
  private want: string | null = null
  /** Counts every write given: the newest content is the one with the highest count. */
  private wanted = 0
  /** The count of the content on disk. */
  private landed = 0
  private draining = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private failure: unknown = null
  private logged = false
  private waiters: { seq: number; resolve: (ok: boolean) => void }[] = []

  constructor(
    readonly file: string,
    private readonly opts: AsyncFileOptions = {},
  ) {}

  /** False while the last write failed and nothing has landed since. */
  get ok(): boolean {
    return this.failure === null
  }

  /** Resolves true once this content, or a newer one, is on disk; false when the attempt that carried it failed (a retry follows). */
  write(text: string): Promise<boolean> {
    this.want = text
    const seq = ++this.wanted
    const landed = new Promise<boolean>((resolve) => this.waiters.push({ seq, resolve }))
    this.kick()
    return landed
  }

  /** Writes anything pending now, on the thread (server shutdown). A failed write throws and the content stays pending. */
  flushSync(): void {
    if (this.wanted !== this.landed) this.writeSync()
  }

  /** Resolves once no write is in flight; a failed one counts as done, its retry is not waited for (tests). */
  async quiet(): Promise<void> {
    while (this.draining) await new Promise((r) => setTimeout(r, 2))
  }

  /** Waits until everything written so far has landed (tests). */
  async settled(): Promise<void> {
    while (this.wanted !== this.landed || this.draining) await new Promise((r) => setTimeout(r, 2))
  }

  private kick(): void {
    if (this.draining || this.wanted === this.landed) return
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    this.draining = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.wanted > this.landed) {
        const seq = this.wanted
        const text = this.want as string
        const tmp = this.tempName(seq)
        try {
          await mkdir(dirname(this.file), { recursive: true })
          await writeFlushedAsync(tmp, text)
          if (seq < this.landed) {
            await rm(tmp, { force: true })
            continue
          }
          await (this.opts.rename ?? renameOverAsync)(tmp, this.file)
          // A flushSync during the rename put newer content on disk; the rename just put older content over it.
          if (this.landed > seq) this.writeSync()
          else this.landedAt(seq)
          this.failure = null
          this.logged = false
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => undefined)
          this.resolveWaiters(seq, false)
          this.failed(err)
          return
        }
      }
    } finally {
      this.draining = false
    }
  }

  private failed(err: unknown): void {
    this.failure = err
    if (!this.logged) {
      this.logged = true
      console.error(`[async-file] ${this.file} could not be saved, trying again: ${(err as Error).stack ?? err}`)
    }
    this.retry = setTimeout(() => {
      this.retry = null
      this.kick()
    }, this.opts.retryMs ?? 3000)
    ;(this.retry as { unref?: () => void }).unref?.()
  }

  private writeSync(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    const seq = this.wanted
    const tmp = `${this.tempName(seq)}.sync`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFlushed(tmp, this.want as string)
      renameOver(tmp, this.file)
    } catch (err) {
      rmSyncQuiet(tmp)
      this.resolveWaiters(seq, false)
      throw err
    }
    this.landedAt(seq)
    this.failure = null
    this.logged = false
  }

  private landedAt(seq: number): void {
    this.landed = seq
    this.resolveWaiters(seq, true)
  }

  private resolveWaiters(upTo: number, ok: boolean): void {
    this.waiters = this.waiters.filter((w) => {
      if (w.seq > upTo) return true
      w.resolve(ok)
      return false
    })
  }

  private tempName(seq: number): string {
    return `${this.file}.${process.pid}.${seq}.tmp`
  }
}

function rmSyncQuiet(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // floor-ok: a temp file left behind is overwritten by the next write
  }
}
