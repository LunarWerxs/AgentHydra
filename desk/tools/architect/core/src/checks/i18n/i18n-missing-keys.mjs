import { runI18nMissingKeysAudit } from "@saydeploy/architect/engines/i18n/i18n-missing-keys-engine";

export const audit = {
  id: "i18n-missing-keys",
  title: "I18n Missing Keys",
  category: "localization",
  defaultConfig: {
    roots: ["src"],
    extensions: [".ts", ".tsx", ".vue"],
    skipSegments: [".git", "coverage", "dist", "node_modules", "tmp"],
    skipFilePatterns: ["\\.spec\\.[cm]?[tj]sx?$", "\\.test\\.[cm]?[tj]sx?$", "(?:^|/)__tests__/"],
    messagesPath: "src/lib/i18n/messages/en-US",
    outputPath: "tmp/audits/I18N_MISSING_KEYS_AUDIT.md",
  },
  async run(context) {
    const targetRoots = context.checkArgs.filter((arg) => !arg.startsWith("--"));
    const result = runI18nMissingKeysAudit({
      root: context.root,
      roots: targetRoots.length ? targetRoots : context.checkConfig.roots,
      extensions: context.checkConfig.extensions,
      skipSegments: context.checkConfig.skipSegments,
      skipFilePatterns: context.checkConfig.skipFilePatterns,
      messagesPath: context.checkConfig.messagesPath,
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
