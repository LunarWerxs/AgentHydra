import assert from "node:assert/strict";
import { test } from "node:test";

import { ENVELOPE_SCHEMA_VERSION, buildEnvelope, digestConfig } from "@saydeploy/architect/core/envelope";

const check = {
  id: "oversized-files",
  title: "Oversized files",
  category: "architecture",
  family: "architecture",
  resolvedConfig: { warnLines: 1000, errorLines: 2000 },
};

test("buildEnvelope produces stable schema-versioned shape", () => {
  const envelope = buildEnvelope({
    check,
    result: {
      findings: [{ severity: "high" }, { severity: "low" }],
      jsonPayload: { customCount: 3 },
    },
    runId: "fixed-run-id",
    emittedAt: "2026-05-24T00:00:00.000Z",
    durationMs: 250,
  });

  assert.equal(envelope.schema_version, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.summary_kind, "audit");
  assert.equal(envelope.run_id, "fixed-run-id");
  assert.equal(envelope.emitted_at, "2026-05-24T00:00:00.000Z");
  assert.equal(envelope.check.id, "oversized-files");
  assert.equal(envelope.check.duration_ms, 250);
  assert.equal(envelope.check.family, "architecture");
  assert.match(envelope.check.config_digest, /^[a-f0-9]{12}$/);
});

test("buildEnvelope derives audit.score from findings", () => {
  const envelope = buildEnvelope({
    check,
    result: { findings: [{ severity: "high" }, { severity: "low" }] },
  });
  // 1*1.0 + 1*0.2 = 1.2; score = 8.8; score100 = 88
  assert.equal(envelope.payload.audit.penalty, 1.2);
  assert.equal(envelope.payload.audit.score, 8.8);
  assert.equal(envelope.payload.audit.score100, 88);
  assert.equal(envelope.payload.audit.grade, "B");
  assert.equal(envelope.payload.audit.total_findings, 2);
});

test("buildEnvelope verdict: fail when result.failed", () => {
  const envelope = buildEnvelope({ check, result: { failed: true, findings: [{ severity: "high" }] } });
  assert.equal(envelope.verdict, "fail");
});

test("buildEnvelope verdict: pass when no findings", () => {
  const envelope = buildEnvelope({ check, result: { findings: [] } });
  assert.equal(envelope.verdict, "pass");
});

test("buildEnvelope verdict: inconclusive when findings but no failed flag", () => {
  const envelope = buildEnvelope({ check, result: { findings: [{ severity: "low" }] } });
  assert.equal(envelope.verdict, "inconclusive");
});

test("buildEnvelope respects explicit verdict", () => {
  const envelope = buildEnvelope({ check, result: { verdict: "fail", findings: [] } });
  assert.equal(envelope.verdict, "fail");
});

test("buildEnvelope merges jsonPayload into diagnostics", () => {
  const envelope = buildEnvelope({
    check,
    result: {
      findings: [],
      jsonPayload: { customCount: 3, breakdown: { a: 1 } },
      topLevelDiagnostic: "ok",
    },
  });
  assert.equal(envelope.payload.diagnostics.customCount, 3);
  assert.deepEqual(envelope.payload.diagnostics.breakdown, { a: 1 });
  assert.equal(envelope.payload.diagnostics.topLevelDiagnostic, "ok");
});

test("buildEnvelope attaches project block when provided", () => {
  const envelope = buildEnvelope({
    check,
    result: { findings: [] },
    project: { root: "/x", languages: ["typescript"], frameworks: ["vue"] },
  });
  assert.deepEqual(envelope.project, { root: "/x", languages: ["typescript"], frameworks: ["vue"] });
});

test("digestConfig is stable across key order", () => {
  const a = digestConfig({ a: 1, b: 2, c: 3 });
  const b = digestConfig({ c: 3, b: 2, a: 1 });
  assert.equal(a, b);
});
