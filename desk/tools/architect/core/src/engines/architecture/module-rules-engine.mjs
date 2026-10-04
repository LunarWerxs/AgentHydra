/**
 * Module-level graph rules (vs dep-rules, which are edge-level).
 *
 * Two rule kinds, both built on the existing import graph:
 *
 *   - "dependents": count how many modules depend ON a module matching `module`,
 *     and flag when that count is below/above a threshold. Answers "is this
 *     `src/components/shared` primitive ACTUALLY shared, or single-use and
 *     misfiled?" (`numberOfDependentsLessThan`) and "is this a god-module
 *     everything couples to?" (`numberOfDependentsMoreThan`).
 *
 *   - "reachable": whether any module matching `to` is reachable (transitively)
 *     from a module matching `from`. Catches boundary violations hidden behind
 *     a shared util that file-level forbidden-edge rules miss — e.g. "a Lambda
 *     handler must not even TRANSITIVELY reach a browser-only module". Ships the
 *     `A → B → C` path as evidence. `reachable:false` (default) = must-not-reach;
 *     `reachable:true` = must-reach (a transitive `required`).
 *
 * Reachability follows runtime edges only (type-only `import type` edges are
 * excluded by default, like cycles), and a target matches either an internal
 * file path OR an external package specifier (`maplibre-gl`, `@ionic/*`).
 *
 * Policy schema:
 *   {
 *     "roots": ["src", "infra/lambda/src"],
 *     "skipImporterPatterns": ["\\.spec\\."],
 *     "rules": [
 *       { "name":"shared-must-be-shared", "kind":"dependents", "severity":"warn",
 *         "module": { "path":"^src/components/shared/", "pathNot":"index\\.ts$" },
 *         "numberOfDependentsLessThan": 2 },
 *       { "name":"lambda-no-browser-deps", "kind":"reachable", "severity":"error",
 *         "from": { "path":"^infra/lambda/" },
 *         "to":   { "path":"maplibre-gl|@ionic/|^src/" }, "reachable": false }
 *     ]
 *   }
 */
import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

export const MODULE_RULES_DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  // Importers matched here don't count toward a module's dependents — a
  // component used only by its own spec is single-use, not shared.
  skipImporterPatterns: ["\\.spec\\.", "\\.test\\.", "__tests__/", "/test/"],
  rules: [],
};

function compileMatcher({ path: pathRe, pathNot } = {}) {
  const include = pathRe ? new RegExp(pathRe) : null;
  const exclude = pathNot ? new RegExp(pathNot) : null;
  return (value) => {
    if (value == null) return false;
    if (include && !include.test(value)) return false;
    if (exclude && exclude.test(value)) return false;
    return true;
  };
}

function buildIndexes(graph, skipMatchers) {
  const adjacency = new Map(); // file -> Set(internal value-edge neighbors)
  const externals = new Map(); // file -> [specifier]
  const dependents = new Map(); // file -> Set(importer files), excluding skipped importers

  for (const [filePath, node] of graph.nodes) {
    const neighbors = new Set();
    const ext = [];
    const skipImporter = skipMatchers.some((m) => m.test(filePath));
    for (const edge of node.imports) {
      if (edge.external) {
        ext.push(edge.specifier);
        continue;
      }
      if (!edge.resolved || !graph.nodes.has(edge.resolved) || edge.resolved === filePath) continue;
      // Type-only edges are erased at runtime — exclude from reachability.
      if (edge.importKind !== "type") neighbors.add(edge.resolved);
      // Dependents counts any real import (value or type), minus skipped importers.
      if (!skipImporter) {
        if (!dependents.has(edge.resolved)) dependents.set(edge.resolved, new Set());
        dependents.get(edge.resolved).add(filePath);
      }
    }
    adjacency.set(filePath, neighbors);
    externals.set(filePath, ext);
  }
  return { adjacency, externals, dependents };
}

