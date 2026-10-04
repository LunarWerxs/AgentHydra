// When a server notify event (finished, needs you, error, limited) becomes a desktop notification.

export interface NoticeContext {
  /** Settings' notifications switch; undefined until the settings arrive (on by default). */
  enabled: boolean | undefined
  /** The window is hidden (minimised, another tab). */
  hidden: boolean
  /** The chat is the one open in the window. */
  viewing: boolean
}

/** Notifications on, and the chat not already in front of the owner. */
export function wantsDesktopNotice(c: NoticeContext): boolean {
  return c.enabled !== false && (c.hidden || !c.viewing)
}
