import { runProductContractsAudit } from "@saydeploy/architect/engines/contracts/product-contracts-engine";

export const audit = {
  id: "product-contracts",
  title: "Product Contracts",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    roots: ["src", "infra/aws/lib", "infra/lambda/src", "public", "config", ".github"],
    extensions: [
      ".cjs",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
      ".vue",
      ".json",
      ".yml",
      ".yaml",
      ".html",
      ".txt",
    ],
    skipSegments: [".git", "cdk.out", "coverage", "dist", "node_modules", "tmp"],
    outputPath: "tmp/audits/PRODUCT_CONTRACTS_AUDIT.md",
  },
  async run(context) {
    const result = await runProductContractsAudit({
      root: context.root,
      roots: context.checkConfig.roots,
      extensions: context.checkConfig.extensions,
      skipSegments: context.checkConfig.skipSegments,
    });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      outputPath: context.checkConfig.outputPath,
      report: result.report,
    };
  },
};
