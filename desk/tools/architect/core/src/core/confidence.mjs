/**
 * Confidence scoring and the three-valued verdict lattice.
 *
 * The 0-100 confidence rubric and 80-cutoff convention come from Anthropic's
 * official code-review plugin (anthropic-claude-code/plugins/pr-review-toolkit/
 * agents/code-reviewer.md). The 3-valued verdict lattice
 * (confirmed/refuted/inconclusive) and Beta-Bernoulli aggregation come from
 * gadievron/raptor (packages/hypothesis_validation/).
 *
 * Why this exists in an arkitect: even deterministic static checks have
 * false-positive modes (a grep-based rule fires on a comment; an AST rule
 * fires on a generated file). Letting a check attach a confidence to each
 * finding, plus a verdict bucket if it ran multiple corroborating sub-checks,
 * lets the runner (or a coordinator) drop noise without the check having to
 * implement its own suppression.
 */

export const CONFIDENCE_BANDS = Object.freeze([
  { min: 0, max: 25, label: "very-low", description: "Likely false positive — do not report" },
  { min: 26, max: 50, label: "low", description: "Nit / style — report only when explicitly requested" },
  { min: 51, max: 75, label: "moderate", description: "Plausible — report when reach is high" },
  { min: 76, max: 90, label: "high", description: "Important — report by default" },
  { min: 91, max: 100, label: "critical", description: "Almost certainly a real problem" },
]);

export const DEFAULT_CONFIDENCE_CUTOFF = 80;

export function bandForConfidence(score) {
  const v = clamp01to100(score);
  for (const band of CONFIDENCE_BANDS) {
    if (v >= band.min && v <= band.max) return band;
  }
  return CONFIDENCE_BANDS[0];
}

export function passesCutoff(score, cutoff = DEFAULT_CONFIDENCE_CUTOFF) {
  return clamp01to100(score) >= cutoff;
}

/**
 * Drop findings whose `confidence` is below the cutoff. Findings without a
 * confidence field are kept (the check did not opt in to confidence scoring).
 */
export function filterByConfidence(findings, cutoff = DEFAULT_CONFIDENCE_CUTOFF) {
  const out = [];
  let dropped = 0;
  for (const finding of findings ?? []) {
    if (typeof finding?.confidence !== "number") {
      out.push(finding);
      continue;
    }
    if (passesCutoff(finding.confidence, cutoff)) {
      out.push(finding);
    } else {
      dropped += 1;
    }
  }
  return { findings: out, dropped };
}

// ── Three-valued verdict lattice ─────────────────────────────────────────────

export const VERDICT = Object.freeze({
  CONFIRMED: "confirmed",
  REFUTED: "refuted",
  INCONCLUSIVE: "inconclusive",
});

/**
 * Mechanical downgrade rules. If any sub-check failed to execute, the parent
 * verdict can never be `confirmed` — it must be `inconclusive`. If a claim
 * says `confirmed` but no evidence rows exist, it must be `refuted`. These
 * are taken straight from raptor/packages/hypothesis_validation/verdict.py.
 */
export function applyVerdictDowngrade({ claim, evidenceCount = 0, toolErrors = 0 }) {
  if (toolErrors > 0) return VERDICT.INCONCLUSIVE;
  if (claim === VERDICT.CONFIRMED && evidenceCount === 0) return VERDICT.REFUTED;
  if (claim === VERDICT.REFUTED && evidenceCount === 0) return VERDICT.REFUTED;
  if (claim !== VERDICT.CONFIRMED && claim !== VERDICT.REFUTED && claim !== VERDICT.INCONCLUSIVE) {
    return VERDICT.INCONCLUSIVE;
  }
  return claim;
}

/**
 * Beta-Bernoulli posterior: given a sequence of independent binary judgments
 * (true = confirms the hypothesis, false = refutes), return the posterior
 * mean (a 0-1 confidence) and posterior strength (count of evidence).
 *
 * Uses a Jeffreys prior (alpha=beta=0.5) so a single confirming observation
 * doesn't immediately swing the estimate to 1.
 */
export function betaBernoulli(votes, { alpha = 0.5, beta = 0.5 } = {}) {
  let successes = 0;
  let failures = 0;
  for (const vote of votes ?? []) {
    if (vote === true) successes += 1;
    else if (vote === false) failures += 1;
  }
  const postAlpha = alpha + successes;
  const postBeta = beta + failures;
  const mean = postAlpha / (postAlpha + postBeta);
  return {
    confidence: Math.round(mean * 100),
    posteriorMean: Number(mean.toFixed(4)),
    alpha: Number(postAlpha.toFixed(2)),
    beta: Number(postBeta.toFixed(2)),
    evidenceCount: successes + failures,
  };
}

function clamp01to100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
