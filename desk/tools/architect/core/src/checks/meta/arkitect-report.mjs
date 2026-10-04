import fs from "node:fs/promises";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { audit as arkitectMatrixAudit } from "./arkitect-matrix.mjs";
import { audit as authLoginMethodsAudit } from "@saydeploy/architect/checks/contracts/auth-login-methods";
import { audit as dataCaptureContractsAudit } from "@saydeploy/architect/checks/contracts/data-capture-contracts";
import {
  analyticsContractsAudit,
  fieldContractsAudit,
  runnyknowsContractsAudit,
} from "@saydeploy/architect/checks/contracts/vocabulary/vocabulary-contracts";
import { audit as workflowOutcomeContractsAudit } from "@saydeploy/architect/checks/contracts/workflow-outcome-contracts";

const ARKITECT_AUDITS = [
  analyticsContractsAudit,
  runnyknowsContractsAudit,
  fieldContractsAudit,
  dataCaptureContractsAudit,
  workflowOutcomeContractsAudit,
  authLoginMethodsAudit,
  arkitectMatrixAudit,
];

const ARKITECT_AUDITS_BY_ID = new Map(ARKITECT_AUDITS.map((audit) => [audit.id, audit]));

const DEFAULT_CHECK_IDS = ARKITECT_AUDITS.map((audit) => audit.id);

function configuredCheckIds(checkConfig) {
  if (!Array.isArray(checkConfig.checkIds) || checkConfig.checkIds.length === 0) {
    return DEFAULT_CHECK_IDS;
  }
  return checkConfig.checkIds.map((id) => String(id ?? "").trim()).filter(Boolean);
}

function unknownCheckFinding(checkId) {
  return createFinding({
    ruleId: "arkitect-report-unknown-check",
    severity: "error",
    filePath: "packages/connections-arkitect/src/checks/arkitect-report.mjs",
    line: 0,
    message: `Arkitect report check "${checkId}" is not registered as an Arkitect child check.`,
    metadata: { checkId },
  });
}

function checkErrorFinding(checkId, error) {
  return createFinding({
    ruleId: "arkitect-report-check-error",
    severity: "error",
    filePath: "packages/connections-arkitect/src/checks/arkitect-report.mjs",
    line: 0,
    message: `Arkitect report check "${checkId}" failed to run: ${error.message}`,
    metadata: { checkId },
  });
}

function runtimeFeedParseFinding(feedPath, lineNumber, error) {
  return createFinding({
    ruleId: "arkitect-report-runtime-feed-parse",
    severity: "warning",
    filePath: feedPath,
    line: lineNumber,
    message: `Arkitect runtime feed line ${lineNumber} could not be parsed: ${error.message}`,
    metadata: { feedPath, lineNumber },
  });
}

function runtimeThresholdFinding({ rulePath, message, metadata }) {
  return createFinding({
    ruleId: "arkitect-report-runtime-threshold",
    severity: "error",
    filePath: rulePath,
    line: 0,
    message,
    metadata,
  });
}

async function runChildAudit({ audit, root, config, checkConfig, options }) {
  const childCheckConfig = {
    ...(audit.defaultConfig ?? {}),
    ...(config.checks?.[audit.id] ?? {}),
    ...(checkConfig.childChecks?.[audit.id] ?? {}),
  };

  return audit.run({
    checkArgs: [],
    config: {
      ...config,
      checks: {
        ...(config.checks ?? {}),
        [audit.id]: childCheckConfig,
      },
    },
    checkConfig: childCheckConfig,
    options,
    root,
  });
}

function childSummary(audit, result) {
  return {
    id: audit.id,
    title: audit.title,
    failed: Boolean(result.failed),
    findingsCount: Array.isArray(result.findings) ? result.findings.length : 0,
    outputPath: result.outputPath || audit.defaultConfig?.outputPath || "",
  };
}

function protectedSurfaces(results) {
  const matrix = results.find((entry) => entry.id === "arkitect-matrix");
  return Array.isArray(matrix?.jsonPayload?.surfaces) ? matrix.jsonPayload.surfaces : [];
}

