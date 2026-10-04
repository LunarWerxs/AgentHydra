/**
 * span-detector — Base class and orchestrator for span-based performance detection
 * ================================================================================
 * Adapted from Sentry's `PerformanceDetector` ABC in
 * `src/sentry/issue_detection/base.py` and the orchestrator in
 * `src/sentry/issue_detection/performance_detection.py`.
 *
 * ## Architecture
 *
 *   SpanDetector (base class)
 *   ├── visitSpan(span)    — called for each span in order, accumulates state
 *   ├── onComplete()       — called after all spans, emits any remaining problems
 *   ├── isSpanEligible(span) — pre-filter: skip spans irrelevant to this detector
 *   └── storedProblems     — Map<hash, SpanProblem> of detected issues
 *
 *   runDetectorOnTrace(detector, spans)  — orchestrator
 *   ├── prepareSpansForDetection(spans)  — tree → flatten
 *   ├── for each span: detector.visitSpan(span)
 *   └── detector.onComplete()
 *   └── return [...detector.storedProblems.values()]
 *
 * ## Detector Lifecycle (matching Sentry)
 *
 *   1. Constructor receives settings + trace context
 *   2. `isSpanEligible()` gates on span op/category (early skip)
 *   3. `visitSpan()` is called on each span IN ORDER
 *   4. `onComplete()` finalizes — some detectors only emit here
 *   5. Problems are stored in `this.storedProblems` keyed by fingerprint
 *
 * ## Integration with the arkitect pipeline
 *
 *   SpanDetector output (SpanProblem[]) feeds into:
 *   - `finding-pipeline.mjs` for normalization, filtering, output
 *   - `finding-grouping-engine.mjs` for deduplication + regression tracking
 *   - `finding-breadcrumbs.mjs` for diagnostic context
 *
 * Codebase-agnostic: no framework dependencies.
 */

import { prepareSpansForDetection } from "./span-tree.mjs";
import { OP, DESCRIPTION, HASH } from "./span-fields.mjs";

// ---------------------------------------------------------------------------
// SpanDetector base class (parallel to Sentry's PerformanceDetector ABC)
// ---------------------------------------------------------------------------

/**
 * Base class for all span-based performance detectors.
 *
 * Subclasses MUST implement:
 *   - `visitSpan(span)` — process one span, may store problems
 *
 * Subclasses MAY override:
 *   - `onComplete()` — finalize after all spans processed
 *   - `isSpanEligible(span)` — pre-filter spans (default: always true)
 *   - `isTraceEligible(spans)` — pre-filter the entire trace (default: true)
 *
 * @abstract
 */
export class SpanDetector {
  /** @type {string} — unique detector type identifier */
  static detectorType = "base";

  /**
   * @param {Object} settings — detector-specific threshold configuration
   * @param {Object} [context] — optional trace-level context (traceId, projectId, etc.)
   */
  constructor(settings = {}, context = {}) {
    this.settings = settings;
    this.context = context;

    /** @type {Map<string, Object>} — fingerprint → SpanProblem */
    this.storedProblems = new Map();

    /** @type {number} — count of spans visited */
    this.spansVisited = 0;

    /** @type {number} — count of spans skipped by isSpanEligible */
    this.spansSkipped = 0;
  }

  /**
   * Pre-filter: should this span be processed by this detector?
   * Override to skip irrelevant spans (e.g., non-DB spans for a DB detector).
   *
   * @param {Object} span
   * @returns {boolean}
   */
  isSpanEligible(_span) {
    return true;
  }

  /**
   * Pre-filter: should this entire trace be processed?
   * Override to skip traces from unsupported SDKs, platforms, etc.
   *
   * @param {Object[]} _spans
   * @returns {boolean}
   */
  isTraceEligible(_spans) {
    return true;
  }

  /**
   * Process a single span. Called on every span in DFS order.
   * Subclasses accumulate state here and may store problems.
   *
   * @param {Object} span
   * @abstract
   */
  visitSpan(_span) {
    throw new Error(`Detector ${this.constructor.detectorType}: visitSpan() not implemented`);
  }

  /**
   * Called after all spans have been visited.
   * Subclasses finalize detection here — some detectors only emit problems
   * when they see the full picture (e.g., "no compressed assets found").
   */
  onComplete() {
    // Default: no-op
  }

  /**
   * Store a detected problem, keyed by fingerprint.
   * If a problem with the same fingerprint already exists, it's a duplicate
   * and is skipped (first-write-wins).
   *
   * @param {string} fingerprint — unique hash for this problem
   * @param {Object} problem — SpanProblem object (from createSpanProblem)
   * @returns {boolean} — true if stored, false if duplicate
   */
  storeProblem(fingerprint, problem) {
    if (this.storedProblems.has(fingerprint)) return false;
    this.storedProblems.set(fingerprint, problem);
    return true;
  }

  /**
   * Get all stored problems as an array.
   *
   * @returns {Object[]}
   */
  getProblems() {
    return [...this.storedProblems.values()];
  }

  /**
   * Get detector stats for diagnostics.
   *
   * @returns {{ detectorType: string, spansVisited: number, spansSkipped: number, problemsFound: number }}
   */
  getStats() {
    return {
      detectorType: this.constructor.detectorType,
      spansVisited: this.spansVisited,
      spansSkipped: this.spansSkipped,
      problemsFound: this.storedProblems.size,
    };
  }
}

// ---------------------------------------------------------------------------
// Detector orchestrator (parallel to Sentry's run_detector_on_data)
// ---------------------------------------------------------------------------

