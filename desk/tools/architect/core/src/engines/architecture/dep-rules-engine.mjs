/**
 * Dependency-cruiser-style forbidden/allowed import rules.
 *
 * Policy schema (codebase-agnostic):
 *
 *   {
 *     "roots": ["src", "packages/foo/src"],
 *     "extensions": [".ts", ".tsx", ".vue"],
 *     "aliases": { "@/": "src/" },
 *     "rules": [
 *       {
 *         "name": "no-test-from-src",
 *         "severity": "error",
 *         "comment": "Production code must not import from test/",
 *         "from": { "path": "^src/", "pathNot": "\\.spec\\." },
 *         "to":   { "path": "^src/__tests__/" },
 *         "dependencyTypes": ["local"]
 *       }
 *     ]
 *   }
 *
 * `from.path`/`from.pathNot` and `to.path`/`to.pathNot` are regex. `dependencyTypes`
 * filters edges by kind: "local" (resolved relative/alias edges) or "external"
 * (bare specifiers that did not resolve to a file in `roots`).
 */
import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

export const DEP_RULES_DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  aliases: {},
  rules: [],
};

function compileMatcher({ path: pathRe, pathNot } = {}) {
  const include = pathRe ? new RegExp(pathRe) : null;
  const exclude = pathNot ? new RegExp(pathNot) : null;
  return (value) => {
    if (include && !include.test(value)) return false;
    if (exclude && exclude.test(value)) return false;
    return true;
  };
}

function compileRule(rawRule) {
  const severity = rawRule.severity ?? "error";
  const dependencyTypes = new Set(rawRule.dependencyTypes ?? ["local"]);
  const fromMatcher = compileMatcher(rawRule.from ?? {});
  const toMatcher = compileMatcher(rawRule.to ?? {});
  return {
    name: rawRule.name ?? "dep-rule",
    severity,
    comment: rawRule.comment ?? "",
    dependencyTypes,
    matches(fromPath, toPath, edge) {
      if (!fromMatcher(fromPath)) return false;
      if (edge.external) {
        if (!dependencyTypes.has("external")) return false;
        return toMatcher(edge.specifier);
      }
      if (!dependencyTypes.has("local")) return false;
      if (!toPath) return false;
      return toMatcher(toPath);
    },
  };
}

function renderReport({ findings, fileCount, ruleCount }) {
  const lines = ["# Dependency Rules", "", `Scanned ${fileCount} files against ${ruleCount} rules.`, ""];
  if (findings.length === 0) {
    lines.push("No dependency-rule violations.", "");
    return lines.join("\n");
  }
  const byRule = new Map();
  for (const finding of findings) {
    const key = finding.metadata.ruleName;
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(finding);
  }
  for (const [ruleName, list] of byRule) {
    const first = list[0];
    lines.push(`## ${ruleName} — ${list.length} (${first.severity})`, "");
    if (first.metadata.comment) lines.push(`_${first.metadata.comment}_`, "");
    for (const finding of list.slice(0, 80)) {
      lines.push(`- \`${finding.filePath}:${finding.line}\` imports \`${finding.metadata.target}\``);
    }
    if (list.length > 80) lines.push(`- …and ${list.length - 80} more`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function runDepRulesAudit({ root, checkConfig = {} } = {}) {
  const config = { ...DEP_RULES_DEFAULTS, ...checkConfig };
  const rawRules = Array.isArray(config.rules) ? config.rules : [];
  const compiled = rawRules.map(compileRule);

  const graph = await buildImportGraph({
    root,
    roots: config.roots,
    extensions: config.extensions,
    aliases: config.aliases,
  });

  const findings = [];
  for (const [filePath, node] of graph.nodes) {
    for (const edge of node.imports) {
      for (const rule of compiled) {
        if (!rule.matches(filePath, edge.resolved, edge)) continue;
        findings.push(
          createFinding({
            ruleId: `dep-rule:${rule.name}`,
            severity: rule.severity,
            filePath,
            line: edge.line,
            message: `${rule.name}: imports \`${edge.specifier}\`${rule.comment ? ` — ${rule.comment}` : ""}`,
            metadata: {
              ruleName: rule.name,
              comment: rule.comment,
              target: edge.resolved ?? edge.specifier,
              external: edge.external,
            },
          }),
        );
      }
    }
  }

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line);

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      fileCount: graph.files.length,
      ruleCount: compiled.length,
      violationCount: findings.length,
      findings,
    },
    report: renderReport({ findings, fileCount: graph.files.length, ruleCount: compiled.length }),
  };
}
