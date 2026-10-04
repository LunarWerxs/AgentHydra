/**
 * detectors/n-plus-one-db.mjs — N+1 DB Query Detector
 * =====================================================
 * Adapted from Sentry's `NPlusOneDBSpanDetector` in
 * `src/sentry/issue_detection/detectors/n_plus_one_db_span_detector.py`.
 *
 * Detects the N+1 query pattern: a "source" DB query followed by N identical
 * DB queries, all under the same parent span. This is the most common
 * performance anti-pattern in ORM-heavy applications.
 *
 * ## Algorithm (matching Sentry)
 *
 *   1. Walk spans in order (already tree-flattened by the orchestrator)
 *   2. Track non-DB spans as potential parents
 *   3. When a DB span is found:
 *      a. If no source span: maybe this DB span STARTS an N+1
 *      b. If source span set: check if this span continues the N+1
 *         (same op + same hash = continuation)
 *      c. If continuation breaks: store the problem (if thresholds met), reset
 *   4. onComplete: store any remaining N+1
 *
 * ## Thresholds
 *
 *   - `count`: minimum number of repeating spans (default: 5)
 *   - `durationThreshold`: minimum total duration of repeating spans in ms (default: 100)
 *
 * ## Fingerprint
 *
 *   SHA-256 of: source_span_hash + parent_span_id
 *   This ensures the same logical N+1 gets the same fingerprint across runs.
 */

import { SpanDetector, isDbSpan, fingerprintSpan, areSpansEquivalent, getSpanEvidence } from "../span-detector.mjs";
import { createSpanProblem, PROBLEM_TYPES } from "../span-problem.mjs";
import { SPAN_ID, PARENT_SPAN_ID, OP, HASH } from "../span-fields.mjs";
import { getTotalSpanDurationMs } from "../span-tree.mjs";
import { createHash } from "node:crypto";

export class NPlusOneDBSpanDetector extends SpanDetector {
  static detectorType = "n_plus_one_db";

  constructor(settings = {}, context = {}) {
    super(settings, context);

    /** @type {Object | null} — the first DB span that might start an N+1 */
    this.sourceSpan = null;

    /** @type {Object[]} — the N repeating spans */
    this.nSpans = [];

    /** @type {Map<string, Object>} — span_id → span for non-DB spans (potential parents) */
    this.potentialParents = new Map();
  }

  isSpanEligible(_span) {
    return true; // We need to see ALL spans to track parents, not just DB spans
  }

  visitSpan(span) {
    const spanId = span[SPAN_ID];
    const op = span[OP];
    if (!spanId || !op) return;

    if (!isDbSpan(span)) {
      // Non-DB span: breaks any current N+1 tracking
      this._maybeStoreProblem();
      this._resetDetection();

      // Track ALL non-DB spans as potential parents.
      // A DB span's parent_span_id references its immediate parent,
      // which could be any non-DB span (including root spans without
      // their own parent_span_id).
      this.potentialParents.set(spanId, span);
      return;
    }

    // This is a DB span
    if (!this.sourceSpan) {
      // No active N+1 tracking — maybe this DB span starts one
      this._maybeUseAsSource(span);
      return;
    }

    // We have a source span — check if this span continues the N+1
    if (this._continuesNPlusOne(span)) {
      this.nSpans.push(span);
    } else {
      // Pattern broken — store if threshold met, then reset
      this._maybeStoreProblem();
      this._resetDetection();

      // Maybe the NEXT DB span starts a new N+1
      this._maybeUseAsSource(span);
    }
  }

  onComplete() {
    this._maybeStoreProblem();
  }

  // --------------- internal ---------------

  _maybeUseAsSource(span) {
    const parentId = span[PARENT_SPAN_ID];
    if (!parentId || !this.potentialParents.has(parentId)) return;
    this.sourceSpan = span;
  }

  _continuesNPlusOne(span) {
    if (!this.sourceSpan) return false;
    return areSpansEquivalent(this.sourceSpan, span);
  }

  _maybeStoreProblem() {
    if (!this.sourceSpan || this.nSpans.length === 0) return;

    const count = this.settings.count ?? 5;
    const durationThreshold = this.settings.durationThreshold ?? 100;

    if (this.nSpans.length < count) return;

    const totalDuration = getTotalSpanDurationMs(this.nSpans);
    if (totalDuration < durationThreshold) return;

    // Require a parent span for fingerprint accuracy
    const parentId = this.sourceSpan[PARENT_SPAN_ID];
    if (!parentId) return;
    const parentSpan = this.potentialParents.get(parentId);
    if (!parentSpan) return;

    // Build fingerprint
    const fingerprint = this._computeFingerprint();

    // Build evidence
    const offenderIds = this.nSpans.map((s) => s[SPAN_ID]).filter(Boolean);
    const evidence = {
      op: this.sourceSpan[OP],
      sourceSpanId: this.sourceSpan[SPAN_ID],
      parentSpanId: parentId,
      parentSpanEvidence: getSpanEvidence(parentSpan),
      repeatingSpanEvidence: getSpanEvidence(this.nSpans[0]),
      repeatingSpanCount: this.nSpans.length,
      totalDurationMs: Math.round(totalDuration),
      averageDurationMs: Math.round(totalDuration / this.nSpans.length),
    };

    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.N_PLUS_ONE_DB,
      spanOp: this.sourceSpan[OP],
      description: getSpanEvidence(this.nSpans[0], false),
      offenderSpanIds: offenderIds,
      causeSpanIds: [this.sourceSpan[SPAN_ID]].filter(Boolean),
      parentSpanIds: [parentId],
      evidence,
    });

    this.storeProblem(fingerprint, problem);
  }

  _resetDetection() {
    this.sourceSpan = null;
    this.nSpans = [];
  }

  _computeFingerprint() {
    const sourceHash = this.sourceSpan[HASH] ?? fingerprintSpan(this.sourceSpan);
    const parentId = this.sourceSpan[PARENT_SPAN_ID] ?? "unknown";
    const input = `${sourceHash}:${parentId}`;
    return createHash("sha256").update(input).digest("hex").substring(0, 16);
  }
}
