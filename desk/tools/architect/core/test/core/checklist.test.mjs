import assert from "node:assert/strict";
import { test } from "node:test";

import { combineCategoryScores, rateScore, scoreChecklist } from "@saydeploy/architect/core/checklist";

test("rateScore lands in the right band", () => {
  assert.equal(rateScore(95), "excellent");
  assert.equal(rateScore(80), "good");
  assert.equal(rateScore(50), "needs-work");
  assert.equal(rateScore(25), "poor");
  assert.equal(rateScore(10), "critical");
});

test("scoreChecklist tallies weighted pass/fail and emits findings", () => {
  const result = scoreChecklist(
    [
      { id: "has-readme", passed: true, weight: 2, successMessage: "README present" },
      { id: "has-license", passed: false, weight: 1, failureMessage: "LICENSE missing" },
      { id: "has-tests", passed: true, weight: 3 },
      { id: "has-ci", passed: false, weight: 2, failureMessage: "No CI", severity: "high" },
    ],
    { check: { id: "repo-health" } },
  );

  assert.equal(result.passed, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.totalWeight, 8);
  assert.equal(result.earnedWeight, 5);
  assert.equal(result.score, 63);
  assert.equal(result.rating, "needs-work");
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].ruleId, "repo-health/has-license");
  assert.equal(result.findings[1].severity, "high");
  assert.ok(result.notes.includes("[-] LICENSE missing"));
});

test("scoreChecklist handles empty input", () => {
  const result = scoreChecklist([], { check: { id: "x" } });
  assert.equal(result.score, 0);
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 0);
});

test("combineCategoryScores weights overall", () => {
  const out = combineCategoryScores([
    { name: "readme", score: 90, weight: 0.25 },
    { name: "tests", score: 70, weight: 0.5 },
    { name: "ci", score: 50, weight: 0.25 },
  ]);
  // (90*0.25 + 70*0.5 + 50*0.25) / 1 = 70
  assert.equal(out.score, 70);
  assert.equal(out.rating, "needs-work");
});

test("combineCategoryScores tolerates zero total weight", () => {
  const out = combineCategoryScores([{ name: "x", score: 100, weight: 0 }]);
  assert.equal(out.score, 0);
  assert.equal(out.rating, "critical");
});
