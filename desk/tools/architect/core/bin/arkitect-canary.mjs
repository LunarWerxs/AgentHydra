#!/usr/bin/env bun
import process from "node:process";

import { getAudit } from "@saydeploy/architect/cli/registry";
import { loadAuditScenarioRecords, runAuditFixtureScenario } from "@saydeploy/architect/fixtures/harness";

const CANARY_SCENARIOS = [
  {
    auditId: "analytics-contracts",
    scenario: "fail-frontend-only",
    label: "Frontend-only analytics event",
  },
  {
    auditId: "analytics-contracts",
    scenario: "fail-backend-only",
    label: "Backend-only analytics event",
  },
  {
    auditId: "runnyknows-contracts",
    scenario: "fail-frontend-only",
    label: "Frontend-only runnyknows source",
  },
  {
    auditId: "endpoint-contracts",
    scenario: "fail-frontend-only",
    label: "Frontend endpoint action missing backend dispatch",
  },
  {
    auditId: "workflow-outcome-contracts",
    scenario: "fail-ungated-success",
    label: "Ungated workflow success side effect",
  },
  {
    auditId: "workflow-outcome-contracts",
    scenario: "fail-optimistic-no-rollback",
    label: "Optimistic workflow side effect without rollback",
  },
];

async function runScenario({ auditId, scenario, label }, records) {
  const audit = getAudit(auditId);
  if (!audit) {
    return {
      auditId,
      scenario,
      label,
      passed: false,
      findingsCount: 0,
      message: `Unknown audit "${auditId}".`,
    };
  }

  const record = records.find((candidate) => candidate.engineId === auditId && candidate.scenario === scenario);
  if (!record) {
    return {
      auditId,
      scenario,
      label,
      passed: false,
      findingsCount: 0,
      message: `Unknown canary scenario "${auditId}/${scenario}".`,
    };
  }

  const expected = record.expected ?? {};
  const result = await runAuditFixtureScenario({ audit, record, project: "arkitect-canary" });
  const shouldFail = expected.failed === true;

  return {
    auditId,
    scenario,
    label,
    passed: shouldFail,
    findingsCount: result.findingsCount,
    message: shouldFail ? "Intentional drift was detected." : "Canary scenario expected.json must declare failed=true.",
  };
}

function renderReport(results) {
  const lines = [
    "# Arkitect Canary",
    "",
    "Runs intentional break fixtures and passes only when the Arkitect catches each one.",
    "",
    "| Canary | Audit | Scenario | Status | Findings |",
    "| --- | --- | --- | --- | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.label} | ${result.auditId} | ${result.scenario} | ${
        result.passed ? "Caught" : "Missed"
      } | ${result.findingsCount} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

const records = await loadAuditScenarioRecords();
const results = [];
for (const scenario of CANARY_SCENARIOS) {
  try {
    results.push(await runScenario(scenario, records));
  } catch (error) {
    results.push({
      ...scenario,
      passed: false,
      findingsCount: 0,
      message: error.message,
    });
  }
}

process.stdout.write(renderReport(results));

const missed = results.filter((result) => !result.passed);
if (missed.length > 0) {
  console.error("Arkitect canary missed intentional drift:");
  for (const result of missed) {
    console.error(`- ${result.label}: ${result.message}`);
  }
  process.exitCode = 1;
}
