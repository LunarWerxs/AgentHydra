// A JSON file with one fast-moving field (a "last synced at" stamp) is rewritten on every pass only
// because that stamp moved. This keeps the field in memory and writes the file when something ELSE
// changed, or when the stamp is older on disk than `flushMs`, or on flush() (shutdown).

export interface QuietWriter<T> {
  /** Write `value` unless only the volatile field differs from the last write and the flush is not due.
   *  Returns true when the file was written. */
  write(value: T): boolean
  /** Write the latest value now if the volatile field is ahead of what is on disk. */
  flush(): boolean
  /** The newest volatile value seen (memory), or null. */
  latest(): number | null
}

export function quietWriter<T extends object, K extends keyof T>(
  doWrite: (value: T) => void,
  volatile: K,
  flushMs: number,
  now: () => number = Date.now,
): QuietWriter<T> {
  let lastSig: string | null = null
  let lastFlushAt = 0
  let mem: number | null = null
  let held: T | null = null
  const sigOf = (v: T) => JSON.stringify({ ...v, [volatile]: null })
  const num = (v: T): number | null =>
    typeof v[volatile] === 'number' ? (v[volatile] as number) : null

  const commit = (v: T): boolean => {
    doWrite(v)
    lastSig = sigOf(v)
    lastFlushAt = now()
    held = null
    return true
  }
  return {
    write(value) {
      const mine = num(value)
      // A caller that read the file has the stale stamp: the newer one in memory wins. A null stamp
      // (a fresh setup) restarts the memory.
      if (mine === null) mem = null
      else if (mem !== null && mem > mine) (value as Record<K, unknown>)[volatile] = mem
      else mem = mine
      if (lastSig !== null && sigOf(value) === lastSig && now() - lastFlushAt < flushMs) {
        held = value
        return false
      }
      return commit(value)
    },
    flush() {
      if (!held) return false
      return commit(held)
    },
    latest: () => mem,
  }
}
