/**
 * Tests for Sentry-inspired arkitect engines:
 *   - finding-grouping-engine.mjs
 *   - finding-pipeline.mjs
 *   - finding-breadcrumbs.mjs
 */
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";

import {
  extractComponents,
  exactVariant,
  fingerprintVariant,
  categoryVariant,
  applyFingerprintRules,
  groupFindings,
  normalizeMessage,
  extractMessageTemplate,
  hashFromValues,
  resolveGroup,
  ignoreGroup,
  serializeState,
  deserializeState,
} from "@saydeploy/architect/engines/pipeline/finding-grouping-engine";

import {
  createPipeline,
  normalizeFinding,
  runMetadataIntegration,
  createPathFilterIntegration,
} from "@saydeploy/architect/engines/pipeline/finding-pipeline";

import {
  addBreadcrumb,
  getBreadcrumbs,
  clearBreadcrumbs,
  withBreadcrumbScope,
  breadcrumbFileParsed,
  breadcrumbRuleMatched,
  attachBreadcrumbsToFinding,
} from "@saydeploy/architect/engines/pipeline/finding-breadcrumbs";

// ===========================================================================
// finding-grouping-engine tests
// ===========================================================================

describe("finding-grouping-engine", () => {
  test("normalizeMessage strips variable parts", () => {
    assert.equal(normalizeMessage('File "src/foo.ts" has 42 issues'), 'file "<str>" has <num> issues');
    assert.equal(normalizeMessage("Visit https://example.com/path for details"), "visit <url> for details");
    assert.equal(normalizeMessage("  Extra   spaces  "), "extra spaces");
  });

  test("extractMessageTemplate is consistent for similar messages", () => {
    const t1 = extractMessageTemplate("Line 10 exceeds 100 chars");
    const t2 = extractMessageTemplate("Line 42 exceeds 100 chars");
    assert.equal(t1, t2); // same template after normalization
  });

  test("hashFromValues is deterministic", () => {
    const h1 = hashFromValues(["a", "b", "c"]);
    const h2 = hashFromValues(["a", "b", "c"]);
    assert.equal(h1, h2);
    assert.equal(h1.length, 16); // truncated SHA-256
  });

  test("hashFromValues differs for different inputs", () => {
    const h1 = hashFromValues(["a", "b", "c"]);
    const h2 = hashFromValues(["a", "b", "d"]);
    assert.notEqual(h1, h2);
  });

  test("extractComponents normalizes fields", () => {
    const comp = extractComponents({
      ruleId: "oversized-files",
      filePath: "src\\components\\Foo.vue",
      line: 42,
      severity: "high",
      message: "File has 500 lines",
      snippet: "  export default {",
    });
    assert.equal(comp.ruleId, "oversized-files");
    assert.equal(comp.filePath, "src/components/Foo.vue"); // backslash normalized
    assert.equal(comp.line, 42);
    assert.equal(comp.severity, "high");
    assert.equal(comp.normMessage, "file has <num> lines");
  });

  test("variants produce different hashes", () => {
    const comp = extractComponents({
      ruleId: "test-rule",
      filePath: "src/test.ts",
      line: 10,
      message: "Some issue",
    });

    const exact = exactVariant(comp);
    const fp = fingerprintVariant(comp);
    const cat = categoryVariant(comp);

    assert.notEqual(exact.hash, fp.hash);
    assert.notEqual(fp.hash, cat.hash);
    assert.equal(exact.variant, "exact");
    assert.equal(fp.variant, "fingerprint");
    assert.equal(cat.variant, "category");
  });

  test("exactVariant groups same location and message", () => {
    const c1 = extractComponents({ ruleId: "R", filePath: "f.ts", line: 1, message: "bad" });
    const c2 = extractComponents({ ruleId: "R", filePath: "f.ts", line: 1, message: "bad" });
    assert.equal(exactVariant(c1).hash, exactVariant(c2).hash);
  });

  test("fingerprintVariant ignores line number changes", () => {
    const c1 = extractComponents({ ruleId: "R", filePath: "f.ts", line: 1, message: "bad thing" });
    const c2 = extractComponents({ ruleId: "R", filePath: "f.ts", line: 99, message: "bad thing" });
    // exact differs but fingerprint matches
    assert.notEqual(exactVariant(c1).hash, exactVariant(c2).hash);
    assert.equal(fingerprintVariant(c1).hash, fingerprintVariant(c2).hash);
  });

  test("applyFingerprintRules matches wildcard patterns", () => {
    const rules = [{ match: { ruleId: "css-*" }, fingerprint: ["css-quality"] }];
    const comp = extractComponents({ ruleId: "css-dedupe", filePath: "style.css", message: "dup" });

    const result = applyFingerprintRules(comp, rules);
    assert.ok(result);
    assert.equal(result.variant, "custom-fingerprint");
    assert.equal(result.hash, hashFromValues(["css-quality"]));
  });

  test("applyFingerprintRules returns null on no match", () => {
    const rules = [{ match: { ruleId: "css-*" }, fingerprint: ["css"] }];
    const comp = extractComponents({ ruleId: "vue-layering", filePath: "App.vue", message: "bad" });

    assert.equal(applyFingerprintRules(comp, rules), null);
  });

  test("groupFindings groups identical findings", () => {
    const findings = [
      { ruleId: "R1", filePath: "a.ts", line: 1, message: "bad", severity: "high" },
      { ruleId: "R1", filePath: "a.ts", line: 1, message: "bad", severity: "high" },
    ];

    const { groupedFindings, stats } = groupFindings(findings);

    assert.equal(stats.totalFindings, 2);
    assert.equal(stats.totalGroups, 1); // both in same group
    assert.equal(groupedFindings[0].isNew, true);
    assert.equal(groupedFindings[1].isNew, false); // second is not new
    // First finding: occurrenceCount=1 (only itself when first seen)
    // Second finding: occurrenceCount=2 (group grew after first was processed)
    assert.equal(groupedFindings[0].occurrenceCount, 1);
    assert.equal(groupedFindings[1].occurrenceCount, 2);
  });

  test("groupFindings detects regressions", () => {
    const findings = [{ ruleId: "R1", filePath: "a.ts", line: 1, message: "bad", severity: "high" }];

    // First run
    const first = groupFindings(findings);

    // Resolve the group
    const resolvedState = resolveGroup(first.newState, first.groupedFindings[0].groupId);
    assert.equal(resolvedState.groups.get(first.groupedFindings[0].groupId).status, "resolved");

    // Second run with same finding — should be a regression
    const second = groupFindings(findings, { previousState: resolvedState });

    assert.equal(second.groupedFindings[0].isRegression, true);
    assert.equal(second.stats.regressions, 1);
  });

  test("groupFindings with fingerprint rules overrides grouping", () => {
    const findings = [
      { ruleId: "css-dedupe", filePath: "a.css", line: 1, message: "dup", severity: "warn" },
      { ruleId: "css-shared", filePath: "b.css", line: 10, message: "unused", severity: "warn" },
    ];

    const rules = [{ match: { ruleId: "css-*" }, fingerprint: ["all-css-issues"] }];

    const { groupedFindings, stats } = groupFindings(findings, { fingerprintRules: rules });

    // Both should be forced into the same group
    assert.equal(stats.totalGroups, 1);
    assert.equal(groupedFindings[0].variant, "custom-fingerprint");
  });

  test("serializeState / deserializeState roundtrip", () => {
    const findings = [{ ruleId: "R", filePath: "f.ts", line: 1, message: "bad", severity: "high" }];
    const { newState } = groupFindings(findings);

    const json = serializeState(newState);
    const restored = deserializeState(json);

    assert.equal(restored.stateVersion, newState.stateVersion);
    assert.equal(restored.groups.size, newState.groups.size);
  });

  test("ignoreGroup marks as ignored", () => {
    const findings = [{ ruleId: "R", filePath: "f.ts", line: 1, message: "bad", severity: "low" }];
    const { newState, groupedFindings } = groupFindings(findings);
    const groupId = groupedFindings[0].groupId;

    const ignored = ignoreGroup(newState, groupId);
    assert.equal(ignored.groups.get(groupId).status, "ignored");
  });
});

