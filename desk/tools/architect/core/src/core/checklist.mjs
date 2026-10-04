/**
 * Weighted-checklist scoring primitive.
 *
 * Adapted from avalonreset/claude-github (github/scripts/audit_repo.py:
 * score_from_checks / score_rating). Use this for rubric-style checks where
 * the result is "did N criteria pass" rather than a list of findings.
 * Examples: README coverage audit, dependency-hygiene audit, release-process
 * audit, project-bootstrap audit.
 *
 * Caller passes `criteria`: each entry has `id`, `passed`, `weight`, plus
 * optional `successMessage` / `failureMessage` and `severity`. The function
 * returns:
 *
 *   {
 *     score:     0-100 weighted-pass percentage
 *     rating:    "excellent" | "good" | "needs-work" | "poor" | "critical"
 *     passed:    number of pass criteria
 *     failed:    number of fail criteria
 *     totalWeight, earnedWeight,
 *     notes:     human-readable bullets
 *     findings:  list of Finding-shaped objects (one per failed criterion)
 *   }
 *
 * Plug into a check by returning `{ findings: result.findings, jsonPayload:
 * { ...result } }` — the arkitect runner picks up findings for SARIF and
 * the rating goes into envelope.diagnostics.
 */

export const RATING_BANDS = Object.freeze([
  { min: 90, label: "excellent" },
  { min: 75, label: "good" },
  { min: 50, label: "needs-work" },
  { min: 25, label: "poor" },
  { min: 0, label: "critical" },
]);

export function rateScore(score100) {
  const v = Math.max(0, Math.min(100, Number(score100) || 0));
  for (const band of RATING_BANDS) if (v >= band.min) return band.label;
  return "critical";
}

/**
 * @typedef {Object} Criterion
 * @property {string} id
 * @property {boolean} passed
 * @property {number} [weight=1]
 * @property {string} [successMessage]
 * @property {string} [failureMessage]
 * @property {string} [severity]       Severity for the emitted Finding when failed.
 * @property {string} [filePath]       Optional file location for the Finding.
 * @property {number} [line]
 */

export function scoreChecklist(criteria, { check } = {}) {
  const list = Array.isArray(criteria) ? criteria : [];
  let totalWeight = 0;
  let earnedWeight = 0;
  let passed = 0;
  let failed = 0;
  const notes = [];
  const findings = [];

  for (const criterion of list) {
    const weight = Number(criterion.weight ?? 1);
    totalWeight += weight;
    if (criterion.passed) {
      passed += 1;
      earnedWeight += weight;
      if (criterion.successMessage) notes.push(`[+] ${criterion.successMessage}`);
    } else {
      failed += 1;
      if (criterion.failureMessage) notes.push(`[-] ${criterion.failureMessage}`);
      findings.push({
        ruleId: `${check?.id ?? "checklist"}/${criterion.id}`,
        severity: criterion.severity ?? "medium",
        filePath: criterion.filePath ?? "",
        line: criterion.line ?? 0,
        message: criterion.failureMessage ?? `${criterion.id} did not pass`,
        snippet: "",
        metadata: { weight, criterionId: criterion.id },
      });
    }
  }

  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  return {
    score,
    rating: rateScore(score),
    passed,
    failed,
    totalWeight,
    earnedWeight,
    notes,
    findings,
  };
}

/**
 * Combine many category scores into a single overall, weighted by category
 * weight. Categories whose weights sum to anything > 0 produce the overall;
 * missing categories are ignored.
 *
 *   categoryScores = [{ name: "readme", score: 87, weight: 0.25 }, ...]
 */
export function combineCategoryScores(categoryScores) {
  const list = Array.isArray(categoryScores) ? categoryScores : [];
  let total = 0;
  let sum = 0;
  for (const entry of list) {
    const weight = Number(entry.weight ?? 0);
    const score = Number(entry.score ?? 0);
    if (weight <= 0) continue;
    total += weight;
    sum += weight * score;
  }
  if (total === 0) return { score: 0, rating: rateScore(0), categories: list };
  const overall = Math.round(sum / total);
  return { score: overall, rating: rateScore(overall), categories: list };
}