async function readRunnyknowsFeed({ root, runtimeConfig, findings }) {
  const relativePath = runtimeConfig.runnyknowsPath || runtimeConfig.path || "";
  if (!relativePath) {
    return {
      enabled: false,
      path: "",
      events: [],
      unavailableReason: "No runnyknows feed path configured.",
    };
  }

  const absolutePath = path.resolve(root, relativePath);
  let text;
  try {
    text = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        enabled: true,
        path: relativePath,
        events: [],
        unavailableReason: "No local runnyknows feed found.",
      };
    }
    throw error;
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object") {
        events.push(event);
      }
    } catch (error) {
      findings.push(runtimeFeedParseFinding(relativePath, index + 1, error));
    }
  }

  return {
    enabled: true,
    path: relativePath,
    events,
    unavailableReason: "",
  };
}

function normalizePathname(pathname) {
  const value = String(pathname || "/").split("?")[0] || "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function splitRoute(route) {
  return normalizePathname(route).split("/").filter(Boolean);
}

function smokePathMatches(smokePath, pathname) {
  if (!smokePath) {
    return false;
  }

  const smokeSegments = splitRoute(smokePath);
  const pathSegments = splitRoute(pathname);
  if (pathSegments.length < smokeSegments.length) {
    return false;
  }

  if (smokePath === "/:handle") {
    const reservedFirstSegments = new Set([
      "_",
      "_connections",
      "account",
      "e",
      "explore",
      "forms",
      "host",
      "map",
      "workspace",
    ]);
    return pathSegments.length === 1 && !reservedFirstSegments.has(pathSegments[0]);
  }

  return smokeSegments.every((segment, index) => segment.startsWith(":") || segment === pathSegments[index]);
}

function surfaceSortValue(surface) {
  return (
    splitRoute(surface.smokePath).length * 10 +
    splitRoute(surface.smokePath).filter((part) => !part.startsWith(":")).length
  );
}

