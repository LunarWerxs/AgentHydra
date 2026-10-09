// Which chats make sound through the headless Chrome profiles, and muting one chat's pages (server: browser/headless-audio-runtime.ts).

export const HEADLESS_AUDIO = '/api/browser/audio'
export const HEADLESS_AUDIO_MUTE = '/api/browser/audio/mute'
export const HEADLESS_AUDIO_EVENT = 'browser.audio'

export interface HeadlessAudioState {
  /** Chats with a page making sound now. */
  audible: string[]
  /** Chats this Desk has muted (their pages stay silent until unmuted). */
  muted: string[]
  /** Audible pages no chat owns (no ledger entry, or an mcp:/pid: owner). */
  unattributed: { profile: string; url: string }[]
}

export interface HeadlessAudioMuteIn {
  chat: string
  muted: boolean
}
