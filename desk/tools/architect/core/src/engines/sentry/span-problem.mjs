/**
 * span-problem — PerformanceProblem model for arkitect span-based detection
 * ==========================================================================
 * Adapted from Sentry's `PerformanceProblem` dataclass in
 * `src/sentry/issue_detection/performance_problem.py`.
 *
 * A SpanProblem is a finding produced by a SpanDetector. It extends the
 * standard arkitect Finding shape with span-specific traceability:
 *
 *   - `offenderSpanIds` — the spans that are actually slow/bad
 *   - `causeSpanIds`   — the spans that triggered the bad spans
 *   - `parentSpanIds`  — the parent span(s) containing the issue
 *   - `evidence`       — structured data proving the issue exists
 *
 * ## Mapping to Sentry's model:
 *
 *   Sentry PerformanceProblem  →  Arkitect SpanProblem
 *   ─────────────────────────      ─────────────────────
 *   fingerprint                  →  (derived from variant hash)
 *   op                           →  spanOp
 *   desc                         →  description
 *   type (GroupType)             →  problemType
 *   parent_span_ids              →  parentSpanIds
 *   cause_span_ids               →  causeSpanIds
 *   offender_span_ids            →  offenderSpanIds
 *   evidence_data                →  evidence
 *   evidence_display             →  (derived from evidence for output)
 *
 * ## Integration with arkitect Findings
 *
 *   SpanProblem extends the standard finding shape:
 *   ```
 *   {
 *     ruleId: "perf-n-plus-one-db",
 *     severity: "high",
 *     filePath: "trace://...",        // trace identifier
 *     message: "N+1 DB query detected: 10 repeats of SELECT ...",
 *     metadata: {
 *       spanProblem: {                // SpanProblem-specific data
 *         offenderSpanIds: [...],
 *         causeSpanIds: [...],
 *         evidence: { ... },
 *       }
 *     }
 *   }
 *   ```
 *
 * Codebase-agnostic: no framework dependencies.
 */

import { createFinding } from "@saydeploy/architect/core/finding";

// ---------------------------------------------------------------------------
// Problem types (matching Sentry's DetectorType enum values)
// ---------------------------------------------------------------------------

export const PROBLEM_TYPES = {
  N_PLUS_ONE_DB: "n_plus_one_db",
  N_PLUS_ONE_API: "n_plus_one_api",
  CONSECUTIVE_DB: "consecutive_db",
  CONSECUTIVE_HTTP: "consecutive_http",
  SLOW_DB_QUERY: "slow_db_query",
  SLOW_HTTP: "slow_http",
  LARGE_HTTP_PAYLOAD: "large_http_payload",
  HTTP_OVERHEAD: "http_overhead",
  UNCOMPRESSED_ASSET: "uncompressed_asset",
  RENDER_BLOCKING_ASSET: "render_blocking_asset",
  MAIN_THREAD_IO: "main_thread_io",
  M_N_PLUS_ONE_DB: "m_n_plus_one_db",
  CACHE_MISS: "cache_miss",
  QUEUE_BACKLOG: "queue_backlog",
};

// ---------------------------------------------------------------------------
// Severity mapping: problem type → default severity
// ---------------------------------------------------------------------------

const DEFAULT_SEVERITY = {
  [PROBLEM_TYPES.N_PLUS_ONE_DB]: "high",
  [PROBLEM_TYPES.N_PLUS_ONE_API]: "high",
  [PROBLEM_TYPES.CONSECUTIVE_DB]: "medium",
  [PROBLEM_TYPES.CONSECUTIVE_HTTP]: "medium",
  [PROBLEM_TYPES.SLOW_DB_QUERY]: "medium",
  [PROBLEM_TYPES.SLOW_HTTP]: "medium",
  [PROBLEM_TYPES.LARGE_HTTP_PAYLOAD]: "low",
  [PROBLEM_TYPES.HTTP_OVERHEAD]: "low",
  [PROBLEM_TYPES.UNCOMPRESSED_ASSET]: "low",
  [PROBLEM_TYPES.RENDER_BLOCKING_ASSET]: "medium",
  [PROBLEM_TYPES.MAIN_THREAD_IO]: "high",
  [PROBLEM_TYPES.M_N_PLUS_ONE_DB]: "high",
  [PROBLEM_TYPES.CACHE_MISS]: "medium",
  [PROBLEM_TYPES.QUEUE_BACKLOG]: "medium",
};

// ---------------------------------------------------------------------------
// SpanProblem factory
// ---------------------------------------------------------------------------

