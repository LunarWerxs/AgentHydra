// web/src/lib/fuzzy.ts - fzf-style ranked fuzzy matching for the type-to-filter boxes.
//
// Adapted from junegunn/fzf src/algo/algo.go FuzzyMatchV2 (MIT, Copyright (c) 2013-2024 Junegunn
// Choi) and microsoft/terminal src/cascadia/fzf/fzf.cpp (MIT, Copyright (c) Microsoft Corporation).
// Adapted for AgentHydra. Both notices are reproduced in THIRD-PARTY-NOTICES.md.
//
// WHY. The session filter used to be `title.includes(q)`: 'cdxsess' found nothing where 'Codex
// session' was meant, and every hit came back in list order, so the one you wanted sat wherever its
// last activity put it. fzf's v2 scorer fixes both: the query only has to be a subsequence, and the
// score rewards what a person means when they type a few letters (word starts, camelCase humps,
// consecutive runs) and charges for the gaps between them, so the best hit sorts first.
//
// WHAT WAS LEFT OUT. fzf's Unicode normalisation, its v1 fallback for very long lines and its
// scheme presets: a session title is ~120 characters, so the full dynamic-programming table is a
// few kilobytes and the fast path would buy nothing. Matching is always case-insensitive; the
// character classes still read the original text, so a camelCase hump scores as one.
//
// Pure string logic with no imports, so it is testable under bun without a DOM.

// Scores, as fzf tunes them (algo.go). A match is worth 16; a gap costs 3 to open and 1 per extra
// character, which is what makes a boundary bonus stop paying once the gap passes about 8 chars.
const SCORE_MATCH = 16
const SCORE_GAP_START = -3
const SCORE_GAP_EXTENSION = -1
const BONUS_BOUNDARY = SCORE_MATCH / 2
const BONUS_NON_WORD = SCORE_MATCH / 2
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
const BONUS_FIRST_CHAR_MULTIPLIER = 2
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1

// Ordered: everything above NON_WORD is a word character, and bonusFor relies on that comparison.
const CharClass = {
  White: 0,
  NonWord: 1,
  Delimiter: 2,
  Lower: 3,
  Upper: 4,
  Letter: 5,
  Number: 6,
} as const
type CharClass = (typeof CharClass)[keyof typeof CharClass]

const DELIMITERS = '/,:;|\\'

function classOf(ch: string): CharClass {
  if (ch >= 'a' && ch <= 'z') return CharClass.Lower
  if (ch >= 'A' && ch <= 'Z') return CharClass.Upper
  if (ch >= '0' && ch <= '9') return CharClass.Number
  if (/\s/.test(ch)) return CharClass.White
  if (DELIMITERS.includes(ch)) return CharClass.Delimiter
  if (ch.toLowerCase() !== ch) return CharClass.Upper
  if (ch.toUpperCase() !== ch) return CharClass.Lower
  if (/\p{L}/u.test(ch)) return CharClass.Letter
  if (/\p{N}/u.test(ch)) return CharClass.Number
  return CharClass.NonWord
}

/** The bonus for matching a character of class `cur` right after one of class `prev`. */
function bonusFor(prev: CharClass, cur: CharClass): number {
  if (cur > CharClass.NonWord) {
    if (prev === CharClass.White) return BONUS_BOUNDARY_WHITE
    if (prev === CharClass.Delimiter) return BONUS_BOUNDARY_DELIMITER
    if (prev === CharClass.NonWord) return BONUS_BOUNDARY
  }
  if (
    (prev === CharClass.Lower && cur === CharClass.Upper) ||
    (prev !== CharClass.Number && cur === CharClass.Number)
  ) {
    return BONUS_CAMEL_123
  }
  if (cur === CharClass.NonWord || cur === CharClass.Delimiter) return BONUS_NON_WORD
  if (cur === CharClass.White) return BONUS_BOUNDARY_WHITE
  return 0
}

export interface FuzzyMatch {
  score: number
  /** Indexes into the text of every matched character, ascending. */
  positions: number[]
}

/**
 * Score `pattern` as a case-insensitive subsequence of `text` (fzf FuzzyMatchV2), or null when it
 * is not one. An empty pattern matches everything with score 0.
 */
