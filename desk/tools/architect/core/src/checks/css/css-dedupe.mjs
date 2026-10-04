import { parseCssDedupeArgs, renderCssDedupeHelp, runCssDedupeAudit } from "@saydeploy/architect/engines/css/css-dedupe-engine";

export const audit = {
  id: "css-dedupe",
  title: "CSS Dedupe",
  category: "maintainability",
  defaultConfig: {
    includeInAll: false,
    roots: ["src"],
    tokenFile: "src/styles/core/tokens.css",
    extensions: [".vue", ".css", ".scss"],
    excludedPaths: ["src/app/app-config.ts", "src/lib/profile/builder-theme.ts", "infra/lambda", "src/__tests__"],
    ignoreFilenameSuffixes: [".spec.ts", ".test.ts", ".d.ts"],
    thresholdHot: 10,
    hotReviewThreshold: 50,
    hotTargetThreshold: 20,
    thresholdSet: 3,
    thresholdSetSize: 2,
    jaccard: 0.75,
    outputPath: "tmp/audits/CSS_DEDUPE_AUDIT.md",
    jsonOutputPath: "tmp/audits/CSS_DEDUPE_AUDIT.json",
  },
  async run(context) {
    const parsedArgs = parseCssDedupeArgs(context.checkArgs);
    const flags = {
      includeAll: false,
      thresholdHot: context.checkConfig.thresholdHot,
      hotReviewThreshold: context.checkConfig.hotReviewThreshold,
      hotTargetThreshold: context.checkConfig.hotTargetThreshold,
      thresholdSet: context.checkConfig.thresholdSet,
      thresholdSetSize: context.checkConfig.thresholdSetSize,
      jaccard: context.checkConfig.jaccard,
      section: null,
      ...parsedArgs,
      json: context.options.format === "json" || parsedArgs.json,
      failOnDrift: context.options.failOnDrift || parsedArgs.failOnDrift,
    };

    if (flags.help) {
      return {
        failed: false,
        jsonPayload: { help: renderCssDedupeHelp() },
        report: `${renderCssDedupeHelp()}\n`,
      };
    }

    const result = await runCssDedupeAudit({
      excludedPaths: context.checkConfig.excludedPaths,
      extensions: context.checkConfig.extensions,
      flags,
      ignoreFilenameSuffixes: context.checkConfig.ignoreFilenameSuffixes,
      jsonOutputPath: context.checkConfig.jsonOutputPath,
      reportOutputPath: context.checkConfig.outputPath,
      root: context.root,
      sourceRoots: context.checkConfig.roots,
      tokensCssPath: context.checkConfig.tokenFile,
    });

    // The audit is intentionally advisory for hot declarations and shared-base
    // discovery; those categories always have content in a moderately-sized
    // codebase. Strict/larger-suite runs should stay quiet unless something is
    // truly actionable. The explicit css-dedupe command still prints the full
    // discovery dashboard so we can learn from it when we ask for it.
    const hasActionableSections = hasActionableCssDedupeContent(result);
    const stripAdvisorySections = !hasActionableSections && context.options.failOnDrift;
    const jsonPayload = stripAdvisorySections
      ? stripAdvisorySectionsFromPayload(result.jsonPayload)
      : result.jsonPayload;
    const report = stripAdvisorySections
      ? renderNoActionableCssDedupeReport(result.jsonPayload?.stats)
      : result.markdownReport;

    return {
      failed: result.failed,
      jsonPayload,
      outputPath: flags.json ? context.checkConfig.jsonOutputPath : context.checkConfig.outputPath,
      report: flags.json ? JSON.stringify(jsonPayload, null, 2) : report,
    };
  },
};

function hasActionableCssDedupeContent(result) {
  if (result.failed) return true;
  const sections = result.sections ?? {};
  // The audit splits its findings into "must-fix" (color drift, byte-identical
  // duplicate rules, identical declaration sets) and "advisory" (hot
  // declarations, near-duplicates, shared-base subsets, local consolidation
  // candidates). Per AUDIT_GUIDE the advisory categories are present in any
  // healthy codebase as a discovery dashboard, not a fix queue. The on-disk
  // markdown report only emits when the must-fix list is non-empty.
  if (sections.colorDrift?.length) return true;
  if (sections.duplicateFullRules?.length) return true;
  if (sections.duplicateDeclarationSets?.length) return true;
  return false;
}

function stripAdvisorySectionsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const sections = payload.sections ?? {};
  return {
    ...payload,
    sections: {
      ...sections,
      hotDeclarations: [],
      sharedBaseSubsets: [],
      nearDuplicateRules: [],
      selectorListCandidates: [],
      localConsolidationCandidates: [],
      vendorPrefixFamilies: [],
    },
  };
}

function renderNoActionableCssDedupeReport(stats = {}) {
  const lines = [];
  lines.push("# CSS De-duplication Audit");
  lines.push("");
  lines.push("- Actionable findings: **0**");
  lines.push(`- Files scanned: **${stats.filesScanned ?? 0}**`);
  lines.push(`- Rules parsed: **${stats.rulesScanned ?? 0}**`);
  lines.push(`- Declarations parsed: **${stats.declarationsScanned ?? 0}**`);
  lines.push("");
  lines.push("No actionable CSS de-duplication drift found.");
  lines.push("");
  lines.push(
    "Hot declarations and shared-base candidates are advisory learning telemetry; run `bun run audit:css-dedupe` explicitly to review that dashboard.",
  );
  return `${lines.join("\n")}\n`;
}