/**
 * Run a single detector on an array of spans.
 *
 * This is the equivalent of Sentry's `run_detector_on_data()`:
 * ```
 * if not detector.is_event_eligible(data): return
 * for span in data["spans"]:
 *     detector.visit_span(span)
 * detector.on_complete()
 * ```
 *
 * @param {SpanDetector} detector
 * @param {Object[]} spans — raw spans (will be tree-flattened)
 * @param {Object} [options]
 * @param {boolean} [options.skipFlatten=false] — skip tree flattening (spans already ordered)
 * @returns {Object[]} — array of SpanProblem findings
 */
export function runDetectorOnTrace(detector, spans, options = {}) {
  if (!spans || spans.length === 0) return [];
  if (!detector.isTraceEligible(spans)) return [];

  // Tree → flatten for detector consumption
  const ordered = options.skipFlatten ? spans : prepareSpansForDetection(spans);

  for (const span of ordered) {
    if (detector.isSpanEligible(span)) {
      detector.visitSpan(span);
      detector.spansVisited++;
    } else {
      detector.spansSkipped++;
    }
  }

  detector.onComplete();
  return detector.getProblems();
}

/**
 * Run multiple detectors on the same span array.
 *
 * This is the equivalent of Sentry's _detect_performance_problems:
 * ```
 * detectors = [cls(settings, data) for cls in DETECTOR_CLASSES]
 * for detector in detectors:
 *     run_detector_on_data(detector, data)
 * ```
 *
 * @param {Array<typeof SpanDetector>} detectorClasses — detector constructors
 * @param {Object[]} spans — raw spans
 * @param {Object} [options]
 * @param {Object} [options.settings] — shared settings map keyed by detectorType
 * @param {Object} [options.context] — trace context (traceId, projectId, etc.)
 * @param {Object} [options.enabledDetectors] — Set of detectorType strings to enable (omit = all)
 * @returns {{ problems: Object[], stats: Object[] }} — all problems + per-detector stats
 */
export function runDetectorsOnTrace(detectorClasses, spans, options = {}) {
  const { settings = {}, context = {}, enabledDetectors = null } = options;

  const allProblems = [];
  const allStats = [];

  // Tree-flatten once, share across all detectors
  const ordered = prepareSpansForDetection(spans);
  if (ordered.length === 0) return { problems: [], stats: [] };

  for (const DetectorClass of detectorClasses) {
    const type = DetectorClass.detectorType;

    // Gate: skip disabled detectors
    if (enabledDetectors && !enabledDetectors.has(type)) continue;

    const detectorSettings = settings[type] ?? {};
    const detector = new DetectorClass(detectorSettings, context);

    // Run
    for (const span of ordered) {
      if (detector.isSpanEligible(span)) {
        detector.visitSpan(span);
        detector.spansVisited++;
      } else {
        detector.spansSkipped++;
      }
    }
    detector.onComplete();

    allProblems.push(...detector.getProblems());
    allStats.push(detector.getStats());
  }

  return { problems: allProblems, stats: allStats };
}

// ---------------------------------------------------------------------------
// Span utility helpers for detectors
// ---------------------------------------------------------------------------

/**
 * Check if a span's operation starts with any of the given prefixes.
 * Parallel to Sentry's `find_span_prefix()`.
 *
 * @param {Object} span
 * @param {string[]} prefixes — e.g. ["db", "db.sql"]
 * @returns {boolean}
 */
export function spanOpMatches(span, prefixes) {
  const op = span[OP] ?? "";
  return prefixes.some((prefix) => op.startsWith(prefix));
}

/**
 * Check if a span is a DB span (excluding Redis).
 * Parallel to Sentry's N+1 detector `_is_db_op()`.
 *
 * @param {Object} span
 * @returns {boolean}
 */
export function isDbSpan(span) {
  const op = span[OP] ?? "";
  return op.startsWith("db") && !op.startsWith("db.redis") && !op.startsWith("db.connection");
}

/**
 * Check if a span is an HTTP client span.
 *
 * @param {Object} span
 * @returns {boolean}
 */
export function isHttpSpan(span) {
  const op = span[OP] ?? "";
  return op === "http.client" || op.startsWith("http.client");
}

/**
 * Get the span evidence value string (op - description).
 * Parallel to Sentry's `get_span_evidence_value()`.
 *
 * @param {Object} span
 * @param {boolean} [includeOp=true]
 * @returns {string}
 */
export function getSpanEvidence(span, includeOp = true) {
  const op = span[OP] ?? "unknown";
  const desc = span[DESCRIPTION] ?? "";
  return includeOp ? `${op} - ${desc}` : desc;
}

/**
 * Get a compact fingerprint for a span (op + hash).
 * Parallel to Sentry's fingerprinting.
 *
 * @param {Object} span
 * @returns {string}
 */
export function fingerprintSpan(span) {
  const op = span[OP] ?? "";
  const hash = span[HASH] ?? "";
  return `${op}:${hash}`;
}

/**
 * Are two spans "equivalent" for N+1 detection?
 * Spans are equivalent if they have the same op AND the same hash.
 *
 * @param {Object} spanA
 * @param {Object} spanB
 * @returns {boolean}
 */
export function areSpansEquivalent(spanA, spanB) {
  const opA = spanA[OP] ?? "";
  const opB = spanB[OP] ?? "";
  if (!opA || !opB || opA !== opB) return false;

  const hashA = spanA[HASH];
  const hashB = spanB[HASH];
  if (hashA !== undefined && hashB !== undefined) return hashA === hashB;

  // Fallback: compare descriptions
  const descA = (spanA[DESCRIPTION] ?? "").trim();
  const descB = (spanB[DESCRIPTION] ?? "").trim();
  return descA === descB;
}
