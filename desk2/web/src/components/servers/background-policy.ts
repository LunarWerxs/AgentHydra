// Which page views of a browser pane stay alive when the person leaves their chat (pure: background-views.ts holds the
// views). A tab playing sound keeps playing in the background, as in Chrome; a silent one is closed so memory does not grow.

/** A view kept for a chat that is not on screen. `silentSince` is when it was last seen not playing (null while it plays). */
export interface KeptView {
  key: string
  chatId: string
  viewId: string
  /** The address the tab opened it at: how the chat's tab finds it again. */
  url: string
  keptAt: number
  silentSince: number | null
}

/** A view stops playing for this long while its chat is off screen and it is closed. */
export const SILENCE_MS = 60_000
/** Most views kept at once. */
export const MAX_KEPT = 6

/** The audio key of a chat: the sidebar's rows key an outside session by its own id, the pane by `external:<id>`. */
export const audioKey = (chatId: string): string => (chatId.startsWith('external:') ? chatId.slice('external:'.length) : chatId)

/** On leaving a chat: keep the view only while it plays and its tab was not closed or pointed elsewhere. */
export const shouldKeep = (playing: boolean, tabClosed: boolean): boolean => playing && !tabClosed

/** Over the cap, which views go: silent ones first, the oldest of each kind first. `incoming` is the newest, so it goes last. */
export function evictForCap(kept: readonly KeptView[], max: number = MAX_KEPT): string[] {
  const over = kept.length - max
  if (over <= 0) return []
  const order = [...kept].sort((a, b) => Number(b.silentSince !== null) - Number(a.silentSince !== null) || a.keptAt - b.keptAt)
  return order.slice(0, over).map((k) => k.key)
}

/** One look at the kept views: notes who is silent, and names those to close (silent for 60 s, or their chat is gone). */
export function lookAtKept(
  kept: readonly KeptView[],
  playing: (viewId: string) => boolean,
  chatLive: (chatId: string) => boolean,
  now: number
): { kept: KeptView[]; close: string[] } {
  const next: KeptView[] = []
  const close: string[] = []
  for (const k of kept) {
    const silentSince = playing(k.viewId) ? null : (k.silentSince ?? now)
    if (!chatLive(k.chatId) || (silentSince !== null && now - silentSince >= SILENCE_MS)) close.push(k.key)
    else next.push({ ...k, silentSince })
  }
  return { kept: next, close }
}
