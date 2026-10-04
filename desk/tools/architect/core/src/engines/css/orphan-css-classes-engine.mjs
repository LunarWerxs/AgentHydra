/**
 * orphan-css-classes engine
 * =========================
 * Flags CSS class selectors defined in the route stylesheets that are never
 * applied in any template / component / script — dead selectors left behind
 * when a component is renamed, deleted, or refactored.
 *
 * Why this exists
 * ---------------
 * The /explore/browse filter sidebar silently vanished on desktop because an
 * automated CSS migration left a *dead* class (`discover-command-bar__text-filters`,
 * rendered by nothing) sitting in a live `display:none` rule next to a live
 * structural container that got swept into the same selector list. css-dedupe
 * and public-css-cascade can't catch a class that matches nothing in the DOM,
 * and docs/todo/EXPLORE.md was hand-tracking dead `.discover-*` families. This
 * check automates that hunt so we are never surprised by it again.
 *
 * Scope is deliberately narrow to keep false positives near-zero:
 *   - Only classes under configured `managedPrefixes` (route-owned BEM families,
 *     e.g. `discover-`, `explore-`) are considered. Library / utility / design-
 *     system classes (gc-*, public-*, Tailwind, ms-icon, app-*) are never flagged
 *     because route CSS legitimately targets them as descendants it does not own.
 *   - A class is "used" if its exact token appears anywhere in the usage roots
 *     (.vue / .ts / .html). The managed families are authored as static string
 *     literals (no `\`discover-${x}\`` interpolation exists in the tree), so an
 *     exact match is reliable.
 *   - A rule preceded by `/* audit-orphan-class-ignore: <reason> *\/` is skipped,
 *     mirroring the existing `audit-css-dedupe-ignore` convention.
 *
 * Usage (via check):
 *   bun packages/connections-arkitect/bin/audit.mjs --check orphan-css-classes
 */

import fs from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

const IGNORE_MARKER = /audit-orphan-class-ignore/i;
// Identifier tokens as they appear in templates/scripts (kebab/BEM class names).
const USAGE_TOKEN_RE = /[A-Za-z_][\w-]*/g;
// `.class-name` inside a selector (ignores `.5rem`-style numeric fragments).
const CLASS_IN_SELECTOR_RE = /\.([A-Za-z_-][\w-]*)/g;

async function collectUsedTokens(root, usageRoots, usageExtensions) {
  const used = new Set();
  const files = await walkFiles({ root, roots: usageRoots, extensions: usageExtensions });
  for (const file of files) {
    const content = await fs.readFile(path.resolve(root, file), "utf-8");
    const matches = content.match(USAGE_TOKEN_RE);
    if (matches) {
      for (const token of matches) used.add(token);
    }
  }
  return used;
}

function ruleIsIgnored(rule) {
  const prev = rule.prev();
  return Boolean(prev && prev.type === "comment" && IGNORE_MARKER.test(prev.text));
}

export async function runOrphanCssClassesAudit({ root, styleRoots, usageRoots, usageExtensions, managedPrefixes }) {
  const isManaged = (className) => managedPrefixes.some((prefix) => className.startsWith(prefix));
  const used = await collectUsedTokens(root, usageRoots, usageExtensions);
  const styleFiles = await walkFiles({ root, roots: styleRoots, extensions: [".css"] });

  const findings = [];
  const seen = new Set();

  for (const file of styleFiles) {
    const absolutePath = path.resolve(root, file);
    let cssRoot;
    try {
      cssRoot = postcss.parse(await fs.readFile(absolutePath, "utf-8"), { from: absolutePath });
    } catch {
      // Unparseable stylesheet — leave it to the dedicated CSS parse checks.
      continue;
    }

    cssRoot.walkRules((rule) => {
      if (ruleIsIgnored(rule)) return;

      const managedClasses = new Set();
      for (const selector of rule.selectors ?? []) {
        for (const match of selector.matchAll(CLASS_IN_SELECTOR_RE)) {
          if (isManaged(match[1])) managedClasses.add(match[1]);
        }
      }

      for (const className of managedClasses) {
        if (used.has(className)) continue;
        const key = `${file}::${className}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push(
          createFinding({
            ruleId: "orphan-css-class",
            severity: "warn",
            filePath: file,
            line: rule.source?.start?.line ?? 1,
            message:
              `\`.${className}\` is defined in CSS but never applied in any template, component, or script ` +
              `(dead selector). Delete it, or add \`/* audit-orphan-class-ignore: <reason> */\` directly above ` +
              `the rule if the class is applied dynamically.`,
            snippet: `.${className}`,
            metadata: { className },
          }),
        );
      }
    });
  }

  findings.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line);

  return {
    failed: findings.length > 0,
    findings,
    report: renderReport(findings),
    jsonPayload: {
      findings: findings.map((f) => ({ filePath: f.filePath, line: f.line, className: f.metadata.className })),
    },
  };
}

function renderReport(findings) {
  if (findings.length === 0) {
    return `# Orphan CSS Classes\n\n✅ No dead route-CSS class selectors found.\n`;
  }

  const byFile = new Map();
  for (const finding of findings) {
    if (!byFile.has(finding.filePath)) byFile.set(finding.filePath, []);
    byFile.get(finding.filePath).push(finding);
  }

  const lines = [
    `# Orphan CSS Classes`,
    ``,
    `- **Dead route-CSS class selectors:** ${findings.length} across ${byFile.size} file(s)`,
    ``,
    `Each class below is defined in a route stylesheet but is **never applied** in any`,
    `\`.vue\` / \`.ts\` / \`.html\` source. Dead selectors hide regressions — a since-renamed`,
    `class lingering in a live \`display:none\`/visibility rule is how the /explore/browse`,
    `sidebar once vanished. Remove the selector (drop it from the comma list, or delete the`,
    `whole rule if every selector is dead). If a class is genuinely applied dynamically, add`,
    `\`/* audit-orphan-class-ignore: <reason> */\` directly above the rule.`,
    ``,
  ];

  for (const [file, fileFindings] of [...byFile.entries()].sort()) {
    lines.push(`## ${file}`, ``);
    for (const finding of fileFindings) {
      lines.push(`- \`${finding.snippet}\` — line ${finding.line}`);
    }
    lines.push(``);
  }

  return `${lines.join("\n")}\n`;
}
