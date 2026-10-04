/**
 * Two-stage findings filter.
 *
 * Adapted from anthropics/claude-code-security-review (claudecode/
 * findings_filter.py). The two stages:
 *
 *   1. Hard rules — fast, pre-compiled regex-or-glob suppressions. Runs first
 *      because it's deterministic and cheap. The rules pattern matches the
 *      finding's `filePath`, `ruleId`, `message`, or `metadata.*`.
 *   2. Semantic predicate — an optional async function the policy pack can
 *      attach to make a smarter call (e.g. "drop findings in test files that
 *      reference a known fixture token"). The runner does NOT ship a default
 *      predicate; that's the policy pack's job.
 *
 * Both stages return `FilterStats` telemetry so the runner can show how many
 * findings were dropped at each stage. This IS the arkitect's suppression /
 * baseline-like mechanic, complementary to per-finding baseline keys.
 */

import { normalizeSeverity } from "./scoring.mjs";

/**
 * @typedef {Object} HardRule
 * @property {string} [id]            Stable id for telemetry.
 * @property {string} [reason]        Why this rule exists. Surfaced in reports.
 * @property {RegExp|string} [filePath]
 * @property {RegExp|string} [ruleId]
 * @property {RegExp|string} [message]
 * @property {Record<string, RegExp|string>} [metadata]
 * @property {string} [severityAtMost]  Drop only when severity <= this.
 */

/** Compile a rule's string patterns into anchored regexes. */
export function compileRule(rule) {
  return {
    id: rule.id ?? "anonymous",
    reason: rule.reason ?? "",
    filePath: toRegex(rule.filePath),
    ruleId: toRegex(rule.ruleId),
    message: toRegex(rule.message),
    metadata: rule.metadata
      ? Object.fromEntries(Object.entries(rule.metadata).map(([key, value]) => [key, toRegex(value)]))
      : null,
    severityAtMost: rule.severityAtMost ? normalizeSeverity(rule.severityAtMost) : null,
  };
}

export function compileRules(rules) {
  return (rules ?? []).map(compileRule);
}

function toRegex(value) {
  if (!value) return null;
  if (value instanceof RegExp) return value;
  return new RegExp(value);
}

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];

function severityLeq(a, b) {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b);
}

export function matchesHardRule(finding, rule) {
  if (rule.filePath && !rule.filePath.test(String(finding?.filePath ?? ""))) return false;
  if (rule.ruleId && !rule.ruleId.test(String(finding?.ruleId ?? ""))) return false;
  if (rule.message && !rule.message.test(String(finding?.message ?? ""))) return false;
  if (rule.metadata) {
    for (const [key, regex] of Object.entries(rule.metadata)) {
      if (!regex.test(String(finding?.metadata?.[key] ?? ""))) return false;
    }
  }
  if (rule.severityAtMost) {
    const sev = normalizeSeverity(finding?.severity);
    if (!severityLeq(sev, rule.severityAtMost)) return false;
  }
  // A rule with no clauses matches nothing — refuse to silently drop everything.
  const hasAnyClause = rule.filePath || rule.ruleId || rule.message || rule.metadata || rule.severityAtMost;
  return Boolean(hasAnyClause);
}

/**
 * @param {Array<Finding>} findings
 * @param {{ hardRules?: HardRule[], semanticPredicate?: (finding) => Promise<boolean>|boolean }} opts
 *   `semanticPredicate(finding)` returns `true` to KEEP the finding, `false`
 *   to drop. Returning `null`/`undefined` is treated as keep.
 */
export async function filterFindings(findings, { hardRules = [], semanticPredicate } = {}) {
  const compiled = hardRules.map((rule) => (rule._compiled ? rule : compileRule(rule)));
  const kept = [];
  const dropped = [];
  const stats = {
    total: 0,
    hardDropped: 0,
    semanticDropped: 0,
    byRuleId: {},
  };

  for (const finding of findings ?? []) {
    stats.total += 1;
    const matchedRule = compiled.find((rule) => matchesHardRule(finding, rule));
    if (matchedRule) {
      stats.hardDropped += 1;
      stats.byRuleId[matchedRule.id] = (stats.byRuleId[matchedRule.id] ?? 0) + 1;
      dropped.push({ finding, stage: "hard", reason: matchedRule.reason, ruleId: matchedRule.id });
      continue;
    }

    if (semanticPredicate) {
      const decision = await semanticPredicate(finding);
      if (decision === false) {
        stats.semanticDropped += 1;
        dropped.push({ finding, stage: "semantic" });
        continue;
      }
    }

    kept.push(finding);
  }

  return { kept, dropped, stats };
}
