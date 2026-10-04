import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONFIDENCE_BANDS,
  DEFAULT_CONFIDENCE_CUTOFF,
  VERDICT,
  applyVerdictDowngrade,
  bandForConfidence,
  betaBernoulli,
  filterByConfidence,
  passesCutoff,
} from "@saydeploy/architect/core/confidence";

test("bandForConfidence finds correct band", () => {
  assert.equal(bandForConfidence(10).label, "very-low");
  assert.equal(bandForConfidence(40).label, "low");
  assert.equal(bandForConfidence(60).label, "moderate");
  assert.equal(bandForConfidence(85).label, "high");
  assert.equal(bandForConfidence(95).label, "critical");
});

test("passesCutoff respects the 80 default", () => {
  assert.equal(DEFAULT_CONFIDENCE_CUTOFF, 80);
  assert.equal(passesCutoff(79), false);
  assert.equal(passesCutoff(80), true);
  assert.equal(passesCutoff(81), true);
});

test("filterByConfidence drops sub-cutoff and keeps unscored", () => {
  const { findings, dropped } = filterByConfidence([
    { ruleId: "A", confidence: 95 },
    { ruleId: "B", confidence: 60 },
    { ruleId: "C", confidence: 80 },
    { ruleId: "D" }, // no confidence — kept
  ]);
  assert.equal(findings.length, 3);
  assert.equal(dropped, 1);
  assert.deepEqual(
    findings.map((f) => f.ruleId),
    ["A", "C", "D"],
  );
});

test("applyVerdictDowngrade: tool errors force inconclusive", () => {
  assert.equal(
    applyVerdictDowngrade({ claim: VERDICT.CONFIRMED, evidenceCount: 5, toolErrors: 1 }),
    VERDICT.INCONCLUSIVE,
  );
});

test("applyVerdictDowngrade: confirmed without evidence becomes refuted", () => {
  assert.equal(applyVerdictDowngrade({ claim: VERDICT.CONFIRMED, evidenceCount: 0 }), VERDICT.REFUTED);
});

test("applyVerdictDowngrade: passes through valid confirmed", () => {
  assert.equal(applyVerdictDowngrade({ claim: VERDICT.CONFIRMED, evidenceCount: 1 }), VERDICT.CONFIRMED);
});

test("applyVerdictDowngrade: garbage claim becomes inconclusive", () => {
  assert.equal(applyVerdictDowngrade({ claim: "yes please" }), VERDICT.INCONCLUSIVE);
});

test("betaBernoulli aggregates votes with Jeffreys prior", () => {
  const zero = betaBernoulli([]);
  assert.equal(zero.evidenceCount, 0);
  assert.equal(zero.confidence, 50);

  const oneYes = betaBernoulli([true]);
  // alpha=1.5 beta=0.5 → mean = 0.75
  assert.equal(oneYes.confidence, 75);

  const tenYes = betaBernoulli([true, true, true, true, true, true, true, true, true, true]);
  // alpha=10.5 beta=0.5 → mean ≈ 0.954
  assert.equal(tenYes.confidence, 95);
});

test("CONFIDENCE_BANDS cover entire 0-100 range", () => {
  for (let i = 0; i <= 100; i += 1) {
    const band = CONFIDENCE_BANDS.find((b) => i >= b.min && i <= b.max);
    assert.ok(band, `no band for ${i}`);
  }
});
