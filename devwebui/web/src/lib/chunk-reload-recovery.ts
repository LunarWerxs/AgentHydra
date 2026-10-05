/**
 * chunk-reload-recovery - ONE window-level listener that recovers a running tab from stale-chunk
 * errors. Installed once per app from its web boot entry (`main.ts`), and it returns the
 * uninstaller it registered, so the listener is torn down with the rest of the app rather than
 * leaking off a module-level side effect nobody can undo.
 *
 * WHY IT RELOADS. When the daemon ships a new build, its hashed chunk names change; a tab still
 * running the old build then lazy-imports a chunk that no longer exists on disk and the import
 * rejects (Vite fires `vite:preloadError`). Reloading once pulls the fresh build instead of
 * showing a dead view. The server side of this pair is the `/assets/*` 404 in
 * `server/src/http/index.ts`, which refuses to answer a missing hashed chunk with the
 * index.html SPA fallback.
 *
 * WHY THE TIMESTAMP GUARD. If the new build is genuinely broken (the chunk is truly missing,
 * not merely renamed), an unconditional reload would loop forever. One reload per 10 seconds
 * is allowed; a second failure inside that window is logged and left alone.
 */

export interface ChunkReloadRecoveryOptions {
  /** The window to listen on; defaults to the global one. */
  target?: Window;
  /** Where the last-reload timestamp is kept; defaults to the target's sessionStorage. */
  storage?: Storage;
}

/** Session key holding the timestamp of the last recovery reload. */
export const RELOAD_STAMP_KEY = "devwebui:last-chunk-reload";

/** How long after a reload a further chunk failure is treated as "the new build is broken". */
export const RELOAD_GUARD_MS = 10_000;

const PRELOAD_ERROR_EVENT = "vite:preloadError";
const INSTALLED_KEY = "__devwebuiChunkReloadRecovery";

type GuardedWindow = Window & { [INSTALLED_KEY]?: () => void };

/**
 * Install the recovery listener once on a window. Idempotent: a second call returns the first
 * install's uninstaller instead of stacking listeners. A no-op (returning a no-op) outside a browser.
 */
export function installChunkReloadRecovery(options: ChunkReloadRecoveryOptions = {}): () => void {
  if (!options.target && typeof window === "undefined") return () => undefined;
  const target = (options.target ?? window) as GuardedWindow;
  const existing = target[INSTALLED_KEY];
  if (existing) return existing;

  const onPreloadError = (event: Event) => {
    const storage = options.storage ?? target.sessionStorage;
    const now = Date.now();
    if (now - Number(storage.getItem(RELOAD_STAMP_KEY) ?? 0) < RELOAD_GUARD_MS) {
      console.error("[devwebui] chunk failed to load again right after a reload", event);
      return;
    }
    storage.setItem(RELOAD_STAMP_KEY, String(now));
    event.preventDefault();
    target.location.reload();
  };

  target.addEventListener(PRELOAD_ERROR_EVENT, onPreloadError);

  const uninstall = () => {
    target.removeEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
    delete target[INSTALLED_KEY];
  };
  target[INSTALLED_KEY] = uninstall;
  return uninstall;
}
