import assert from "node:assert/strict";
import { test } from "node:test";

import { SARIF_SCHEMA_URI, SARIF_VERSION, buildSarifLog, severityToSarifLevel } from "@saydeploy/architect/core/sarif";

test("severityToSarifLevel collapses to four SARIF levels", () => {
  assert.equal(severityToSarifLevel("critical"), "error");
  assert.equal(severityToSarifLevel("high"), "error");
  assert.equal(severityToSarifLevel("medium"), "warning");
  assert.equal(severityToSarifLevel("low"), "note");
  assert.equal(severityToSarifLevel("info"), "note");
});

test("buildSarifLog emits 2.1.0 shell", () => {
  const log = buildSarifLog([]);
  assert.equal(log.version, SARIF_VERSION);
  assert.equal(log.$schema, SARIF_SCHEMA_URI);
  assert.deepEqual(log.runs, []);
});

test("buildSarifLog builds one run per check with auto-derived rules", () => {
  const log = buildSarifLog([
    {
      check: { id: "oversized-files", title: "Oversized files", family: "architecture" },
      findings: [
        {
          ruleId: "oversized-files/too-large",
          severity: "medium",
          filePath: "src/components/Big.vue",
          line: 1247,
          message: "File exceeds 1000-line budget",
          metadata: { lines: 1247 },
        },
      ],
    },
  ]);

  assert.equal(log.runs.length, 1);
  const run = log.runs[0];
  assert.equal(run.tool.driver.name, "arkitect");
  assert.equal(run.tool.driver.rules.length, 1);
  assert.equal(run.tool.driver.rules[0].id, "oversized-files/too-large");
  assert.equal(run.tool.driver.properties.family, "architecture");

  assert.equal(run.results.length, 1);
  const result = run.results[0];
  assert.equal(result.ruleId, "oversized-files/too-large");
  assert.equal(result.ruleIndex, 0);
  assert.equal(result.level, "warning");
  assert.equal(result.message.text, "File exceeds 1000-line budget");
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, "src/components/Big.vue");
  assert.equal(result.locations[0].physicalLocation.region.startLine, 1247);
  assert.deepEqual(result.properties, { lines: 1247 });
});

test("buildSarifLog respects declared rules from check", () => {
  const log = buildSarifLog([
    {
      check: {
        id: "secrets",
        title: "Secret scanner",
        family: "security",
        helpUri: "https://example.com/rules",
        rules: [
          { id: "SEC-001", name: "aws-access-key", fullDescription: "Hardcoded AWS access key" },
          { id: "SEC-002", name: "private-key" },
        ],
      },
      findings: [{ ruleId: "SEC-001", severity: "critical", filePath: "config.js", line: 12 }],
    },
  ]);

  const run = log.runs[0];
  assert.equal(run.tool.driver.rules.length, 2);
  assert.equal(run.tool.driver.rules[0].id, "SEC-001");
  assert.equal(run.tool.driver.rules[0].fullDescription.text, "Hardcoded AWS access key");
  assert.equal(run.tool.driver.rules[0].helpUri, "https://example.com/rules");
  assert.equal(run.results[0].level, "error");
});

test("buildSarifLog carries source anchors in result properties", () => {
  const log = buildSarifLog([
    {
      check: { id: "demo", title: "Demo" },
      findings: [
        {
          ruleId: "demo/rule",
          severity: "medium",
          filePath: "src/demo.ts",
          line: 4,
          metadata: { baselineKey: "src/demo.ts:4" },
          sourceAnchor: {
            version: 1,
            kind: "content-hash",
            filePath: "src/demo.ts",
            line: 4,
            anchor: "L4:sha256-abc123abc123",
            lineHash: "sha256-abc123abc123",
            contextStartLine: 2,
            contextEndLine: 6,
            contextHash: "sha256-def456def456",
          },
        },
      ],
    },
  ]);

  assert.equal(log.runs[0].results[0].properties.baselineKey, "src/demo.ts:4");
  assert.equal(log.runs[0].results[0].properties.sourceAnchor.anchor, "L4:sha256-abc123abc123");
});
