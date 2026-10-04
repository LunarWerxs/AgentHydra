import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTERNAL_LEGACY_ENGINE_IDS = new Set([
  "compute-platform-tier",
  "endpoint-contracts",
  "lambda-contracts",
  "migration-ledger",
  "webhook-delivery",
]);

export function resolveDefaultFixtureRoot() {
  return path.resolve(__dirname, "../../test/fixtures");
}

export function resolveDefaultScenarioManifestPath(fixtureRoot = resolveDefaultFixtureRoot()) {
  return path.resolve(fixtureRoot, "scenarios.generated.mjs");
}

export async function loadAuditScenarioRecords({ fixtureRoot, scenarioManifestPath } = {}) {
  const manifestPath = scenarioManifestPath ?? resolveDefaultScenarioManifestPath(fixtureRoot);
  const module = await import(pathToFileURL(manifestPath).href);
  const records = module.default;
  if (!Array.isArray(records)) {
    throw new Error(`Scenario manifest must export an array: ${manifestPath}`);
  }
  return records;
}

export async function runAuditFixtureScenarios({ audits, fixtureRoot, getAudit }) {
  const records = await loadAuditScenarioRecords({ fixtureRoot });
  const results = [];
  const coveredEngines = new Set();

  for (const record of records) {
    const engineId = String(record.engineId ?? "");
    const scenarioName = String(record.scenario ?? "");
    const audit = getAudit(engineId);
    if (!audit) {
      if (EXTERNAL_LEGACY_ENGINE_IDS.has(engineId)) {
        results.push({
          status: "skip",
          engineId,
          scenario: scenarioName || "(scenario)",
          message: `Engine moved outside Arkitect; legacy fixture retained for reference.`,
        });
        continue;
      }
      results.push({
        status: "error",
        engineId,
        scenario: scenarioName || "(scenario)",
        message: `Unknown engine id "${engineId}"`,
      });
      continue;
    }
    coveredEngines.add(engineId);

    try {
      const result = await runAuditFixtureScenario({ audit, record });
      results.push({ status: "pass", engineId, scenario: scenarioName, ...result });
    } catch (error) {
      results.push({
        status: "fail",
        engineId,
        scenario: scenarioName,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  const uncoveredEngines = audits.map((audit) => audit.id).filter((id) => !coveredEngines.has(id));

  return {
    results,
    uncoveredEngines,
  };
}

export function hasFixtureFailures(results) {
  return results.some((result) => result.status !== "pass" && result.status !== "skip");
}

export function printFixtureSummary(results, uncoveredEngines, auditCount) {
  const passes = results.filter((result) => result.status === "pass");
  const skips = results.filter((result) => result.status === "skip");
  const failures = results.filter((result) => result.status !== "pass" && result.status !== "skip");
  const coveredEngineCount = new Set(results.map((result) => result.engineId)).size;
  const totalEngineCount = auditCount ?? coveredEngineCount + uncoveredEngines.length;

  console.log("connections-arkitect-test");
  console.log("");
  console.log(`Scenarios: ${results.length} (${passes.length} pass, ${skips.length} skip, ${failures.length} fail)`);
  console.log(`Engines covered: ${coveredEngineCount}/${totalEngineCount}`);
  console.log("");

  if (failures.length > 0) {
    console.log("Failures:");
    for (const failure of failures) {
      console.log(`  ✗ ${failure.engineId}/${failure.scenario}`);
      console.log(`    - ${failure.message}`);
    }
    console.log("");
  }

  if (skips.length > 0) {
    console.log("Skips:");
    for (const skip of skips) {
      console.log(`  - ${skip.engineId}/${skip.scenario}: ${skip.message}`);
    }
    console.log("");
  }

  if (passes.length > 0) {
    console.log("Passes:");
    for (const pass of passes) {
      console.log(`  ✓ ${pass.engineId}/${pass.scenario} (${pass.findingsCount} findings)`);
    }
    console.log("");
  }

  if (uncoveredEngines.length > 0) {
    console.log(`Uncovered engines (no fixture yet): ${uncoveredEngines.length}`);
    for (const id of uncoveredEngines) {
      console.log(`  - ${id}`);
    }
  }
}

export async function runAuditFixtureScenario({ audit, record, project = "fixture" }) {
  const expected = record.expected;
  validateExpectation(expected);

  const scenarioDir = await materializeScenario(record);
  const filesDir = path.join(scenarioDir, "files");
  const checkConfig = {
    ...(audit.defaultConfig ?? {}),
    ...(record.config ?? {}),
  };

  try {
    const result = await audit.run({
      root: filesDir,
      checkArgs: [],
      options: { format: "text" },
      config: { project, checks: { [audit.id]: checkConfig } },
      checkConfig,
    });

    return assertResult(expected, result, audit.id);
  } finally {
    await fs.rm(scenarioDir, { recursive: true, force: true });
  }
}

async function materializeScenario(record) {
  const scenarioDir = await fs.mkdtemp(path.join(os.tmpdir(), "connections-arkitect-scenario-"));
  const filesDir = path.join(scenarioDir, "files");
  await fs.mkdir(filesDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(record.files ?? {})) {
    const normalizedPath = normalizePath(relativePath);
    if (!normalizedPath || normalizedPath.startsWith("../") || path.isAbsolute(normalizedPath)) {
      throw new Error(`Invalid scenario file path: ${relativePath}`);
    }

    const filePath = path.join(filesDir, normalizedPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(content), "utf8");
  }

  return scenarioDir;
}

function validateExpectation(expected) {
  if (typeof expected !== "object" || expected === null) {
    throw new Error("expected.json must be an object");
  }
  const hasAssertion =
    typeof expected.failed === "boolean" ||
    Array.isArray(expected.expectFindings) ||
    Array.isArray(expected.forbidFindings) ||
    (expected.ruleCounts && typeof expected.ruleCounts === "object") ||
    Array.isArray(expected.expectPayloadIncludes);
  if (!hasAssertion) {
    throw new Error(
      "expected.json must include at least one of: failed, expectFindings, forbidFindings, ruleCounts, expectPayloadIncludes",
    );
  }
}

function assertResult(expected, result, engineId) {
  const errors = [];

  if (typeof expected.failed === "boolean") {
    if (typeof result.failed !== "boolean") {
      errors.push("engine did not return a boolean `failed` field");
    } else if (result.failed !== expected.failed) {
      errors.push(`failed mismatch: expected ${expected.failed}, got ${result.failed}`);
    }
  }

  const findings = extractFindings(result, engineId);

  if (Array.isArray(expected.expectFindings)) {
    for (const want of expected.expectFindings) {
      const matched = findings.some(
        (finding) => finding.ruleId === want.ruleId && normalizePath(finding.filePath) === normalizePath(want.filePath),
      );
      if (!matched) {
        errors.push(
          `expected finding not present: ruleId=${want.ruleId} filePath=${want.filePath}` +
            ` (got ${findings.length} findings: ${summarizeFindings(findings)})`,
        );
      }
    }
  }

  if (Array.isArray(expected.forbidFindings)) {
    for (const forbid of expected.forbidFindings) {
      const matched = findings.find(
        (finding) =>
          finding.ruleId === forbid.ruleId && normalizePath(finding.filePath) === normalizePath(forbid.filePath),
      );
      if (matched) {
        errors.push(`forbidden finding present: ruleId=${forbid.ruleId} filePath=${forbid.filePath}`);
      }
    }
  }

  if (expected.ruleCounts) {
    for (const [ruleId, count] of Object.entries(expected.ruleCounts)) {
      const actual = findings.filter((finding) => finding.ruleId === ruleId).length;
      if (actual !== count) {
        errors.push(`ruleCount mismatch for ${ruleId}: expected ${count}, got ${actual}`);
      }
    }
  }

  if (Array.isArray(expected.expectPayloadIncludes)) {
    for (const want of expected.expectPayloadIncludes) {
      const target = readPayloadPath(result.jsonPayload, want.path);
      const matched = Array.isArray(target)
        ? target.some((item) => payloadValueEquals(item, want.value))
        : payloadValueEquals(target, want.value);
      if (!matched) {
        errors.push(
          `expected payload include not present: path=${JSON.stringify(want.path)} value=${JSON.stringify(want.value)}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n  - "));
  }

  return { findingsCount: findings.length };
}

function readPayloadPath(payload, pathSegments) {
  if (!Array.isArray(pathSegments)) {
    return undefined;
  }

  let current = payload;
  for (const segment of pathSegments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function payloadValueEquals(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function extractFindings(result, engineId) {
  const sources = [];
  if (Array.isArray(result.findings)) sources.push(...result.findings);
  const payload = result.jsonPayload ?? {};
  for (const key of ["findings", "bugs", "fileBugs", "splitFailures", "regressions"]) {
    if (Array.isArray(payload[key]) && payload[key] !== result.findings) {
      sources.push(...payload[key]);
    }
  }
  return sources.map((finding) => ({
    ruleId: finding.ruleId ?? finding.rule ?? engineId,
    filePath: finding.filePath ?? finding.file ?? "",
  }));
}

function normalizePath(filePath) {
  return String(filePath ?? "").replaceAll("\\", "/");
}

function summarizeFindings(findings) {
  if (findings.length === 0) return "none";
  return (
    findings
      .slice(0, 5)
      .map((finding) => `${finding.ruleId}@${normalizePath(finding.filePath)}`)
      .join(", ") + (findings.length > 5 ? `, +${findings.length - 5} more` : "")
  );
}
