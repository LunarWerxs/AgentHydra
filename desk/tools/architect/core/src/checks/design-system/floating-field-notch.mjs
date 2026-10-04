import {
  renderReport,
  runFloatingFieldNotchAudit,
} from "@saydeploy/architect/engines/design-system/floating-field-notch-engine";

export const audit = {
  id: "floating-field-notch",
  title: "Floating Field Notch Mask",
  category: "design-system",
  defaultConfig: {
    cssFile: "packages/connections-ui/src/styles/primitives/app-text-field.css",
    outputPath: "tmp/audits/FLOATING_FIELD_NOTCH_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = runFloatingFieldNotchAudit({
      root: context.root,
      cssFile: cfg.cssFile,
    });

    return {
      failed: result.findings.some((finding) => finding.severity === "error"),
      findings: result.findings,
      jsonPayload: result,
      outputPath: cfg.outputPath,
      report: renderReport(result),
    };
  },
};