/**
 * Create a SpanProblem finding from detector output.
 *
 * @param {Object} params
 * @param {string} params.problemType  — one of PROBLEM_TYPES
 * @param {string} params.spanOp       — the span operation (e.g. "db.sql.query")
 * @param {string} params.description  — human-readable issue description
 * @param {string[]} params.offenderSpanIds — spans that are the problem
 * @param {string[]} [params.causeSpanIds]  — spans that caused the problem
 * @param {string[]} [params.parentSpanIds] — parent span containing the issue
 * @param {Object} [params.evidence]        — structured evidence data
 * @param {Object} [params.overrides]       — overrides for finding fields (severity, filePath, etc.)
 * @returns {Object} an arkitect Finding with span problem metadata
 */
export function createSpanProblem({
  problemType,
  spanOp,
  description,
  offenderSpanIds,
  causeSpanIds = [],
  parentSpanIds = [],
  evidence = {},
  overrides = {},
}) {
  const ruleId = `perf-${problemType.replaceAll("_", "-")}`;
  const severity = overrides.severity ?? DEFAULT_SEVERITY[problemType] ?? "medium";

  // Build a human-readable message
  const offenderCount = offenderSpanIds.length;
  const message = buildProblemMessage(problemType, spanOp, description, offenderCount);

  const finding = createFinding({
    ruleId,
    severity,
    filePath: overrides.filePath ?? "",
    line: overrides.line ?? 0,
    message,
    snippet: overrides.snippet ?? description,
    metadata: {
      ...overrides.metadata,
      spanProblem: {
        problemType,
        spanOp,
        description,
        offenderSpanIds,
        causeSpanIds,
        parentSpanIds,
        evidence,
        offenderCount,
      },
    },
  });

  return finding;
}

/**
 * Build a human-readable message for each problem type.
 */
function buildProblemMessage(problemType, spanOp, description, offenderCount) {
  switch (problemType) {
    case PROBLEM_TYPES.N_PLUS_ONE_DB:
      return `N+1 DB query detected: ${offenderCount} repeats of \`${spanOp}\` — ${description}`;
    case PROBLEM_TYPES.N_PLUS_ONE_API:
      return `N+1 API call detected: ${offenderCount} repeats to \`${description}\``;
    case PROBLEM_TYPES.CONSECUTIVE_DB:
      return `Consecutive DB queries detected: ${offenderCount} sequential \`${spanOp}\` calls — ${description}`;
    case PROBLEM_TYPES.CONSECUTIVE_HTTP:
      return `Consecutive HTTP requests detected: ${offenderCount} sequential calls — ${description}`;
    case PROBLEM_TYPES.SLOW_DB_QUERY:
      return `Slow DB query: \`${spanOp}\` — ${description}`;
    case PROBLEM_TYPES.SLOW_HTTP:
      return `Slow HTTP request: \`${spanOp}\` — ${description}`;
    case PROBLEM_TYPES.LARGE_HTTP_PAYLOAD:
      return `Large HTTP payload: ${description}`;
    case PROBLEM_TYPES.HTTP_OVERHEAD:
      return `HTTP/1.1 connection overhead: ${offenderCount} requests to ${description}`;
    case PROBLEM_TYPES.UNCOMPRESSED_ASSET:
      return `Uncompressed asset: ${description}`;
    case PROBLEM_TYPES.RENDER_BLOCKING_ASSET:
      return `Render-blocking asset: ${description}`;
    case PROBLEM_TYPES.MAIN_THREAD_IO:
      return `Main thread I/O: \`${spanOp}\` — ${description}`;
    case PROBLEM_TYPES.M_N_PLUS_ONE_DB:
      return `M:N+1 DB query pattern: ${offenderCount} offenders — ${description}`;
    case PROBLEM_TYPES.CACHE_MISS:
      return `Cache miss: ${description}`;
    case PROBLEM_TYPES.QUEUE_BACKLOG:
      return `Queue backlog: ${description}`;
    default:
      return `${problemType}: ${description}`;
  }
}

/**
 * Check if a finding contains span problem metadata.
 *
 * @param {Object} finding
 * @returns {boolean}
 */
export function isSpanProblem(finding) {
  return !!finding?.metadata?.spanProblem;
}

/**
 * Extract the SpanProblem metadata from a finding.
 *
 * @param {Object} finding
 * @returns {Object | null}
 */
export function getSpanProblem(finding) {
  return finding?.metadata?.spanProblem ?? null;
}
