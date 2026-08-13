// web/src/lib/session-shape.ts — what KIND of session this was, at a glance.
//
// A session list is a wall of near-identical rows, and the thing that separates them for a reader
// is rarely the title: it is whether this was a two-minute question or a six-hour build. Both
// inputs are already on every row (message count and the two timestamps), so this is pure
// classification — nothing is stored, nothing is fetched, and changing the thresholds cannot
// invalidate anything.
//
// WHY TWO AXES AND NOT JUST MESSAGE COUNT. They disagree in both directions, and each disagreement
// is a real session shape:
//
//   30 messages over 6 hours   → a long sitting with a lot of thinking between turns, not "standard"
//   300 messages in 12 minutes → a fast automated grind, not "deep"
//
// Taking the LARGER of the two verdicts means a session is described by whichever dimension makes
// it notable. Under-calling a marathon is the failure that matters; over-calling one is not.
//
// 'automation' is not a fifth point on that scale — it is a different question ("did a person drive
// this?") and it wins outright, because for a queued run the message count says something about the
// prompt rather than about anyone's afternoon.

export type SessionShape = 'automation' | 'quick' | 'standard' | 'deep' | 'marathon'

/** Ordered, so "the larger of the two verdicts" is a comparison rather than a lookup table. */
const SCALE: readonly SessionShape[] = ['quick', 'standard', 'deep', 'marathon']

/**
 * Upper bounds, exclusive. The last bucket has none: anything past `deep` is a marathon.
 *
 * MEASURED, NOT GUESSED. Set from the 50th/75th/90th percentiles of 440 real local sessions
 * (messages 25 / 469 / 1065; span 12m / 149m / 463m), so the four labels land on roughly
 * 45 / 20 / 15 / 20 percent of a real store. The first attempt used round numbers instead
 * (20/100/400 messages, 10/60/240 minutes) and put a THIRD of everything in "marathon" while
 * "standard" described 7 percent, which is a scale with no middle: when the extreme label is also
 * the common one, the labels have stopped saying anything.
 *
 * The time axis is a SPAN, gaps included: a session opened in the morning and picked up after lunch
 * measures six hours whatever happened in between. That is deliberate, because coming back to a
 * piece of work all day is exactly what "marathon" should catch, but it is a claim about how long a
 * session was ALIVE rather than about time spent typing, and no timestamp in a transcript can tell
 * those two apart.
 */
const BY_MESSAGES = [25, 450, 1000]
const BY_MINUTES = [15, 150, 480]

function rank(value: number, bounds: readonly number[]): number {
  for (let i = 0; i < bounds.length; i++) if (value < (bounds[i] ?? 0)) return i
  return bounds.length
}

export interface ShapeInput {
  message_count: number
  created_at: number | null
  last_activity_at: number
  dispatched: boolean
}

export function sessionShape(s: ShapeInput): SessionShape {
  if (s.dispatched) return 'automation'
  // A missing start time is common enough not to be an error: some transcripts carry no timestamp
  // on their first line. Message count alone then decides, rather than a duration of "now".
  const minutes =
    s.created_at === null ? null : Math.max(0, (s.last_activity_at - s.created_at) / 60_000)
  const byMessages = rank(s.message_count, BY_MESSAGES)
  const byTime = minutes === null ? 0 : rank(minutes, BY_MINUTES)
  return SCALE[Math.max(byMessages, byTime)] ?? 'quick'
}

/** How a session list narrows by shape. 'all' is the default and is never applied on our own. */
export type ShapeScope = 'all' | SessionShape
export const SHAPE_SCOPES: readonly ShapeScope[] = [
  'all',
  'quick',
  'standard',
  'deep',
  'marathon',
  'automation',
]
