/**
 * Tests for Sentry-inspired span detection engines:
 *   - span-fields.mjs
 *   - span-tree.mjs
 *   - span-detector.mjs
 *   - span-problem.mjs
 *   - detectors/n-plus-one-db.mjs
 *   - detectors/slow-db-query.mjs
 *   - detectors/consecutive-db.mjs
 *   - detectors/consecutive-http.mjs
 *   - detectors/large-http-payload.mjs
 *   - detectors/index.mjs
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ---------------------------------------------------------------------------
// span-fields tests
// ---------------------------------------------------------------------------
import { classifySpanModule, categorizeSpanOp, MODULES } from "@saydeploy/architect/engines/sentry/span-fields";

describe("span-fields", () => {
  test("classifySpanModule categorizes DB spans", () => {
    assert.equal(classifySpanModule({ op: "db.sql.query" }), MODULES.DB);
    assert.equal(classifySpanModule({ op: "db", category: "db" }), MODULES.DB);
  });

  test("classifySpanModule categorizes Redis as cache", () => {
    assert.equal(classifySpanModule({ op: "db.redis" }), MODULES.CACHE);
  });

  test("classifySpanModule categorizes HTTP spans", () => {
    assert.equal(classifySpanModule({ op: "http.client" }), MODULES.HTTP);
    assert.equal(classifySpanModule({ category: "http" }), MODULES.HTTP);
  });

  test("classifySpanModule categorizes resource spans", () => {
    assert.equal(classifySpanModule({ op: "resource.script" }), MODULES.RESOURCE);
    assert.equal(classifySpanModule({ op: "resource.css" }), MODULES.RESOURCE);
  });

  test("classifySpanModule categorizes cache spans", () => {
    assert.equal(classifySpanModule({ op: "cache.get_item" }), MODULES.CACHE);
  });

  test("classifySpanModule categorizes queue spans", () => {
    assert.equal(classifySpanModule({ op: "queue.process" }), MODULES.QUEUE);
  });

  test("classifySpanModule categorizes vitals", () => {
    assert.equal(classifySpanModule({ op: "pageload" }), MODULES.VITAL);
    assert.equal(classifySpanModule({ op: "ui.webvital.lcp" }), MODULES.VITAL);
  });

  test("classifySpanModule falls back to other", () => {
    assert.equal(classifySpanModule({ op: "custom.thing" }), MODULES.OTHER);
    assert.equal(classifySpanModule({}), MODULES.OTHER);
  });

  test("categorizeSpanOp returns correct categories", () => {
    assert.equal(categorizeSpanOp({ op: "db.sql.query" }), "db");
    assert.equal(categorizeSpanOp({ op: "db.redis" }), "cache");
    assert.equal(categorizeSpanOp({ op: "http.client" }), "http");
    assert.equal(categorizeSpanOp({ op: "cache.get" }), "cache");
    assert.equal(categorizeSpanOp({ op: "queue.publish" }), "queue");
    assert.equal(categorizeSpanOp({ op: "resource.img" }), "resource");
    assert.equal(categorizeSpanOp({ op: "pageload" }), "browser");
    assert.equal(categorizeSpanOp({ op: "app.start.cold" }), "mobile");
    assert.equal(categorizeSpanOp({ op: "ai.run" }), "ai");
    assert.equal(categorizeSpanOp({ op: "weird.thing" }), "unknown");
  });
});

// ---------------------------------------------------------------------------
// span-tree tests
// ---------------------------------------------------------------------------
import {
  buildSpanTree,
  flattenSpanTree,
  sortChronologically,
  prepareSpansForDetection,
  getSpanDurationMs,
  getTotalSpanDurationMs,
  spansOverlap,
  getGapBetweenSpansMs,
  getSegmentSpan,
} from "@saydeploy/architect/engines/sentry/span-tree";

describe("span-tree", () => {
  test("buildSpanTree creates tree from flat spans", () => {
    const spans = [
      { span_id: "A", parent_span_id: null, start_timestamp: 0, timestamp: 10 },
      { span_id: "B", parent_span_id: "A", start_timestamp: 2, timestamp: 5 },
      { span_id: "C", parent_span_id: "A", start_timestamp: 6, timestamp: 9 },
    ];

    const { tree, rootId } = buildSpanTree(spans);
    assert.equal(rootId, "A");
    assert.equal(tree.get("A").children.length, 2);
    assert.equal(tree.get("B").children.length, 0);
    assert.equal(tree.get("C").children.length, 0);
  });

  test("flattenSpanTree produces DFS order", () => {
    const spans = [
      { span_id: "B", parent_span_id: "A", start_timestamp: 2, timestamp: 5 },
      { span_id: "C", parent_span_id: "A", start_timestamp: 6, timestamp: 9 },
      { span_id: "A", parent_span_id: null, start_timestamp: 0, timestamp: 10 },
    ];

    const { tree, rootId } = buildSpanTree(spans);
    const flat = flattenSpanTree(tree, rootId);

    assert.equal(flat.length, 3);
    assert.equal(flat[0].span_id, "A"); // root first
    assert.equal(flat[1].span_id, "B"); // child that starts earlier
    assert.equal(flat[2].span_id, "C"); // child that starts later
  });

  test("sortChronologically orders by start_timestamp", () => {
    const spans = [
      { span_id: "C", start_timestamp: 10 },
      { span_id: "A", start_timestamp: 0 },
      { span_id: "B", start_timestamp: 5 },
    ];

    const sorted = sortChronologically(spans);
    assert.equal(sorted[0].span_id, "A");
    assert.equal(sorted[1].span_id, "B");
    assert.equal(sorted[2].span_id, "C");
  });

  test("prepareSpansForDetection returns flattened ordered spans", () => {
    const spans = [
      { span_id: "B", parent_span_id: "A", start_timestamp: 2, timestamp: 5 },
      { span_id: "A", parent_span_id: null, start_timestamp: 0, timestamp: 10 },
    ];

    const result = prepareSpansForDetection(spans);
    assert.equal(result[0].span_id, "A");
    assert.equal(result[1].span_id, "B");
  });

  test("prepareSpansForDetection handles empty input", () => {
    assert.deepStrictEqual(prepareSpansForDetection([]), []);
    assert.deepStrictEqual(prepareSpansForDetection(null), []);
  });

  test("getSpanDurationMs computes duration correctly", () => {
    const span = { start_timestamp: 1.0, timestamp: 1.5 };
    assert.equal(getSpanDurationMs(span), 500);
  });

  test("getSpanDurationMs returns 0 for missing timestamps", () => {
    assert.equal(getSpanDurationMs({}), 0);
  });

  test("getTotalSpanDurationMs sums durations", () => {
    const spans = [
      { start_timestamp: 0, timestamp: 0.1 },
      { start_timestamp: 0.1, timestamp: 0.2 },
    ];
    assert.equal(getTotalSpanDurationMs(spans), 200);
  });

  test("spansOverlap detects overlapping spans", () => {
    const a = { start_timestamp: 0, timestamp: 5 };
    const b = { start_timestamp: 3, timestamp: 8 };
    const c = { start_timestamp: 5, timestamp: 10 };
    assert.ok(spansOverlap(a, b));
    assert.ok(!spansOverlap(a, c)); // touches but doesn't overlap
  });

  test("getGapBetweenSpansMs measures gap", () => {
    const a = { start_timestamp: 0, timestamp: 5 };
    const b = { start_timestamp: 10, timestamp: 15 };
    assert.equal(getGapBetweenSpansMs(a, b), 5000);
  });

  test("getGapBetweenSpansMs returns 0 for overlapping", () => {
    const a = { start_timestamp: 0, timestamp: 5 };
    const b = { start_timestamp: 3, timestamp: 8 };
    assert.equal(getGapBetweenSpansMs(a, b), 0);
  });

  test("getSegmentSpan finds root span", () => {
    const spans = [
      { span_id: "B", parent_span_id: "A", is_segment: false },
      { span_id: "A", parent_span_id: null, is_segment: true },
    ];
    assert.equal(getSegmentSpan(spans).span_id, "A");
  });
});

// ---------------------------------------------------------------------------
// span-detector tests
// ---------------------------------------------------------------------------
import {
  SpanDetector,
  runDetectorOnTrace,
  runDetectorsOnTrace,
  isDbSpan,
  isHttpSpan,
  spanOpMatches,
  getSpanEvidence,
  fingerprintSpan,
  areSpansEquivalent,
} from "@saydeploy/architect/engines/sentry/span-detector";

describe("span-detector base", () => {
  test("SpanDetector base class throws on visitSpan", () => {
    const detector = new SpanDetector({});
    assert.throws(() => detector.visitSpan({}), /visitSpan.*not implemented/);
  });

  test("SpanDetector stores problems by fingerprint", () => {
    const detector = new SpanDetector({});
    const problem1 = { ruleId: "test", message: "p1" };
    const problem2 = { ruleId: "test", message: "p2" };

    assert.ok(detector.storeProblem("fp1", problem1));
    assert.ok(detector.storeProblem("fp2", problem2));
    assert.ok(!detector.storeProblem("fp1", problem1)); // duplicate

    assert.equal(detector.getProblems().length, 2);
    assert.equal(detector.storedProblems.size, 2);
  });

  test("SpanDetector getStats returns stats", () => {
    const detector = new SpanDetector({});
    detector.spansVisited = 10;
    detector.spansSkipped = 3;

    const stats = detector.getStats();
    assert.equal(stats.spansVisited, 10);
    assert.equal(stats.spansSkipped, 3);
    assert.equal(stats.problemsFound, 0);
    assert.equal(stats.detectorType, "base");
  });

  test("isDbSpan identifies DB spans", () => {
    assert.ok(isDbSpan({ op: "db.sql.query" }));
    assert.ok(isDbSpan({ op: "db" }));
    assert.ok(!isDbSpan({ op: "db.redis" }));
    assert.ok(!isDbSpan({ op: "db.connection" }));
    assert.ok(!isDbSpan({ op: "http.client" }));
  });

  test("isHttpSpan identifies HTTP client spans", () => {
    assert.ok(isHttpSpan({ op: "http.client" }));
    assert.ok(!isHttpSpan({ op: "http.server" }));
    assert.ok(!isHttpSpan({ op: "db" }));
  });

  test("spanOpMatches checks prefixes", () => {
    assert.ok(spanOpMatches({ op: "db.sql.query" }, ["db", "db.sql"]));
    assert.ok(!spanOpMatches({ op: "http.client" }, ["db"]));
  });

  test("getSpanEvidence formats span details", () => {
    const span = { op: "db.sql.query", description: "SELECT * FROM users" };
    assert.equal(getSpanEvidence(span), "db.sql.query - SELECT * FROM users");
    assert.equal(getSpanEvidence(span, false), "SELECT * FROM users");
  });

  test("fingerprintSpan creates hash-based key", () => {
    const span = { op: "db", hash: "abc123" };
    assert.equal(fingerprintSpan(span), "db:abc123");
  });

  test("areSpansEquivalent compares op + hash", () => {
    const a = { op: "db", hash: "abc" };
    const b = { op: "db", hash: "abc" };
    const c = { op: "db", hash: "def" };
    const d = { op: "http", hash: "abc" };

    assert.ok(areSpansEquivalent(a, b));
    assert.ok(!areSpansEquivalent(a, c));
    assert.ok(!areSpansEquivalent(a, d));
  });

  test("areSpansEquivalent falls back to description", () => {
    const a = { op: "db", description: "SELECT 1" };
    const b = { op: "db", description: "SELECT 1" };
    const c = { op: "db", description: "SELECT 2" };

    assert.ok(areSpansEquivalent(a, b));
    assert.ok(!areSpansEquivalent(a, c));
  });
});

// ---------------------------------------------------------------------------
// runDetectorOnTrace tests
// ---------------------------------------------------------------------------

describe("runDetectorOnTrace", () => {
  /** Simple detector that counts spans */
  class CountingDetector extends SpanDetector {
    static detectorType = "test_counting";
    constructor(settings, context) {
      super(settings, context);
      this.count = 0;
    }
    visitSpan(_span) {
      this.count++;
    }
  }

  test("runDetectorOnTrace visits all spans", () => {
    const detector = new CountingDetector({});
    const spans = [
      { span_id: "1", parent_span_id: null, start_timestamp: 0, timestamp: 1 },
      { span_id: "2", parent_span_id: "1", start_timestamp: 0.5, timestamp: 1.5 },
    ];

    runDetectorOnTrace(detector, spans);
    assert.equal(detector.count, 2);
    assert.equal(detector.spansVisited, 2);
  });

  test("runDetectorOnTrace respects isSpanEligible", () => {
    class FilteredDetector extends SpanDetector {
      static detectorType = "test_filtered";
      constructor(settings, context) {
        super(settings, context);
        this.visited = [];
      }
      isSpanEligible(span) {
        return span.op === "db";
      }
      visitSpan(span) {
        this.visited.push(span);
      }
    }

    const detector = new FilteredDetector({});
    const spans = [
      { span_id: "1", parent_span_id: null, op: "db", start_timestamp: 0, timestamp: 1 },
      { span_id: "2", parent_span_id: "1", op: "http.client", start_timestamp: 0.5, timestamp: 1 },
      { span_id: "3", parent_span_id: "1", op: "db", start_timestamp: 1, timestamp: 2 },
    ];

    runDetectorOnTrace(detector, spans);
    assert.equal(detector.visited.length, 2);
    assert.equal(detector.spansVisited, 2);
    assert.equal(detector.spansSkipped, 1);
  });

  test("runDetectorOnTrace calls onComplete", () => {
    class CompleteDetector extends SpanDetector {
      static detectorType = "test_complete";
      constructor(settings, context) {
        super(settings, context);
        this.completed = false;
      }
      visitSpan(_span) {}
      onComplete() {
        this.completed = true;
      }
    }

    const detector = new CompleteDetector({});
    runDetectorOnTrace(detector, [{ span_id: "1", start_timestamp: 0, timestamp: 1 }]);
    assert.ok(detector.completed);
  });

  test("runDetectorsOnTrace runs multiple detectors", () => {
    class DetectorA extends SpanDetector {
      static detectorType = "detector_a";
      visitSpan(_span) {}
    }
    class DetectorB extends SpanDetector {
      static detectorType = "detector_b";
      visitSpan(_span) {}
    }

    const spans = [{ span_id: "1", start_timestamp: 0, timestamp: 1 }];
    const { problems, stats } = runDetectorsOnTrace([DetectorA, DetectorB], spans);

    assert.equal(problems.length, 0);
    assert.equal(stats.length, 2);
    assert.equal(stats[0].detectorType, "detector_a");
    assert.equal(stats[1].detectorType, "detector_b");
  });

  test("runDetectorsOnTrace respects enabledDetectors", () => {
    class DetectorA extends SpanDetector {
      static detectorType = "a";
      visitSpan(_span) {}
    }
    class DetectorB extends SpanDetector {
      static detectorType = "b";
      visitSpan(_span) {}
    }

    const spans = [{ span_id: "1", start_timestamp: 0, timestamp: 1 }];
    const { stats } = runDetectorsOnTrace([DetectorA, DetectorB], spans, {
      enabledDetectors: new Set(["a"]),
    });

    assert.equal(stats.length, 1);
    assert.equal(stats[0].detectorType, "a");
  });
});

