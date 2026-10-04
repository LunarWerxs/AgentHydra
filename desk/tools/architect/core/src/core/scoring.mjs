/**
 * Severity-weighted scoring primitives.
 *
 * Adopted from the audit-suite convention popularised by
 * levnikolaevich/claude-code-skills (shared/references/audit_scoring.md) and
 * itsmesherry/claude-audit (src/core/auditor.ts mergeStaticIntoCategories).
 *
 * The model: each finding has a severity. Severities have weights. Penalty is
 * the weighted sum. A 0-10 score is `max(0, 10 - penalty)`. A 0-100 score is
 * the same, multiplied by 10. A letter grade is derived from the 0-100 score.
 *
 * Two weight tables ship out of the box:
 *   - CODE_QUALITY_WEIGHTS — gentler, suited to architecture/quality audits.
 *     Matches the published `penalty = C*2.0 + H*1.0 + M*0.5 + L*0.2` formula.
 *   - SECURITY_WEIGHTS — steeper, suited to security audits where a single
 *     critical should dominate the score. Matches claude-audit's
 *     mergeStaticIntoCategories (critical=15, high=8, medium=4, low=2).
 *
 * Anything that returns findings can call `scoreFindings(findings, weights?)`
 * to produce a uniform `{ score, score100, grade, penalty, severityCounts }`
 * object. Use it to populate the `payload.audit.{score,severity_counts}`
 * envelope fields (see ./envelope.mjs) without each check having to roll its
 * own math.
 */

export const SEVERITY_LEVELS = Object.freeze(["critical", "high", "medium", "low", "info"]);

export const CODE_QUALITY_WEIGHTS = Object.freeze({
  critical: 2.0,
  high: 1.0,
  medium: 0.5,
  low: 0.2,
  info: 0,
});

export const SECURITY_WEIGHTS = Object.freeze({
  critical: 15,
  high: 8,
  medium: 4,
  low: 2,
  info: 0,
});

/**
 * Map any in-the-wild severity label onto the canonical 5-level scale. The
 * arkitect's own checks use `error`/`warn`/`info` historically; SARIF uses
 * `error`/`warning`/`note`; security tools use `critical`/`high`/...
 */
export function normalizeSeverity(value) {
  const raw = String(value ?? "")
    .toLowerCase()
    .trim();
  if (!raw) return "info";

  switch (raw) {
    case "critical":
    case "crit":
    case "blocker":
    case "fatal":
      return "critical";
    case "high":
    case "error":
    case "err":
      return "high";
    case "medium":
    case "med":
    case "warning":
    case "warn":
    case "moderate":
      return "medium";
    case "low":
    case "minor":
    case "note":
      return "low";
    case "info":
    case "informational":
    case "hint":
    case "none":
      return "info";
    default:
      return "info";
  }
}

export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings ?? []) {
    counts[normalizeSeverity(finding?.severity)] += 1;
  }
  return counts;
}

export function calculatePenalty(severityCounts, weights = CODE_QUALITY_WEIGHTS) {
  let penalty = 0;
  for (const level of SEVERITY_LEVELS) {
    const count = Number(severityCounts?.[level] ?? 0);
    const weight = Number(weights?.[level] ?? 0);
    penalty += count * weight;
  }
  return Number(penalty.toFixed(4));
}

export function scoreFromPenalty(penalty, { max = 10 } = {}) {
  const score = Math.max(0, max - penalty);
  return Number(score.toFixed(4));
}

export function gradeFromScore100(score100) {
  if (score100 >= 90) return "A";
  if (score100 >= 80) return "B";
  if (score100 >= 70) return "C";
  if (score100 >= 60) return "D";
  return "F";
}

/**
 * Apply a blast-radius modifier to a base severity. The pattern is borrowed
 * from 3stoneBrother/code-audit (references/core/attack_path_priority.md):
 * findings that need no auth are more severe than those gated behind admin.
 * Reach is the equivalent for non-security audits — a finding that affects
 * every page is worse than one isolated to an admin route.
 *
 *   reach="global"|"public" → bump up one level
 *   reach="internal"        → unchanged
 *   reach="admin"|"local"   → drop one level
 */
export function applyBlastRadius(severity, reach) {
  const normalized = normalizeSeverity(severity);
  const idx = SEVERITY_LEVELS.indexOf(normalized);
  const r = String(reach ?? "").toLowerCase();
  let shift = 0;
  if (r === "global" || r === "public" || r === "no-auth") shift = -1;
  else if (r === "admin" || r === "local" || r === "private") shift = 1;
  const next = Math.max(0, Math.min(SEVERITY_LEVELS.length - 1, idx + shift));
  return SEVERITY_LEVELS[next];
}

export function scoreFindings(findings, weights = CODE_QUALITY_WEIGHTS) {
  const severityCounts = countBySeverity(findings);
  const penalty = calculatePenalty(severityCounts, weights);
  const score = scoreFromPenalty(penalty);
  const score100 = Math.round(score * 10);
  return {
    score,
    score100,
    grade: gradeFromScore100(score100),
    penalty,
    severityCounts,
    totalFindings: (findings ?? []).length,
  };
}
