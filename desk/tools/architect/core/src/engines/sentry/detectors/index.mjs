/**
 * detectors/index.mjs — Detector registry (parallel to Sentry's DETECTOR_CLASSES)
 * ================================================================================
 * Adapted from Sentry's `DETECTOR_CLASSES` list in
 * `src/sentry/issue_detection/performance_detection.py`.
 *
 * This is the central registry of all span-based performance detectors.
 * Add new detectors here to enable them in the detection pipeline.
 *
 * Usage:
 *   import { DETECTOR_CLASSES, DETECTOR_NAMES } from "./detectors/index.mjs";
 *   import { runDetectorsOnTrace } from "../span-detector.mjs";
 *
 *   const { problems, stats } = runDetectorsOnTrace(DETECTOR_CLASSES, spans, {
 *     settings: {
 *       n_plus_one_db: { count: 5, durationThreshold: 100 },
 *       slow_db_query: { durationThreshold: 1000 },
 *     },
 *   });
 */

import { NPlusOneDBSpanDetector } from "./n-plus-one-db.mjs";
import { SlowDBQueryDetector } from "./slow-db-query.mjs";
import { ConsecutiveDBSpanDetector } from "./consecutive-db.mjs";
import { ConsecutiveHTTPSpanDetector } from "./consecutive-http.mjs";
import { LargeHTTPPayloadDetector } from "./large-http-payload.mjs";

/**
 * All registered detector classes.
 * Parallel to Sentry's DETECTOR_CLASSES list.
 *
 * @type {Array<typeof import("../span-detector.mjs").SpanDetector>}
 */
export const DETECTOR_CLASSES = [
  NPlusOneDBSpanDetector,
  SlowDBQueryDetector,
  ConsecutiveDBSpanDetector,
  ConsecutiveHTTPSpanDetector,
  LargeHTTPPayloadDetector,
];

/**
 * Map of detectorType → class for quick lookup.
 */
export const DETECTOR_MAP = Object.fromEntries(DETECTOR_CLASSES.map((cls) => [cls.detectorType, cls]));

/**
 * Human-readable names for each detector type.
 */
export const DETECTOR_NAMES = {
  n_plus_one_db: "N+1 DB Queries",
  slow_db_query: "Slow DB Queries",
  consecutive_db: "Consecutive DB Queries",
  consecutive_http: "Consecutive HTTP Requests",
  large_http_payload: "Large HTTP Payloads",
};

/**
 * Default thresholds for each detector.
 * Parallel to Sentry's get_detection_settings().
 *
 * @returns {Object<string, Object>}
 */
export function getDefaultDetectorSettings() {
  return {
    n_plus_one_db: {
      count: 5,
      durationThreshold: 100, // ms
    },
    slow_db_query: {
      durationThreshold: 1000, // ms (1 second)
    },
    consecutive_db: {
      consecutiveCountThreshold: 2,
      minTimeSaved: 100, // ms
      minTimeSavedRatio: 0.1,
      spanDurationThreshold: 30, // ms
    },
    consecutive_http: {
      consecutiveCountThreshold: 3,
      spanDurationThreshold: 50, // ms
      minTimeSaved: 200, // ms
    },
    large_http_payload: {
      payloadSizeThreshold: 300000, // bytes (~300KB)
    },
  };
}
