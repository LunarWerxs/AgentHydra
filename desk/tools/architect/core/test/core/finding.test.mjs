import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDecisionBrief,
  createFinding,
  normalizeFinding,
  scoreNormalizedFinding,
} from "@saydeploy/architect/core/finding";

test("createFinding preserves explicit source anchors", () => {
  const finding = createFinding({
    ruleId: "demo",
    sourceAnchor: {
      version: 1,
      kind: "content-hash",
      filePath: "src/demo.ts",
      line: 1,
      anchor: "L1:sha256-abc123abc123",
      lineHash: "sha256-abc123abc123",
      contextStartLine: 1,
      contextEndLine: 1,
      contextHash: "sha256-def456def456",
    },
  });

  assert.equal(finding.sourceAnchor.anchor, "L1:sha256-abc123abc123");
});

test("createFinding preserves operational finding metadata", () => {
  const finding = createFinding({
    ruleId: "public-bucket",
    severity: "error",
    confidence: 92,
    resource: "AssetsBucket",
    arn: "arn:aws:s3:::assets",
    account: "123456789012",
    region: "us-east-1",
    why: "the bucket is internet reachable",
    fix: "block public access",
    blastRadius: "public",
    compliance: ["security"],
    mapNodeId: "s3:AssetsBucket",
  });

  assert.equal(finding.confidence, 92);
  assert.equal(finding.arn, "arn:aws:s3:::assets");
  assert.deepEqual(finding.compliance, ["security"]);
});

test("normalizeFinding emits the S0 operational schema and risk score", () => {
  const finding = normalizeFinding(
    createFinding({
      ruleId: "s3-public-policy",
      severity: "error",
      filePath: "infra/template.json",
      line: 12,
      confidence: 90,
      resource: "PublicAssetsBucket",
      arn: "arn:aws:s3:::public-assets",
      account: "123456789012",
      region: "us-east-1",
      message: "S3 bucket policy allows public read",
      why: "public buckets can leak user-uploaded data",
      fix: "enable block public access and remove the public principal",
      blastRadius: "public",
      compliance: "security",
      mapNodeId: "s3:PublicAssetsBucket",
    }),
    { check: { id: "infra-public-exposure", title: "Public Exposure", category: "infra" } },
  );

  assert.equal(finding.ruleId, "s3-public-policy");
  assert.equal(finding.severity, "error");
  assert.equal(finding.confidence, 90);
  assert.equal(finding.resource, "PublicAssetsBucket");
  assert.equal(finding.arn, "arn:aws:s3:::public-assets");
  assert.equal(finding.account, "123456789012");
  assert.equal(finding.region, "us-east-1");
  assert.deepEqual(finding.location, {
    file: "infra/template.json",
    line: 12,
    column: 0,
    label: "infra/template.json:12",
  });
  assert.equal(finding.why, "public buckets can leak user-uploaded data");
  assert.equal(finding.fix, "enable block public access and remove the public principal");
  assert.equal(finding.blastRadius, "public");
  assert.deepEqual(finding.compliance, ["security"]);
  assert.equal(finding.source.checkId, "infra-public-exposure");
  assert.equal(finding.mapNodeId, "s3:PublicAssetsBucket");
  assert.equal(finding.riskScore, 83);
  assert.equal(finding.threatScore, 83);
});

test("scoreNormalizedFinding includes operational context weights", () => {
  const risk = scoreNormalizedFinding({
    severity: "warn",
    confidence: 80,
    resource: "ApiGateway",
    message: "Public API route has missing WAF and no alarm",
    blastRadius: "public",
  });

  assert.equal(risk.score, 66);
  assert.equal(risk.factors.exposureWeight, 20);
  assert.equal(risk.factors.reachabilityWeight, 10);
  assert.equal(risk.factors.noSafetyNetWeight, 10);
});

test("buildDecisionBrief emits DevOpz operational buckets and next actions", () => {
  const findings = [
    normalizeFinding(
      createFinding({
        ruleId: "iam-wildcard-write",
        severity: "warn",
        confidence: 85,
        resource: "AppRole",
        message: "IAM policy allows wildcard write actions",
        fix: "replace wildcard actions with explicit least-privilege actions",
      }),
      { check: { id: "infra-iam-blast-radius", title: "IAM Blast Radius", category: "infra" } },
    ),
    normalizeFinding(
      createFinding({
        ruleId: "cost-log-retention",
        severity: "warn",
        confidence: 70,
        resource: "ApiLogs",
        message: "Cost waste: log group keeps infinite retention",
      }),
      { check: { id: "infra-cost-efficiency", title: "Cost Efficiency", category: "infra" } },
    ),
  ];

  const brief = buildDecisionBrief({
    findings,
    manifest: { generatedAt: "2026-05-31T00:00:00.000Z", mode: "all", pass: { nextAction: "fix-errors" } },
    toolName: "devopz",
  });

  assert.equal(brief.tool, "devopz");
  assert.equal(brief.nextAction, "fix-errors");
  assert.equal(brief.topOverbroadIamGrants.length, 1);
  assert.equal(brief.costHotSpots.length, 1);
  assert.equal(brief.nextActions[0].action, "replace wildcard actions with explicit least-privilege actions");
});
