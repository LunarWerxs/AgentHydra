/**
 * detectors/slow-db-query.mjs — Slow DB Query Detector
 * =====================================================
 * Adapted from Sentry's `SlowDBQueryDetector` in
 * `src/sentry/issue_detection/detectors/slow_db_query_detector.py`.
 *
 * Detects individual DB spans whose duration exceeds a configurable threshold.
 * This is the simplest detector — it's a single-span check.
 *
 * ## Algorithm
 *
 *   1. For each DB span, check if duration ≥ threshold
 *   2. Only trigger on SELECT statements (not INSERT/UPDATE/DELETE)
 *   3. Skip truncated queries (ending with "...")
 *   4. One problem per unique span hash (first-write-wins)
 *
 * ## Thresholds
 *
 *   - `durationThreshold`: minimum span duration in ms (default: 1000 = 1 second)
 *
 * ## Fingerprint
 *
 *   SHA-256 of: span hash
 */

import { SpanDetector, isDbSpan } from "../span-detector.mjs";
import { createSpanProblem, PROBLEM_TYPES } from "../span-problem.mjs";
import { SPAN_ID, DESCRIPTION, OP, HASH } from "../span-fields.mjs";
import { getSpanDurationMs } from "../span-tree.mjs";
import { createHash } from "node:crypto";

export class SlowDBQueryDetector extends SpanDetector {
  static detectorType = "slow_db_query";

  isSpanEligible(span) {
    return isDbSpan(span);
  }

  visitSpan(span) {
    const durationThreshold = this.settings.durationThreshold ?? 1000; // ms
    const duration = getSpanDurationMs(span);

    if (duration < durationThreshold) return;

    // Only trigger on SELECT statements
    const desc = (span[DESCRIPTION] ?? "").trim();
    if (!desc || desc.slice(0, 6).toUpperCase() !== "SELECT") return;

    // Skip truncated queries
    if (desc.endsWith("...")) return;

    // Fingerprint by span hash (one problem per unique query)
    const hash = span[HASH];
    if (!hash) return;
    const fingerprint = createHash("sha256").update(String(hash)).digest("hex").substring(0, 16);

    const spanId = span[SPAN_ID];
    if (!spanId) return;

    const evidence = {
      op: span[OP],
      spanId,
      durationMs: Math.round(duration),
      query: desc.substring(0, 200), // truncated for display
      threshold: durationThreshold,
    };

    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.SLOW_DB_QUERY,
      spanOp: span[OP],
      description: desc.substring(0, 200),
      offenderSpanIds: [spanId],
      evidence,
    });

    this.storeProblem(fingerprint, problem);
  }
}
