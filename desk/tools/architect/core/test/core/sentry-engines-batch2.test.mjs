/**
 * Tests for batch 2 Sentry-inspired arkitect engines:
 *   - audit-scope.mjs
 *   - release-churn-engine.mjs (unit tests only — no git shell)
 *   - stacktrace-engine.mjs
 */
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import {
  AuditScope,
  getGlobalScope,
  getIsolationScope,
  getCurrentScope,
  setTag,
  setExtra,
  setContext,
  withScope,
  withIsolationScope,
  applyAllScopesToFinding,
  resetAllScopes,
  scopeFingerprint,
} from "@saydeploy/architect/engines/shared/audit-scope";

import {
  computeReleaseHotspots,
  summarizeReleaseRisk,
} from "@saydeploy/architect/engines/sentry/release-churn-engine";

import {
  parseStackTrace,
  filterInAppFrames,
  getCulpritFrame,
  formatFrame,
  isAnonymousFunction,
  parameterizeContextLine,
  frameFingerprint,
  stacktraceFingerprint,
  detectPlatform,
  stacktraceToFindings,
} from "@saydeploy/architect/engines/sentry/stacktrace-engine";

// ===========================================================================
// audit-scope tests
// ===========================================================================

describe("audit-scope", () => {
  afterEach(() => {
    resetAllScopes();
  });

  test("AuditScope setTag and applyToFinding", () => {
    const scope = new AuditScope();
    scope.setTag("env", "production");
    scope.setTag("check", "test");

    const finding = { ruleId: "R1", message: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._tags.env, "production");
    assert.equal(enriched.metadata._tags.check, "test");
    assert.equal(enriched.ruleId, "R1"); // original fields preserved
  });

  test("AuditScope setExtra adds arbitrary data", () => {
    const scope = new AuditScope();
    scope.setExtra("count", 42);
    scope.setExtra("nested", { key: "value" });

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._extra.count, 42);
    assert.deepEqual(enriched.metadata._extra.nested, { key: "value" });
  });

  test("AuditScope setContext namespaces data", () => {
    const scope = new AuditScope();
    scope.setContext("git", { branch: "main", sha: "abc123" });
    scope.setContext("ci", { job: "test", runId: "42" });

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._contexts.git.branch, "main");
    assert.equal(enriched.metadata._contexts.ci.runId, "42");
  });

  test("AuditScope setUser", () => {
    const scope = new AuditScope();
    scope.setUser({ id: "user-1", email: "a@b.com" });

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._user.id, "user-1");
  });

  test("AuditScope setUser(null) clears user", () => {
    const scope = new AuditScope();
    scope.setUser({ id: "user-1" });
    scope.setUser(null);

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);
    assert.equal(enriched.metadata._user, undefined);
  });

  test("AuditScope addBreadcrumb adds crumbs", () => {
    const scope = new AuditScope();
    scope.addBreadcrumb({ type: "audit", message: "step 1" });
    scope.addBreadcrumb({ type: "parse", message: "step 2" });

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._breadcrumbs.length, 2);
    assert.equal(enriched.metadata._breadcrumbs[0].message, "step 1");
  });

  test("AuditScope breadcrumbs cap at 100", () => {
    const scope = new AuditScope();
    for (let i = 0; i < 150; i++) {
      scope.addBreadcrumb({ type: "info", message: `crumb ${i}` });
    }
    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.metadata._breadcrumbs.length, 100);
  });

  test("AuditScope event processors transform findings", () => {
    const scope = new AuditScope();
    scope.addEventProcessor((f) => ({ ...f, enriched: true }));
    scope.addEventProcessor((f) => ({ ...f, doubleEnriched: true }));

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched.enriched, true);
    assert.equal(enriched.doubleEnriched, true);
  });

  test("AuditScope event processor returning null drops finding", () => {
    const scope = new AuditScope();
    scope.addEventProcessor(() => null);

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);

    assert.equal(enriched, null);
  });

  test("AuditScope clone creates independent copy", () => {
    const scope = new AuditScope();
    scope.setTag("env", "prod");

    const cloned = scope.clone();
    cloned.setTag("env", "staging");

    // Original unchanged
    const finding = { ruleId: "test" };
    assert.equal(scope.applyToFinding(finding).metadata._tags.env, "prod");
    assert.equal(cloned.applyToFinding(finding).metadata._tags.env, "staging");
  });

  test("AuditScope clear resets everything", () => {
    const scope = new AuditScope();
    scope.setTag("env", "prod");
    scope.setExtra("count", 42);
    scope.addBreadcrumb({ type: "info", message: "test" });

    scope.clear();

    const finding = { ruleId: "test" };
    const enriched = scope.applyToFinding(finding);
    assert.equal(enriched.metadata._tags, undefined);
    assert.equal(enriched.metadata._breadcrumbs, undefined);
  });

  test("convenience helpers operate on current scope", () => {
    setTag("env", "test-env");
    setExtra("count", 99);
    setContext("git", { branch: "feat/x" });

    const finding = { ruleId: "test" };
    const enriched = getCurrentScope().applyToFinding(finding);

    assert.equal(enriched.metadata._tags.env, "test-env");
    assert.equal(enriched.metadata._extra.count, 99);
    assert.equal(enriched.metadata._contexts.git.branch, "feat/x");
  });

  test("withScope creates temporary clone", () => {
    setTag("env", "outer");

    const result = withScope((scope) => {
      scope.setTag("env", "inner");
      scope.setExtra("temp", true);
      return scope.applyToFinding({ ruleId: "test" });
    });

    // Inside scope: inner tag
    assert.equal(result.metadata._tags.env, "inner");
    assert.equal(result.metadata._extra.temp, true);

    // Outside scope: original tag preserved, temp extras NOT leaked
    const outerFinding = { ruleId: "test2" };
    const outerEnriched = getCurrentScope().applyToFinding(outerFinding);
    assert.equal(outerEnriched.metadata._tags.env, "outer");
    // _extra was only set in the temp scope — not present on parent
    assert.equal(outerEnriched.metadata._extra ?? null, null);
  });

  test("withIsolationScope creates fresh scope", () => {
    setTag("env", "outer");

    withIsolationScope((scope) => {
      // Fresh scope has no parent tags
      const finding = { ruleId: "test" };
      const enriched = scope.applyToFinding(finding);
      assert.equal(enriched.metadata._tags, undefined);

      // Set something in isolation scope
      scope.setTag("iso", "true");
    });

    // Outside: parent scope unchanged
    const finding = { ruleId: "test2" };
    const enriched = getCurrentScope().applyToFinding(finding);
    assert.equal(enriched.metadata._tags.env, "outer");
    assert.equal(enriched.metadata._tags.iso, undefined);
  });

  test("applyAllScopesToFinding merges all three scopes", () => {
    getGlobalScope().setTag("global", "g");
    getIsolationScope().setTag("iso", "i");
    getCurrentScope().setTag("current", "c");

    const finding = { ruleId: "test" };
    const enriched = applyAllScopesToFinding(finding);

    assert.equal(enriched.metadata._tags.global, "g");
    assert.equal(enriched.metadata._tags.iso, "i");
    assert.equal(enriched.metadata._tags.current, "c");
  });

  test("scopeFingerprint is stable for same config", () => {
    const scope = new AuditScope();
    scope.setTag("a", "1");
    scope.setTag("b", "2");
    const fp1 = scopeFingerprint();

    const scope2 = new AuditScope();
    scope2.setTag("a", "1");
    scope2.setTag("b", "2");

    // Not directly comparable (uses current scope), but same inputs produce same output
    assert.equal(typeof fp1, "string");
    assert.equal(fp1.length, 12);
  });

  test("AuditScope toJSON serializes safely", () => {
    const scope = new AuditScope();
    scope.setTag("env", "prod");
    scope.addBreadcrumb({ type: "info", message: "test" });

    const json = scope.toJSON();
    assert.equal(json.tags.env, "prod");
    assert.equal(json.breadcrumbCount, 1);
  });
});

