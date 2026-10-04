import {
  runSurfaceSizeCoverageAudit,
  SURFACE_SIZE_COVERAGE_DEFAULTS,
} from "@saydeploy/architect/engines/surface/surface-size-coverage-engine";

export const audit = {
  id: "oversized-files",
  title: "Oversized Files",
  category: "maintainability",
  defaultConfig: {
    ...SURFACE_SIZE_COVERAGE_DEFAULTS,
    title: "Oversized Files Audit",
    roots: ["src"],
    extensions: [".css", ".ts", ".tsx", ".vue"],
    warnLines: 1000,
    reviewLines: 2000,
    highRiskLines: 2000,
    includeSizeQueue: true,
    failOnSizeRegressions: true,
    growthLines: 100,
    top: 40,
    outputPath: "tmp/audits/OVERSIZED_FILES_AUDIT.md",
    coverageTerms: [],
    coverageColumnLabel: "Covered by tests",
    testFilePattern: "\\.spec\\.ts$",
    largestFilesHeading: "Largest Files",
    oversizedLabel: "Files",
    attentionQueueLabel: "Files in attention queue",
    policyNote:
      "Line count is a maintainability heuristic, not a universal safety rule. Use the queue to find files that may mix responsibilities; strict failures come from size regressions.",
  },
  run: runSurfaceSizeCoverageAudit,
};
