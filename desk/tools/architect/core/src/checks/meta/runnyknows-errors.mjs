/**
 * runnyknows-errors — connections-arkitect check
 * ===============================================
 * Reads the dev-time runnyknows error log (tmp/runnyknows/runnyknows.ndjson)
 * and surfaces runtime errors as arkitect findings so the AI audit workflow
 * can see and fix runtime issues alongside static ones.
 *
 * Prerequisite: dev server must have been running to populate the log.
 *
 * Rules:
 *   1. runnyknows-runtime-error — error-level events (window-error, vue-error, unhandledrejection)
 *   2. runnyknows-network-error — network-response errors (4xx/5xx from API calls)
 *   3. runnyknows-resource-error — resource-load failures (404s on scripts, styles, images)
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check runnyknows-errors
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";

const DEFAULT_LOG_PATH = "tmp/runnyknows/runnyknows.ndjson";

const SEVERITY_BY_SOURCE = {
  "window-error": "error",
  unhandledrejection: "error",
  "vue-error": "error",
  "network-response": "error",
  "resource-error": "warn",
  console: "warn",
};

const RULE_BY_SOURCE = {
  "window-error": "runnyknows-runtime-error",
  unhandledrejection: "runnyknows-runtime-error",
  "vue-error": "runnyknows-runtime-error",
  "network-response": "runnyknows-network-error",
  "resource-error": "runnyknows-resource-error",
  console: "runnyknows-console-warn",
};

const _RULES = {
  "runnyknows-runtime-error": {
    severity: "error",
    description: "Runtime error caught by runnyknows (window-error, vue-error, or unhandled rejection).",
  },
  "runnyknows-network-error": {
    severity: "error",
    description: "Network response error caught by runnyknows (4xx/5xx API responses).",
  },
  "runnyknows-resource-error": {
    severity: "warn",
    description: "Resource load failure caught by runnyknows (404 on script, style, or image).",
  },
  "runnyknows-console-warn": {
    severity: "warn",
    description: "Console warning/error caught by runnyknows.",
  },
};

function readRunnyknowsLog(root, logPath) {
  const abs = path.resolve(root, logPath);
  if (!existsSync(abs)) return [];

  try {
    const text = readFileSync(abs, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function deduplicateByMessage(events) {
  const seen = new Map();
  const deduped = [];

  for (const event of events) {
    const key = `${event.source}|${event.message}|${event.component || ""}`;
    const existing = seen.get(key);
    if (existing) {
      existing.occurrenceCount = (existing.occurrenceCount || 1) + (event.occurrenceCount || 1);
      if (event.lastRecordedAt > existing.lastRecordedAt) {
        existing.lastRecordedAt = event.lastRecordedAt;
        existing.pathname = event.pathname;
        existing.stack = event.stack || existing.stack;
      }
    } else {
      seen.set(key, { ...event, occurrenceCount: event.occurrenceCount || 1 });
      deduped.push(seen.get(key));
    }
  }

  return deduped.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

function renderReport(findings, events) {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;

  const lines = [
    "# Runnyknows Runtime Errors Audit",
    "",
    `- Total events in log: ${events.length}`,
    `- Unique errors surfaced: ${findings.length}`,
    `- **Errors:** ${errorCount}`,
    `- **Warnings:** ${warnCount}`,
    "",
  ];

  if (findings.length === 0) {
    if (events.length === 0) {
      lines.push("No runnyknows log found. Start the dev server to populate runtime error data.");
    } else {
      lines.push("No runtime errors found in the runnyknows log.");
    }
    lines.push("");
    lines.push(`Errors: ${errorCount}`);
    lines.push(`Warnings: ${warnCount}`);
    return lines.join("\n");
  }

  // Group by source, with severity-tagged headings the runner regex recognizes.
  const bySource = {};
  for (const f of findings) {
    (bySource[f.metadata?.source ?? "unknown"] ??= []).push(f);
  }

  for (const [source, sourceFindings] of Object.entries(bySource)) {
    const groupErrors = sourceFindings.filter((f) => f.severity === "error").length;
    const groupWarnings = sourceFindings.length - groupErrors;
    const severityLabel = groupErrors > 0 ? "error" : "warning";
    lines.push(`## ${source} — ${sourceFindings.length} (${severityLabel})`);
    lines.push("");
    lines.push(`- Errors: ${groupErrors}`);
    lines.push(`- Warnings: ${groupWarnings}`);
    lines.push("");

    for (const f of sourceFindings) {
      const event = f.metadata;
      lines.push(`- **${event.pathname || "unknown"}** — ${event.occurrenceCount || 1}x — ${f.message}`);
      if (event.stack) {
        const firstLine = event.stack.split("\n")[0]?.trim();
        if (firstLine) lines.push(`  \`${firstLine}\``);
      }
    }
    lines.push("");
  }

  // Canonical plain footer the runner aggregator regex scans for.
  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);
  return lines.join("\n");
}

export async function runRunnyknowsErrorsAudit({ root, logPath, maxFindings = 50 }) {
  const events = readRunnyknowsLog(root, logPath);
  const deduped = deduplicateByMessage(events.filter((e) => e.level === "error" || e.source === "resource-error"));
  const top = deduped.slice(0, maxFindings);

  const findings = top.map((event) =>
    createFinding({
      ruleId: RULE_BY_SOURCE[event.source] ?? "runnyknows-console-warn",
      severity: SEVERITY_BY_SOURCE[event.source] ?? "warn",
      filePath: event.pathname || "unknown",
      line: 0,
      message: `[${event.source}] ${event.message}`,
      snippet: event.stack?.split("\n")[0]?.trim() ?? event.message,
      metadata: {
        source: event.source,
        occurrenceCount: event.occurrenceCount,
        component: event.component,
        pathname: event.pathname,
        lastRecordedAt: event.lastRecordedAt,
        stack: event.stack?.slice(0, 500),
      },
    }),
  );

  return {
    failed: findings.some((f) => f.severity === "error"),
    findings,
    jsonPayload: { events: top, totalEvents: events.length },
    report: renderReport(findings, events),
  };
}

export const audit = {
  id: "runnyknows-errors",
  title: "Runnyknows Runtime Errors",
  category: "tests",
  defaultConfig: {
    // Cheap file read; safe in --all. If the ndjson is missing, the check
    // emits nothing and the report is auto-deleted.
    includeInAll: true,
    logPath: DEFAULT_LOG_PATH,
    maxFindings: 50,
    outputPath: "tmp/audits/RUNNYKNOWS_ERRORS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const result = await runRunnyknowsErrorsAudit({
      root: context.root,
      logPath: cfg.logPath,
      maxFindings: cfg.maxFindings,
    });

    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: cfg.outputPath,
    };
  },
};
