// Which chats are making sound, and which the person muted, as a browser tab does: a chat is audible while a video in its
// transcript plays with sound or one of its browser-pane page views (AgentHydra's window only, native-browser.ts) says it
// plays; muting a chat silences both. The sidebar row shows the speaker (components/sidebar/AudioButton.vue). Kept in
// memory, and in sessionStorage so a page reload keeps it.
import { reactive } from 'vue'

const KEY = 'hydra-desk.chat-audio.muted'

/** The part of a <video> this store reads and sets (a test passes a plain object). */
export interface VideoLike {
  muted: boolean
  paused: boolean
  ended: boolean
  volume: number
  isConnected: boolean
}

function restore(): Record<string, boolean> {
  try {
    const ids = JSON.parse(globalThis.sessionStorage?.getItem(KEY) ?? '[]')
    return Array.isArray(ids) ? Object.fromEntries(ids.filter((i) => typeof i === 'string').map((i) => [i, true])) : {}
  } catch {
    return {}
  }
}
function persist() {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(Object.keys(state.muted).filter((k) => state.muted[k])))
  } catch {
    // storage refused: the mute lasts until the window closes
  }
}

const state = reactive({
  muted: restore(),
  /** chat id -> a video in its transcript plays with sound */
  video: {} as Record<string, boolean>,
  /** page view id -> the chat whose browser pane owns it */
  viewChat: {} as Record<string, string>,
  /** page view id -> the host says it plays sound */
  playing: {} as Record<string, boolean>,
})
const videos = new Map<string, Set<VideoLike>>()
/** Videos this store muted for a muted chat: the ones that get their sound back when the chat does. */
const forced = new WeakSet<VideoLike>()
const sendMute = new Map<string, (muted: boolean) => void>()

export const isMuted = (chatId: string): boolean => !!state.muted[chatId]

export function isAudible(chatId: string): boolean {
  if (state.video[chatId]) return true
  for (const [view, chat] of Object.entries(state.viewChat)) if (chat === chatId && state.playing[view]) return true
  return false
}

/** What a row's speaker shows: null while the chat is neither audible nor muted; else the icon and what a click does. */
export function speakerFor(chatId: string): { muted: boolean; label: string } | null {
  const muted = isMuted(chatId)
  if (!muted && !isAudible(chatId)) return null
  return { muted, label: muted ? 'Unmute this chat' : 'Mute this chat' }
}

function look(chatId: string) {
  const set = videos.get(chatId)
  if (set) for (const v of set) if (!v.isConnected) set.delete(v)
  state.video[chatId] = !!set && [...set].some((v) => !v.paused && !v.ended && !v.muted && v.volume > 0)
}

export function setMuted(chatId: string, muted: boolean) {
  if (!!state.muted[chatId] === muted) return
  if (muted) state.muted[chatId] = true
  else delete state.muted[chatId]
  persist()
  for (const v of videos.get(chatId) ?? []) {
    if (muted && !v.muted) {
      forced.add(v)
      v.muted = true
    } else if (!muted && forced.has(v)) {
      forced.delete(v)
      v.muted = false
    }
  }
  look(chatId)
  for (const [view, chat] of Object.entries(state.viewChat)) if (chat === chatId) sendMute.get(view)?.(muted)
}

export const toggleMuted = (chatId: string) => setMuted(chatId, !isMuted(chatId))

/** A play, pause, end or volume change of a transcript video of this chat. A video the person unmutes in a muted chat unmutes the chat. */
export function videoChanged(chatId: string, v: VideoLike) {
  let set = videos.get(chatId)
  if (!set) videos.set(chatId, (set = new Set()))
  set.add(v)
  if (!v.muted) forced.delete(v)
  if (state.muted[chatId] && !v.muted) setMuted(chatId, false)
  look(chatId)
}

/** The chat's transcript is gone (another chat opened): its videos no longer count. */
export function clearVideos(chatId: string) {
  videos.delete(chatId)
  state.video[chatId] = false
}

/** A page view of this chat's browser pane. `mute` tells the host; a view of a muted chat is muted at once. Returns the undo for its close. */
export function registerView(chatId: string, viewId: string, mute: (muted: boolean) => void): () => void {
  state.viewChat[viewId] = chatId
  sendMute.set(viewId, mute)
  if (state.muted[chatId]) mute(true)
  return () => {
    delete state.viewChat[viewId]
    delete state.playing[viewId]
    sendMute.delete(viewId)
  }
}

/** The host's `audio` event for a page view. */
export function viewAudio(viewId: string, playing: boolean) {
  if (viewId in state.viewChat) state.playing[viewId] = playing
}

const VIDEO_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange'] as const

/** Follows every <video> inside a chat's transcript (the events do not bubble: a capture listener on the root hears them all). Returns the stop. */
export function watchTranscript(root: HTMLElement, chatId: string): () => void {
  const onEvent = (e: Event) => {
    if (e.target instanceof HTMLVideoElement) videoChanged(chatId, e.target)
  }
  for (const t of VIDEO_EVENTS) root.addEventListener(t, onEvent, true)
  // A video scrolled out of the window or replaced is removed without a pause event.
  const gone = new MutationObserver(() => look(chatId))
  gone.observe(root, { childList: true, subtree: true })
  return () => {
    for (const t of VIDEO_EVENTS) root.removeEventListener(t, onEvent, true)
    gone.disconnect()
    clearVideos(chatId)
  }
}

/** Test seam: forget everything. */
export function resetChatAudio() {
  for (const k of Object.keys(state.muted)) delete state.muted[k]
  for (const k of Object.keys(state.video)) delete state.video[k]
  for (const k of Object.keys(state.viewChat)) delete state.viewChat[k]
  for (const k of Object.keys(state.playing)) delete state.playing[k]
  videos.clear()
  sendMute.clear()
}
