import fs from "node:fs/promises";
import path from "node:path";
import { countFileLines, walkFiles } from "@saydeploy/architect/core/files";

export const SURFACE_SIZE_COVERAGE_DEFAULTS = {
  title: "Surface Size And Coverage Audit",
  roots: ["src"],
  extensions: [".css", ".ts", ".tsx", ".vue"],
  warnLines: 700,
  reviewLines: 1200,
  highRiskLines: 2000,
  includeSizeQueue: true,
  failOnSizeRegressions: true,
  growthLines: 100,
  top: 35,
  outputPath: "tmp/audits/SURFACE_SIZE_COVERAGE_AUDIT.md",
  coverageTerms: [],
  coverageColumnLabel: "Covered by tests",
  testFilePattern: "\\.spec\\.ts$",
  largestFilesHeading: "Largest Surface Files",
  oversizedLabel: "Surface files",
  attentionQueueLabel: "Files in attention queue",
  policyNote:
    "Line count is a maintainability heuristic, not a universal safety rule. Use the queue to find files that may mix responsibilities; strict failures come from size regressions or missing coverage terms.",
};

export async function runSurfaceSizeCoverageAudit(context) {
  const checkConfig = applyLegacyArgs(context.checkConfig, context.checkArgs);
  const files = (
    await Promise.all(
      (
        await walkFiles({
          root: context.root,
          roots: checkConfig.roots,
          extensions: checkConfig.extensions,
          skipSegments: checkConfig.skipSegments,
        })
      ).map(async (filePath) => ({
        path: filePath,
        lines: await countFileLines(context.root, filePath),
      })),
    )
  ).sort((left, right) => right.lines - left.lines);

  const oversized = checkConfig.includeSizeQueue ? files.filter((file) => file.lines >= checkConfig.warnLines) : [];
  const testFilePattern = new RegExp(checkConfig.testFilePattern);
  const testFiles = files.filter((file) => testFilePattern.test(file.path));
  const testText = (
    await Promise.all(testFiles.map((file) => fs.readFile(path.resolve(context.root, file.path), "utf8")))
  ).join("\n");

  const coverage = checkConfig.coverageTerms.map((term) => ({
    label: term.label,
    covered: new RegExp(term.pattern, term.flags ?? "i").test(testText),
  }));
  const uncovered = coverage.filter((item) => !item.covered);
  const regressions =
    context.baseline?.files && checkConfig.includeSizeQueue && checkConfig.failOnSizeRegressions
      ? oversized.filter((file) => {
          const baselineLines = context.baseline.files?.[file.path]?.lines;
          if (baselineLines === undefined) {
            return true;
          }
          return file.lines - baselineLines >= checkConfig.growthLines;
        })
      : [];
  const sizeBands = buildSizeBands(oversized, checkConfig);

  const baselineDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    includeSizeQueue: checkConfig.includeSizeQueue,
    failOnSizeRegressions: checkConfig.failOnSizeRegressions,
    warnLines: checkConfig.warnLines,
    reviewLines: checkConfig.reviewLines,
    highRiskLines: checkConfig.highRiskLines,
    growthLines: checkConfig.growthLines,
    files: Object.fromEntries(oversized.map((file) => [file.path, { lines: file.lines }])),
    coverage: Object.fromEntries(coverage.map((item) => [item.label, item.covered])),
  };

  const report = renderMarkdown({
    baseline: context.baseline,
    checkConfig,
    coverage,
    files,
    oversized,
    regressions,
    sizeBands,
    testFiles,
    uncovered,
  });

  return {
    baselineDocument,
    failed: regressions.length > 0 || uncovered.length > 0,
    jsonPayload: {
      files,
      oversized,
      testFiles,
      coverage,
      uncovered,
      regressions,
    },
    outputPath: checkConfig.outputPath,
    report,
  };
}

function readArg(args, name, fallback) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function readBooleanArg(args, name, fallback) {
  const rawValue = readArg(args, name, fallback);
  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  return String(rawValue).toLowerCase() !== "false";
}

