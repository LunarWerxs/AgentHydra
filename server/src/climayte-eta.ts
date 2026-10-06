// server/src/climayte-eta.ts — how long a CliMayte worker said its task would take, against how long it
// really took (docs/CLIMAYTE.md "Time estimates"). Pure: climayte.ts records the estimate from the
// worker's stream and the time when its turn ends, and the launch puts the calibration note in the
// worker brief.
//
// WHY (owner, 2026-10-05): "I would love for them if they could somehow say estimated times ... it
// could be like estimated five minutes ... and then we could get better at improving the prompt we
// give the sub-agents for estimating time until they can actually estimate time properly." The
// brief asks for one `ETA: <n> min` line before the first tool call; every finished message is a
// sample of what was said against the working time it took, and the next worker's brief carries the
// median ratio of the newest samples (of its kind once there are enough), so an agent that keeps
// estimating short is told by how much.

/** What a worker said one message would take. */
export interface CliMayteEta {
  /** Its estimate, in minutes. */
  minutes: number
  /** When it said it (epoch ms; the event's own time). */
  at: number
  /** The attempt it said it in (an index into `attempts`): the working time is counted from there. */
  attempt: number
  /** Working seconds from `at` until the message's turn ended done (etaTookSeconds): the time its
   *  CLI ran, not the waits for an account between attempts. Absent until then. */
  tookS?: number
  /** When the turn ended (epoch ms). Absent until then. */
  doneAt?: number
  /** The whole `ETA:` line as it was written (trimmed, at most ETA_LINE_MAX chars). */
  line?: string
  /** When the worker was asked why its estimate missed (the Stop hook, stopDecision). Once per message. */
  reviewAskedAt?: number
  /** Its answer to that question (parseReview). */
  review?: EtaReview
}

/** The causes a review names; anything else is kept as `other` with the word it wrote. */
export const ETA_CAUSES = [
  'human-pace',
  'scope-smaller',
  'scope-larger',
  'slow-commands',
  'waiting',
  'rework',
  'padding',
  'unclear-ask',
  'other',
] as const

/** A worker's answer to the review question. */
export interface EtaReview {
  why: string
  cause: string
  /** The word it wrote when that was not one of ETA_CAUSES. */
  raw?: string
}

export const ETA_LINE_MAX = 300
export const ETA_TEXT_MAX = 2000

/** An estimate past a day is not one. */
const MAX_ETA_MIN = 24 * 60

/** The start of an estimate line: `ETA: ~5 min`, `**ETA:** 12 minutes`, `- ETA 1h 20m`. */
const ETA_LINE =
  /(?:^|\n)[ \t]*(?:[*_>#`-]+[ \t]*)*ETA\b[*_`]*[ \t]*[:=–—-]?[ \t]*[*_`]*[ \t]*(?:~|≈|about|approx(?:imately|\.)?|around|roughly)?[ \t]*/i

/** One amount: `5`, `5.5`, `5-10`, `5 to 10`, with its unit when it has one. */
const AMOUNT =
  /[ \t]*(\d+(?:\.\d+)?)(?:[ \t]*(?:-|–|to)[ \t]*(\d+(?:\.\d+)?))?[ \t]*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)?(?![a-z])/iy

const unitMinutes = (unit: string): number => {
  const u = unit.toLowerCase()
  return u.startsWith('h') ? 60 : u.startsWith('s') ? 1 / 60 : 1
}

/** The minutes an `ETA:` line in `text` names, or null when it has none. A bare number is minutes;
 *  `1h 20m` adds up; a range counts as its middle. Only the amounts right after `ETA:` count, so
 *  `ETA: 5 min (the tests take 2)` is 5. */
export function parseEta(text: string): number | null {
  return parseEtaFull(text)?.minutes ?? null
}

/** The estimate and the whole line it was written on (trimmed, cut at ETA_LINE_MAX). */
export function parseEtaFull(text: string): { minutes: number; line: string } | null {
  const head = ETA_LINE.exec(text)
  if (!head) return null
  let pos = head.index + head[0].length
  let total = 0
  let parts = 0
  for (;;) {
    AMOUNT.lastIndex = pos
    const m = AMOUNT.exec(text)
    if (!m) break
    const lo = Number(m[1])
    const value = m[2] === undefined ? lo : (lo + Number(m[2])) / 2
    if (!m[3] && parts > 0) break // `1h 20` would read the 20 as minutes; stop instead
    total += value * (m[3] ? unitMinutes(m[3]) : 1)
    parts++
    pos = AMOUNT.lastIndex
    if (!m[3]) break // a bare number is the whole estimate
  }
  if (!parts || !(total > 0) || total > MAX_ETA_MIN) return null
  const start = text[head.index] === '\n' ? head.index + 1 : head.index
  const end = text.indexOf('\n', pos)
  const line = text
    .slice(start, end < 0 ? undefined : end)
    .trim()
    .slice(0, ETA_LINE_MAX)
  return { minutes: Math.round(total * 10) / 10, line }
}

/** The estimate in one stream-json event: an assistant message's text, never a tool's output. */
export function etaOfEvent(raw: unknown): number | null {
  return etaFullOfEvent(raw)?.minutes ?? null
}

/** The same with the exact line and the text block it was in (cut at ETA_TEXT_MAX). */
export function etaFullOfEvent(
  raw: unknown,
): { minutes: number; line: string; text: string } | null {
  const ev = raw as { type?: string; message?: { content?: unknown } } | null
  if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null
  for (const b of ev.message.content as Array<{ type?: string; text?: unknown }>) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    const found = parseEtaFull(b.text)
    if (found) return { ...found, text: b.text.trim().slice(0, ETA_TEXT_MAX) }
  }
  return null
}

