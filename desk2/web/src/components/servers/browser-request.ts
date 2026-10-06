// The transcript's Browser card fires OPEN_BROWSER_EVENT; the servers pane is lazy-loaded and may mount after it
// fired, so main.ts imports this module at startup and the latest request waits here for the pane.
import { ref } from 'vue'
import { OPEN_BROWSER_EVENT, type BrowserOpenRequest } from '@shared/browser'

/** The latest request; the pane watches it. */
export const browserRequest = ref<BrowserOpenRequest | null>(null)

const claimed = new WeakSet<object>()

/** The latest request when no pane has acted on it yet (a pane that mounts later does not repeat an old one). */
export function claimBrowserRequest(): BrowserOpenRequest | null {
  const r = browserRequest.value
  if (!r || claimed.has(r)) return null
  claimed.add(r)
  return r
}

if (typeof window !== 'undefined') {
  window.addEventListener(OPEN_BROWSER_EVENT, (e) => {
    const d = (e as CustomEvent<BrowserOpenRequest | undefined>).detail
    browserRequest.value = { profile: d?.profile || undefined, url: d?.url || undefined }
  })
}