// ===========================================================================
// finding-pipeline tests
// ===========================================================================

describe("finding-pipeline", () => {
  test("normalizeFinding fills defaults", () => {
    const f = normalizeFinding({});
    assert.equal(f.ruleId, "unknown");
    assert.equal(f.severity, "warn");
    assert.equal(f.filePath, "");
    assert.equal(f.line, 0);
    assert.ok(f.metadata._pipeline);
  });

  test("normalizeFinding maps invalid severity to warn", () => {
    const f = normalizeFinding({ ruleId: "test", severity: "CRITICAL" });
    // "CRITICAL" is not in the valid set ("critical" is, but not "CRITICAL")
    assert.equal(f.severity, "warn");
  });

  test("normalizeFinding truncates long messages", () => {
    const f = normalizeFinding({ message: "x".repeat(600) }, { maxMessageLength: 500 });
    assert.equal(f.message.length, 503); // 500 + "..."
    assert.ok(f.message.endsWith("..."));
  });

  test("pipeline processes a finding end-to-end", () => {
    const pipeline = createPipeline({
      globalTags: { env: "test" },
    });

    const result = pipeline.processFinding(
      { ruleId: "test-rule", filePath: "f.ts", message: "test", severity: "high" },
      { checkId: "test-check", runId: "run-1" },
    );

    assert.ok(result);
    assert.equal(result.metadata._tags.env, "test");
    assert.equal(result.metadata._checkId, "test-check");
    assert.equal(result.metadata._runId, "run-1");
    assert.equal(pipeline.stats.received, 1);
    assert.equal(pipeline.stats.outputted, 1);
  });

  test("pipeline drops findings via sampleRate=0", () => {
    const pipeline = createPipeline({ sampleRate: 0.0 });
    const result = pipeline.processFinding({ ruleId: "test" });
    assert.equal(result, null);
    assert.equal(pipeline.stats.droppedBySampleRate, 1);
  });

  test("pipeline drops findings via beforeOutput returning null", () => {
    const pipeline = createPipeline({
      beforeOutput: () => null,
    });

    const result = pipeline.processFinding({ ruleId: "test" });
    assert.equal(result, null);
    assert.equal(pipeline.stats.droppedByBeforeOutput, 1);
  });

  test("runMetadataIntegration adds timestamps", () => {
    const pipeline = createPipeline({
      integrations: [runMetadataIntegration],
    });

    const result = pipeline.processFinding({ ruleId: "test" }, { runId: "run-42" });

    assert.ok(result.metadata._processedAt);
    assert.equal(result.metadata._runId, "run-42");
  });

  test("createPathFilterIntegration excludes by rule", () => {
    const pipeline = createPipeline({
      integrations: [createPathFilterIntegration({ excludeRules: ["noisy-rule"] })],
    });

    const r1 = pipeline.processFinding({ ruleId: "noisy-rule", message: "noise" });
    const r2 = pipeline.processFinding({ ruleId: "good-rule", message: "signal" });

    assert.equal(r1, null);
    assert.ok(r2);
    assert.equal(pipeline.stats.droppedByPreprocessor, 1);
  });

  test("createPathFilterIntegration excludes by path", () => {
    const pipeline = createPipeline({
      integrations: [createPathFilterIntegration({ excludePaths: ["node_modules", "__tests__"] })],
    });

    assert.equal(pipeline.processFinding({ ruleId: "R", filePath: "node_modules/pkg/index.js" }), null);
    assert.equal(pipeline.processFinding({ ruleId: "R", filePath: "src/__tests__/foo.spec.ts" }), null);
    assert.ok(pipeline.processFinding({ ruleId: "R", filePath: "src/components/Foo.vue" }));
  });

  test("processBatch handles multiple findings", () => {
    const pipeline = createPipeline();
    const { processed, stats } = pipeline.processBatch([
      { ruleId: "a", message: "1" },
      { ruleId: "b", message: "2" },
      { ruleId: "c", message: "3" },
    ]);

    assert.equal(processed.length, 3);
    assert.equal(stats.received, 3);
    assert.equal(stats.outputted, 3);
  });
});

