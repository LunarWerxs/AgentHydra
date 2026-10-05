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
}

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
  return Math.round(total * 10) / 10
}

/** The estimate in one stream-json event: an assistant message's text, never a tool's output. */
export function etaOfEvent(raw: unknown): number | null {
  const ev = raw as { type?: string; message?: { content?: unknown } } | null
  if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) return null
  for (const b of ev.message.content as Array<{ type?: string; text?: unknown }>) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    const min = parseEta(b.text)
    if (min !== null) return min
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

/** One estimate against the time it took. */
export interface EtaSample {
  id: string
  kind: string | null
  minutes: number
  tookS: number
  doneAt: number
}

/** Every settled estimate of `workers`, newest first. */
export function etaSamples(
  workers: Iterable<{
    id: string
    kind?: string | null
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
        })
  return out.sort((a, b) => b.doneAt - a.doneAt)
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

/** Estimates within this factor of the real time count as close. */
const CLOSE = 1.25

const times = (n: number): string => `${n < 1 ? n.toFixed(2) : n.toFixed(1)}x`

/** The sentence the worker brief ends with, or null when there is nothing to say yet. */
export function etaNote(c: EtaCalibration | null): string | null {
  if (!c) return null
  const over = `over the last ${c.samples}${c.kind ? ` ${c.kind}` : ''} tasks the real working time was a median ${times(c.ratio)} the estimate (half fell between ${times(c.low)} and ${times(c.high)})`
  if (c.ratio <= CLOSE && c.ratio >= 1 / CLOSE)
    return `Your estimates have been close: ${over}. Keep estimating the same way.`
  const way = c.ratio > 1 ? 'short' : 'long'
  return `Calibrate your ETA: ${over}, so estimates have run ${way}. Multiply your first guess by about ${c.ratio < 1 ? c.ratio.toFixed(2) : c.ratio.toFixed(1)} before you write it.`
}