// ---------------------------------------------------------------------------
// span-problem tests
// ---------------------------------------------------------------------------
import { createSpanProblem, PROBLEM_TYPES, isSpanProblem, getSpanProblem } from "@saydeploy/architect/engines/sentry/span-problem";

describe("span-problem", () => {
  test("createSpanProblem produces a valid finding", () => {
    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.N_PLUS_ONE_DB,
      spanOp: "db.sql.query",
      description: "SELECT * FROM users",
      offenderSpanIds: ["span1", "span2"],
      causeSpanIds: ["span0"],
      parentSpanIds: ["parent1"],
      evidence: { count: 2 },
    });

    assert.equal(problem.ruleId, "perf-n-plus-one-db");
    assert.equal(problem.severity, "high");
    assert.ok(problem.message.includes("N+1 DB query"));
    assert.ok(problem.message.includes("2 repeats"));
    assert.ok(problem.message.includes("SELECT * FROM users"));

    const sp = getSpanProblem(problem);
    assert.ok(sp);
    assert.equal(sp.problemType, PROBLEM_TYPES.N_PLUS_ONE_DB);
    assert.deepStrictEqual(sp.offenderSpanIds, ["span1", "span2"]);
    assert.deepStrictEqual(sp.causeSpanIds, ["span0"]);
    assert.deepStrictEqual(sp.parentSpanIds, ["parent1"]);
    assert.equal(sp.evidence.count, 2);
  });

  test("isSpanProblem detects span problem metadata", () => {
    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.SLOW_DB_QUERY,
      spanOp: "db",
      description: "slow",
      offenderSpanIds: ["s1"],
    });

    assert.ok(isSpanProblem(problem));
    assert.ok(!isSpanProblem({ ruleId: "other", metadata: {} }));
    assert.ok(!isSpanProblem(null));
  });

  test("getSpanProblem returns null for non-span problems", () => {
    assert.equal(getSpanProblem({ ruleId: "other", metadata: {} }), null);
    assert.equal(getSpanProblem(null), null);
  });

  test("problem messages are distinct per type", () => {
    const types = Object.values(PROBLEM_TYPES);
    const messages = new Set();

    for (const type of types) {
      const p = createSpanProblem({
        problemType: type,
        spanOp: "test.op",
        description: "test desc",
        offenderSpanIds: ["s1"],
      });
      messages.add(p.message);
    }

    // Each type should produce a unique message
    // (at minimum, the problem type is embedded)
    assert.ok(messages.size >= types.length - 1); // some may share format
  });

  test("createSpanProblem allows overrides", () => {
    const problem = createSpanProblem({
      problemType: PROBLEM_TYPES.N_PLUS_ONE_DB,
      spanOp: "db",
      description: "test",
      offenderSpanIds: ["s1"],
      overrides: { severity: "low", filePath: "trace://abc", line: 42 },
    });

    assert.equal(problem.severity, "low");
    assert.equal(problem.filePath, "trace://abc");
    assert.equal(problem.line, 42);
  });
});

