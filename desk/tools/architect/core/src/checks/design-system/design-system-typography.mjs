import { runDesignSystemTypographyAudit } from "@saydeploy/architect/engines/design-system/design-system-typography-engine";

export const audit = {
  id: "design-system-typography",
  title: "Design System Typography",
  category: "design-system",
  defaultConfig: {
    roots: ["src"],
    extensions: [".vue", ".css"],
    skipSegments: [".git", "dist", "node_modules", "tmp"],
    maxPerRule: 120,
    inlineFontSizeFileAllowlist: ["src/SharedPrimitivesLiveHarness.vue"],
    outputPath: "tmp/audits/DESIGN_SYSTEM_TYPOGRAPHY_AUDIT.md",
  },
  async run(context) {
    const result = await runDesignSystemTypographyAudit({
      root: context.root,
      roots: context.checkConfig.roots,
      extensions: context.checkConfig.extensions,
      skipSegments: context.checkConfig.skipSegments,
      maxPerRule: context.checkConfig.maxPerRule,
      inlineFontSizeFileAllowlist: context.checkConfig.inlineFontSizeFileAllowlist,
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