export function fuzzyMatch(text: string, pattern: string): FuzzyMatch | null {
  const M = pattern.length
  const N = text.length
  if (M === 0) return { score: 0, positions: [] }
  if (M > N) return null
  const T = text.toLowerCase()
  const P = pattern.toLowerCase()
  // toLowerCase can change a string's length (a few non-ASCII letters expand); indexes would then
  // drift away from the original text, so such text is matched only if the lengths still agree.
  if (T.length !== N || P.length !== M) return null

  // Phase 1: greedy forward scan. F[i] is the earliest index pattern[i] can sit at, which bounds
  // every row of the table below; failing here means the pattern is not a subsequence at all.
  const F = new Int32Array(M)
  let pi = 0
  for (let j = 0; j < N && pi < M; j++) if (T[j] === P[pi]) F[pi++] = j
  if (pi < M) return null
  let lastIdx = N - 1
  while (T[lastIdx] !== P[M - 1]) lastIdx--

  // Bonus per text position, from the ORIGINAL characters so case transitions are visible.
  const B = new Int16Array(N)
  let prevClass: CharClass = CharClass.White
  for (let j = 0; j < N; j++) {
    const cls = classOf(text[j] as string)
    B[j] = bonusFor(prevClass, cls)
    prevClass = cls
  }

  // H is the best score with pattern[0..i] placed ending at or before text[j]; C is the length of
  // the consecutive run that score ends in (0 when text[j] is not matched in it).
  const H = new Int32Array(M * N)
  const C = new Int32Array(M * N)
  let maxScore = 0
  let maxPos = -1

  // Phase 2: the first row. The first query character's bonus counts double.
  let inGap = false
  let prevH = 0
  for (let j = F[0] as number; j <= lastIdx; j++) {
    let h: number
    if (T[j] === P[0]) {
      h = SCORE_MATCH + (B[j] as number) * BONUS_FIRST_CHAR_MULTIPLIER
      C[j] = 1
      inGap = false
      if (M === 1 && h > maxScore) {
        maxScore = h
        maxPos = j
      }
    } else {
      h = Math.max(prevH + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START), 0)
      C[j] = 0
      inGap = true
    }
    H[j] = h
    prevH = h
  }

  // Phase 3: the remaining rows (Smith-Waterman style, affine gap).
  for (let i = 1; i < M; i++) {
    const row = i * N
    const up = row - N
    const pch = P[i]
    inGap = false
    for (let j = F[i] as number; j <= lastIdx; j++) {
      const left = j > (F[i] as number) ? (H[row + j - 1] as number) : 0
      const s2: number = left + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START)
      let s1 = 0
      let consecutive = 0
      if (T[j] === pch) {
        s1 = (H[up + j - 1] as number) + SCORE_MATCH
        let b = B[j] as number
        consecutive = (C[up + j - 1] as number) + 1
        if (consecutive > 1) {
          // A run keeps the bonus of the boundary it started on, unless this character starts a
          // stronger boundary of its own, in which case the run is broken and restarts here.
          const fb = B[j - consecutive + 1] as number
          if (b >= BONUS_BOUNDARY && b > fb) consecutive = 1
          else b = Math.max(b, BONUS_CONSECUTIVE, fb)
        }
        if (s1 + b < s2) {
          s1 += B[j] as number
          consecutive = 0
        } else {
          s1 += b
        }
      }
      C[row + j] = consecutive
      inGap = s1 < s2
      const score = Math.max(s1, s2, 0)
      if (i === M - 1 && score > maxScore) {
        maxScore = score
        maxPos = j
      }
      H[row + j] = score
    }
  }
  if (maxPos < 0) return null

  // Phase 4: walk back from the best cell to recover which characters were matched.
  const positions: number[] = []
  let i = M - 1
  let preferMatch = true
  for (let j = maxPos; j >= 0; j--) {
    const at = i * N + j
    const s = H[at] as number
    const s1 = i > 0 && j >= (F[i] as number) && j > 0 ? (H[at - N - 1] as number) : 0
    const s2 = j > (F[i] as number) ? (H[at - 1] as number) : 0
    if (s > s1 && (s > s2 || (s === s2 && preferMatch))) {
      positions.push(j)
      if (i === 0) break
      i--
    }
    const next = at + N + 1
    preferMatch = (C[at] as number) > 1 || (next < C.length && (C[next] as number) > 0)
  }
  if (positions.length !== M) return null
  positions.reverse()
  return { score: maxScore, positions }
}

