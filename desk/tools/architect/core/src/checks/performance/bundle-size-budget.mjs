import { runBundleSizeBudgetSection } from "@saydeploy/architect/engines/performance/bundle-size-budget-engine";

const SECTION_ALIASES = {
  "client-chunks": "client-chunks",
  client: "client-chunks",
  "lambda-handlers": "lambda-handlers",
  lambda: "lambda-handlers",
};

export const audit = {
  id: "bundle-size-budget",
  title: "Bundle Size Budgets",
  category: "maintainability",
  defaultConfig: {
    sections: ["client-chunks", "lambda-handlers"],
    outputPath: "tmp/audits/BUNDLE_SIZE_BUDGET.md",
    "client-chunks": {
      dir: "dist/assets",
      extensions: [".js"],
      warnBytes: 800_000,
      errorBytes: 1_500_000,
      top: 25,
      perFileBudgets: {
        // Vendor bundles are inherently large (framework + library code).
        // Budget thresholds account for expected baseline sizes.
        "vendor-vue": { warn: 1_500_000, error: 2_000_000 },
        "vendor-map-vector": { warn: 1_200_000, error: 1_500_000 },
      },
      outputPath: "tmp/audits/CLIENT_CHUNKS_BUDGET.md",
    },
    "lambda-handlers": {
      dir: "infra/lambda/dist",
      extensions: [".zip"],
      warnBytes: 500_000,
      errorBytes: 5_000_000,
      top: 25,
      perFileBudgets: {},
      outputPath: "tmp/audits/LAMBDA_HANDLERS_BUDGET.md",
    },
  },
  async run(context) {
    const sections = resolveSections(context);
    const results = [];

    for (const sectionId of sections) {
      const sectionConfig = context.checkConfig[sectionId];
      if (!sectionConfig) {
        continue;
      }
      results.push(
        await runBundleSizeBudgetSection({
          root: context.root,
          sectionId,
          sectionConfig,
        }),
      );
    }

    const failed = results.some((r) => r.failed);
    const report = results.map((r) => r.report.trimEnd()).join("\n\n");
    const outputPath = resolveOutputPath(context, sections);

    return {
      failed,
      jsonPayload: {
        sections: results.map((r) => ({
          sectionId: r.sectionId,
          skipped: r.skipped,
          failed: r.failed,
          ...r.jsonPayload,
        })),
      },
      outputPath,
      report,
    };
  },
};

function resolveSections(context) {
  const requested = [];
  for (const arg of context.checkArgs ?? []) {
    const value = arg.startsWith("--section=") ? arg.slice("--section=".length) : arg;
    if (value.startsWith("--")) continue;
    const normalized = SECTION_ALIASES[value];
    if (normalized && !requested.includes(normalized)) {
      requested.push(normalized);
    }
  }
  if (requested.length > 0) {
    return requested;
  }
  return context.checkConfig.sections ?? audit.defaultConfig.sections;
}

function resolveOutputPath(context, sections) {
  if (sections.length === 1) {
    return context.checkConfig[sections[0]]?.outputPath ?? context.checkConfig.outputPath;
  }
  return context.checkConfig.outputPath;
}
