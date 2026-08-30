// server/src/new-chat-defaults.ts - owner directive 2026-08-30: "every time you start a new
// chat. unless you have a specific compelling reason to do so it should always be started in
// Opus 5 Ultra code. Which is not Max I believe it is a level above that."
//
// Decoded against the machine rather than guessed (2026-08-30): no 'ultra' MODEL or EFFORT
// exists anywhere - his real transcripts carry claude-opus-5 / claude-fable-5, and the bundled
// CLI's effort ladder tops out at max (low, medium, high, xhigh, max). The thing that IS "a
// level above max" is ULTRACODE - Claude Code's exhaustive multi-agent session mode, armed by
// the literal keyword appearing in the prompt. So "Opus 5 Ultra code" = model 'opus' (the CLI
// alias for the latest Opus, today claude-opus-5) + the ultracode keyword in the first prompt.
//
// The compelling-reason escape is EXPLICITNESS: a caller that names a model keeps it, and a
// caller that passes ultracode:false skips the keyword. Defaults only ever fill silence.

import { getSetting } from './db'

export const ULTRACODE_KEYWORD = 'ultracode'

export function defaultNewChatModel(): string {
  const v = getSetting('new_chat_model').trim()
  return v || 'opus'
}

export function newChatUltracodeEnabled(): boolean {
  return getSetting('new_chat_ultracode') !== '0'
}

/** Prepend the keyword on its own line unless the prompt already carries it - idempotent, so
 *  re-applying defaults (or a caller who already typed it) never doubles the word. */
export function withUltracode(prompt: string): string {
  return /\bultracode\b/i.test(prompt) ? prompt : `${ULTRACODE_KEYWORD}\n\n${prompt}`
}

/** The one chokepoint: what model and prompt does a NEW automated chat actually start with?
 *  Resumes and explicit choices pass through untouched. */
export function applyNewChatDefaults(spec: {
  newChat: boolean
  model?: string | null
  prompt: string
  /** Explicit opt-out (the compelling-reason escape for the keyword). */
  ultracode?: boolean
}): { model: string | null; prompt: string } {
  if (!spec.newChat) return { model: spec.model?.trim() || null, prompt: spec.prompt }
  const model = spec.model?.trim() || defaultNewChatModel()
  const wantUltra = spec.ultracode ?? newChatUltracodeEnabled()
  return { model, prompt: wantUltra ? withUltracode(spec.prompt) : spec.prompt }
}
