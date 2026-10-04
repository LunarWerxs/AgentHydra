import { scanForUiAntipatterns } from "@saydeploy/architect/engines/shared/ui-antipatterns-engine";

export const audit = {
  id: "ui-antipatterns",
  title: "UI Anti-Patterns (Impeccable Ruleset)",
  category: "designSystem",
  defaultConfig: {
    enabled: true,
    includeInAll: false,
    roots: ["src"],
    extensions: [".html", ".vue", ".tsx", ".jsx", ".svelte", ".astro", ".css", ".scss"],
    allowlist: {},
    outputPath: "tmp/audits/UI_ANTIPATTERNS_AUDIT.md",
    failOnCategories: [],
  },
  async run(context) {
    const config = context.checkConfig;
    const { findings, scannedFiles, totalFiles, findingsByRule, ruleCatalog } = await scanForUiAntipatterns({
      root: context.root,
      roots: config.roots,
      extensions: config.extensions,
      allowlist: config.allowlist,
      skipSegments: config.skipSegments,
    });

    // `failOnCategories: []` means warn-only — surface findings but exit clean.
    // Set to `["slop"]` or `["slop","quality"]` to make CI fail on regressions.
    const failingCategories = new Set(config.failOnCategories ?? []);
    const failingFindings = failingCategories.size
      ? findings.filter((finding) => {
          const rule = ruleCatalog.find((entry) => entry.id === finding.antipattern);
          return rule && failingCategories.has(rule.category);
        })
      : [];

    const ruleSummary = [...findingsByRule.entries()]
      .map(([id, list]) => {
        const rule = ruleCatalog.find((entry) => entry.id === id);
        return {
          id,
          name: rule?.name ?? id,
          category: rule?.category ?? "unknown",
          count: list.length,
        };
      })
      .sort((left, right) => right.count - left.count);

    const report = renderMarkdown({
      scannedFiles,
      totalFiles,
      findings,
      ruleSummary,
      failingFindings,
      ruleCatalog,
    });

    return {
      failed: failingFindings.length > 0,
      jsonPayload: {
        scannedFiles,
        totalFiles,
        totalFindings: findings.length,
        failingFindings: failingFindings.length,
        ruleSummary,
        findings,
      },
      outputPath: config.outputPath,
      report,
    };
  },
};

function renderMarkdown({ scannedFiles, totalFiles, findings, ruleSummary, failingFindings, ruleCatalog }) {
  const lines = [
    "# UI Anti-Patterns Audit",
    "",
    "Source-file regex scan against the codebase-agnostic anti-pattern catalog harvested from",
    "[impeccable](https://github.com/pbakaus/impeccable). Twenty-nine rules cover the most",
    "reliable AI-generated UI tells (side-tab borders, overused fonts, gradient text, AI palettes,",
    "nested cards, bounce easing, dark glows, icon-tile stacks, …) plus WCAG-class quality issues.",
    "",
    `- Files scanned: ${scannedFiles} / ${totalFiles}`,
    `- Findings: ${findings.length}`,
    `- Failing findings: ${failingFindings.length}`,
    `- Rule catalog size: ${ruleCatalog.length}`,
    "",
  ];

  if (ruleSummary.length === 0) {
    lines.push("No anti-patterns detected.", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Rule summary", "", "| Count | Category | Rule | ID |", "| ---: | --- | --- | --- |");
  for (const entry of ruleSummary) {
    lines.push(`| ${entry.count} | ${entry.category} | ${entry.name} | \`${entry.id}\` |`);
  }
  lines.push("");

  const grouped = new Map();
  for (const finding of findings) {
    const bucket = grouped.get(finding.antipattern) ?? [];
    bucket.push(finding);
    grouped.set(finding.antipattern, bucket);
  }

  lines.push("## Findings", "");
  for (const [id, list] of grouped) {
    const rule = ruleCatalog.find((entry) => entry.id === id);
    lines.push(`### ${rule?.name ?? id} (\`${id}\`)`, "");
    if (rule?.description) {
      lines.push(rule.description, "");
    }
    for (const finding of list.slice(0, 40)) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- \`${location}\` — ${finding.snippet}`);
    }
    if (list.length > 40) {
      lines.push(`- … ${list.length - 40} more occurrences`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
