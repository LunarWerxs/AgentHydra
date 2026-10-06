// Live `.devwebui` reloading (ported from DevWebUI's project-watch.ts): an edit shows up without restarting anything.
//
// What a naive `watch(file)` gets wrong, and so what this does:
// 1. Watch the DIRECTORY. Editors, `git checkout` and any write-temp-then-rename save atomically, replacing the
//    inode; a file watch goes deaf after the first such save.
// 2. Debounce (200 ms): one save emits several events.
// 3. Never trust a partial read: a half-written file is invalid JSON and a rename leaves a window with no file. A
//    failed read is skipped for the next event; an invalid file keeps the last good state (one log line).
// 4. Ignore no-op writes: the raw text is compared with the last one applied.
// 5. The event's file name is advisory (Linux and macOS report the temp file), so any event in a watched folder
//    re-checks that folder's watched files; the byte compare makes a spurious check free.
// One watcher per folder holding a loaded file. The manager owns the reconcile (it is applied, never restarted).

import { type FSWatcher, readFileSync, watch } from 'node:fs'
import path from 'node:path'

export interface WatchHost {
  /** The loaded .devwebui files. */
  files(): string[]
  /** Re-reads the file and reconciles it. Throws when it is invalid (the watcher logs it and keeps the last good state). */
  apply(file: string): void
  log(line: string): void
}

export interface ProjectWatch {
  /** Brings the watchers in step with the loaded files. */
  sync(): void
  stop(): void
  /** The files watched now. */
  watched(): string[]
}

const keyOf = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase()

export function createProjectWatch(host: WatchHost, debounceMs = 200): ProjectWatch {
  const dirWatchers = new Map<string, FSWatcher>()
  const lastText = new Map<string, string | null>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const realPath = new Map<string, string>()
  let stopped = false

  const readRaw = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null // mid-rename or gone: transient by assumption
    }
  }

  const reload = (fileKey: string): void => {
    if (stopped) return
    const file = realPath.get(fileKey)
    if (!file) return
    const raw = readRaw(file)
    // Unreadable or byte-identical to what is applied: nothing to do, and the last text stays so a retry still differs.
    if (raw == null || raw === lastText.get(fileKey)) return
    lastText.set(fileKey, raw)
    try {
      host.apply(file)
    } catch (e) {
      host.log(`${file}: ${(e as Error).message} (keeping the last good version)`)
    }
  }

  const schedule = (fileKey: string): void => {
    if (stopped || !lastText.has(fileKey)) return
    const pending = timers.get(fileKey)
    if (pending) clearTimeout(pending)
    timers.set(
      fileKey,
      setTimeout(() => {
        timers.delete(fileKey)
        reload(fileKey)
      }, debounceMs)
    )
  }

  const syncDirs = (): void => {
    const needed = new Set<string>()
    for (const file of realPath.values()) needed.add(keyOf(path.dirname(file)))
    for (const [dirKey, w] of dirWatchers) {
      if (needed.has(dirKey)) continue
      w.close()
      dirWatchers.delete(dirKey)
    }
    for (const file of realPath.values()) {
      const dir = path.dirname(file)
      const dirKey = keyOf(dir)
      if (dirWatchers.has(dirKey)) continue
      try {
        const w = watch(dir, { persistent: false }, () => {
          for (const [k, f] of realPath) if (keyOf(path.dirname(f)) === dirKey) schedule(k)
        })
        // A watched folder renamed or removed surfaces here: drop the watcher rather than let the error end the service.
        w.on('error', () => {
          w.close()
          dirWatchers.delete(dirKey)
        })
        dirWatchers.set(dirKey, w)
      } catch {
        // Unwatchable (permissions, just gone): staleness is the cost; it must never stop the service.
      }
    }
  }

  const sync = (): void => {
    if (stopped) return
    const desired = new Map<string, string>()
    for (const f of host.files()) desired.set(keyOf(f), f)
    for (const [k, file] of desired) {
      if (lastText.has(k)) continue
      realPath.set(k, file)
      // Primed with the text just loaded, so the first sync reconciles nothing. An unreadable file primes null.
      lastText.set(k, readRaw(file))
    }
    for (const k of [...lastText.keys()]) {
      if (desired.has(k)) continue
      lastText.delete(k)
      realPath.delete(k)
      const t = timers.get(k)
      if (t) {
        clearTimeout(t)
        timers.delete(k)
      }
    }
    syncDirs()
  }

  return {
    sync,
    stop() {
      stopped = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const w of dirWatchers.values()) w.close()
      dirWatchers.clear()
      lastText.clear()
      realPath.clear()
    },
    watched: () => [...realPath.values()],
  }
}
