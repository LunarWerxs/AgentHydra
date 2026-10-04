/**
 * span-tree — Span tree builder and flattener for arkitect detector pipeline
 * ==========================================================================
 * Adapted from Sentry's `build_tree()` and `flatten_tree()` in
 * `src/sentry/issue_detection/performance_detection.py`.
 *
 * Detectors expect spans in a flat, depth-first, chronologically-ordered list.
 * Raw trace data has spans in arbitrary order with parent-child relationships
 * defined by `span_id` / `parent_span_id`. This module:
 *
 *   1. Builds a tree from flat spans
 *   2. Sorts children chronologically within each level
 *   3. Flattens the tree depth-first for detector consumption
 *
 * ## Why tree → flatten?
 *
 * Detectors like N+1 and Consecutive DB assume spans are ordered the way
 * they appear in a trace waterfall. A chronological flat list doesn't capture
 * the parent-child nesting that matters for detecting patterns within a
 * single transaction scope.
 *
 * ## Example
 *
 *   Input (flat, arbitrary order):
 *   ```
 *   [{span_id: "B", parent_span_id: "A", start: 5},
 *    {span_id: "A", parent_span_id: null, start: 0},
 *    {span_id: "C", parent_span_id: "A", start: 10}]
 *   ```
 *
 *   Output (tree → DFS → flat):
 *   ```
 *   [{span_id: "A", ...},       // root
 *    {span_id: "B", ...},       // first child of A (starts earlier)
 *    {span_id: "C", ...}]       // second child of A
 *   ```
 *
 * Codebase-agnostic: works on any array of span-like objects.
 */

import { SPAN_ID, PARENT_SPAN_ID, START_TIMESTAMP, TIMESTAMP } from "./span-fields.mjs";

// ---------------------------------------------------------------------------
// Tree building (parallel to Sentry's build_tree)
// ---------------------------------------------------------------------------

/**
 * Build a span tree from a flat array of spans.
 *
 * Returns a Map of span_id → { span, children[] } and the root span.
 * The root is the span with no parent_span_id, or the first span if none found.
 *
 * @param {Object[]} spans — array of span objects
 * @returns {{ tree: Map<string, {span: Object, children: Object[]}>, rootId: string | null }}
 */
export function buildSpanTree(spans) {
  /** @type {Map<string, {span: Object, children: Object[]}>} */
  const tree = new Map();

  // First pass: create nodes
  for (const span of spans) {
    const id = span[SPAN_ID];
    if (!id) continue;
    tree.set(id, { span, children: [] });
  }

  // Second pass: link children to parents
  for (const span of spans) {
    const id = span[SPAN_ID];
    const parentId = span[PARENT_SPAN_ID];
    if (!id || !parentId) continue;

    const childNode = tree.get(id);
    const parentNode = tree.get(parentId);
    if (childNode && parentNode) {
      parentNode.children.push(span);
    }
  }

  // Find root: span with no parent_span_id, or not referenced as child
  let rootId = null;
  for (const span of spans) {
    const id = span[SPAN_ID];
    const parentId = span[PARENT_SPAN_ID];
    if (!id) continue;
    if (!parentId || !tree.has(parentId)) {
      rootId = id;
      break;
    }
  }

  // Fallback: first span
  if (!rootId && spans.length > 0) {
    rootId = spans[0][SPAN_ID] ?? null;
  }

  return { tree, rootId };
}

// ---------------------------------------------------------------------------
// Chronological sorting
// ---------------------------------------------------------------------------

/**
 * Sort spans chronologically by start_timestamp, then by span_id for stability.
 *
 * @param {Object[]} spans
 * @returns {Object[]}
 */
export function sortChronologically(spans) {
  return [...spans].sort((a, b) => {
    const aStart = a[START_TIMESTAMP] ?? 0;
    const bStart = b[START_TIMESTAMP] ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    // Tie-break by span_id for deterministic ordering
    return String(a[SPAN_ID] ?? "").localeCompare(String(b[SPAN_ID] ?? ""));
  });
}

// ---------------------------------------------------------------------------
// Depth-first flattening (parallel to Sentry's flatten_tree)
// ---------------------------------------------------------------------------

/**
 * Flatten a span tree into a depth-first list.
 *
 * At each level, children are sorted chronologically before traversal.
 * This produces the order detectors expect: parent → sorted children (each
 * recursively flattened).
 *
 * @param {Map<string, {span: Object, children: Object[]}>} tree
 * @param {string | null} rootId
 * @param {Set<string>} [visited] — internal, tracks visited nodes to avoid cycles
 * @returns {Object[]} flat array of spans in DFS order
 */
