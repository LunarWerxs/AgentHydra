import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE_QUALITY_WEIGHTS,
  SECURITY_WEIGHTS,
  applyBlastRadius,
  calculatePenalty,
  countBySeverity,
  gradeFromScore100,
  normalizeSeverity,
  scoreFindings,
  scoreFromPenalty,
} from "@saydeploy/architect/core/scoring";

test("normalizeSeverity maps common aliases", () => {
  assert.equal(normalizeSeverity("CRITICAL"), "critical");
  assert.equal(normalizeSeverity("error"), "high");
  assert.equal(normalizeSeverity("warn"), "medium");
  assert.equal(normalizeSeverity("note"), "low");
  assert.equal(normalizeSeverity("informational"), "info");
  assert.equal(normalizeSeverity(undefined), "info");
  assert.equal(normalizeSeverity("nonsense"), "info");
});

test("countBySeverity bins all five levels", () => {
  const counts = countBySeverity([
    { severity: "critical" },
    { severity: "high" },
    { severity: "high" },
    { severity: "medium" },
    { severity: "low" },
    { severity: "info" },
    {},
  ]);
  assert.deepEqual(counts, { critical: 1, high: 2, medium: 1, low: 1, info: 2 });
});

test("calculatePenalty uses code-quality weights by default", () => {
  const penalty = calculatePenalty({ critical: 1, high: 2, medium: 4, low: 5, info: 99 });
  // 1*2 + 2*1 + 4*0.5 + 5*0.2 = 7.0
  assert.equal(penalty, 7);
});

test("calculatePenalty supports security weights", () => {
  const penalty = calculatePenalty({ critical: 1, high: 1, medium: 0, low: 0, info: 0 }, SECURITY_WEIGHTS);
  // 1*15 + 1*8 = 23
  assert.equal(penalty, 23);
});

test("scoreFromPenalty clamps at zero", () => {
  assert.equal(scoreFromPenalty(3), 7);
  assert.equal(scoreFromPenalty(15), 0);
});

test("gradeFromScore100 matches band boundaries", () => {
  assert.equal(gradeFromScore100(100), "A");
  assert.equal(gradeFromScore100(90), "A");
  assert.equal(gradeFromScore100(89), "B");
  assert.equal(gradeFromScore100(70), "C");
  assert.equal(gradeFromScore100(60), "D");
  assert.equal(gradeFromScore100(59), "F");
});

test("scoreFindings end-to-end", () => {
  const result = scoreFindings([{ severity: "high" }, { severity: "medium" }, { severity: "low" }]);
  // penalty = 1.0 + 0.5 + 0.2 = 1.7; score = 8.3; 100-score = 83
  assert.equal(result.penalty, 1.7);
  assert.equal(result.score, 8.3);
  assert.equal(result.score100, 83);
  assert.equal(result.grade, "B");
  assert.equal(result.totalFindings, 3);
});

test("applyBlastRadius shifts severity up/down within bounds", () => {
  assert.equal(applyBlastRadius("medium", "global"), "high");
  assert.equal(applyBlastRadius("medium", "admin"), "low");
  assert.equal(applyBlastRadius("medium", "internal"), "medium");
  // critical is already the top of the lattice; "global" cannot bump higher.
  assert.equal(applyBlastRadius("critical", "global"), "critical");
  // info is already the bottom; "admin" cannot bump lower.
  assert.equal(applyBlastRadius("info", "admin"), "info");
});

test("CODE_QUALITY_WEIGHTS is frozen", () => {
  assert.equal(Object.isFrozen(CODE_QUALITY_WEIGHTS), true);
});