// ===========================================================================
// finding-breadcrumbs tests
// ===========================================================================

describe("finding-breadcrumbs", () => {
  const TEST_RUN = "test-run-breadcrumbs";

  afterEach(() => {
    clearBreadcrumbs(TEST_RUN);
    clearBreadcrumbs(); // also clear default
  });

  test("addBreadcrumb and getBreadcrumbs", () => {
    addBreadcrumb({ type: "parse", message: "Parsed foo.ts" }, TEST_RUN);
    addBreadcrumb({ type: "match", message: "Matched rule X" }, TEST_RUN);

    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs.length, 2);
    assert.equal(crumbs[0].type, "parse");
    assert.equal(crumbs[0].message, "Parsed foo.ts");
    assert.ok(crumbs[0].timestamp);
    assert.equal(crumbs[1].type, "match");
  });

  test("addBreadcrumb defaults invalid type to info", () => {
    addBreadcrumb({ type: "invalid", message: "test" }, TEST_RUN);
    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs[0].type, "info");
  });

  test("breadcrumbFileParsed helper", () => {
    breadcrumbFileParsed("src/App.vue", { lines: 200 }, TEST_RUN);
    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs.length, 1);
    assert.equal(crumbs[0].type, "parse");
    assert.equal(crumbs[0].data.filePath, "src/App.vue");
    assert.equal(crumbs[0].data.lines, 200);
  });

  test("breadcrumbRuleMatched helper", () => {
    breadcrumbRuleMatched("oversized-files", "big.ts", { lineCount: 500 }, TEST_RUN);
    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs[0].type, "match");
    assert.equal(crumbs[0].data.ruleId, "oversized-files");
    assert.equal(crumbs[0].data.lineCount, 500);
  });

  test("clearBreadcrumbs removes all crumbs for a run", () => {
    addBreadcrumb({ type: "info", message: "test" }, TEST_RUN);
    assert.equal(getBreadcrumbs(TEST_RUN).length, 1);
    clearBreadcrumbs(TEST_RUN);
    assert.equal(getBreadcrumbs(TEST_RUN).length, 0);
  });

  test("attachBreadcrumbsToFinding adds crumbs to metadata", () => {
    addBreadcrumb({ type: "audit", message: "Starting check" }, TEST_RUN);
    addBreadcrumb({ type: "match", message: "Found issue" }, TEST_RUN);

    const finding = { ruleId: "test", filePath: "f.ts", message: "bad" };
    const enriched = attachBreadcrumbsToFinding(finding, TEST_RUN);

    assert.ok(enriched.metadata._breadcrumbs);
    assert.equal(enriched.metadata._breadcrumbs.length, 2);
    assert.equal(enriched.metadata._breadcrumbs[0].type, "audit");
  });

  test("attachBreadcrumbsToFinding no-ops when no crumbs", () => {
    clearBreadcrumbs(TEST_RUN);
    const finding = { ruleId: "test", metadata: {} };
    const enriched = attachBreadcrumbsToFinding(finding, TEST_RUN);
    assert.equal(enriched, finding); // same reference (no crumbs = no change)
    assert.equal(enriched.metadata._breadcrumbs, undefined);
  });

  test("withBreadcrumbScope isolates crumbs", async () => {
    addBreadcrumb({ type: "info", message: "parent crumb" }, TEST_RUN);

    await withBreadcrumbScope(async (scope) => {
      scope.addBreadcrumb({ type: "parse", message: "child crumb" });
      // Inside scope, parent crumbs are NOT visible
      // (scope isolation — only the scope's own crumbs matter)
    }, TEST_RUN);

    // After scope completes, child crumbs are merged into parent
    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs.length, 2);
    assert.equal(crumbs[0].message, "parent crumb");
    assert.equal(crumbs[1].message, "child crumb");
  });

  test("breadcrumb max limit enforced", () => {
    for (let i = 0; i < 150; i++) {
      addBreadcrumb({ type: "info", message: `crumb ${i}` }, TEST_RUN);
    }
    const crumbs = getBreadcrumbs(TEST_RUN);
    assert.equal(crumbs.length, 100); // capped at 100
    assert.equal(crumbs[0].message, "crumb 50"); // oldest 50 trimmed
    assert.equal(crumbs[99].message, "crumb 149"); // newest kept
  });
});