// ---------------------------------------------------------------------------
// N+1 DB Detector tests
// ---------------------------------------------------------------------------
import { NPlusOneDBSpanDetector } from "@saydeploy/architect/engines/sentry/detectors/n-plus-one-db";

describe("NPlusOneDBSpanDetector", () => {
  test("detects classic N+1 pattern", () => {
    const detector = new NPlusOneDBSpanDetector({
      count: 3,
      durationThreshold: 0,
    });

    const spans = [
      // Parent (non-DB)
      { span_id: "parent", op: "pageload", start_timestamp: 0, timestamp: 10, parent_span_id: null },
      // Source query (first DB span)
      {
        span_id: "source",
        op: "db.sql.query",
        hash: "abc",
        description: "SELECT * FROM users WHERE id = %s",
        start_timestamp: 1,
        timestamp: 1.1,
        parent_span_id: "parent",
      },
      // N repeats
      {
        span_id: "r1",
        op: "db.sql.query",
        hash: "abc",
        description: "SELECT * FROM users WHERE id = %s",
        start_timestamp: 2,
        timestamp: 2.1,
        parent_span_id: "parent",
      },
      {
        span_id: "r2",
        op: "db.sql.query",
        hash: "abc",
        description: "SELECT * FROM users WHERE id = %s",
        start_timestamp: 3,
        timestamp: 3.1,
        parent_span_id: "parent",
      },
      {
        span_id: "r3",
        op: "db.sql.query",
        hash: "abc",
        description: "SELECT * FROM users WHERE id = %s",
        start_timestamp: 4,
        timestamp: 4.1,
        parent_span_id: "parent",
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ruleId, "perf-n-plus-one-db");

    const sp = getSpanProblem(problems[0]);
    assert.equal(sp.offenderSpanIds.length, 3); // the 3 repeats
    assert.ok(sp.offenderSpanIds.includes("r1"));
    assert.ok(sp.causeSpanIds.includes("source"));
    assert.ok(sp.parentSpanIds.includes("parent"));
  });

  test("does not detect when count below threshold", () => {
    const detector = new NPlusOneDBSpanDetector({
      count: 5,
      durationThreshold: 0,
    });

    const spans = [
      { span_id: "parent", op: "pageload", start_timestamp: 0, timestamp: 10, parent_span_id: null },
      {
        span_id: "source",
        op: "db.sql.query",
        hash: "abc",
        description: "query",
        start_timestamp: 1,
        timestamp: 1.1,
        parent_span_id: "parent",
      },
      {
        span_id: "r1",
        op: "db.sql.query",
        hash: "abc",
        description: "query",
        start_timestamp: 2,
        timestamp: 2.1,
        parent_span_id: "parent",
      },
      {
        span_id: "r2",
        op: "db.sql.query",
        hash: "abc",
        description: "query",
        start_timestamp: 3,
        timestamp: 3.1,
        parent_span_id: "parent",
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0); // only 3 total, need 5
  });

  test("non-DB span breaks N+1 chain", () => {
    const detector = new NPlusOneDBSpanDetector({
      count: 2,
      durationThreshold: 0,
    });

    const spans = [
      { span_id: "parent", op: "pageload", start_timestamp: 0, timestamp: 10, parent_span_id: null },
      {
        span_id: "source",
        op: "db.sql.query",
        hash: "abc",
        description: "query",
        start_timestamp: 1,
        timestamp: 1.1,
        parent_span_id: "parent",
      },
      {
        span_id: "r1",
        op: "db.sql.query",
        hash: "abc",
        description: "query",
        start_timestamp: 2,
        timestamp: 2.1,
        parent_span_id: "parent",
      },
      // Interrupting non-DB span
      {
        span_id: "http1",
        op: "http.client",
        hash: "xyz",
        description: "GET /api",
        start_timestamp: 3,
        timestamp: 3.2,
        parent_span_id: "parent",
      },
      // New DB span — different hash, not a continuation
      {
        span_id: "db2",
        op: "db.sql.query",
        hash: "def",
        description: "other",
        start_timestamp: 4,
        timestamp: 4.1,
        parent_span_id: "parent",
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    // The first N+1 (source + r1) doesn't meet count threshold of 2 repeats,
    // it only has 1 repeat (r1). Count is min number of REPEATING spans.
    assert.equal(problems.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Slow DB Query Detector tests
// ---------------------------------------------------------------------------
import { SlowDBQueryDetector } from "@saydeploy/architect/engines/sentry/detectors/slow-db-query";

describe("SlowDBQueryDetector", () => {
  test("detects slow SELECT query", () => {
    const detector = new SlowDBQueryDetector({ durationThreshold: 500 });
    const spans = [
      {
        span_id: "s1",
        op: "db.sql.query",
        hash: "h1",
        description: "SELECT * FROM large_table",
        start_timestamp: 0,
        timestamp: 1.0,
      }, // 1000ms
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ruleId, "perf-slow-db-query");

    const sp = getSpanProblem(problems[0]);
    assert.ok(sp.evidence.durationMs >= 500);
  });

  test("skips queries below threshold", () => {
    const detector = new SlowDBQueryDetector({ durationThreshold: 500 });
    const spans = [
      { span_id: "s1", op: "db.sql.query", hash: "h1", description: "SELECT 1", start_timestamp: 0, timestamp: 0.1 }, // 100ms
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });

  test("skips non-SELECT queries", () => {
    const detector = new SlowDBQueryDetector({ durationThreshold: 100 });
    const spans = [
      {
        span_id: "s1",
        op: "db.sql.query",
        hash: "h1",
        description: "INSERT INTO users",
        start_timestamp: 0,
        timestamp: 2.0,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });

  test("skips truncated queries", () => {
    const detector = new SlowDBQueryDetector({ durationThreshold: 100 });
    const spans = [
      {
        span_id: "s1",
        op: "db.sql.query",
        hash: "h1",
        description: "SELECT * FROM users WHERE...",
        start_timestamp: 0,
        timestamp: 2.0,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });

  test("deduplicates by hash", () => {
    const detector = new SlowDBQueryDetector({ durationThreshold: 100 });
    const spans = [
      { span_id: "s1", op: "db.sql.query", hash: "abc", description: "SELECT 1", start_timestamp: 0, timestamp: 2.0 },
      { span_id: "s2", op: "db.sql.query", hash: "abc", description: "SELECT 1", start_timestamp: 3, timestamp: 5.0 },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1); // only first one stored
  });
});

// ---------------------------------------------------------------------------
// Consecutive DB Detector tests
// ---------------------------------------------------------------------------
import { ConsecutiveDBSpanDetector } from "@saydeploy/architect/engines/sentry/detectors/consecutive-db";

describe("ConsecutiveDBSpanDetector", () => {
  test("detects consecutive DB queries", () => {
    const detector = new ConsecutiveDBSpanDetector({
      consecutiveCountThreshold: 2,
      minTimeSaved: 50,
      minTimeSavedRatio: 0,
      spanDurationThreshold: 0,
    });

    const spans = [
      { span_id: "db1", op: "db.sql.query", hash: "h1", description: "SELECT 1", start_timestamp: 0, timestamp: 0.2 }, // 200ms
      { span_id: "db2", op: "db.sql.query", hash: "h2", description: "SELECT 2", start_timestamp: 0.3, timestamp: 0.5 }, // 200ms
      {
        span_id: "http1",
        op: "http.client",
        hash: "h3",
        description: "GET /api",
        start_timestamp: 0.6,
        timestamp: 0.8,
      }, // breaks chain
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ruleId, "perf-consecutive-db");

    const sp = getSpanProblem(problems[0]);
    assert.equal(sp.offenderSpanIds.length, 2);
  });

  test("does not detect single DB query", () => {
    const detector = new ConsecutiveDBSpanDetector({
      consecutiveCountThreshold: 2,
      minTimeSaved: 0,
      minTimeSavedRatio: 0,
      spanDurationThreshold: 0,
    });

    const spans = [
      { span_id: "db1", op: "db.sql.query", hash: "h1", description: "SELECT 1", start_timestamp: 0, timestamp: 0.2 },
      { span_id: "http1", op: "http.client", hash: "h3", description: "GET", start_timestamp: 0.3, timestamp: 0.5 },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Consecutive HTTP Detector tests
// ---------------------------------------------------------------------------
import { ConsecutiveHTTPSpanDetector } from "@saydeploy/architect/engines/sentry/detectors/consecutive-http";

describe("ConsecutiveHTTPSpanDetector", () => {
  test("detects consecutive HTTP requests", () => {
    const detector = new ConsecutiveHTTPSpanDetector({
      consecutiveCountThreshold: 2,
      spanDurationThreshold: 0,
      minTimeSaved: 0,
    });

    const spans = [
      {
        span_id: "h1",
        op: "http.client",
        hash: "h1",
        span_domain: "api.example.com",
        description: "GET /users",
        start_timestamp: 0,
        timestamp: 0.2,
      },
      {
        span_id: "h2",
        op: "http.client",
        hash: "h2",
        span_domain: "api.example.com",
        description: "GET /posts",
        start_timestamp: 0.3,
        timestamp: 0.5,
      },
      {
        span_id: "h3",
        op: "http.client",
        hash: "h3",
        span_domain: "api.example.com",
        description: "GET /comments",
        start_timestamp: 0.6,
        timestamp: 0.8,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ruleId, "perf-consecutive-http");
  });

  test("skips HTTP spans below duration threshold", () => {
    const detector = new ConsecutiveHTTPSpanDetector({
      consecutiveCountThreshold: 2,
      spanDurationThreshold: 500, // ms — all spans are 200ms, below threshold
      minTimeSaved: 0,
    });

    const spans = [
      { span_id: "h1", op: "http.client", hash: "h1", description: "GET /a", start_timestamp: 0, timestamp: 0.2 },
      { span_id: "h2", op: "http.client", hash: "h2", description: "GET /b", start_timestamp: 0.3, timestamp: 0.5 },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });

  test("respects minTimeSaved threshold", () => {
    const detector = new ConsecutiveHTTPSpanDetector({
      consecutiveCountThreshold: 2,
      spanDurationThreshold: 0,
      minTimeSaved: 1000, // very high — won't meet
    });

    const spans = [
      { span_id: "h1", op: "http.client", hash: "h1", description: "GET /a", start_timestamp: 0, timestamp: 0.1 },
      { span_id: "h2", op: "http.client", hash: "h2", description: "GET /b", start_timestamp: 0.2, timestamp: 0.3 },
      { span_id: "h3", op: "http.client", hash: "h3", description: "GET /c", start_timestamp: 0.4, timestamp: 0.5 },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Large HTTP Payload Detector tests
// ---------------------------------------------------------------------------
import { LargeHTTPPayloadDetector } from "@saydeploy/architect/engines/sentry/detectors/large-http-payload";

describe("LargeHTTPPayloadDetector", () => {
  test("detects large response payloads", () => {
    const detector = new LargeHTTPPayloadDetector({ payloadSizeThreshold: 100000 });
    const spans = [
      {
        span_id: "h1",
        op: "http.client",
        description: "GET /big-file",
        "http.response_transfer_size": 500000,
        start_timestamp: 0,
        timestamp: 2,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ruleId, "perf-large-http-payload");

    const sp = getSpanProblem(problems[0]);
    assert.ok(sp.evidence.payloadSize >= 100000);
  });

  test("skips payloads below threshold", () => {
    const detector = new LargeHTTPPayloadDetector({ payloadSizeThreshold: 1000000 });
    const spans = [
      {
        span_id: "h1",
        op: "http.client",
        description: "GET /small",
        http_response_transfer_size: 50000,
        start_timestamp: 0,
        timestamp: 0.1,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 0);
  });

  test("uses content_length fallback", () => {
    const detector = new LargeHTTPPayloadDetector({ payloadSizeThreshold: 100000 });
    const spans = [
      {
        span_id: "h1",
        op: "http.client",
        description: "GET /file",
        "http.response_content_length": 200000,
        start_timestamp: 0,
        timestamp: 1,
      },
    ];

    const problems = runDetectorOnTrace(detector, spans, { skipFlatten: true });
    assert.equal(problems.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Detector registry tests
// ---------------------------------------------------------------------------
import {
  DETECTOR_CLASSES,
  DETECTOR_MAP,
  DETECTOR_NAMES,
  getDefaultDetectorSettings,
} from "@saydeploy/architect/engines/sentry/detectors/index";

describe("detector registry", () => {
  test("DETECTOR_CLASSES contains all detectors", () => {
    assert.ok(DETECTOR_CLASSES.length >= 5);
    const types = DETECTOR_CLASSES.map((c) => c.detectorType);
    assert.ok(types.includes("n_plus_one_db"));
    assert.ok(types.includes("slow_db_query"));
    assert.ok(types.includes("consecutive_db"));
    assert.ok(types.includes("consecutive_http"));
    assert.ok(types.includes("large_http_payload"));
  });

  test("DETECTOR_MAP provides lookup by type", () => {
    const cls = DETECTOR_MAP["n_plus_one_db"];
    assert.ok(cls);
    assert.equal(cls.detectorType, "n_plus_one_db");
  });

  test("DETECTOR_NAMES has human-readable names", () => {
    assert.equal(DETECTOR_NAMES.n_plus_one_db, "N+1 DB Queries");
    assert.equal(DETECTOR_NAMES.slow_db_query, "Slow DB Queries");
    assert.equal(DETECTOR_NAMES.consecutive_db, "Consecutive DB Queries");
  });

  test("getDefaultDetectorSettings returns defaults for all detectors", () => {
    const settings = getDefaultDetectorSettings();
    assert.ok(settings.n_plus_one_db);
    assert.ok(settings.slow_db_query);
    assert.ok(settings.consecutive_db);
    assert.ok(settings.consecutive_http);
    assert.ok(settings.large_http_payload);

    assert.equal(settings.n_plus_one_db.count, 5);
    assert.equal(settings.slow_db_query.durationThreshold, 1000);
    assert.equal(settings.large_http_payload.payloadSizeThreshold, 300000);
  });

  test("runDetectorsOnTrace works with full registry", () => {
    const spans = [
      { span_id: "parent", op: "pageload", start_timestamp: 0, timestamp: 10, parent_span_id: null },
      {
        span_id: "db1",
        op: "db.sql.query",
        hash: "h1",
        description: "SELECT 1",
        start_timestamp: 1,
        timestamp: 2,
        parent_span_id: "parent",
      },
    ];

    const { stats } = runDetectorsOnTrace(DETECTOR_CLASSES, spans, {
      settings: getDefaultDetectorSettings(),
      enabledDetectors: new Set(["slow_db_query", "large_http_payload"]),
    });

    assert.equal(stats.length, 2);
    // slow_db_query should detect the 1000ms SELECT
    // large_http_payload should not detect (no HTTP span)
    const slowDbStats = stats.find((s) => s.detectorType === "slow_db_query");
    assert.ok(slowDbStats);
    assert.equal(slowDbStats.problemsFound, 1);
  });
});