/** One slice of a string, marked when its characters were matched. */
export interface TextRun {
  text: string
  hit: boolean
}

/**
 * Split `text` into alternating plain and matched runs, so a template can bold the hit characters
 * without building HTML. Positions must be ascending (fuzzyMatch returns them so).
 */
export function highlightRuns(text: string, positions: readonly number[]): TextRun[] {
  if (positions.length === 0) return text ? [{ text, hit: false }] : []
  const hits = new Set(positions)
  const runs: TextRun[] = []
  let start = 0
  for (let j = 1; j <= text.length; j++) {
    if (j === text.length || hits.has(j) !== hits.has(start)) {
      runs.push({ text: text.slice(start, j), hit: hits.has(start) })
      start = j
    }
  }
  return runs
}

/** The fields one row offers a filter box: the first is the one whose hits get highlighted. */
export interface FuzzyFields {
  /** Shown text; its matched positions are returned for highlighting. */
  primary: string
  /** Also searched (a path, say), ranked but never highlighted. */
  secondary?: readonly string[]
  /** Matched only as a plain substring: an id is typed or pasted exactly, never abbreviated. */
  exact?: readonly string[]
}

export interface FieldsMatch {
  score: number
  /** Matched positions in `primary`, ascending and de-duplicated. */
  positions: number[]
}

/**
 * Match a whole query against a row. Space-separated terms must ALL match (fzf's extended-search
 * AND), each in whichever field scores it best; the row's score is the sum. Null when any term
 * matches nowhere.
 */
export function matchFields(fields: FuzzyFields, query: string): FieldsMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  let score = 0
  const hit = new Set<number>()
  for (const term of terms) {
    let best: FuzzyMatch | null = fuzzyMatch(fields.primary, term)
    let bestIsPrimary = best !== null
    for (const other of fields.secondary ?? []) {
      const m = fuzzyMatch(other, term)
      if (m && (!best || m.score > best.score)) {
        best = m
        bestIsPrimary = false
      }
    }
    const needle = term.toLowerCase()
    if (!best && (fields.exact ?? []).some((v) => v.toLowerCase().includes(needle))) {
      // Scored as a consecutive run with no boundary bonus, so a pasted id still ranks.
      best = { score: needle.length * (SCORE_MATCH + BONUS_CONSECUTIVE), positions: [] }
    }
    if (!best) return null
    score += best.score
    if (bestIsPrimary) for (const p of best.positions) hit.add(p)
  }
  return { score, positions: [...hit].sort((a, b) => a - b) }
}

/**
 * What a session filter box searches: the title (highlighted), the working directory (ranked
 * only), and the id as a plain substring. Shared by the sessions sidebar and the session picker
 * so the two boxes never disagree about what matches.
 */
export function sessionSearchFields(s: {
  title: string
  cwd: string
  session_id: string
}): FuzzyFields {
  return { primary: s.title, secondary: [s.cwd], exact: [s.session_id] }
}

/**
 * Keep the rows that match `query`, best first. Equal scores keep their incoming order, which is
 * how fzf breaks the last tie (by index) and here means most recent first; fzf's earlier length
 * tiebreak is skipped, because a shorter title says nothing about which chat was meant.
 */
export function rankByQuery<T>(
  rows: readonly T[],
  query: string,
  fieldsOf: (row: T) => FuzzyFields,
): Array<{ row: T; match: FieldsMatch }> {
  const out: Array<{ row: T; match: FieldsMatch; index: number }> = []
  rows.forEach((row, index) => {
    const match = matchFields(fieldsOf(row), query)
    if (match) out.push({ row, match, index })
  })
  out.sort((a, b) => b.match.score - a.match.score || a.index - b.index)
  return out.map(({ row, match }) => ({ row, match }))
}