function owningSurfaceForEvent(event, surfaces) {
  const pathname = normalizePathname(event.pathname);
  const sortedSurfaces = [...surfaces].sort((a, b) => surfaceSortValue(b) - surfaceSortValue(a));
  return sortedSurfaces.find((surface) => smokePathMatches(surface.smokePath, pathname)) ?? null;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function countLevel(events, levelNames) {
  const accepted = new Set(levelNames);
  return events.filter((event) => accepted.has(String(event.level || ""))).length;
}

function summarizeRunnyknowsFeed(feed, surfaces, runtimeConfig) {
  const events = feed.events;
  const topLimit = Number(runtimeConfig.maxTopMessages ?? 5);
  const bySurface = new Map();
  const unmatched = [];

  for (const event of events) {
    const surface = owningSurfaceForEvent(event, surfaces);
    if (!surface) {
      unmatched.push(event);
      continue;
    }

    const current = bySurface.get(surface.id) ?? {
      id: surface.id,
      label: surface.label,
      smokePath: surface.smokePath,
      count: 0,
      errors: 0,
      warnings: 0,
      sources: {},
    };
    current.count += 1;
    if (event.level === "error") current.errors += 1;
    if (event.level === "warn" || event.level === "warning") current.warnings += 1;
    const source = String(event.source || "unknown");
    current.sources[source] = (current.sources[source] ?? 0) + 1;
    bySurface.set(surface.id, current);
  }

  const topMessages = countBy(events, (event) => String(event.message || "Unknown runtime event")).slice(0, topLimit);
  const sourceCounts = countBy(events, (event) => String(event.source || "unknown"));
  const levelCounts = countBy(events, (event) => String(event.level || "unknown"));
  const totalOccurrences = events.reduce((sum, event) => sum + Math.max(1, Number(event.occurrenceCount || 1)), 0);
  const totalErrors = countLevel(events, ["error"]);
  const totalWarnings = countLevel(events, ["warn", "warning"]);

  return {
    enabled: feed.enabled,
    path: feed.path,
    unavailableReason: feed.unavailableReason,
    totalEvents: events.length,
    totalOccurrences,
    totalErrors,
    totalWarnings,
    levelCounts,
    sourceCounts,
    topMessages,
    surfaces: [...bySurface.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    unmatchedCount: unmatched.length,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function evaluateRuntimeThresholds(runtimeSignals, runtimeConfig) {
  const thresholds = runtimeConfig.thresholds;
  if (!thresholds || thresholds.enabled === false || !runtimeSignals.enabled || runtimeSignals.unavailableReason) {
    return [];
  }

  const checks = [
    {
      key: "maxTotalEvents",
      actual: runtimeSignals.totalEvents,
      label: "runtime event records",
    },
    {
      key: "maxErrorEvents",
      actual: runtimeSignals.totalErrors,
      label: "runtime error records",
    },
    {
      key: "maxWarningEvents",
      actual: runtimeSignals.totalWarnings,
      label: "runtime warning records",
    },
    {
      key: "maxUnmatchedEvents",
      actual: runtimeSignals.unmatchedCount,
      label: "unmatched runtime records",
    },
  ];

  const findings = [];
  for (const check of checks) {
    const limit = finiteNumber(thresholds[check.key]);
    if (limit === null || check.actual <= limit) {
      continue;
    }
    findings.push(
      runtimeThresholdFinding({
        rulePath: runtimeSignals.path || "packages/connections-arkitect/src/checks/arkitect-report.mjs",
        message: `Arkitect runtime threshold exceeded: ${check.label} ${check.actual} > ${limit}.`,
        metadata: {
          threshold: check.key,
          actual: check.actual,
          limit,
        },
      }),
    );
  }

  const maxSurfaceErrorEvents = finiteNumber(thresholds.maxSurfaceErrorEvents);
  if (maxSurfaceErrorEvents !== null) {
    for (const surface of runtimeSignals.surfaces) {
      if (surface.errors <= maxSurfaceErrorEvents) {
        continue;
      }
      findings.push(
        runtimeThresholdFinding({
          rulePath: runtimeSignals.path || "packages/connections-arkitect/src/checks/arkitect-report.mjs",
          message: `Arkitect runtime threshold exceeded for ${surface.label}: runtime error records ${surface.errors} > ${maxSurfaceErrorEvents}.`,
          metadata: {
            threshold: "maxSurfaceErrorEvents",
            surfaceId: surface.id,
            actual: surface.errors,
            limit: maxSurfaceErrorEvents,
          },
        }),
      );
    }
  }

  return findings;
}

function renderFindingLines(findings) {
  if (findings.length === 0) {
    return ["No Arkitect contract drift found.", ""];
  }

  const lines = ["## Findings", ""];
  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.ruleId} at \`${location}\`: ${finding.message}`);
  }
  lines.push("");
  return lines;
}

function renderRuntimeSignals(runtimeSignals) {
  const lines = ["## Runtime Signals", ""];

  if (!runtimeSignals.enabled) {
    lines.push("Runtime signal input is disabled.", "");
    return lines;
  }

  if (runtimeSignals.unavailableReason) {
    lines.push(`${runtimeSignals.unavailableReason} Path: \`${runtimeSignals.path}\`.`, "");
    return lines;
  }

  lines.push(
    `Loaded \`${runtimeSignals.path}\`: ${runtimeSignals.totalEvents} event records, ${runtimeSignals.totalOccurrences} total occurrences.`,
    "",
  );

  lines.push(`Runtime levels: ${runtimeSignals.totalErrors} error, ${runtimeSignals.totalWarnings} warning.`, "");

  if (runtimeSignals.surfaces.length > 0) {
    lines.push("| Surface | Events | Errors | Warnings | Sources |");
    lines.push("| --- | ---: | ---: | ---: | --- |");
    for (const surface of runtimeSignals.surfaces) {
      const sources = Object.entries(surface.sources)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([source, count]) => `${source} (${count})`)
        .join(", ");
      lines.push(
        `| ${surface.label} | ${surface.count} | ${surface.errors} | ${surface.warnings} | ${sources || "-"} |`,
      );
    }
    lines.push("");
  }

  if (runtimeSignals.topMessages.length > 0) {
    lines.push("Top runtime messages:");
    for (const entry of runtimeSignals.topMessages) {
      lines.push(`- ${entry.count}x ${entry.key}`);
    }
    lines.push("");
  }

  if (runtimeSignals.unmatchedCount > 0) {
    lines.push(`Unmatched runtime records: ${runtimeSignals.unmatchedCount}.`, "");
  }

  return lines;
}

