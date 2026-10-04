import { parseMobileAuditArgs, runMobileAudit } from "@saydeploy/architect/engines/mobile/mobile-audit-engine";
import { runStaticMobileAudit } from "@saydeploy/architect/engines/mobile/mobile-static-engine";

export const audit = {
  id: "mobile-audit",
  title: "Mobile Audit",
  category: "mobile",
  defaultConfig: {
    enabled: true,
    roots: [
      "src/components",
      "src/styles",
      "index.html",
    ],
    extensions: [".vue", ".css", ".html", ".ts", ".tsx"],
    skipSegments: [".git", "dist", "node_modules", "tmp"],
    skipFilePatterns: ["\\.spec\\.[cm]?[tj]sx?$", "\\.test\\.[cm]?[tj]sx?$", "(?:^|/)__tests__/"],
    allowlist: [],
    viewportDocuments: ["index.html"],
    workspaceViewportContractFiles: ["src/components/AppRouteShell.vue"],
    minFormControlFontPx: 16,
    fixedWidthWarnPx: 390,
    maxFindings: 120,
    fullAuditCommand: "bun run audit:mobile",
    urls: ["http://localhost:4173/"],
    devices: ["iphone_13"],
    format: "markdown",
    timeout: 30000,
    outputPath: "tmp/audits/MOBILE_AUDIT.md",
    browserOutputPath: "tmp/audits/MOBILE_BROWSER_AUDIT.md",
  },
  async run(context) {
    const fullBrowserAudit =
      context.checkArgs.includes("--full") ||
      context.checkArgs.includes("--browser") ||
      context.checkArgs.includes("--runtime");
    if (!fullBrowserAudit) {
      const result = await runStaticMobileAudit({
        root: context.root,
        roots: context.checkConfig.roots,
        extensions: context.checkConfig.extensions,
        skipSegments: context.checkConfig.skipSegments,
        skipFilePatterns: context.checkConfig.skipFilePatterns,
        allowlist: context.checkConfig.allowlist,
        viewportDocuments: context.checkConfig.viewportDocuments,
        workspaceViewportContractFiles: context.checkConfig.workspaceViewportContractFiles,
        minFormControlFontPx: context.checkConfig.minFormControlFontPx,
        fixedWidthWarnPx: context.checkConfig.fixedWidthWarnPx,
        maxFindings: context.checkConfig.maxFindings,
        fullAuditCommand: context.checkConfig.fullAuditCommand,
        baseline: context.baseline,
      });

      return {
        baselineDocument: result.baselineDocument,
        failed: result.failed,
        findings: result.findings,
        jsonPayload: result.jsonPayload,
        outputPath: context.checkConfig.outputPath,
        report: result.report,
      };
    }

    const args = parseMobileAuditArgs(context.checkArgs);
    const urls = args.urls.length ? args.urls : context.checkConfig.urls;
    const devices = args.devices?.length ? args.devices : context.checkConfig.devices;
    const format = args.format ?? context.options?.format ?? context.checkConfig.format;
    const result = await runMobileAudit({
      urls,
      devices,
      reportFormat: format,
      timeout: args.timeout ?? context.checkConfig.timeout,
      headers: args.headers,
      cookies: args.cookies,
      userAgent: args.userAgent,
      enable: args.enable,
      throttle: args.throttle,
      runs: args.runs,
      quiet: args.quiet,
      screenshot: args.screenshot,
    });

    return {
      failed: result.failed,
      jsonPayload: result.jsonPayload,
      outputPath: args.outputFile && args.outputFile !== "-" ? args.outputFile : context.checkConfig.browserOutputPath,
      report: result.report,
    };
  },
};
