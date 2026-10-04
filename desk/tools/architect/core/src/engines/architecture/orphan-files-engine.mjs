/**
 * Orphan files (unimported-style reachability).
 *
 * BFS from `entryPatterns` over resolved imports; any file in `roots` not
 * visited is flagged as unreachable. Use `ignorePatterns` to exclude files
 * that are loaded by mechanisms the static analyzer can't see (test runners,
 * dynamic require, build-time discovery).
 *
 * Policy:
 *   {
 *     "roots": ["src"],
 *     "extensions": [".ts", ".tsx", ".vue"],
 *     "aliases": { "@/": "src/" },
 *     "entryPatterns": ["^src/main\\.ts$", "^src/router\\.ts$"],
 *     "ignorePatterns": ["\\.spec\\.", "__tests__/", "\\.d\\.ts$"]
 *   }
 */
import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

export const ORPHAN_FILES_DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  aliases: {},
  entryPatterns: [],
  ignorePatterns: [],
};

function matchesAny(value, matchers) {
  return matchers.some((matcher) => matcher.test(value));
}

function renderReport({ findings, fileCount, entryCount }) {
  const lines = [
    "# Orphan Files",
    "",
    `Scanned ${fileCount} files from ${entryCount} entry points.`,
    `Orphans: ${findings.length}`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No orphan files.", "");
    return lines.join("\n");
  }
  for (const finding of findings) {
    lines.push(`- \`${finding.filePath}\``);
  }
  lines.push("");
  return lines.join("\n");
}

export async function runOrphanFilesAudit({ root, checkConfig = {} } = {}) {
  const config = { ...ORPHAN_FILES_DEFAULTS, ...checkConfig };
  const graph = await buildImportGraph({
    root,
    roots: config.roots,
    extensions: config.extensions,
    aliases: config.aliases,
  });

  const entryMatchers = (config.entryPatterns ?? []).map((pattern) => new RegExp(pattern));
  const ignoreMatchers = (config.ignorePatterns ?? []).map((pattern) => new RegExp(pattern));

  const entries = graph.files.filter((filePath) => matchesAny(filePath, entryMatchers));
  const reachable = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    const node = graph.nodes.get(current);
    if (!node) continue;
    for (const edge of node.imports) {
      if (!edge.resolved) continue;
      if (!graph.nodes.has(edge.resolved)) continue;
      if (reachable.has(edge.resolved)) continue;
      queue.push(edge.resolved);
    }
  }

  const findings = [];
  for (const filePath of graph.files) {
    if (reachable.has(filePath)) continue;
    if (matchesAny(filePath, ignoreMatchers)) continue;
    findings.push(
      createFinding({
        ruleId: "orphan-file",
        severity: "warn",
        filePath,
        line: 0,
        message: `Unreachable from entry points`,
        metadata: { baselineKey: filePath },
      }),
    );
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      fileCount: graph.files.length,
      entryCount: entries.length,
      orphanCount: findings.length,
      findings,
    },
    report: renderReport({ findings, fileCount: graph.files.length, entryCount: entries.length }),
  };
}
