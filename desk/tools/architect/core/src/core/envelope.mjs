/**
 * Canonical JSON output envelope for audit results.
 *
 * Adopted from levnikolaevich/claude-code-skills (shared/references/
 * audit_summary_contract.md). The envelope is what every check that opts in
 * MUST return when invoked with `--format=envelope`. It gives downstream
 * consumers (coordinators, dashboards, CI) a stable, versioned shape they can
 * parse without knowing which check produced it.
 *
 * The envelope is intentionally orthogonal to whatever ad-hoc `jsonPayload`
 * shape a check returns today — checks can produce both, and the envelope is
 * derived from findings + scoring at the runner edge.
 *
 *   {
 *     schema_version: 1,
 *     summary_kind:   "audit",
 *     run_id:         "<uuid>",
 *     emitted_at:     "<iso8601>",
 *     check: {
 *       id, title, category, family,
 *       config_digest: <hash of resolved checkConfig>,
 *       duration_ms,
 *     },
 *     project: { root, name, languages, frameworks },  // optional
 *     verdict: "pass" | "fail" | "inconclusive",
 *     payload: {
 *       audit: { score, score100, grade, penalty, severity_counts, total_findings },
 *       findings: [Finding],                            // normalized SARIF-ish
 *       diagnostics: { ... },                           // free-form per-check
 *     },
 *   }
 */

import crypto from "node:crypto";

import { scoreFindings, CODE_QUALITY_WEIGHTS } from "./scoring.mjs";

export const ENVELOPE_SCHEMA_VERSION = 1;

export function createRunId() {
  return crypto.randomUUID();
}

export function digestConfig(checkConfig) {
  const json = JSON.stringify(checkConfig ?? {}, Object.keys(checkConfig ?? {}).sort());
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
}

/**
 * Build a stable envelope from a check's raw result. The runner can call this
 * once per check; the check itself does not need to know the envelope schema.
 */
export function buildEnvelope({
  check,
  result,
  project,
  runId = createRunId(),
  emittedAt = new Date().toISOString(),
  durationMs = 0,
  weights = CODE_QUALITY_WEIGHTS,
}) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const score = scoreFindings(findings, weights);
  const verdict = decideVerdict({ result, findings });

  const envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    summary_kind: "audit",
    run_id: runId,
    emitted_at: emittedAt,
    check: {
      id: check?.id ?? "",
      title: check?.title ?? "",
      category: check?.category ?? "",
      family: check?.family ?? check?.category ?? "",
      config_digest: digestConfig(check?.resolvedConfig ?? {}),
      duration_ms: Math.max(0, Number(durationMs) || 0),
    },
    verdict,
    payload: {
      audit: {
        score: score.score,
        score100: score.score100,
        grade: score.grade,
        penalty: score.penalty,
        severity_counts: score.severityCounts,
        total_findings: score.totalFindings,
      },
      findings,
      diagnostics: pickDiagnostics(result),
    },
  };

  if (project) {
    envelope.project = project;
  }

  return envelope;
}

function decideVerdict({ result, findings }) {
  if (result?.verdict) return String(result.verdict);
  if (result?.failed === true) return "fail";
  if (findings.length === 0) return "pass";
  // Findings present but `failed !== true` → the check itself doesn't gate on
  // them. Treat as "inconclusive" so the coordinator can decide.
  return "inconclusive";
}

const RESERVED_RESULT_KEYS = new Set([
  "findings",
  "failed",
  "baseline",
  "baselineDocument",
  "report",
  "jsonPayload",
  "outputPath",
  "verdict",
  "usedBaseline",
]);

function pickDiagnostics(result) {
  if (!result || typeof result !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (RESERVED_RESULT_KEYS.has(key)) continue;
    out[key] = value;
  }
  // Merge anything the check has explicitly placed under jsonPayload so a
  // single envelope reader sees everything.
  if (result.jsonPayload && typeof result.jsonPayload === "object") {
    for (const [key, value] of Object.entries(result.jsonPayload)) {
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}
