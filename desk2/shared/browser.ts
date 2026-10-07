// The browser pane's contract: the saved browsers of a chat's workspace, and the live view of one.
//
// A saved browser is a managed Chrome profile of the Connections MCP (its local browser_* tools): a chat's AI opens,
// drives and signs it in through those tools, and the MCP records what it holds. Desk 2 lists the profiles of the
// chat's workspace, shows one live in the servers pane and lets the person click and type into it (to log in, say).
// Desk 2 never writes the profile store: notes, logins and new profiles are the MCP's to record.
//
// server/src/browser/ answers these routes; web/src/components/servers/ draws them; the transcript's Browser card
// fires OPEN_BROWSER_EVENT.

export const BROWSER_BASE = '/api/browser'
/** GET ?cwd=<chat folder> -> BrowserProfiles. */
export const BROWSER_PROFILES = `${BROWSER_BASE}/profiles`
/**
 * POST { cwd, profile, url?, login? } -> BrowserOpened: the profile's Chrome, started visible when none runs on it.
 * login:true starts it with nothing attached (no debugging port, as the MCP's browser_profile_login does, so sign-in
 * walls behave): the person signs in in that window and the pane has no live view of it until it closes.
 */
export const BROWSER_OPEN = `${BROWSER_BASE}/open`
/**
 * POST { cwd, profile } -> { closed }: closes the profile's Chrome (what closing its pane tab means). closed is false when
 * none ran, or one that has no debugging port (a sign-in window) that is the person's to close. 404/403 as BROWSER_OPEN.
 */
export const BROWSER_CLOSE = `${BROWSER_BASE}/close`
/**
 * The window event the pane fires, detail { profile }, when it closed that profile's browser: its Browser card shows
 * Closed at once instead of waiting for its next look.
 */
export const BROWSER_CLOSED_EVENT = 'hydra-desk:browser-closed'
/** GET ?cwd=&profile= -> BrowserTab[]: the pages of the profile's running Chrome. 409 when it is not open. */
export const BROWSER_TABS = `${BROWSER_BASE}/tabs`
/** POST { cwd, profile, url } -> BrowserTab: a NEW page of the profile's running Chrome at that http(s) address (no page that exists is navigated). 409 when not open. */
export const BROWSER_PAGE = `${BROWSER_BASE}/page`
/**
 * POST { cwd, profile, tab } -> { closed }: closes that one page (what closing its pane tab means); the Chrome stays unless that was its
 * last page. closed is false when no such page. 404/403/409 as BROWSER_TABS.
 */
export const BROWSER_PAGE_CLOSE = `${BROWSER_BASE}/page/close`
/** A page the pane gives a tab: an http(s) or file address. about:*, chrome://, devtools://, data:, blob: and empty are blank. */
export function isRealPage(url: string | null | undefined): boolean {
  return /^(https?|file):\/\//i.test((url ?? '').trim())
}
/**
 * GET ?cwd=&profile= -> a small JPEG (about 640px wide) of the profile's current page, Cache-Control: no-store.
 * 404 when the profile is not open, 403 for another workspace's profile; it never starts a Chrome.
 */
export const BROWSER_PREVIEW = `${BROWSER_BASE}/preview`
/** WebSocket ?cwd=&profile=&tab=<id, optional>: BrowserLiveOut from the server, BrowserLiveIn from the page. */
export const BROWSER_LIVE = `${BROWSER_BASE}/live`
/**
 * WebSocket ?cwd=&profile=: BrowserPreviewOut from the server, nothing accepted from the page (input is never forwarded).
 * The transcript Browser card's low-fps stream of the profile's page: at most about 5 frames a second, about 640px wide,
 * shared with the pane's live view when that shows the page. 409 when the profile is not open, 404 for another workspace's.
 */
export const BROWSER_PREVIEW_STREAM = `${BROWSER_BASE}/preview-stream`

/**
 * The window event the transcript's Browser card fires, detail BrowserOpenRequest: DeskFrame opens the servers pane
 * and the pane shows that browser (live when the profile's Chrome runs, else the address).
 */
export const OPEN_BROWSER_EVENT = 'hydra-desk:open-browser'

export interface BrowserOpenRequest {
  /** The profile the AI drove (profile:'<name>' on its browser_* call); absent for the person's own browser. */
  profile?: string
  url?: string
}

export type BrowserSiteState = 'reached' | 'signin-wall' | 'challenged'

export interface BrowserSite {
  host: string
  state: BrowserSiteState
  /** ISO time it was seen. */
  at: string
}

export interface BrowserProfile {
  /** The name a browser_* tool takes as profile:'<name>'. */
  name: string
  /** A short display name the AI gave it (browser_profile_note's title); absent when none was set. */
  title?: string
  /** What it holds and is for, as the AI recorded it (browser_profile_note); null when none was recorded. */
  note: string | null
  /** Hosts it was last seen to reach or be stopped at, newest first. */
  sites: BrowserSite[]
  /** Hosts its cookie store holds a session for (host names only, never a value). */
  sessionHosts: string[]
  /** A Chrome runs on it now and answers on its debugging port. */
  open: boolean
  /** The chat's workspace owns it; false for a profile nobody owns, listed only while it is open. */
  own: boolean
  /** ISO time it was last used, or null. */
  lastUsedAt: string | null
}

export interface BrowserProfiles {
  /** The store's name for the chat's workspace, or null when that folder has no saved browsers yet. */
  workspace: string | null
  profiles: BrowserProfile[]
  /** Why the store could not be read; a missing store is an empty list and no error. */
  error?: string
}

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export interface BrowserOpened {
  profile: string
  /** Desk 2 started the Chrome (false: one already ran on the profile). */
  started: boolean
  tab: BrowserTab | null
}

/** Server to page over BROWSER_LIVE. */
export type BrowserLiveOut =
  /** One screencast frame: base64 JPEG, and the page viewport it shows in CSS pixels. */
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'page'; tab: BrowserTab; canGoBack: boolean; canGoForward: boolean }
  | { type: 'tabs'; tabs: BrowserTab[] }
  | { type: 'closed'; reason: string }

/** Server to card over BROWSER_PREVIEW_STREAM. */
export type BrowserPreviewOut =
  /** One frame: base64 JPEG, and its size in pixels (0 when unknown). */
  | { type: 'frame'; data: string; width: number; height: number }
  /** The stream ended (the browser closed, or the page could not be shown); the card falls back to polling. */
  | { type: 'closed'; reason: string }

/** Page to server over BROWSER_LIVE. Coordinates are page CSS pixels; modifiers is CDP's bit field (Alt 1, Ctrl 2, Meta 4, Shift 8). */
export type BrowserLiveIn =
  | {
      type: 'mouse'
      event: 'down' | 'up' | 'move'
      x: number
      y: number
      button: 'left' | 'middle' | 'right' | 'none'
      clickCount: number
      modifiers: number
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; event: 'down' | 'up'; key: string; code: string; modifiers: number; text?: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'history'; go: 'back' | 'forward' | 'reload' }
  | { type: 'tab'; id: string }
  /** The size in CSS pixels the live canvas box has; the page is laid out at it so it fills the pane. */
  | { type: 'viewport'; width: number; height: number }
