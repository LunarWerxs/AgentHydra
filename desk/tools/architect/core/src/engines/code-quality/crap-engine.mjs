/**
 * crap-engine — CRAP (Change Risk Anti-Patterns) score
 * ====================================================
 * Direct port of the CRAP formula popularized by Alberto Savoia's CRAP4J and
 * ported to Rust as `cargo-crap` (minikin/cargo-crap):
 *
 *     CRAP(m) = comp(m)^2 * (1 - cov(m)/100)^3 + comp(m)
 *
 * - `comp(m)` is cyclomatic complexity of method m.
 * - `cov(m)` is m's test coverage as a percentage (0..100).
 * - Default flagging threshold is 30 (cargo-crap default).
 *
 * "Missing coverage" policy mirrors cargo-crap's `--missing` flag:
 *   - "pessimistic" → treat unmapped functions as 0% coverage (default)
 *   - "optimistic"  → treat them as 100% coverage
 *   - "skip"        → omit them from the report entirely
 */
export const CRAP_DEFAULT_THRESHOLD = 30;

export function crapScore(complexity, coveragePercent) {
  const cc = Math.max(1, Number(complexity) || 1);
  const cov = Math.max(0, Math.min(100, Number(coveragePercent) || 0));
  const uncovered = 1 - cov / 100;
  return cc * cc * Math.pow(uncovered, 3) + cc;
}

export function scoreFunctions(functions, { coverageFor, missing = "pessimistic" } = {}) {
  const out = [];
  for (const fn of functions) {
    let coverage = coverageFor ? coverageFor(fn) : null;
    if (coverage === null || coverage === undefined) {
      if (missing === "skip") continue;
      coverage = missing === "optimistic" ? 100 : 0;
    }
    const score = crapScore(fn.cyclomaticComplexity, coverage);
    out.push({
      ...fn,
      coveragePercent: coverage,
      crapScore: score,
      coverageMissing: coverageFor ? coverageFor(fn) === null : true,
    });
  }
  return out;
}

/**
 * Compare a `current` rule-counts map against a baseline and return only the
 * functions whose CRAP score regressed (cargo-crap "regression detection").
 */
export function regressions(current, baseline) {
  const out = [];
  const baselineMap = new Map((baseline ?? []).map((entry) => [entry.key, entry.score]));
  for (const entry of current ?? []) {
    const baseScore = baselineMap.get(entry.key) ?? 0;
    if (entry.score > baseScore + 0.0001) {
      out.push({ ...entry, baselineScore: baseScore, delta: entry.score - baseScore });
    }
  }
  return out;
}