function renderReport({ summaries, findings, surfaces, runtimeSignals }) {
  const lines = [
    "# Arkitect Report",
    "",
    "Top-level digest for the repo-native Arkitect layer: contract drift, protected surfaces, and the commands humans should run before release.",
    "",
    ...renderFindingLines(findings),
    "## Contract Gates",
    "",
    "| Check | Status | Findings | Report |",
    "| --- | --- | ---: | --- |",
  ];

  for (const summary of summaries) {
    lines.push(
      `| ${summary.title} | ${summary.failed ? "Fail" : "Pass"} | ${summary.findingsCount} | ${
        summary.outputPath || "-"
      } |`,
    );
  }

  lines.push("", "## Protected Surfaces", "");
  if (surfaces.length === 0) {
    lines.push("No protected surfaces were reported by the Arkitect matrix.", "");
  } else {
    lines.push("| Surface | Smoke path | Workflows |");
    lines.push("| --- | --- | --- |");
    for (const surface of surfaces) {
      lines.push(`| ${surface.label} | ${surface.smokePath} | ${(surface.workflows ?? []).join(", ") || "-"} |`);
    }
    lines.push("");
  }

  lines.push(...renderRuntimeSignals(runtimeSignals));

  lines.push("## Commands", "");
  lines.push("- Fast contract gate: `bun run audit:arkitect:contracts`");
  lines.push("- Canary confidence check: `bun run audit:arkitect:canary`");
  lines.push("- Explicit live smoke: `bun run audit:arkitect:live` (requires `ARKITECT_LIVE_BASE_URL`)");
  lines.push("- Full local Arkitect gate: `bun run audit:arkitect`");
  lines.push("- Digest only: `bun run audit:arkitect:report`");
  lines.push("");

  return lines.join("\n");
}

export async function runArchitectReportAudit({
  root = process.cwd(),
  checkConfig = {},
  config = {},
  options = {},
} = {}) {
  const findings = [];
  const results = [];
  const summaries = [];

  for (const checkId of configuredCheckIds(checkConfig)) {
    const childAudit = ARKITECT_AUDITS_BY_ID.get(checkId);
    if (!childAudit) {
      findings.push(unknownCheckFinding(checkId));
      continue;
    }

    try {
      const result = await runChildAudit({ audit: childAudit, root, config, checkConfig, options });
      const childFindings = Array.isArray(result.findings) ? result.findings : [];
      findings.push(...childFindings);
      results.push({
        id: childAudit.id,
        title: childAudit.title,
        jsonPayload: result.jsonPayload,
      });
      summaries.push(childSummary(childAudit, result));
    } catch (error) {
      findings.push(checkErrorFinding(checkId, error));
      summaries.push({
        id: childAudit.id,
        title: childAudit.title,
        failed: true,
        findingsCount: 1,
        outputPath: childAudit.defaultConfig?.outputPath || "",
      });
    }
  }

  const surfaces = protectedSurfaces(results);
  const runtimeFeed = await readRunnyknowsFeed({
    root,
    runtimeConfig: checkConfig.runtimeSignals ?? {},
    findings,
  });
  const runtimeSignals = summarizeRunnyknowsFeed(runtimeFeed, surfaces, checkConfig.runtimeSignals ?? {});
  findings.push(...evaluateRuntimeThresholds(runtimeSignals, checkConfig.runtimeSignals ?? {}));
  const failed = findings.some((finding) => finding.severity === "error");

  return {
    failed,
    findings,
    outputPath: checkConfig.outputPath,
    report: renderReport({ summaries, findings, surfaces, runtimeSignals }),
    jsonPayload: {
      failed,
      findings,
      checks: summaries,
      surfaces,
      runtimeSignals,
      actionable: [
        ...summaries.map((summary) => ({
          id: summary.id,
          title: summary.title,
          command: `bun run audit:${summary.id}`,
        })),
        ...surfaces.map((surface) => ({
          id: surface.id,
          label: surface.label,
          smokePath: surface.smokePath,
        })),
      ],
    },
  };
}

export const audit = {
  id: "arkitect-report",
  title: "Arkitect Report",
  category: "product",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    includeInAll: false,
    outputPath: "tmp/audits/ARKITECT_REPORT.md",
    checkIds: DEFAULT_CHECK_IDS,
    runtimeSignals: {
      runnyknowsPath: "tmp/runnyknows/runnyknows.ndjson",
      maxTopMessages: 5,
    },
  },
  async run(context) {
    return runArchitectReportAudit(context);
  },
};
