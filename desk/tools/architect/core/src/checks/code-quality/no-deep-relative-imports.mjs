/**
 * no-deep-relative-imports — connections-arkitect check
 * ======================================================
 * Flags imports that use 3+ "../" segments or cross known
 * package boundaries. These are brittle: moving the importing
 * or imported file breaks the path. Prefer path aliases
 * (@/..., @lunawerx/ui/...) or package self-imports
 * (@saydeploy/architect/...).
 *
 * Rules:
 *   1. deep-relative-import — import uses 3+ "../" segments
 *      These break when either file moves. Use a path alias.
 *
 *   2. cross-boundary-relative-import — import crosses from
 *      one project root into another (e.g. src/ importing
 *      from infra/, or vice versa). These shouldn't exist;
 *      shared code belongs in a shared package or is copied
 *      at build time.
 *
 *   3. parent-relative-import — import reaches above the
 *      nearest project root (e.g. src/components/ importing
 *      from ../../../../ outside src/). Almost always a bug
 *      or a sign that a file is in the wrong directory.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check no-deep-relative-imports
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";
import { normalizePath } from "@saydeploy/architect/core/path";

const RULES = {
  "deep-relative-import": {
    severity: "warn",
    description:
      "Import uses 3+ '../' segments. Prefer a path alias (@/..., @lunawerx/ui/...) or package self-import so the import survives file moves.",
  },
  "cross-boundary-relative-import": {
    severity: "error",
    description:
      "Import crosses a project root boundary (e.g. src/ importing from infra/). Code in separate roots should not depend on each other via relative paths.",
  },
  "parent-relative-import": {
    severity: "error",
    description:
      "Import reaches above the nearest project root. This almost always indicates a file in the wrong directory or a missing shared abstraction.",
  },
};

const IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?|export\s+(?:type\s+)?[^'"]*\s+from\s+|import\s*\(\s*)["']([^"']+)["']/g;

const PROJECT_ROOTS = [
  { root: "src", name: "app" },
  { root: "infra/lambda", name: "lambda" },
  { root: "infra/aws", name: "cdk" },
  { root: "infra/shared", name: "infra-shared" },
  { root: "packages/connections-arkitect", name: "arkitect" },
  { root: "packages/connections-ui", name: "ui-package" },
  { root: "scripts", name: "scripts" },
];

const AVAILABLE_ALIASES = [
  { alias: "@/*", mapsTo: "src/*", description: "App source (Vue, TS, composables, lib)" },
  { alias: "@lunawerx/ui/*", mapsTo: "packages/connections-ui/src/*", description: "Shared UI primitives package" },
  {
    alias: "@saydeploy/architect/...",
    mapsTo: "packages/connections-arkitect",
    description: "Arkitect audit package (self-import)",
  },
  { alias: "@infra-shared/*", mapsTo: "infra/shared/*", description: "Shared infra utilities (oauth, etc.)" },
];

function depthOf(importPath) {
  const segments = importPath.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "..") depth += 1;
    else break;
  }
  return depth;
}

function findProjectRoot(filePath) {
  const normalized = normalizePath(filePath);
  let best = null;
  for (const root of PROJECT_ROOTS) {
    const prefix = `${root.root}/`;
    if (normalized.startsWith(prefix)) {
      if (!best || root.root.length > best.root.length) {
        best = root;
      }
    }
  }
  return best;
}

function resolveImportTarget(importingFile, importPath) {
  if (importPath.startsWith(".")) {
    const dir = path.dirname(importingFile);
    return normalizePath(path.resolve(dir, importPath));
  }
  return null; // package import, not relative
}

function findProjectRootForPath(filePath) {
  return findProjectRoot(filePath);
}

function suggestAlias(importPath, importingFile) {
  const target = resolveImportTarget(importingFile, importPath);
  if (!target) return "";

  for (const { alias, mapsTo, description } of AVAILABLE_ALIASES) {
    const prefix = mapsTo.replace("/*", "/");
    if (target.startsWith(prefix)) {
      const remainder = target.slice(prefix.length);
      const aliasForm = alias.replace("*", remainder);
      return `${aliasForm} (${description})`;
    }
  }

  return "";
}

export function findDeepRelativeImports({ filePath, source }) {
  const findings = [];
  IMPORT_RE.lastIndex = 0;

  for (const match of source.matchAll(IMPORT_RE)) {
    const importPath = match[1];
    if (!importPath.startsWith(".")) continue; // package import — fine
    if (importPath.includes("node_modules")) continue; // dynamic node_modules import — fine

    const depth = depthOf(importPath);
    const importStart = match.index ?? 0;
    const line = source.slice(0, importStart).split("\n").length;
    const statement = match[0].trim();

    // Rule 1: deep relative
    if (depth >= 3) {
      const suggestion = suggestAlias(importPath, filePath);
      const msg = suggestion
        ? `Import uses ${depth} "../" segments. Suggested: ${suggestion}.`
        : `Import uses ${depth} "../" segments. Prefer a path alias.`;

      findings.push(
        createFinding({
          ruleId: "deep-relative-import",
          severity: "warn",
          filePath,
          line,
          message: msg,
          snippet: statement,
          metadata: { depth, importPath, suggestion },
        }),
      );
    }

    // Rule 2+3: cross-boundary and parent-relative (only for 3+ depth — same as deep threshold)
    if (depth >= 3) {
      const target = resolveImportTarget(filePath, importPath);
      if (target) {
        const importingRoot = findProjectRootForPath(filePath);
        const targetRoot = findProjectRootForPath(target);

        // Rule 3: parent-relative — resolved target is above all known roots
        if (!targetRoot) {
          findings.push(
            createFinding({
              ruleId: "parent-relative-import",
              severity: "error",
              filePath,
              line,
              message: `Import resolves to "${target}" which is outside all known project roots. This file may be in the wrong directory.`,
              snippet: statement,
              metadata: { importPath, resolved: target },
            }),
          );
          continue;
        }

        // Rule 2: cross-boundary
        if (importingRoot && targetRoot && importingRoot.name !== targetRoot.name) {
          findings.push(
            createFinding({
              ruleId: "cross-boundary-relative-import",
              severity: "error",
              filePath,
              line,
              message: `Import crosses project boundaries: "${importingRoot.name}" (${importingRoot.root}) → "${targetRoot.name}" (${targetRoot.root}). Shared code should not be imported via relative paths across roots.`,
              snippet: statement,
              metadata: {
                importPath,
                fromRoot: importingRoot.name,
                toRoot: targetRoot.name,
              },
            }),
          );
        }
      }
    }
  }

  return findings;
}

export const DEEP_RELATIVE_IMPORTS_DEFAULTS = {
  roots: ["src", "infra", "packages", "scripts"],
  extensions: [".ts", ".tsx", ".vue", ".mjs", ".js", ".jsx"],
  skipSegments: ["node_modules", "dist", ".git", "tmp", "__tests__", "cdk.out", "coverage"],
  maxDepth: 3,
  outputPath: "tmp/audits/DEEP_RELATIVE_IMPORTS_AUDIT.md",
};

function groupByRule(findings) {
  const grouped = {};
  for (const f of findings) {
    (grouped[f.ruleId] ??= []).push(f);
  }
  return grouped;
}

function renderReport(findings) {
  const grouped = groupByRule(findings);
  const lines = [
    "# Deep Relative Imports Audit",
    "",
    `- Total findings: ${findings.length}`,
    `- Deep relative (3+ "../"): ${(grouped["deep-relative-import"] ?? []).length}`,
    `- Cross-boundary: ${(grouped["cross-boundary-relative-import"] ?? []).length}`,
    `- Parent-relative (above root): ${(grouped["parent-relative-import"] ?? []).length}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No brittle relative imports found.");
    return lines.join("\n");
  }

  lines.push("## Available path aliases");
  lines.push("");
  for (const { alias, mapsTo, description } of AVAILABLE_ALIASES) {
    lines.push(`- \`${alias}\` → \`${mapsTo}\` — ${description}`);
  }
  lines.push("");

  for (const [ruleId, ruleFindings] of Object.entries(grouped)) {
    lines.push(`## ${ruleId} (${ruleFindings.length})`);
    lines.push("");
    for (const f of ruleFindings) {
      lines.push(`- **${f.filePath}:${f.line}** — ${f.message}`);
      lines.push(`  \`${f.snippet}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runDeepRelativeImportsAudit({ root, roots, extensions, skipSegments, maxDepth: _maxDepth }) {
  const allFiles = await walkFiles({ root, roots, extensions, skipSegments });
  const allFindings = [];

  for (const rel of allFiles) {
    const abs = path.resolve(root, rel);
    let source;
    try {
      source = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }

    const findings = findDeepRelativeImports({ filePath: rel, source });
    allFindings.push(...findings);
  }

  allFindings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath));

  return {
    failed: allFindings.some((f) => f.severity === "error"),
    findings: allFindings,
    jsonPayload: { findings: allFindings, rules: RULES },
    report: renderReport(allFindings),
  };
}

export const audit = {
  id: "no-deep-relative-imports",
  title: "No Deep Relative Imports",
  category: "codeRisk",
  defaultConfig: {
    ...DEEP_RELATIVE_IMPORTS_DEFAULTS,
    includeInAll: false,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runDeepRelativeImportsAudit({
      root: context.root,
      roots: cfg.roots,
      extensions: cfg.extensions,
      skipSegments: cfg.skipSegments,
      maxDepth: cfg.maxDepth,
    });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};
