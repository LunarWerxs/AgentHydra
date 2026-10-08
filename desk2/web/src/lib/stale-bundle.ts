// A Hydra Desk window stays open across server restarts and rebuilds, so it can keep running a bundle
// the server no longer serves (the old "Read-only" strip after the resume fix shipped). The built page
// names its entry script by content hash, so a window whose own entry differs from the one the server
// serves now is stale and reloads itself: at once when it is out of sight, else once it has been left
// alone a while, never under a typing hand (drafts are saved as they are typed, and view-memory.ts brings
// the window back to the chat it showed). It looks on every hello (a restarted server), every minute and
// whenever it comes back into view, so a new build of the window alone (`bun run build`) reaches it with
// no server restart.

const RELOADED_FOR = 'hydra-desk:reloaded-for'
/** Input this recent holds a reload back. */
export const QUIET_MS = 30_000
const LOOK_EVERY_MS = 60_000

/** The entry script's path in an index.html, or null. */
export function entryOf(html: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1] ?? null
}

/** True when the server serves a different entry than this window loaded. */
export function isStale(mine: string | null, served: string | null): boolean {
  return !!mine && !!served && mine !== served
}

/** A stale window reloads when it is out of sight, or when no one has touched it for `quietMs`. */
export function mayReload(hidden: boolean, lastInputAt: number, now: number, quietMs = QUIET_MS): boolean {
  return hidden || now - lastInputAt >= quietMs
}

/** The newer entry this window waits to reload onto. */
let pending: string | null = null
let lastInputAt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let watching = false

/** Looks for a newer build; a stale window reloads once (per served entry) as soon as it is not in the way. */
export async function reloadIfStale(): Promise<boolean> {
  try {
    const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null
    const served = entryOf(await (await fetch('/', { cache: 'no-store' })).text())
    if (!isStale(mine, served) || sessionStorage.getItem(RELOADED_FOR) === served) return false
    pending = served
    return reloadWhenQuiet()
  } catch {
    return false // server unreachable: the next look tries again
  }
}

function reloadWhenQuiet(): boolean {
  if (!pending) return false
  if (timer) clearTimeout(timer)
  timer = null
  const now = Date.now()
  if (!mayReload(document.hidden, lastInputAt, now)) {
    timer = setTimeout(reloadWhenQuiet, QUIET_MS - (now - lastInputAt))
    return false
  }
  sessionStorage.setItem(RELOADED_FOR, pending)
  location.reload()
  return true
}

const INPUT_TYPES = ['keydown', 'pointerdown', 'wheel', 'touchstart']
const touched = () => {
  lastInputAt = Date.now()
}
const onVisibility = () => {
  if (document.hidden) reloadWhenQuiet()
  else void reloadIfStale()
}
const onFocus = () => void reloadIfStale()

/** Starts looking for new builds: every minute, on coming back into view, and on focus (once per window). Returns what stops it. */
export function watchBundle(): () => void {
  // Tests run the store with stand-ins for window and document, or none.
  if (watching || typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return () => {}
  watching = true
  for (const type of INPUT_TYPES) window.addEventListener(type, touched, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  // A hidden window looks when it comes back into view (above), not every minute.
  const every = setInterval(() => {
    if (!document.hidden) void reloadIfStale()
  }, LOOK_EVERY_MS)
  return () => {
    for (const type of INPUT_TYPES) window.removeEventListener(type, touched, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    clearInterval(every)
    if (timer) clearTimeout(timer)
    timer = null
    watching = false
  }
}