// Shortest path (BFS) from `start` to the first reachable module that matches
// `toMatch` — either an internal file path or an external specifier. Returns the
// path as `["start", …, "hit"]` (with the external specifier appended when the
// hit is a bare import), or null if `to` is unreachable.
function shortestReachPath(start, adjacency, externals, toMatch) {
  const parent = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current !== start && toMatch(current)) return reconstruct(parent, current);
    for (const specifier of externals.get(current) ?? []) {
      if (toMatch(specifier)) return [...reconstruct(parent, current), specifier];
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

function reconstruct(parent, node) {
  const path = [];
  let cursor = node;
  while (cursor != null) {
    path.unshift(cursor);
    cursor = parent.get(cursor);
  }
  return path;
}

function evaluateDependents(rule, graph, dependents, findings) {
  const matchModule = compileMatcher(rule.module ?? {});
  const lessThan = rule.numberOfDependentsLessThan;
  const moreThan = rule.numberOfDependentsMoreThan;
  for (const filePath of graph.nodes.keys()) {
    if (!matchModule(filePath)) continue;
    const count = dependents.get(filePath)?.size ?? 0;
    let reason = null;
    if (typeof lessThan === "number" && count < lessThan) reason = `${count} dependents (< ${lessThan})`;
    else if (typeof moreThan === "number" && count > moreThan) reason = `${count} dependents (> ${moreThan})`;
    if (!reason) continue;
    findings.push(
      createFinding({
        // Dependents-count is inherently fuzzy (a single-use child is fine;
        // 0-dependents overlaps dead-code), so it defaults to advisory `info`
        // and never gates. A policy can opt a specific rule up to error/warn.
        ruleId: `module-rule:${rule.name}`,
        severity: rule.severity ?? "info",
        filePath,
        line: 0,
        message: `${rule.name}: ${filePath} has ${reason}${rule.comment ? ` — ${rule.comment}` : ""}`,
        metadata: { ruleName: rule.name, kind: "dependents", count, baselineKey: `${rule.name}:${filePath}` },
      }),
    );
  }
}

function evaluateReachable(rule, graph, adjacency, externals, findings, skipMatchers) {
  const matchFrom = compileMatcher(rule.from ?? {});
  const matchTo = compileMatcher(rule.to ?? {});
  const mustReach = rule.reachable === true;
  for (const filePath of graph.nodes.keys()) {
    if (!matchFrom(filePath)) continue;
    // Test files are not runtime — a parity/alignment spec that reaches across a
    // boundary is intentional, so they never source a reachability violation.
    if (skipMatchers.some((m) => m.test(filePath))) continue;
    const path = shortestReachPath(filePath, adjacency, externals, matchTo);
    if (mustReach) {
      if (path) continue; // required reachability satisfied
      findings.push(
        createFinding({
          ruleId: `module-rule:${rule.name}`,
          severity: rule.severity ?? "error",
          filePath,
          line: 0,
          message: `${rule.name}: ${filePath} must reach a module matching the policy but does not${rule.comment ? ` — ${rule.comment}` : ""}`,
          metadata: { ruleName: rule.name, kind: "reachable", baselineKey: `${rule.name}:${filePath}` },
        }),
      );
    } else if (path) {
      findings.push(
        createFinding({
          ruleId: `module-rule:${rule.name}`,
          severity: rule.severity ?? "error",
          filePath,
          line: 0,
          message: `${rule.name}: ${filePath} must not reach \`${path[path.length - 1]}\` — via ${path.join(" → ")}${rule.comment ? ` (${rule.comment})` : ""}`,
          metadata: { ruleName: rule.name, kind: "reachable", via: path, baselineKey: `${rule.name}:${filePath}` },
        }),
      );
    }
  }
}

export async function runModuleRulesAudit({ root, checkConfig = {} } = {}) {
  const config = { ...MODULE_RULES_DEFAULTS, ...checkConfig };
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const skipMatchers = (config.skipImporterPatterns ?? []).map((pattern) => new RegExp(pattern));

  const graph = await buildImportGraph({ root, roots: config.roots, extensions: config.extensions });
  const { adjacency, externals, dependents } = buildIndexes(graph, skipMatchers);

  const findings = [];
  for (const rule of rules) {
    if (rule.kind === "dependents") evaluateDependents(rule, graph, dependents, findings);
    else if (rule.kind === "reachable") evaluateReachable(rule, graph, adjacency, externals, findings, skipMatchers);
  }
  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath));

  return {
    findings,
    jsonPayload: { fileCount: graph.files.length, ruleCount: rules.length, violationCount: findings.length, findings },
    report: renderReport(findings, graph.files.length, rules.length),
    baselineDocument: {
      version: 1,
      generatedAt: new Date().toISOString(),
      keys: findings.map((finding) => finding.metadata.baselineKey).filter(Boolean),
    },
  };
}

function renderReport(findings, fileCount, ruleCount) {
  // Only error/warn findings gate; `info` (dependents advisory) is excluded
  // from the counts the strict-gate summarizer parses.
  const gating = findings.filter((f) => f.severity === "error" || f.severity === "warn");
  const advisory = findings.filter((f) => f.severity === "info");
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  const lines = [
    "# Module Rules",
    "",
    `Scanned ${fileCount} files against ${ruleCount} module rules.`,
    "",
    `Errors: ${errors}`,
    `Warnings: ${warnings}`,
    "",
  ];

  if (gating.length > 0) {
    renderByRule(lines, gating, "## Violations — fail the gate", 100);
  } else {
    lines.push("No gating module-rule violations.", "");
  }
  if (advisory.length > 0) {
    lines.push(`## Advisory — ${advisory.length} (does not gate)`, "");
    renderByRule(lines, advisory, null, 60);
  }
  return `${lines.join("\n")}\n`;
}

function renderByRule(lines, findings, heading, cap) {
  if (heading) lines.push(heading, "");
  const byRule = new Map();
  for (const finding of findings) {
    if (!byRule.has(finding.metadata.ruleName)) byRule.set(finding.metadata.ruleName, []);
    byRule.get(finding.metadata.ruleName).push(finding);
  }
  for (const [ruleName, list] of byRule) {
    lines.push(`### ${ruleName} — ${list.length} (${list[0].severity})`, "");
    for (const finding of list.slice(0, cap)) lines.push(`- ${finding.message}`);
    if (list.length > cap) lines.push(`- …and ${list.length - cap} more`);
    lines.push("");
  }
}
