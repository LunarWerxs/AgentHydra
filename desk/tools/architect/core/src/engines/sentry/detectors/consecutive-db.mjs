/**
 * detectors/consecutive-db.mjs — Consecutive DB Query Detector
 * =============================================================
 * Adapted from Sentry's `ConsecutiveDBSpanDetector` in
 * `src/sentry/issue_detection/detectors/consecutive_db_detector.py`.
 *
 * Detects runs of consecutive DB queries that could be parallelized.
 * When multiple DB queries appear back-to-back without any non-DB spans
 * between them, they may be independent and could run in parallel.
 *
 * ## Algorithm
 *
 *   1. Collect consecutive DB spans until a non-DB span breaks the chain
 *   2. When the chain breaks, analyze the collected spans:
 *      a. Split into independent (parallelizable) vs dependent spans
 *      b. If the sum of independent span durations exceeds threshold → problem
 *   3. Spans are "dependent" if they contain WHERE clauses referencing
 *      data that could come from a previous query
 *
 * ## Independence heuristic (simplified from Sentry)
 *
 *   Two DB spans are independent if:
 *   - They have different hashes (different queries), OR
 *   - They have the same hash but no WHERE clause overlap
 *
 *   For simplicity, this port uses a heuristic: spans with different hashes
 *   that don't overlap chronologically are potentially parallelizable.
 *
 * ## Thresholds
 *
 *   - `consecutiveCountThreshold`: min consecutive DB spans to trigger (default: 2)
 *   - `minTimeSaved`: min ms saved by parallelization (default: 100)
 *   - `minTimeSavedRatio`: min ratio of independent/total duration (default: 0.1)
 *   - `spanDurationThreshold`: min individual span duration in ms (default: 30)
 */

import { SpanDetector, isDbSpan, getSpanEvidence } from "../span-detector.mjs";
import { createSpanProblem, PROBLEM_TYPES } from "../span-problem.mjs";
import { SPAN_ID, OP, HASH } from "../span-fields.mjs";
import { getSpanDurationMs, getTotalSpanDurationMs, spansOverlap } from "../span-tree.mjs";
import { createHash } from "node:crypto";

export class ConsecutiveDBSpanDetector extends SpanDetector {
  static detectorType = "consecutive_db";

  constructor(settings = {}, context = {}) {
    super(settings, context);

    /** @type {Object[]} — consecutive DB spans being collected */
    this.consecutiveDbSpans = [];

    /** @type {Object[]} — spans from consecutive run that are independent (parallelizable) */
    this.independentSpans = [];

    /** @type {Object | null} — the last non-DB span (for detecting chain breaks) */
    this.lastSpan = null;
  }

  isSpanEligible(_span) {
    // We need to see all spans to detect chain breaks
    return true;
  }

  visitSpan(span) {
    const spanId = span[SPAN_ID];
    if (!spanId) return;

    if (!isDbSpan(span)) {
      // Non-DB span: chain broken → analyze accumulated consecutive DB spans
      this._validateAndStore();
      this._reset();
      this.lastSpan = span;
      return;
    }

    // DB span
    const spanDurationThreshold = this.settings.spanDurationThreshold ?? 30;
    if (getSpanDurationMs(span) < spanDurationThreshold) {
      // Too short to matter
      this._validateAndStore();
      this._reset();
      return;
    }

    // Check if this DB span overlaps the PREVIOUS span (not just DB, any span)
    if (this._overlapsLastSpan(span)) {
      this._validateAndStore();
      this._reset();
      return;
    }

    this.consecutiveDbSpans.push(span);
  }

  onComplete() {
    this._validateAndStore();
  }

  // --------------- internal ---------------

  _overlapsLastSpan(span) {
    if (!this.lastSpan) {
      // Check against the last span in consecutiveDbSpans
      if (this.consecutiveDbSpans.length === 0) return false;
      return spansOverlap(this.consecutiveDbSpans[this.consecutiveDbSpans.length - 1], span);
    }
    return spansOverlap(this.lastSpan, span);
  }

  _validateAndStore() {
    const countThreshold = this.settings.consecutiveCountThreshold ?? 2;
    if (this.consecutiveDbSpans.length < countThreshold) return;

    // Determine which spans are independent (parallelizable)
    this._computeIndependentSpans();
    if (this.independentSpans.length < 2) return;

    const totalDuration = getTotalSpanDurationMs(this.consecutiveDbSpans);
    const independentDuration = getTotalSpanDurationMs(this.independentSpans);
    const timeSaved = independentDuration; // all independent spans could run in parallel

    const minTimeSaved = this.settings.minTimeSaved ?? 100;
    const minTimeSavedRatio = this.settings.minTimeSavedRatio ?? 0.1;

    if (timeSaved < minTimeSaved) return;
    if (totalDuration > 0 && timeSaved / totalDuration < minTimeSavedRatio) return;

    // Build fingerprint
    const fingerprint = this._computeFingerprint();

    // Build evidence
    const offenderIds = this.consecutiveDbSpans.map((s) => s[SPAN_ID]).filter(Boolean);
    const independentIds = this.independentSpans.map((s) => s[SPAN_ID]).filter(Boolean);

    const evidence = {
      consecutiveCount: this.consecutiveDbSpans.length,
      independentCount: this.independentSpans.length,
      totalDurationMs: Math.round(totalDuration),
      independentDurationMs: Math.round(independentDuration),
      timeSavedMs: Math.round(timeSaved),
      timeSavedRatio: totalDuration > 0 ? Math.round((timeSaved / totalDuration) * 100) / 100 : 0,
      sampleQuery: getSpanEvidence(this.consecutiveDbSpans[0]),
    };

    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.CONSECUTIVE_DB,
      spanOp: this.consecutiveDbSpans[0][OP] ?? "db",
      description: `${this.consecutiveDbSpans.length} consecutive DB queries (${this.independentSpans.length} parallelizable, save ${Math.round(timeSaved)}ms)`,
      offenderSpanIds: offenderIds,
      causeSpanIds: independentIds,
      evidence,
    });

    this.storeProblem(fingerprint, problem);
  }

  /**
   * Heuristic: spans with different hashes are independent.
   * Spans with the same hash that don't overlap chronologically are also independent.
   */
  _computeIndependentSpans() {
    this.independentSpans = [];
    const seen = new Set();

    for (const span of this.consecutiveDbSpans) {
      const hash = span[HASH] ?? "";
      if (!seen.has(hash) || hash === "") {
        this.independentSpans.push(span);
        seen.add(hash);
      }
    }
  }

  _reset() {
    this.consecutiveDbSpans = [];
    this.independentSpans = [];
  }

  _computeFingerprint() {
    const hashes = this.consecutiveDbSpans
      .map((s) => s[HASH] ?? "")
      .sort()
      .join(",");
    return createHash("sha256").update(hashes).digest("hex").substring(0, 16);
  }
}