const REVIEW_LINE =
  /^[ \t]*(?:[*_>#`-]+[ \t]*)*ETA-REVIEW\b[*_`]*[ \t]*[:=–—-][ \t]*[*_`]*[ \t]*(.*)$/im
const CAUSE_LINE = /^[ \t]*(?:[*_>#`-]+[ \t]*)*CAUSE\b[*_`]*[ \t]*[:=–—-][ \t]*[*_`]*[ \t]*(.*)$/im
const REVIEW_LINES =
  /^[ \t]*(?:[*_>#`-]+[ \t]*)*(?:ETA-REVIEW|CAUSE)\b[*_`]*[ \t]*[:=–—-][ \t]*[*_`]*[ \t]*.*(?:\r?\n|$)/gim

/** The review a text block holds (`ETA-REVIEW:` and `CAUSE:` lines), or null without the first. */
export function parseReview(text: string): EtaReview | null {
  const why = REVIEW_LINE.exec(text)?.[1]
    ?.replace(/[*_`]+$/, '')
    .trim()
  if (!why) return null
  const word = (CAUSE_LINE.exec(text)?.[1] ?? '')
    .replace(/[*_`.]/g, '')
    .trim()
    .toLowerCase()
  const first = word.split(/\s+/)[0] ?? ''
  const known = (ETA_CAUSES as readonly string[]).includes(first)
  return {
    why: why.slice(0, 600),
    cause: known ? first : 'other',
    ...(!known && word ? { raw: word.slice(0, 60) } : {}),
  }
}

/** `text` without its `ETA-REVIEW:` and `CAUSE:` lines, trimmed: what a review message leaves of a
 *  report (nothing when it is only those lines). */
export function stripReview(text: string): string {
  return text.replace(REVIEW_LINES, '').trim()
}

/** The review in one stream-json event (an assistant text block), else null. */
export function reviewOfEvent(raw: unknown): EtaReview | null {
  const ev = raw as { type?: string; message?: { content?: unknown } } | null
  if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null
  for (const b of ev.message.content as Array<{ type?: string; text?: unknown }>) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    const r = parseReview(b.text)
    if (r) return r
  }
  return null
}

/** Working seconds since the estimate: the rest of the attempt it was said in, then every later
 *  attempt whole. A move, a limit or a handoff adds attempts; the waits between them are not work
 *  the worker could have foreseen. */
export function etaTookSeconds(
  eta: Pick<CliMayteEta, 'at' | 'attempt'>,
  attempts: ReadonlyArray<{ startedAt: number; endedAt: number | null }>,
  now: number,
): number {
  let ms = 0
  for (let i = Math.max(0, eta.attempt); i < attempts.length; i++) {
    const a = attempts[i]!
    const start = i === eta.attempt ? Math.max(a.startedAt, eta.at) : a.startedAt
    ms += Math.max(0, (a.endedAt ?? now) - start)
  }
  return Math.round(ms / 1000)
}

/** Settled estimates of a task's earlier messages kept on it; the oldest go first. */
export const MAX_PAST_ETAS = 10
/** The calibration reads this many of the newest samples. */
export const ETA_SAMPLES = 30
/** Fewer samples than this say nothing yet (no note in the brief). */
export const ETA_MIN_SAMPLES = 5

/** How a settled estimate compares with the time: within CLOSE either way, or too long / too short. */
export type EtaBucket = 'close' | 'over' | 'under'

/** One estimate against the time it took. */
export interface EtaSample {
  id: string
  kind: string | null
  minutes: number
  tookS: number
  doneAt: number
  /** When the estimate was said: with `id`, what tells one estimate of a worker from another. */
  at?: number
  title?: string
  model?: string | null
  effort?: string | null
  line?: string
  /** What the owner waited, in seconds (doneAt - at). */
  wallS?: number
  bucket?: EtaBucket
  review?: EtaReview
}

/** took / estimated, two places. */
export const etaRatio = (minutes: number, tookS: number): number => round2(tookS / 60 / minutes)

export function etaBucket(ratio: number): EtaBucket {
  return ratio <= CLOSE && ratio >= 1 / CLOSE ? 'close' : ratio < 1 ? 'over' : 'under'
}

/** Every settled estimate of `workers`, newest first. */
export function etaSamples(
  workers: Iterable<{
    id: string
    kind?: string | null
    title?: string
    model?: string | null
    effort?: string | null
    eta?: CliMayteEta
    pastEtas?: CliMayteEta[]
  }>,
): EtaSample[] {
  const out: EtaSample[] = []
  for (const w of workers)
    for (const e of [...(w.pastEtas ?? []), ...(w.eta ? [w.eta] : [])])
      if (e.tookS !== undefined && e.doneAt !== undefined && e.minutes > 0)
        out.push({
          id: w.id,
          kind: w.kind ?? null,
          minutes: e.minutes,
          tookS: e.tookS,
          doneAt: e.doneAt,
          at: e.at,
          ...(w.title ? { title: w.title } : {}),
          model: w.model ?? null,
          effort: w.effort ?? null,
          ...(e.line ? { line: e.line } : {}),
          wallS: Math.max(0, Math.round((e.doneAt - e.at) / 1000)),
          bucket: etaBucket(etaRatio(e.minutes, e.tookS)),
          ...(e.review ? { review: e.review } : {}),
        })
  return out.sort((a, b) => b.doneAt - a.doneAt)
}

/** The ledger's samples and the live workers' as one newest-first list. An estimate on both (the
 *  worker is still here) counts once, the ledger's copy kept; a review only one of them has is
 *  added to it. */
export function mergeSamples(ledger: EtaSample[], live: EtaSample[]): EtaSample[] {
  const key = (s: EtaSample): string => `${s.id}|${s.at ?? s.doneAt}`
  const byKey = new Map(ledger.map((s) => [key(s), s]))
  for (const s of live) {
    const have = byKey.get(key(s))
    if (!have) byKey.set(key(s), s)
    else if (!have.review && s.review) byKey.set(key(s), { ...have, review: s.review })
  }
  return [...byKey.values()].sort((a, b) => b.doneAt - a.doneAt)
}

/** How the newest estimates compare with the real time: `ratio` is the median of took / estimated,
 *  and half the samples fell between `low` and `high`. `kind` is set when the figures are that
 *  kind's own (it has ETA_MIN_SAMPLES of them), null when they are every kind's. */
export interface EtaCalibration {
  kind: string | null
  samples: number
  ratio: number
  low: number
  high: number
}

/** Estimates within this factor of the real time count as close. */
const CLOSE = 1.25

const quantile = (sorted: number[], q: number): number => {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The calibration for a task of `kind`: its kind's own newest samples when there are enough, else
 *  every kind's; null under ETA_MIN_SAMPLES. `samples` is newest first (etaSamples). */
export function etaCalibration(samples: EtaSample[], kind: string | null): EtaCalibration | null {
  const own = kind ? samples.filter((s) => s.kind === kind) : []
  const useOwn = own.length >= ETA_MIN_SAMPLES
  const pick = (useOwn ? own : samples).slice(0, ETA_SAMPLES)
  if (pick.length < ETA_MIN_SAMPLES) return null
  const ratios = pick.map((s) => s.tookS / 60 / s.minutes).sort((a, b) => a - b)
  return {
    kind: useOwn ? kind : null,
    samples: pick.length,
    ratio: round2(quantile(ratios, 0.5)),
    low: round2(quantile(ratios, 0.25)),
    high: round2(quantile(ratios, 0.75)),
  }
}

const times = (n: number): string => `${n < 1 ? n.toFixed(2) : n.toFixed(1)}x`

/** A worker's reviews count toward the brief from this many. */
export const REVIEW_NOTE_MIN = 3
const NOTE_MAX = 450
const QUOTE_MAX = 160

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The reason sentence for the brief: the most common cause of the newest reviews with its count,
 *  and a short quote of the newest review of it. `reviews` is newest first. */
function causeSentence(reviews: EtaSample[], room: number): string | null {
  const rs = reviews.filter((s) => s.review)
  if (rs.length < REVIEW_NOTE_MIN) return null
  const counts = new Map<string, number>()
  for (const s of rs) counts.set(s.review!.cause, (counts.get(s.review!.cause) ?? 0) + 1)
  let top = ''
  for (const [cause, n] of counts) if (n > (counts.get(top) ?? 0)) top = cause
  const head = ` Most common reason an estimate missed: ${top} (${counts.get(top)} of ${rs.length}); newest: "`
  const tail = '".'
  const why = oneLine(rs.find((s) => s.review!.cause === top)!.review!.why)
  const quoteRoom = Math.min(QUOTE_MAX, room - head.length - tail.length)
  if (quoteRoom < 30) return null
  const quote = why.length > quoteRoom ? `${why.slice(0, quoteRoom - 1).trimEnd()}…` : why
  return `${head}${quote}${tail}`
}

/** The sentence the worker brief ends with, or null when there is nothing to say yet. `reviews`
 *  (newest first) adds why the misses happened once there are REVIEW_NOTE_MIN of them. */
export function etaNote(c: EtaCalibration | null, reviews: EtaSample[] = []): string | null {
  let base: string | null = null
  if (c) {
    const over = `over the last ${c.samples}${c.kind ? ` ${c.kind}` : ''} tasks the real working time was a median ${times(c.ratio)} the estimate (half fell between ${times(c.low)} and ${times(c.high)})`
    if (c.ratio <= CLOSE && c.ratio >= 1 / CLOSE)
      base = `Your estimates have been close: ${over}. Keep estimating the same way.`
    else {
      const way = c.ratio > 1 ? 'short' : 'long'
      base = `Calibrate your ETA: ${over}, so estimates have run ${way}. Multiply your first guess by about ${c.ratio < 1 ? c.ratio.toFixed(2) : c.ratio.toFixed(1)} before you write it.`
    }
  }
  const why = causeSentence(reviews, NOTE_MAX - (base?.length ?? 0))
  if (!base) return why?.trim() ?? null
  return why ? `${base}${why}` : base
}

/** An estimate this far off (either way) is asked about. */
export const REVIEW_BAND = 1.5

/** The Stop hook's question for a worker whose estimate was `ratio` of the real time. */
export function reviewQuestion(eta: Pick<CliMayteEta, 'minutes' | 'line'>, tookS: number): string {
  const took = Math.round(tookS / 6) / 10
  const ratio = etaRatio(eta.minutes, tookS)
  return (
    `Your estimate for this message was "${eta.line ?? `ETA: ${eta.minutes} min`}" (${eta.minutes} min). ` +
    `The working time it took was ${took} min, ${times(ratio)} the estimate. ` +
    'Reply with exactly two lines and nothing else:\n' +
    'ETA-REVIEW: <why the estimate was off, and what you would estimate for a task like this next time>\n' +
    `CAUSE: <one of ${ETA_CAUSES.join(', ')}>\n` +
    'Your report above stands; do not repeat it and do no more work.'
  )
}

/** What the Stop hook says for a worker about to end its turn: the question to put to it (block),
 *  or null to let it stop. */
export function stopDecision(opts: {
  eta: CliMayteEta | undefined
  stopHookActive: boolean
  asking: boolean
  tookS: number | null
}): string | null {
  const { eta, tookS } = opts
  if (!eta || opts.stopHookActive || opts.asking || tookS === null) return null
  if (eta.review || eta.reviewAskedAt !== undefined) return null
  // Settled before: asked only about an estimate still open (the hook settles it when it asks).
  if (eta.tookS !== undefined || !(eta.minutes > 0)) return null
  const ratio = tookS / 60 / eta.minutes
  if (ratio <= REVIEW_BAND && ratio >= 1 / REVIEW_BAND) return null
  return reviewQuestion(eta, tookS)
}