function applyLegacyArgs(config, args) {
  return {
    ...config,
    includeSizeQueue: readBooleanArg(args, "--include-size-queue", config.includeSizeQueue),
    failOnSizeRegressions: readBooleanArg(args, "--fail-on-size-regressions", config.failOnSizeRegressions),
    warnLines: Number(readArg(args, "--warn-lines", config.warnLines)),
    reviewLines: Number(readArg(args, "--review-lines", config.reviewLines)),
    highRiskLines: Number(readArg(args, "--high-risk-lines", config.highRiskLines)),
    growthLines: Number(readArg(args, "--growth-lines", config.growthLines)),
    top: Number(readArg(args, "--top", config.top)),
    outputPath: readArg(args, "--output", config.outputPath),
  };
}

function buildSizeBands(oversized, checkConfig) {
  const highRisk = oversized.filter((file) => file.lines >= checkConfig.highRiskLines);
  const review = oversized.filter(
    (file) => file.lines >= checkConfig.reviewLines && file.lines < checkConfig.highRiskLines,
  );
  const attention = oversized.filter(
    (file) => file.lines >= checkConfig.warnLines && file.lines < checkConfig.reviewLines,
  );

  return { attention, review, highRisk };
}

function sizeBandFor(lines, checkConfig) {
  if (lines >= checkConfig.highRiskLines) {
    return "high-risk";
  }

  if (lines >= checkConfig.reviewLines) {
    return "review";
  }

  if (lines >= checkConfig.warnLines) {
    return "attention";
  }

  return "below threshold";
}

function renderMarkdown({
  baseline,
  checkConfig,
  coverage,
  files,
  oversized,
  regressions,
  sizeBands,
  testFiles,
  uncovered,
}) {
  const lines = [
    `# ${checkConfig.title}`,
    "",
    `- Files scanned: ${files.length}`,
    `- Test files scanned: ${testFiles.length}`,
    `- Coverage terms checked: ${coverage.length}`,
    `- Missing coverage terms: ${uncovered.length}`,
  ];

  if (checkConfig.includeSizeQueue) {
    lines.push(
      `- ${checkConfig.attentionQueueLabel} (>= ${checkConfig.warnLines} lines): ${oversized.length}`,
      `- Attention band (${checkConfig.warnLines}-${checkConfig.reviewLines - 1} lines): ${sizeBands.attention.length}`,
      `- Review band (${checkConfig.reviewLines}-${checkConfig.highRiskLines - 1} lines): ${sizeBands.review.length}`,
      `- High-risk band (>= ${checkConfig.highRiskLines} lines): ${sizeBands.highRisk.length}`,
      `- Size regressions: ${regressions.length}`,
    );
  }

  lines.push("");

  if (checkConfig.policyNote) {
    lines.push("## Policy", "", checkConfig.policyNote, "");
  }

  if (checkConfig.includeSizeQueue && regressions.length > 0) {
    lines.push("## Size Regressions", "");
    for (const file of regressions) {
      const baselineLines = baseline.files?.[file.path]?.lines ?? "new";
      lines.push(`- ${file.path}: ${file.lines} lines (baseline: ${baselineLines})`);
    }
    lines.push("");
  }

  lines.push("## Coverage Terms", "", `| Term | ${checkConfig.coverageColumnLabel} |`, "| --- | --- |");
  for (const item of coverage) {
    lines.push(`| ${item.label} | ${item.covered ? "yes" : "no"} |`);
  }

  if (checkConfig.includeSizeQueue) {
    lines.push("", `## ${checkConfig.largestFilesHeading}`, "", "| Lines | Band | File |", "| ---: | --- | --- |");
    for (const file of files.slice(0, checkConfig.top)) {
      lines.push(`| ${file.lines} | ${sizeBandFor(file.lines, checkConfig)} | \`${file.path}\` |`);
    }
  }

  return `${lines.join("\n")}\n`;
}
