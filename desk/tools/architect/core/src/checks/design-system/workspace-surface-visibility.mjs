import {
  renderReport,
  runWorkspaceSurfaceVisibilityAudit,
} from "@saydeploy/architect/engines/design-system/workspace-surface-visibility-engine";

export const audit = {
  id: "workspace-surface-visibility",
  title: "Workspace Surface Visibility",
  category: "design-system",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    tokenFile: "src/styles/core/tokens.css",
    desktopSearchCssFile: "packages/connections-ui/src/styles/primitives/desktop-search.css",
    outputPath: "tmp/audits/WORKSPACE_SURFACE_VISIBILITY_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = runWorkspaceSurfaceVisibilityAudit({
      root: context.root,
      tokenFile: cfg.tokenFile,
      desktopSearchCssFile: cfg.desktopSearchCssFile,
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
