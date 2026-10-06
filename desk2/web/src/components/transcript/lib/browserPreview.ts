// The live preview of a Browser card: one small JPEG of the profile's page, fetched every few seconds by the newest
// card of that profile only. The open/closed answer is one shared, briefly cached read of the saved browsers.
import { BROWSER_PREVIEW, BROWSER_PROFILES, type BrowserProfiles } from '@shared/browser'

export const PREVIEW_EVERY_MS = 3000

const known = new Map<string, { at: number; open: Promise<Set<string> | null> }>()

/** The names of the chat folder's browsers that run now (own ones only), or null when the read failed (unknown, not closed); shared by every card for a few seconds. */
export function openProfiles(cwd: string, now = Date.now()): Promise<Set<string> | null> {
  const hit = known.get(cwd)
  if (hit && now - hit.at < PREVIEW_EVERY_MS - 500) return hit.open
  const open = fetch(`${BROWSER_PROFILES}?${new URLSearchParams({ cwd })}`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? (r.json() as Promise<BrowserProfiles>) : Promise.reject(new Error(String(r.status)))))
    .then((p) => new Set(p.profiles.filter((x) => x.open && x.own).map((x) => x.name)))
    .catch(() => null)
  known.set(cwd, { at: now, open })
  return open
}

/** The next frame of the profile as an object URL, loaded and decoded so showing it never flashes blank; null when the browser is not open. */
export async function nextFrame(cwd: string, profile: string): Promise<string | null> {
  const res = await fetch(`${BROWSER_PREVIEW}?${new URLSearchParams({ cwd, profile })}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
  if (!res.ok) return null
  const url = URL.createObjectURL(await res.blob())
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  return url
}
