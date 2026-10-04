// server/src/rewake-cooldown.ts - an escalating hold on auto-resumes that keep producing nothing.
//
// WHY THIS EXISTS. The auto-resume monitor (monitor.ts) re-wakes a session every time it stops at
// a 5-hour wall, up to the per-session attempt cap. A session that wakes, writes no real turn and
// stops again is a loop that only burns quota: every wake re-reads the whole context and does no
// work. The attempt cap bounds how MANY such wakes happen; this bounds how FAST they come. After
// two resumes in a row that added no real turn, the next one is held back by a cooldown that starts
// at two minutes, doubles per further empty resume and caps at thirty. Any real turn - the model
// doing work, or a person typing into the chat - resets the streak to zero, so a session that is
// actually moving is never slowed down.
//
// The idea comes from paperclipai/paperclip's issue re-wake throttle (MIT); this is written fresh
// for AgentHydra, with no code copied.
//
// Everything here is pure except readProgressMark, which reads one transcript off disk.

import { isApiErrorEvent } from './rate-limit-signal'
import { findTranscript } from './transcript'

/** Empty resumes in a row that are still let through at full speed. */
export const REWAKE_FREE_EMPTY_RESUMES = 2
/** The first hold, once the free empty resumes are spent. */
export const REWAKE_COOLDOWN_BASE_MS = 120_000
/** The hold never grows past this, however long the empty streak. */
export const REWAKE_COOLDOWN_CAP_MS = 30 * 60_000

/**
 * How long to hold the next resume, given how many resumes in a row added no real turn.
 * 0 and 1 wait nothing; 2 waits 2 min; each further one doubles, capped at 30 min.
 */
export function rewakeCooldownMs(emptyStreak: number): number {
  if (!Number.isFinite(emptyStreak) || emptyStreak < REWAKE_FREE_EMPTY_RESUMES) return 0
  const doublings = Math.floor(emptyStreak) - REWAKE_FREE_EMPTY_RESUMES
  // Past ~14 doublings the product already exceeds the cap; stop multiplying before it overflows.
  if (doublings >= 14) return REWAKE_COOLDOWN_CAP_MS
  return Math.min(REWAKE_COOLDOWN_CAP_MS, REWAKE_COOLDOWN_BASE_MS * 2 ** doublings)
}

/**
 * The empty streak after this stop, from the previous resume's record and the transcript now.
 *
 * `prior.mark` is the progress mark taken when the previous resume was scheduled. If the transcript
 * holds no more real turns now than it did then, that resume came and went without doing anything,
 * so the streak grows by one. Any growth resets it. An unreadable mark on either side is not proof
 * of an empty resume, so it resets too: the hold must never fire on a guess.
 */
export function nextEmptyStreak(
  prior: { mark: number | null; streak: number } | null,
  currentMark: number | null,
): number {
  if (!prior || prior.mark == null || currentMark == null) return 0
  return currentMark > prior.mark ? 0 : prior.streak + 1
}

/** Text a user record carries, or '' for a pure tool_result record (the model's own plumbing). */
function userText(ev: any): string {
  const content = ev?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
}

/**
 * Count the real turns in a Claude transcript: model-written assistant records, plus user messages
 * a person typed. Left out on purpose: the CLI's own bookkeeping (isMeta lines, `<synthetic>`
 * replies), API error notices such as the rate-limit wall itself, tool_result records, and the
 * monitor's own resume prompt - a wake that only restates "resume" is exactly what must not count
 * as progress. The number only has to grow when real work or a real message lands; its absolute
 * value means nothing.
 */
export function countProgressTurns(jsonl: string, resumePrompt: string): number {
  const nudge = resumePrompt.trim()
  let turns = 0
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue // a torn last line is not a turn
    }
    if (ev?.isMeta === true || isApiErrorEvent(ev)) continue
    if (ev?.type === 'assistant') {
      turns++
    } else if (ev?.type === 'user') {
      const text = userText(ev).trim()
      if (text && text !== nudge) turns++
    }
  }
  return turns
}

/** The progress mark of a session's transcript right now, or null when it cannot be read. */
export async function readProgressMark(
  sessionId: string,
  resumePrompt: string,
): Promise<number | null> {
  const tf = findTranscript(sessionId, 'claude')
  if (!tf) return null
  try {
    return countProgressTurns(await Bun.file(tf.path).text(), resumePrompt)
  } catch {
    return null
  }
}
