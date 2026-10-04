import {
  HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS,
  renderReport,
  runHostedEventResponsiveContractAudit,
} from "@saydeploy/architect/engines/design-system/hosted-event-responsive-contract-engine";

export const audit = {
  id: "hosted-event-responsive-contract",
  title: "Hosted Event Responsive Contract",
  category: "design-system",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: {
    ...HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS,
    outputPath: "tmp/audits/HOSTED_EVENT_RESPONSIVE_CONTRACT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = runHostedEventResponsiveContractAudit({
      root: context.root,
      bodyFiles: cfg.bodyFiles,
      routeCssFiles: cfg.routeCssFiles,
      topbarFile: cfg.topbarFile,
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
