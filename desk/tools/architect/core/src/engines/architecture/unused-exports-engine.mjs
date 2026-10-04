/**
 * Unused exports (knip / ts-prune-style).
 *
 * For each file, collects exported symbol names; for each named/default/star
 * import across the project, marks the corresponding export as used. Anything
 * left over is reported, modulo:
 *
 *   - entryPatterns: regex list of "always-used" files (e.g. ^src/main\\.ts$).
 *   - ignoreNames:   regex list of names that are not really exports (e.g. ^[A-Z]
 *                    for components that are auto-discovered).
 *   - ignorePatterns: regex list of files to skip entirely.
 *
 * Star re-exports (`export * from "x"`) propagate "used" from importer to the
 * re-export target — so importing one re-exported name covers the chain.
 */
import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

export const UNUSED_EXPORTS_DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  aliases: {},
  entryPatterns: [],
  ignorePatterns: [],
  ignoreNames: [],
};

function matchesAny(value, matchers) {
  return matchers.some((matcher) => matcher.test(value));
}

function renderReport({ findings, fileCount, exportCount }) {
  const lines = [
    "# Unused Exports",
    "",
    `Scanned ${fileCount} files, ${exportCount} exports.`,
    `Unused: ${findings.length}`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No unused exports.", "");
    return lines.join("\n");
  }
  const byFile = new Map();
  for (const finding of findings) {
    if (!byFile.has(finding.filePath)) byFile.set(finding.filePath, []);
    byFile.get(finding.filePath).push(finding);
  }
  for (const [filePath, list] of byFile) {
    lines.push(`## ${filePath} (${list.length})`, "");
    for (const finding of list) {
      lines.push(`- \`${filePath}:${finding.line}\` — \`${finding.metadata.name}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runUnusedExportsAudit({ root, checkConfig = {} } = {}) {
  const config = { ...UNUSED_EXPORTS_DEFAULTS, ...checkConfig };
  const graph = await buildImportGraph({
    root,
    roots: config.roots,
    extensions: config.extensions,
    aliases: config.aliases,
  });

  const entryMatchers = (config.entryPatterns ?? []).map((pattern) => new RegExp(pattern));
  const ignoreMatchers = (config.ignorePatterns ?? []).map((pattern) => new RegExp(pattern));
  const nameMatchers = (config.ignoreNames ?? []).map((pattern) => new RegExp(pattern));

  const exportsByFile = new Map(); // filePath -> Map<name, line>
  const reExportTargets = new Map(); // filePath -> Set<resolvedTarget>
  let totalExports = 0;

  for (const [filePath, node] of graph.nodes) {
    if (matchesAny(filePath, ignoreMatchers)) continue;
    const map = new Map();
    const targets = new Set();
    for (const exportEntry of node.exports) {
      if (exportEntry.reExportedFrom) {
        targets.add(exportEntry.reExportedFrom);
      }
      if (!exportEntry.name) continue;
      if (!map.has(exportEntry.name)) map.set(exportEntry.name, exportEntry.line);
    }
    if (map.size > 0) exportsByFile.set(filePath, map);
    if (targets.size > 0) reExportTargets.set(filePath, targets);
    totalExports += map.size;
  }

  const usedByFile = new Map(); // filePath -> Set<name>  ("*" means all)
  function markUsed(filePath, name) {
    if (!usedByFile.has(filePath)) usedByFile.set(filePath, new Set());
    usedByFile.get(filePath).add(name);
  }

  for (const [filePath, node] of graph.nodes) {
    for (const entry of node.namedImports) {
      if (!entry.resolved) continue;
      markUsed(entry.resolved, entry.name);
    }
    if (matchesAny(filePath, entryMatchers)) {
      markUsed(filePath, "*");
    }
  }

  for (const filePath of exportsByFile.keys()) {
    const targets = reExportTargets.get(filePath);
    if (!targets) continue;
    const used = usedByFile.get(filePath);
    if (!used) continue;
    if (used.has("*")) {
      for (const target of targets) markUsed(target, "*");
    }
  }

  const findings = [];
  for (const [filePath, exportMap] of exportsByFile) {
    const used = usedByFile.get(filePath) ?? new Set();
    if (used.has("*")) continue;
    for (const [name, line] of exportMap) {
      if (used.has(name)) continue;
      if (matchesAny(name, nameMatchers)) continue;
      findings.push(
        createFinding({
          ruleId: "unused-export",
          severity: "warn",
          filePath,
          line,
          message: `Unused export: \`${name}\``,
          metadata: { baselineKey: `${filePath}:${name}`, name },
        }),
      );
    }
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      fileCount: graph.files.length,
      exportCount: totalExports,
      unusedCount: findings.length,
      findings,
    },
    report: renderReport({ findings, fileCount: graph.files.length, exportCount: totalExports }),
  };
}