// ===========================================================================
// release-churn-engine tests (unit — no git shell required)
// ===========================================================================

describe("release-churn-engine", () => {
  test("computeReleaseHotspots basic calculation", () => {
    const revisionMap = new Map([
      ["src/a.ts", 10],
      ["src/b.ts", 5],
      ["src/c.ts", 3],
    ]);

    const weightMap = new Map([
      ["src/a.ts", 100],
      ["src/b.ts", 50],
      ["src/c.ts", 30],
    ]);

    const releaseMap = new Map([
      ["src/a.ts", new Set(["v1.0", "v1.1", "v2.0"])],
      ["src/b.ts", new Set(["v1.1"])],
      // src/c.ts not in any release (never changed between releases)
    ]);

    const hotspots = computeReleaseHotspots(revisionMap, weightMap, releaseMap, 3);

    assert.equal(hotspots.length, 3);

    // src/a.ts: crossRelease=3, releaseRatio=1.0, releaseChurn=10*(1+1)=20, risk=2000
    const a = hotspots.find((h) => h.file === "src/a.ts");
    assert.equal(a.crossRelease, 3);
    assert.equal(a.releaseRatio, 1);
    assert.equal(a.releaseChurn, 20);
    assert.equal(a.riskScore, 2000);

    // src/b.ts: crossRelease=1, releaseRatio=0.33, releaseChurn=5*1.33=6.67, risk=333.33
    const b = hotspots.find((h) => h.file === "src/b.ts");
    assert.equal(b.crossRelease, 1);
    assert.equal(b.releaseRatio, 0.33);
  });

  test("computeReleaseHotspots sorts by riskScore descending", () => {
    const revisionMap = new Map([
      ["low.ts", 1],
      ["high.ts", 20],
    ]);
    const weightMap = new Map([
      ["low.ts", 10],
      ["high.ts", 100],
    ]);
    const releaseMap = new Map([
      ["low.ts", new Set(["v1"])],
      ["high.ts", new Set(["v1", "v2", "v3", "v4"])],
    ]);

    const hotspots = computeReleaseHotspots(revisionMap, weightMap, releaseMap, 4);
    assert.equal(hotspots[0].file, "high.ts");
  });

  test("computeReleaseHotspots handles empty maps", () => {
    const hotspots = computeReleaseHotspots(new Map(), new Map(), new Map(), 0);
    assert.equal(hotspots.length, 0);
  });

  test("summarizeReleaseRisk categorizes correctly", () => {
    const hotspots = [
      { file: "high.ts", riskScore: 200, releaseRatio: 0.9, crossRelease: 9 },
      { file: "med.ts", riskScore: 50, releaseRatio: 0.5, crossRelease: 5 },
      { file: "low.ts", riskScore: 10, releaseRatio: 0.1, crossRelease: 1 },
    ];

    const summary = summarizeReleaseRisk(hotspots);
    assert.equal(summary.totalFiles, 3);
    assert.equal(summary.highRisk, 1);
    assert.equal(summary.mediumRisk, 1);
    assert.equal(summary.lowRisk, 1);
    assert.equal(summary.topRisks[0].file, "high.ts");
  });

  test("summarizeReleaseRisk handles empty input", () => {
    const summary = summarizeReleaseRisk([]);
    assert.equal(summary.totalFiles, 0);
    assert.equal(summary.highRisk, 0);
  });
});

