// Page views that outlive their pane. ServersPane is keyed by chat, so a chat switch destroys its PageTabs; a tab whose
// view plays sound hands the view here instead of closing it (hidden, still playing, still counting for its chat's row), and
// the chat's tab adopts it again when the person returns. Decisions are in background-policy.ts.
import type { HostView } from './native-browser'
import { viewPlaying } from '@/lib/chat-audio'
import { audioKey, evictForCap, type KeptView, lookAtKept, shouldKeep } from './background-policy'

export interface BackgroundDeps {
  playing: (viewId: string) => boolean
  chatLive: (chatId: string) => boolean
  now: () => number
}

interface Entry extends KeptView {
  view: HostView
  /** Ends the view's registration with the chat's audio (lib/chat-audio.ts registerView's undo). */
  unregister: (() => void) | null
}

export function createBackgroundViews(deps: BackgroundDeps) {
  const kept = new Map<string, Entry>()
  /** Tabs closed or retargeted while their pane lives: their view must not be kept when the page tab unmounts. */
  const closing = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  const slot = (chatId: string, url: string) => `${audioKey(chatId)}|${url}`

  function drop(key: string) {
    const e = kept.get(key)
    if (!e) return
    kept.delete(key)
    e.unregister?.()
    e.view.close()
    if (!kept.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function look() {
    const r = lookAtKept([...kept.values()], deps.playing, deps.chatLive, deps.now())
    for (const k of r.kept) {
      const e = kept.get(k.key)
      if (e) e.silentSince = k.silentSince
    }
    for (const key of r.close) drop(key)
  }

  return {
    /** The tab at `url` of this chat is being closed or pointed elsewhere. */
    tabClosing(chatId: string, url: string) {
      closing.add(slot(chatId, url))
    },
    /** A page tab unmounts. Returns true when it keeps the view (hidden, still playing); false means the caller closes it. */
    leave(chatId: string, url: string, view: HostView, unregister: (() => void) | null): boolean {
      const key = slot(chatId, url)
      const tabClosed = closing.delete(key)
      if (!view.isOpen || !shouldKeep(deps.playing(view.id), tabClosed)) return false
      const old = kept.get(key)
      if (old && old.view !== view) drop(key)
      view.place(null)
      const now = deps.now()
      kept.set(key, { key, chatId, viewId: view.id, url, keptAt: now, silentSince: null, view, unregister })
      for (const gone of evictForCap([...kept.values()])) drop(gone)
      timer ??= setInterval(look, 5000)
      return true
    },
    /** The chat's tab at `url` comes back: the kept view, no longer kept, or null. */
    adopt(chatId: string, url: string): HostView | null {
      const key = slot(chatId, url)
      const e = kept.get(key)
      if (!e) return null
      // Its registration with the chat's audio stays: the page tab registers it again, and the host only reports a change
      // of sound, so dropping `playing` here would leave the speaker off for a view that plays on.
      kept.delete(key)
      if (!kept.size && timer) {
        clearInterval(timer)
        timer = null
      }
      return e.view
    },
    look,
    has: (chatId: string, url: string) => kept.has(slot(chatId, url)),
    size: () => kept.size,
    /** Closes every kept view of a chat (archived, deleted). */
    dropChat(chatId: string) {
      for (const [key, e] of kept) if (e.chatId === chatId) drop(key)
    },
  }
}

let live: (chatId: string) => boolean = () => true

/** The window's one registry. */
export const backgroundViews = createBackgroundViews({ playing: viewPlaying, chatLive: (c) => live(c), now: Date.now })

/** Tells the registry which chats still exist and are not archived (DeskFrame); a kept view of any other is closed. */
export function setChatLive(fn: (chatId: string) => boolean) {
  live = fn
  backgroundViews.look()
}
