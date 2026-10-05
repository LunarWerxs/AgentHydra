// Adapted from fzf src/algo/algo.go (MIT, Copyright (c) 2013 Junegunn Choi). Adapted for DevWebUI.
//
// WHY: the dashboard search box used a plain substring test, so "asv" never found
// "API Server" and every hit came back in list order. This is fzf's FuzzyMatchV2:
// a Smith-Waterman-style pass that scores each in-order subsequence match, rewarding
// matches at word boundaries, camelCase/letter-to-digit humps and consecutive runs,
// so the most plausible target ranks first. Pure + stateless; case-insensitive always.

/** "path" treats slashes as the delimiters and the start of the text as one (for folder names). */
export type FuzzyScheme = "default" | "path";

export interface FuzzyMatch {
  /** Higher is better; only comparable between matches of the same query. */
  score: number;
  /** Matched UTF-16 indexes into the text, ascending (for highlighting). */
  positions: number[];
}

// fzf's constants (algo.go): a boundary bonus stops paying once the gap it bridges
// passes about 8 chars, and the first query char's bonus counts double.
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NON_WORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

// Character classes, ordered as in fzf: every class above NON_WORD counts as a "word" char.
const C_WHITE = 0;
const C_NON_WORD = 1;
const C_DELIMITER = 2;
const C_LOWER = 3;
const C_UPPER = 4;
const C_LETTER = 5;
const C_NUMBER = 6;

interface SchemeConfig {
  boundaryWhite: number;
  boundaryDelimiter: number;
  delimiters: string;
  /** Class assumed before the first char, so a match at index 0 earns a boundary bonus. */
  initialClass: number;
}

const SCHEMES: Record<FuzzyScheme, SchemeConfig> = {
  default: {
    boundaryWhite: BONUS_BOUNDARY + 2,
    boundaryDelimiter: BONUS_BOUNDARY + 1,
    delimiters: "/,:;|",
    initialClass: C_WHITE,
  },
  // Both separators: the browser cannot tell which OS a folder name came from.
  path: {
    boundaryWhite: BONUS_BOUNDARY,
    boundaryDelimiter: BONUS_BOUNDARY + 1,
    delimiters: "/\\",
    initialClass: C_DELIMITER,
  },
};

const RE_WHITE = /\s/;
const RE_LOWER = /\p{Ll}/u;
const RE_UPPER = /\p{Lu}/u;
const RE_NUMBER = /\p{N}/u;
const RE_LETTER = /\p{L}/u;

function charClassOf(ch: string, delimiters: string): number {
  if (ch >= "a" && ch <= "z") return C_LOWER;
  if (ch >= "A" && ch <= "Z") return C_UPPER;
  if (ch >= "0" && ch <= "9") return C_NUMBER;
  if (RE_WHITE.test(ch)) return C_WHITE;
  if (delimiters.includes(ch)) return C_DELIMITER;
  if (ch.charCodeAt(0) < 128) return C_NON_WORD;
  if (RE_LOWER.test(ch)) return C_LOWER;
  if (RE_UPPER.test(ch)) return C_UPPER;
  if (RE_NUMBER.test(ch)) return C_NUMBER;
  if (RE_LETTER.test(ch)) return C_LETTER;
  return C_NON_WORD;
}

function bonusFor(prev: number, cls: number, cfg: SchemeConfig): number {
  if (cls > C_NON_WORD) {
    if (prev === C_WHITE) return cfg.boundaryWhite;
    if (prev === C_DELIMITER) return cfg.boundaryDelimiter;
    if (prev === C_NON_WORD) return BONUS_BOUNDARY;
  }
  if ((prev === C_LOWER && cls === C_UPPER) || (prev !== C_NUMBER && cls === C_NUMBER)) {
    return BONUS_CAMEL_123;
  }
  if (cls === C_NON_WORD || cls === C_DELIMITER) return BONUS_NON_WORD;
  if (cls === C_WHITE) return cfg.boundaryWhite;
  return 0;
}

/** Lowercase per UTF-16 unit so indexes stay aligned with the original text. */
function lowerUnits(s: string): string[] {
  const out = new Array<string>(s.length);
  for (let i = 0; i < s.length; i++) {
    const lc = s[i].toLowerCase();
    out[i] = lc.length === 1 ? lc : s[i];
  }
  return out;
}

/** The DP tables shared by the phases of one fuzzyMatch call. */
interface DpTable {
  txt: string[];
  pat: string[];
  M: number;
  N: number;
  /** F[i] is the first column pattern char i can occupy. */
  F: Int32Array;
  /** Last occurrence of the final pattern char. */
  lastIdx: number;
  H: Int32Array;
  C: Int32Array;
  B: Int32Array;
}

interface Best {
  score: number;
  pos: number;
}

interface Cell {
  score: number;
  consecutive: number;
}

const NO_MATCH: Cell = { score: 0, consecutive: 0 };

function gapPenalty(inGap: boolean): number {
  return inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
}

// Phase 1: F[i] is the first column pattern char i can occupy; lastIdx is the last
// occurrence of the final pattern char. Not a subsequence -> null, before any DP.
function firstOccurrences(txt: string[], pat: string[]): { F: Int32Array; lastIdx: number } | null {
  const M = pat.length;
  const F = new Int32Array(M);
  let pidx = 0;
  let lastIdx = -1;
  for (let j = 0; j < txt.length; j++) {
    if (txt[j] === pat[Math.min(pidx, M - 1)]) {
      if (pidx < M) F[pidx++] = j;
      lastIdx = j;
    }
  }
  return pidx < M ? null : { F, lastIdx };
}

