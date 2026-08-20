// web/src/lib/session-clipboard.ts — what "copy the session file location" actually puts on the
// clipboard.
//
// The path alone is a fact about the disk. What people do NEXT with it is hand the session to
// another agent and ask it to carry on, and for that they also need what the conversation was
// CALLED and a sentence to open with. Both parts are settings (see composables/useUiPrefs.ts) and
// both default on, because a setting you have to go and find is a setting that does nothing.
//
// Turning both off must give back the bare path this action always copied, byte for byte. That is
// why the path is written last and unadorned rather than labelled: with the extras off there is
// nothing to strip, and a paste into a terminal still works.

export interface SessionPathClipboard {
  /** Absolute path to the transcript. Always included; it is the thing the action is named for. */
  path: string
  /** The session's title, as the list shows it. */
  title: string
  includeName: boolean
  includePrompt: boolean
  prompt: string
}

export function composeSessionPathClipboard(opts: SessionPathClipboard): string {
  const lines: string[] = []
  // Prompt FIRST. The paste is meant to be sendable as it stands, and an instruction arriving after
  // its own context reads as an afterthought. The blank line keeps it from running into the title.
  const prompt = opts.prompt.trim()
  if (opts.includePrompt && prompt) lines.push(prompt, '')
  // Trimmed and skipped when empty, so a session with no title cannot contribute a blank line that
  // silently turns a one-line clipboard into two.
  const title = opts.title.trim()
  if (opts.includeName && title) lines.push(title)
  lines.push(opts.path)
  return lines.join('\n')
}