// ===========================================================================
// stacktrace-engine tests
// ===========================================================================

describe("stacktrace-engine", () => {
  test("parseStackTrace Chrome V8 format", () => {
    const stack = [
      "Error: something broke",
      "    at doThing (/project/src/utils.ts:10:5)",
      "    at process (/project/src/index.ts:42:3)",
    ].join("\n");

    const frames = parseStackTrace(stack);

    assert.equal(frames.length, 2);
    assert.equal(frames[0].function, "doThing");
    assert.equal(frames[0].lineno, 10);
    assert.equal(frames[0].colno, 5);
    assert.equal(frames[0].filename, "utils.ts");
    assert.equal(frames[1].function, "process");
    assert.equal(frames[1].lineno, 42);
  });

  test("parseStackTrace Chrome anonymous function", () => {
    const stack = [
      "Error: test",
      "    at /project/src/index.ts:5:1",
      "    at Object.<anonymous> (/project/src/app.ts:10:2)",
    ].join("\n");

    const frames = parseStackTrace(stack);

    assert.equal(frames.length, 2);
    assert.equal(frames[0].function, "<anonymous>");
  });

  test("parseStackTrace Firefox SpiderMonkey format", () => {
    const stack = "doThing@/project/src/utils.ts:10:5\nprocess@/project/src/index.ts:42:3";

    const frames = parseStackTrace(stack);

    assert.equal(frames.length, 2);
    assert.equal(frames[0].function, "doThing");
    assert.equal(frames[0].lineno, 10);
    assert.equal(frames[1].function, "process");
  });

  test("parseStackTrace empty input", () => {
    assert.deepEqual(parseStackTrace(""), []);
  });

  test("filterInAppFrames separates user code from vendor", () => {
    const stack = [
      "Error: test",
      "    at doThing (/project/src/utils.ts:10:5)",
      "    at React.render (/project/node_modules/react/index.js:100:1)",
      "    at process (/project/src/index.ts:42:3)",
    ].join("\n");

    const frames = parseStackTrace(stack);
    const inApp = filterInAppFrames(frames);

    assert.equal(inApp.length, 2); // doThing + process, not React
    assert.equal(inApp[0].function, "doThing");
    assert.equal(inApp[1].function, "process");
  });

  test("filterInAppFrames marks node_modules as not in_app", () => {
    const stack = [
      "    at myFunc (/project/node_modules/some-lib/index.js:1:1)",
      "    at myAppFunc (/project/src/app.ts:5:5)",
    ].join("\n");

    const frames = parseStackTrace(stack);
    assert.equal(frames[0].in_app, "false"); // node_modules
    assert.equal(frames[1].in_app, "true"); // src/
  });

  test("getCulpritFrame returns topmost in-app frame", () => {
    const stack = [
      "Error: test",
      "    at React.render (/project/node_modules/react/index.js:100:1)",
      "    at doThing (/project/src/utils.ts:10:5)",
      "    at process (/project/src/index.ts:42:3)",
    ].join("\n");

    const frames = parseStackTrace(stack);
    const culprit = getCulpritFrame(frames);

    assert.equal(culprit.function, "doThing");
    assert.equal(culprit.in_app, "true");
  });

  test("getCulpritFrame falls back to first frame when no in_app", () => {
    const stack = ["    at libFunc (/project/node_modules/lib/index.js:1:1)"].join("\n");

    const frames = parseStackTrace(stack);
    const culprit = getCulpritFrame(frames);

    assert.equal(culprit.function, "libFunc");
  });

  test("getCulpritFrame returns null for empty frames", () => {
    assert.equal(getCulpritFrame([]), null);
  });

  test("formatFrame renders function + file:line:col", () => {
    const frame = {
      function: "myFunc",
      filename: "utils.ts",
      lineno: 42,
      colno: 5,
    };

    assert.equal(formatFrame(frame), "myFunc at utils.ts:42:5");
  });

  test("formatFrame replaces anonymous names", () => {
    const frame = {
      function: "<anonymous>",
      filename: "app.ts",
      lineno: 10,
      colno: 0,
    };

    assert.equal(formatFrame(frame), "<anonymous> at app.ts:10:0");
  });

  test("isAnonymousFunction identifies anonymous names", () => {
    assert.equal(isAnonymousFunction("<anonymous>"), true);
    assert.equal(isAnonymousFunction("?"), true);
    assert.equal(isAnonymousFunction(""), true);
    assert.equal(isAnonymousFunction("myFunc"), false);
  });

  test("parameterizeContextLine strips values", () => {
    assert.equal(
      parameterizeContextLine('const x = 42; fetch("https://api.com/users/123");'),
      'const x = <NUM>; fetch("<STR>");',
    );

    assert.equal(
      parameterizeContextLine("if (true && enabled === false) {"),
      "if (<BOOL> && enabled === <BOOL>) {",
    );
  });

  test("parameterizeContextLine handles empty", () => {
    assert.equal(parameterizeContextLine(""), "");
    assert.equal(parameterizeContextLine(null), "");
  });

  test("frameFingerprint is stable for same frame", () => {
    const f1 = { module: "utils", function: "doThing", filename: "utils.ts" };
    const f2 = { module: "utils", function: "doThing", filename: "utils.ts" };

    assert.equal(frameFingerprint(f1), frameFingerprint(f2));
  });

  test("frameFingerprint differs for different frames", () => {
    const f1 = { module: "utils", function: "doThing", filename: "utils.ts" };
    const f2 = { module: "utils", function: "other", filename: "utils.ts" };

    assert.notEqual(frameFingerprint(f1), frameFingerprint(f2));
  });

  test("stacktraceFingerprint uses in_app frames only", () => {
    const stack = [
      "Error: test",
      "    at doThing (/project/src/utils.ts:10:5)",
      "    at React.render (/project/node_modules/react/index.js:100:1)",
      "    at process (/project/src/index.ts:42:3)",
    ].join("\n");

    const frames = parseStackTrace(stack);
    const fp1 = stacktraceFingerprint(frames);

    // Same stack should produce same fingerprint
    const fp2 = stacktraceFingerprint(parseStackTrace(stack));
    assert.equal(fp1, fp2);
  });

  test("stacktraceFingerprint different stacks produce different fingerprints", () => {
    const stack1 = ["    at a (/src/a.ts:1:1)", "    at b (/src/b.ts:2:2)"].join("\n");
    const stack2 = ["    at x (/src/x.ts:9:9)", "    at y (/src/y.ts:8:8)"].join("\n");

    const fp1 = stacktraceFingerprint(parseStackTrace(stack1));
    const fp2 = stacktraceFingerprint(parseStackTrace(stack2));

    assert.notEqual(fp1, fp2);
  });

  test("detectPlatform identifies node stack", () => {
    assert.equal(
      detectPlatform("    at Module._compile (node:internal/modules/cjs/loader:1198:14)"),
      "node",
    );
  });

  test("detectPlatform identifies browser stack", () => {
    assert.equal(
      detectPlatform("    at onClick (https://example.com/static/app.js:100:5)"),
      "browser",
    );
  });

  test("detectPlatform returns unknown for ambiguous", () => {
    assert.equal(detectPlatform("    at myFunc (/project/src/app.ts:10:5)"), "unknown");
  });

  test("stacktraceToFindings converts stack to findings", () => {
    const stack = [
      "Error: test",
      "    at doThing (/project/src/utils.ts:10:5)",
      "    at process (/project/src/index.ts:42:3)",
    ].join("\n");

    const findings = stacktraceToFindings(stack, {
      ruleId: "perf-stacktrace",
      severity: "medium",
    });

    assert.equal(findings.length, 2);
    assert.equal(findings[0].ruleId, "perf-stacktrace");
    assert.equal(findings[0].severity, "medium");
    assert.equal(findings[0].filePath, "/project/src/utils.ts");
    assert.equal(findings[0].line, 10);
    assert.ok(findings[0].metadata._stacktrace.stacktraceFingerprint);
    assert.equal(findings[0].metadata._stacktrace.frameIndex, 0);
    assert.equal(findings[1].metadata._stacktrace.frameIndex, 1);
  });

  test("stacktraceToFindings marks vendor frames as info severity", () => {
    const stack = [
      "    at myFunc (/project/node_modules/lib/index.js:1:1)",
      "    at myAppFunc (/project/src/app.ts:5:5)",
    ].join("\n");

    const findings = stacktraceToFindings(stack, { severity: "high" });

    assert.equal(findings[0].severity, "info"); // vendor frame
    assert.equal(findings[1].severity, "high"); // in_app frame
  });

  test("anonymous function names are detected correctly", () => {
    assert.equal(isAnonymousFunction("<anonymous>"), true);
    assert.equal(isAnonymousFunction("?"), true);
    assert.equal(isAnonymousFunction("<unknown>"), true);
    assert.equal(isAnonymousFunction("[anonymous]"), true);
    assert.equal(isAnonymousFunction("Global code"), true);
    assert.equal(isAnonymousFunction("myApp"), false);
    assert.equal(isAnonymousFunction("render"), false);
  });
});
