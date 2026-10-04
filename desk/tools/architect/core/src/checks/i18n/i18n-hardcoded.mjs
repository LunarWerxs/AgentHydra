import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultI18nHardcodedTargets, runI18nHardcodedAudit } from "@saydeploy/architect/engines/i18n/i18n-hardcoded-engine";

export const audit = {
  id: "i18n-hardcoded",
  title: "I18n Hardcoded Strings",
  category: "localization",
  defaultConfig: {
    targets: defaultI18nHardcodedTargets,
    targetListPath: null,
    outputPath: "tmp/audits/I18N_HARDCODED_AUDIT.md",
  },
  async run(context) {
    const targetArgs = context.checkArgs.filter((arg) => !arg.startsWith("--"));
    const configuredTargets = readTargets(context);
    const result = runI18nHardcodedAudit({
      root: context.root,
      targets: targetArgs.length ? targetArgs : configuredTargets,
    });

    return {
      failed: result.failed,
      jsonPayload: result.jsonPayload,
      outputPath: context.checkConfig.outputPath,
      report: result.report,
    };
  },
};

function readTargets(context) {
  if (Array.isArray(context.checkConfig.targets) && context.checkConfig.targets.length > 0) {
    return context.checkConfig.targets;
  }

  if (!context.checkConfig.targetListPath) {
    return defaultI18nHardcodedTargets;
  }

  const targetListPath = resolve(context.root, context.checkConfig.targetListPath);
  return JSON.parse(readFileSync(targetListPath, "utf8"));
}
