/**
 * SARIF 2.1.0 writer.
 *
 * Borrowed from gadievron/raptor (core/sarif/) and the SARIF 2.1.0 OASIS spec.
 * SARIF is the lingua franca of static analyzers — GitHub Code Scanning,
 * VS Code's SARIF viewer, Sonar, CodeQL, Semgrep, and Snyk all read it. Once
 * the arkitect emits SARIF, its findings are surfaced everywhere those tools
 * already are without writing per-consumer adapters.
 *
 * Shape: ONE sarifLog per audit run (or per check, when the runner is invoked
 * with --format=sarif on a single check). Each check contributes one `run`
 * with its rules under `run.tool.driver.rules` and its findings under
 * `run.results`. This wrapper takes the arkitect's `Finding` shape and a
 * minimal tool descriptor and produces a valid sarifLog object — callers
 * stringify and write.
 */

import { normalizeSeverity } from "./scoring.mjs";

export const SARIF_SCHEMA_URI =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
export const SARIF_VERSION = "2.1.0";

const ARKITECT_TOOL = Object.freeze({
  name: "arkitect",
  semanticVersion: "0.0.0",
  informationUri: "https://github.com/lunarwerx/arkitect",
});

/** Map the arkitect's normalized severity onto a SARIF result.level. */
export function severityToSarifLevel(severity) {
  const s = normalizeSeverity(severity);
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "warning";
  if (s === "low" || s === "info") return "note";
  return "none";
}

/**
 * Build a SARIF 2.1.0 log from a list of `{ check, findings }` entries.
 *
 *   checkResults = [
 *     {
 *       check: { id, title, family, helpUri?, rules?: [{ id, name?, helpUri?, ... }] },
 *       findings: [Finding],
 *     },
 *   ]
 */
export function buildSarifLog(checkResults, { tool = ARKITECT_TOOL } = {}) {
  return {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: (checkResults ?? []).map((entry) => buildSarifRun(entry, tool)),
  };
}

function buildSarifRun({ check, findings }, tool) {
  const rules = collectRules(check, findings ?? []);
  const ruleIndexById = new Map(rules.map((rule, index) => [rule.id, index]));

  return {
    tool: {
      driver: {
        name: tool.name,
        semanticVersion: tool.semanticVersion,
        informationUri: tool.informationUri,
        rules,
        properties: {
          family: check?.family ?? check?.category ?? "",
          checkId: check?.id ?? "",
          checkTitle: check?.title ?? "",
        },
      },
    },
    results: (findings ?? []).map((finding) => buildSarifResult(finding, ruleIndexById)),
  };
}

function collectRules(check, findings) {
  const declared = Array.isArray(check?.rules) ? check.rules : [];
  const seen = new Set(declared.map((rule) => rule.id));
  const out = declared.map((rule) => normalizeRule(rule, check));

  for (const finding of findings) {
    const ruleId = finding?.ruleId ?? check?.id ?? "unknown";
    if (seen.has(ruleId)) continue;
    seen.add(ruleId);
    out.push(
      normalizeRule(
        {
          id: ruleId,
          shortDescription: finding?.message?.slice(0, 80),
        },
        check,
      ),
    );
  }

  return out;
}

function normalizeRule(rule, check) {
  return {
    id: rule.id,
    name: rule.name ?? rule.id,
    shortDescription: { text: rule.shortDescription ?? rule.id },
    fullDescription: rule.fullDescription ? { text: rule.fullDescription } : undefined,
    helpUri: rule.helpUri ?? check?.helpUri ?? undefined,
    properties: rule.properties ?? undefined,
  };
}

function buildSarifResult(finding, ruleIndexById) {
  const ruleId = finding?.ruleId ?? "unknown";
  const result = {
    ruleId,
    ruleIndex: ruleIndexById.has(ruleId) ? ruleIndexById.get(ruleId) : -1,
    level: severityToSarifLevel(finding?.severity),
    message: { text: finding?.message ?? "" },
    locations: finding?.filePath
      ? [
          {
            physicalLocation: {
              artifactLocation: { uri: finding.filePath },
              region: locationRegion(finding),
            },
          },
        ]
      : [],
  };

  const properties = {};
  if (finding?.metadata && typeof finding.metadata === "object") {
    Object.assign(properties, finding.metadata);
  }
  if (finding?.sourceAnchor && typeof finding.sourceAnchor === "object") {
    properties.sourceAnchor = finding.sourceAnchor;
  }
  if (Object.keys(properties).length > 0) {
    result.properties = properties;
  }
  if (finding?.snippet) {
    if (result.locations[0]?.physicalLocation?.region) {
      result.locations[0].physicalLocation.region.snippet = { text: finding.snippet };
    }
  }
  return result;
}

function locationRegion(finding) {
  const startLine = Number(finding?.line ?? 0) || 0;
  if (startLine <= 0) return undefined;
  const endLine = Number(finding?.endLine ?? startLine) || startLine;
  const region = { startLine };
  if (endLine > startLine) region.endLine = endLine;
  if (Number.isFinite(finding?.column) && finding.column > 0) {
    region.startColumn = finding.column;
  }
  return region;
}
