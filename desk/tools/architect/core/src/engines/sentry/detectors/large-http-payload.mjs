/**
 * detectors/large-http-payload.mjs — Large HTTP Payload Detector
 * ===============================================================
 * Adapted from Sentry's `LargeHTTPPayloadDetector` in
 * `src/sentry/issue_detection/detectors/large_http_payload_detector.py`.
 *
 * Detects HTTP responses whose payload size exceeds a configurable threshold.
 *
 * ## Algorithm
 *
 *   1. For each HTTP client span, check transfer size or content length
 *   2. If size ≥ threshold → problem
 *   3. One problem per unique URL fingerprint
 *
 * ## Thresholds
 *
 *   - `payloadSizeThreshold`: min payload size in bytes (default: 300000 = ~300KB)
 */

import { SpanDetector, isHttpSpan, fingerprintSpan } from "../span-detector.mjs";
import { createSpanProblem, PROBLEM_TYPES } from "../span-problem.mjs";
import {
  SPAN_ID,
  HTTP_RESPONSE_TRANSFER_SIZE,
  HTTP_RESPONSE_CONTENT_LENGTH,
  HTTP_DECODED_RESPONSE_CONTENT_LENGTH,
  DESCRIPTION,
  OP,
} from "../span-fields.mjs";
import { createHash } from "node:crypto";

export class LargeHTTPPayloadDetector extends SpanDetector {
  static detectorType = "large_http_payload";

  isSpanEligible(span) {
    return isHttpSpan(span);
  }

  visitSpan(span) {
    const payloadSizeThreshold = this.settings.payloadSizeThreshold ?? 300000; // bytes

    // Check transfer size first, then content length, then decoded length
    const transferSize = span[HTTP_RESPONSE_TRANSFER_SIZE];
    const contentLength = span[HTTP_RESPONSE_CONTENT_LENGTH];
    const decodedLength = span[HTTP_DECODED_RESPONSE_CONTENT_LENGTH];

    const size = transferSize ?? contentLength ?? decodedLength;
    if (typeof size !== "number" || size < payloadSizeThreshold) return;

    const spanId = span[SPAN_ID];
    if (!spanId) return;

    // Fingerprint by span evidence
    const fingerprint = createHash("sha256").update(fingerprintSpan(span)).digest("hex").substring(0, 16);

    const evidence = {
      op: span[OP],
      spanId,
      payloadSize: size,
      threshold: payloadSizeThreshold,
      description: span[DESCRIPTION] ?? "",
    };

    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.LARGE_HTTP_PAYLOAD,
      spanOp: span[OP] ?? "http.client",
      description: `${Math.round(size / 1024)}KB payload — ${span[DESCRIPTION] ?? "unknown URL"}`,
      offenderSpanIds: [spanId],
      evidence,
    });

    this.storeProblem(fingerprint, problem);
  }
}
