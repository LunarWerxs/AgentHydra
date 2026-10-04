/**
 * detectors/consecutive-http.mjs — Consecutive HTTP Request Detector
 * ===================================================================
 * Adapted from Sentry's `ConsecutiveHTTPSpanDetector` in
 * `src/sentry/issue_detection/detectors/consecutive_http_detector.py`.
 *
 * Detects runs of consecutive HTTP requests to the same domain that could
 * be parallelized. Similar to ConsecutiveDB but for HTTP calls.
 *
 * ## Algorithm
 *
 *   1. Collect consecutive HTTP spans to the same domain
 *   2. When chain breaks, check: ≥ threshold count, ≥ min time saved
 *   3. Store problem if thresholds met
 *
 * ## Thresholds
 *
 *   - `consecutiveCountThreshold`: min consecutive HTTP spans (default: 3)
 *   - `spanDurationThreshold`: min individual span duration in ms (default: 50)
 *   - `minTimeSaved`: min ms saved by parallelization (default: 200)
 */

import { SpanDetector, isHttpSpan, getSpanEvidence } from "../span-detector.mjs";
import { createSpanProblem, PROBLEM_TYPES } from "../span-problem.mjs";
import { SPAN_ID, OP, RAW_DOMAIN, SPAN_DOMAIN } from "../span-fields.mjs";
import { getSpanDurationMs, getTotalSpanDurationMs, spansOverlap } from "../span-tree.mjs";
import { createHash } from "node:crypto";

export class ConsecutiveHTTPSpanDetector extends SpanDetector {
  static detectorType = "consecutive_http";

  constructor(settings = {}, context = {}) {
    super(settings, context);

    /** @type {Object[]} — consecutive HTTP spans being collected */
    this.consecutiveHttpSpans = [];
  }

  isSpanEligible(span) {
    return isHttpSpan(span);
  }

  visitSpan(span) {
    const spanId = span[SPAN_ID];
    if (!spanId) return;

    if (!isHttpSpan(span)) {
      this._validateAndStore();
      this._reset();
      return;
    }

    const spanDurationThreshold = this.settings.spanDurationThreshold ?? 50;
    if (getSpanDurationMs(span) < spanDurationThreshold) {
      this._validateAndStore();
      this._reset();
      return;
    }

    // Check overlap with previous span
    if (this.consecutiveHttpSpans.length > 0) {
      const prev = this.consecutiveHttpSpans[this.consecutiveHttpSpans.length - 1];
      if (spansOverlap(prev, span)) {
        this._validateAndStore();
        this._reset();
        return;
      }
    }

    this.consecutiveHttpSpans.push(span);
  }

  onComplete() {
    this._validateAndStore();
  }

  // --------------- internal ---------------

  _validateAndStore() {
    const countThreshold = this.settings.consecutiveCountThreshold ?? 3;
    if (this.consecutiveHttpSpans.length < countThreshold) return;

    const totalDuration = getTotalSpanDurationMs(this.consecutiveHttpSpans);
    const maxSingle = Math.max(...this.consecutiveHttpSpans.map((s) => getSpanDurationMs(s)));
    const timeSaved = totalDuration - maxSingle; // everything except longest could run in parallel

    const minTimeSaved = this.settings.minTimeSaved ?? 200;
    if (timeSaved < minTimeSaved) return;

    const fingerprint = this._computeFingerprint();

    const offenderIds = this.consecutiveHttpSpans.map((s) => s[SPAN_ID]).filter(Boolean);
    const domain = this.consecutiveHttpSpans[0][SPAN_DOMAIN] ?? this.consecutiveHttpSpans[0][RAW_DOMAIN] ?? "unknown";

    const evidence = {
      consecutiveCount: this.consecutiveHttpSpans.length,
      totalDurationMs: Math.round(totalDuration),
      timeSavedMs: Math.round(timeSaved),
      domain,
      sampleRequest: getSpanEvidence(this.consecutiveHttpSpans[0]),
    };

    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.CONSECUTIVE_HTTP,
      spanOp: this.consecutiveHttpSpans[0][OP] ?? "http.client",
      description: `${this.consecutiveHttpSpans.length} consecutive HTTP requests to ${domain} (save ${Math.round(timeSaved)}ms by parallelizing)`,
      offenderSpanIds: offenderIds,
      evidence,
    });

    this.storeProblem(fingerprint, problem);
  }

  _reset() {
    this.consecutiveHttpSpans = [];
  }

  _computeFingerprint() {
    const domain = this.consecutiveHttpSpans[0]?.[SPAN_DOMAIN] ?? this.consecutiveHttpSpans[0]?.[RAW_DOMAIN] ?? "";
    const input = `${domain}:${this.consecutiveHttpSpans.length}`;
    return createHash("sha256").update(input).digest("hex").substring(0, 16);
  }
}