export function flattenSpanTree(tree, rootId, visited = new Set()) {
  if (!rootId || visited.has(rootId)) return [];

  const result = [];
  const stack = [rootId];

  while (stack.length > 0) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);

    const node = tree.get(id);
    if (!node) continue;

    result.push(node.span);

    // Sort children chronologically, then push in reverse so they pop in order
    const sortedChildren = sortChronologically(node.children);
    for (let i = sortedChildren.length - 1; i >= 0; i--) {
      const childId = sortedChildren[i][SPAN_ID];
      if (childId && !visited.has(childId)) {
        stack.push(childId);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Segment extraction
// ---------------------------------------------------------------------------

/**
 * Extract the "segment span" — the root span of a trace segment.
 * In Sentry, segments are the unit of streaming detection.
 *
 * @param {Object[]} spans
 * @returns {Object | null}
 */
export function getSegmentSpan(spans) {
  if (spans.length === 0) return null;
  // The segment span is the one with no parent_span_id or is_segment flag
  for (const span of spans) {
    if (span.is_segment) return span;
    if (!span[PARENT_SPAN_ID]) return span;
  }
  return spans[0];
}

// ---------------------------------------------------------------------------
// Span utilities (parallel to Sentry's detectors/utils.py)
// ---------------------------------------------------------------------------

/**
 * Get span duration in milliseconds.
 *
 * @param {Object} span
 * @returns {number} duration in ms, or 0 if uncomputable
 */
export function getSpanDurationMs(span) {
  const start = span[START_TIMESTAMP];
  const end = span[TIMESTAMP];
  if (typeof start !== "number" || typeof end !== "number") return 0;
  return Math.max(0, (end - start) * 1000);
}

/**
 * Get the total duration of a list of spans in milliseconds.
 *
 * @param {Object[]} spans
 * @returns {number}
 */
export function getTotalSpanDurationMs(spans) {
  return spans.reduce((sum, s) => sum + getSpanDurationMs(s), 0);
}

/**
 * Get the exclusive time (self time) of a span in milliseconds.
 * If exclusive_time is set on the span, use it; otherwise fall back to duration.
 *
 * @param {Object} span
 * @returns {number}
 */
export function getSpanExclusiveTimeMs(span) {
  if (typeof span.exclusive_time === "number") return span.exclusive_time;
  if (typeof span[START_TIMESTAMP] === "number" && typeof span[TIMESTAMP] === "number") {
    return (span[TIMESTAMP] - span[START_TIMESTAMP]) * 1000;
  }
  return 0;
}

/**
 * Check if two spans overlap chronologically.
 *
 * @param {Object} spanA
 * @param {Object} spanB
 * @returns {boolean}
 */
export function spansOverlap(spanA, spanB) {
  const aStart = spanA[START_TIMESTAMP] ?? 0;
  const aEnd = spanA[TIMESTAMP] ?? 0;
  const bStart = spanB[START_TIMESTAMP] ?? 0;
  const bEnd = spanB[TIMESTAMP] ?? 0;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Get the chronological gap between two spans in milliseconds.
 * Returns 0 if they overlap.
 *
 * @param {Object} earlier — the span that ends first
 * @param {Object} later   — the span that starts second
 * @returns {number} gap in ms, 0 if overlapping
 */
export function getGapBetweenSpansMs(earlier, later) {
  const earlierEnd = earlier[TIMESTAMP] ?? 0;
  const laterStart = later[START_TIMESTAMP] ?? 0;
  return Math.max(0, (laterStart - earlierEnd) * 1000);
}

// ---------------------------------------------------------------------------
// High-level pipeline: spans → flattened → ready for detectors
// ---------------------------------------------------------------------------

/**
 * Prepare spans for detector consumption.
 *
 * 1. Build tree from flat spans
 * 2. Flatten depth-first with chronological ordering
 * 3. Return the ordered span list
 *
 * This is the equivalent of Sentry's:
 * ```
 * tree, segment_id = build_tree(spans)
 * data = {**data, "spans": flatten_tree(tree, segment_id)}
 * ```
 *
 * @param {Object[]} spans
 * @returns {Object[]} flattened, ordered spans
 */
export function prepareSpansForDetection(spans) {
  if (!spans || spans.length === 0) return [];

  const { tree, rootId } = buildSpanTree(spans);
  if (!rootId) return sortChronologically(spans); // fallback: just sort flat

  return flattenSpanTree(tree, rootId);
}