// Phase 2: per-column bonuses, and row 0 (the first pattern char, bonus doubled).
// Only a single-char pattern takes its best from this row.
function scoreFirstRow(dp: DpTable, text: string, cfg: SchemeConfig): Best {
  const best: Best = { score: 0, pos: -1 };
  let prevClass = cfg.initialClass;
  let inGap = false;
  let prevH = 0;
  for (let j = 0; j <= dp.lastIdx; j++) {
    const cls = charClassOf(text[j], cfg.delimiters);
    const bonus = bonusFor(prevClass, cls, cfg);
    dp.B[j] = bonus;
    prevClass = cls;
    const matched = dp.txt[j] === dp.pat[0];
    dp.H[j] = matched
      ? SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER
      : Math.max(prevH + gapPenalty(inGap), 0);
    dp.C[j] = matched ? 1 : 0;
    if (matched && dp.M === 1 && dp.H[j] > best.score) {
      best.score = dp.H[j];
      best.pos = j;
      // Nothing later can beat a boundary hit by enough to matter; take the first.
      if (bonus >= BONUS_BOUNDARY) break;
    }
    inGap = !matched;
    prevH = dp.H[j];
  }
  return best;
}

/** Score of a match at column j of the row after `prev`, given the gap score s2. */
function matchCell(dp: DpTable, prev: number, j: number, s2: number): Cell {
  let score = dp.H[prev + j - 1] + SCORE_MATCH;
  let b = dp.B[j];
  let consecutive = dp.C[prev + j - 1] + 1;
  if (consecutive > 1) {
    const fb = dp.B[j - consecutive + 1];
    // A strong boundary mid-run starts a fresh chunk instead of extending the old one.
    if (b >= BONUS_BOUNDARY && b > fb) consecutive = 1;
    else b = Math.max(b, BONUS_CONSECUTIVE, fb);
  }
  if (score + b < s2) {
    score += dp.B[j];
    consecutive = 0;
  } else {
    score += b;
  }
  return { score, consecutive };
}

// Phase 3: fill row i. H[row + F[i] - 1] stays 0 as the left edge.
function fillRow(dp: DpTable, i: number, best: Best): void {
  const row = i * dp.N;
  const prev = row - dp.N;
  const pc = dp.pat[i];
  const isLastRow = i === dp.M - 1;
  let inGap = false;
  for (let j = dp.F[i]; j <= dp.lastIdx; j++) {
    const s2: number = dp.H[row + j - 1] + gapPenalty(inGap);
    const cell = dp.txt[j] === pc ? matchCell(dp, prev, j, s2) : NO_MATCH;
    dp.C[row + j] = cell.consecutive;
    inGap = cell.score < s2;
    const score = Math.max(cell.score, s2, 0);
    if (isLastRow && score > best.score) {
      best.score = score;
      best.pos = j;
    }
    dp.H[row + j] = score;
  }
}

/** True when the backtrace at (i, j) takes pattern char i as matched at column j. */
function isMatchStep(dp: DpTable, i: number, j: number, preferMatch: boolean): boolean {
  const row = i * dp.N;
  const s = dp.H[row + j];
  const s1 = i > 0 && j >= dp.F[i] ? dp.H[row - dp.N + j - 1] : 0;
  const s2 = j > dp.F[i] ? dp.H[row + j - 1] : 0;
  return s > s1 && (s > s2 || (s === s2 && preferMatch));
}

function continuesRun(dp: DpTable, row: number, j: number): boolean {
  const { C, N } = dp;
  return C[row + j] > 1 || (row + N + j + 1 < C.length && C[row + N + j + 1] > 0);
}

// Phase 4: backtrace from the best end column to recover the matched positions,
// preferring to stay inside a consecutive run when two paths score the same.
function backtrace(dp: DpTable, endPos: number): number[] {
  const positions: number[] = [];
  let i = dp.M - 1;
  let j = endPos;
  let preferMatch = true;
  while (j >= 0) {
    const row = i * dp.N;
    if (isMatchStep(dp, i, j, preferMatch)) {
      positions.push(j);
      if (i === 0) break;
      i--;
    }
    preferMatch = continuesRun(dp, row, j);
    j--;
  }
  positions.reverse();
  return positions;
}

/**
 * Score `pattern` as an in-order, case-insensitive subsequence of `text`
 * (fzf FuzzyMatchV2). Returns null when it is not a subsequence at all.
 */
export function fuzzyMatch(
  text: string,
  pattern: string,
  scheme: FuzzyScheme = "default",
): FuzzyMatch | null {
  const M = pattern.length;
  if (M === 0) return { score: 0, positions: [] };
  const N = text.length;
  if (M > N) return null;
  const cfg = SCHEMES[scheme];
  const pat = lowerUnits(pattern);
  const txt = lowerUnits(text);

  const occ = firstOccurrences(txt, pat);
  if (!occ) return null;

  // Full-width rows keep the indexing plain; dashboard names are short.
  const dp: DpTable = {
    txt,
    pat,
    M,
    N,
    F: occ.F,
    lastIdx: occ.lastIdx,
    H: new Int32Array(M * N),
    C: new Int32Array(M * N),
    B: new Int32Array(N),
  };

  const best = scoreFirstRow(dp, text, cfg);
  if (M === 1) return { score: best.score, positions: [best.pos] };

  for (let i = 1; i < M; i++) fillRow(dp, i, best);

  return { score: best.score, positions: backtrace(dp, best.pos) };
}

/**
 * Toolbar-search semantics: whitespace splits the query into terms that must ALL
 * match (fzf's extended-search AND); the scores add up. A blank query matches
 * everything with score 0.
 */
export function fuzzySearch(
  text: string,
  query: string,
  scheme: FuzzyScheme = "default",
): FuzzyMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const m = fuzzyMatch(text, term, scheme);
    if (!m) return null;
    score += m.score;
    for (const p of m.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}
