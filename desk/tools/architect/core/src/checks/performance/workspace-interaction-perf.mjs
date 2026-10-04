/**
 * Workspace Interaction Performance — connections-arkitect check
 * ==============================================================
 * Consumes `packages/connections-arkitect/runners/workspace-interaction-perf.mjs` output and
 * flags post-load UI stalls during workspace tab switches.
 *
 * Uses browser-native Long Animation Frames / Long Tasks plus app-level
 * workspace perf markers. This catches interaction jank that HAR and
 * page-load Lighthouse audits cannot see.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_RESULTS_PATH = "tmp/browser-perf-audit/workspace-interactions.json";

const RULES = {
  "workspace-interaction-missing-results": {
    severity: "info",
    description: "No workspace interaction capture exists yet.",
  },
  "workspace-interaction-scenario-error": {
    severity: "error",
    description: "A workspace interaction scenario failed before it could complete.",
  },
  "workspace-interaction-slow-scenario": {
    severity: "error",
    description: "A workspace interaction scenario exceeded the wall-clock budget.",
  },
  "workspace-interaction-slow-first-frame": {
    severity: "error",
    description: "A tab switch took too long to reach the first animation frame.",
  },
  "workspace-interaction-long-animation-frame": {
    severity: "error",
    description: "A Long Animation Frame exceeded the interaction budget.",
  },
  "workspace-interaction-blocking-time": {
    severity: "warning",
    description: "Long Animation Frames accumulated too much blocking time.",
  },
  "workspace-interaction-contact-derivation": {
    severity: "warning",
    description: "Contact list derivation consumed a visible amount of an interaction frame.",
  },
  "workspace-interaction-virtual-layout": {
    severity: "warning",
    description: "Virtual list layout measurement consumed a visible amount of an interaction frame.",
  },
};

const THRESHOLDS = {
  contactDerivationWarningMs: 35,
  firstFrameErrorMs: 250,
  firstFrameWarningMs: 120,
  longAnimationFrameErrorMs: 250,
  longAnimationFrameWarningMs: 200,
  scenarioErrorMs: 1200,
  scenarioWarningMs: 1000,
  totalBlockingWarningMs: 200,
  virtualLayoutWarningMs: 35,
};

function severityForThreshold(value, warning, error) {
  if (value > error) return "error";
  if (value > warning) return "warning";
  return null;
}

function renderScenarioSummary(scenario) {
  const summary = scenario.summary ?? {};
  return [
    `total=${scenario.totalMs ?? 0}ms`,
    `firstFrame=${summary.maxTabFirstFrameMs ?? 0}ms`,
    `loaf=${summary.maxLongAnimationFrameMs ?? 0}ms`,
    `blocking=${summary.totalBlockingMs ?? 0}ms`,
    `contactDerive=${summary.maxContactDerivationMs ?? 0}ms`,
    `virtualLayout=${summary.maxVirtualListLayoutMs ?? 0}ms`,
  ].join(", ");
}

function topSlowEvents(scenario, count = 5) {
  return (scenario.summary?.slowestEvents ?? [])
    .slice(0, count)
    .map((event) => `${event.kind}${event.label ? ` ${event.label}` : ""}: ${Math.round(event.durationMs ?? 0)}ms`);
}

function renderReport({ report, findings, resultsPath }) {
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const lines = [
    "# Workspace Interaction Performance Audit",
    "",
    "_Post-load tab-switch responsiveness using Puppeteer plus browser Long Animation Frames / Long Tasks._",
    "",
    `Errors: ${errorCount}`,
    `Warnings: ${warningCount}`,
    "",
    `- Results: \`${resultsPath}\``,
    `- Findings: ${findings.length}`,
    `- Coverage: ${report?.coverageMode ?? "unknown"}`,
    `- Scenarios: ${report?.scenarios?.length ?? 0}`,
    "",
  ];

  if (!report) {
    lines.push("No capture file found. Run `bun run audit:workspace-interactions:capture` first.", "");
    return `${lines.join("\n")}\n`;
  }

  for (const scenario of report.scenarios ?? []) {
    lines.push(`## ${scenario.name}`, "", `- ${renderScenarioSummary(scenario)}`);
    if (scenario.error) {
      lines.push(`- Error: ${scenario.error}`);
    }
    const slowEvents = topSlowEvents(scenario);
    if (slowEvents.length > 0) {
      lines.push("- Slowest events:");
      for (const event of slowEvents) {
        lines.push(`  - ${event}`);
      }
    }
    lines.push("");
  }

  if (findings.length > 0) {
    lines.push("## Findings", "");
    for (const finding of findings) {
      lines.push(`- **${finding.severity}** \`${finding.ruleId}\` — ${finding.message}`);
    }
    lines.push("");
  } else {
    lines.push("No workspace interaction performance findings.", "");
  }

  return `${lines.join("\n")}\n`;
}

export const audit = {
  id: "workspace-interaction-perf",
  title: "Workspace Interaction Performance",
  category: "performance",
  defaultConfig: {
    includeInAll: false,
    outputPath: "tmp/audits/WORKSPACE_INTERACTION_PERF_AUDIT.md",
    resultsPath: DEFAULT_RESULTS_PATH,
    thresholds: THRESHOLDS,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const thresholds = { ...THRESHOLDS, ...(cfg.thresholds ?? {}) };
    const resultsPath = path.resolve(context.root, cfg.resultsPath || DEFAULT_RESULTS_PATH);

    let report = null;
    if (!existsSync(resultsPath)) {
      const findings = [
        {
          filePath: resultsPath,
          message: `No results file found at ${resultsPath}. Run \`bun run audit:workspace-interactions:capture\` first.`,
          ruleId: "workspace-interaction-missing-results",
          severity: RULES["workspace-interaction-missing-results"].severity,
        },
      ];
      return {
        failed: false,
        findings,
        filesScanned: 0,
        outputPath: cfg.outputPath,
        report: renderReport({ findings, report, resultsPath }),
      };
    }

    try {
      report = JSON.parse(readFileSync(resultsPath, "utf8"));
    } catch (error) {
      const findings = [
        {
          filePath: resultsPath,
          message: `Unable to parse workspace interaction results: ${error.message}`,
          ruleId: "workspace-interaction-missing-results",
          severity: "error",
        },
      ];
      return {
        failed: true,
        findings,
        filesScanned: 0,
        outputPath: cfg.outputPath,
        report: renderReport({ findings, report, resultsPath }),
      };
    }

    const findings = [];
    for (const scenario of report.scenarios ?? []) {
      const summary = scenario.summary ?? {};
      const scenarioName = scenario.name ?? "unknown";

      if (scenario.error) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: ${scenario.error}`,
          ruleId: "workspace-interaction-scenario-error",
          severity: RULES["workspace-interaction-scenario-error"].severity,
        });
        continue;
      }

      const scenarioSeverity = severityForThreshold(
        scenario.totalMs ?? 0,
        thresholds.scenarioWarningMs,
        thresholds.scenarioErrorMs,
      );
      if (scenarioSeverity) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: ${renderScenarioSummary(scenario)}`,
          ruleId: "workspace-interaction-slow-scenario",
          severity: scenarioSeverity,
        });
      }

      const firstFrameSeverity = severityForThreshold(
        summary.maxTabFirstFrameMs ?? 0,
        thresholds.firstFrameWarningMs,
        thresholds.firstFrameErrorMs,
      );
      if (firstFrameSeverity) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: max first-frame tab switch ${summary.maxTabFirstFrameMs}ms`,
          ruleId: "workspace-interaction-slow-first-frame",
          severity: firstFrameSeverity,
        });
      }

      const loafSeverity = severityForThreshold(
        summary.maxLongAnimationFrameMs ?? 0,
        thresholds.longAnimationFrameWarningMs,
        thresholds.longAnimationFrameErrorMs,
      );
      if (loafSeverity) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: max long animation frame ${summary.maxLongAnimationFrameMs}ms`,
          ruleId: "workspace-interaction-long-animation-frame",
          severity: loafSeverity,
        });
      }

      if ((summary.totalBlockingMs ?? 0) > thresholds.totalBlockingWarningMs) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: total LoAF blocking time ${summary.totalBlockingMs}ms`,
          ruleId: "workspace-interaction-blocking-time",
          severity: RULES["workspace-interaction-blocking-time"].severity,
        });
      }

      if ((summary.maxContactDerivationMs ?? 0) > thresholds.contactDerivationWarningMs) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: contact derivation took ${summary.maxContactDerivationMs}ms`,
          ruleId: "workspace-interaction-contact-derivation",
          severity: RULES["workspace-interaction-contact-derivation"].severity,
        });
      }

      if ((summary.maxVirtualListLayoutMs ?? 0) > thresholds.virtualLayoutWarningMs) {
        findings.push({
          filePath: resultsPath,
          message: `${scenarioName}: virtual list layout took ${summary.maxVirtualListLayoutMs}ms`,
          ruleId: "workspace-interaction-virtual-layout",
          severity: RULES["workspace-interaction-virtual-layout"].severity,
        });
      }
    }

    const failed = findings.some((finding) => finding.severity === "error");
    return {
      failed,
      findings,
      filesScanned: report.scenarios?.length ?? 0,
      jsonPayload: { findings, report, thresholds },
      metadata: {
        baseUrl: report.baseUrl,
        generatedAt: report.generatedAt,
        tool: report.tool,
      },
      outputPath: cfg.outputPath,
      report: renderReport({ findings, report, resultsPath }),
    };
  },
};

export const metadata = {
  rules: RULES,
  thresholds: THRESHOLDS,
};
