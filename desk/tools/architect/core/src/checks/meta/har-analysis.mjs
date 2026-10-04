/**
 * HAR Analysis — connections-arkitect check
 * ==========================================
 * Consumes HAR files captured by `packages/connections-arkitect/runners/capture-hars.mjs` and
 * flags performance, reliability, and bloat issues.
 *
 * Rules:
 *   1. har-slow-api-endpoint
 *      An API endpoint took >800ms. These are Lambda invocations that
 *      directly impact page readiness.
 *
 *   2. har-broken-response
 *      A request returned 4xx, 5xx, or failed (status 0). Broken requests
 *      waste bandwidth and degrade UX.
 *
 *   3. har-cross-page-hotspot
 *      The same URL is slow on multiple pages — likely a shared dependency
 *      or global fetch that should be cached or optimized.
 *
 *   4. har-eager-import-bloat
 *      A page loads more than 600 dev modules on first paint. In production
 *      these become bundle chunks; high counts mean too much is eagerly
 *      imported before the user can interact.
 *
 *   5. har-large-third-party
 *      A third-party origin accounts for >750 KB on one captured page.
 *
 * Because this requires pre-captured HAR files, it is NOT included in
 * `check:github`. Run `packages/connections-arkitect/runners/capture-hars.mjs` first, then:
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check har-analysis
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { runHarAnalysisEngine } from "@saydeploy/architect/engines/har/har-analysis-engine";

const RULES = {
  "har-slow-api-endpoint": {
    severity: "error",
    description:
      "API endpoint took >800ms. These are Lambda invocations that directly impact page readiness. Investigate cold starts, query performance, or N+1 patterns.",
  },
  "har-broken-response": {
    severity: "error",
    description:
      "Request returned 4xx, 5xx, or failed. Broken requests waste bandwidth, trigger error fallbacks, and degrade UX.",
  },
  "har-cross-page-hotspot": {
    severity: "warning",
    description:
      "Same URL is slow on multiple pages — likely a shared dependency or global fetch that should be cached or optimized.",
  },
  "har-eager-import-bloat": {
    severity: "warning",
    description:
      "Page loads >600 dev modules on first paint. In production these become bundle chunks; reduce eager imports so the critical path is leaner.",
  },
  "har-large-third-party": {
    severity: "warning",
    description:
      "Third-party origin accounts for >750 KB on one captured page. Audit whether this dependency is necessary or can be loaded lazily.",
  },
  "har-missing-data": {
    severity: "warning",
    description:
      "No HAR files found. Run `bun packages/connections-arkitect/runners/capture-hars.mjs --top` for the fast top-10 sweep, or `bun run audit:har:capture` for the full route list.",
  },
};

const VERY_SLOW_MS = 800;
const DEFAULT_BLOAT_MODULE_THRESHOLD = 600;
const DEFAULT_LARGE_THIRD_PARTY_BYTES = 750_000;

export const audit = {
  id: "har-analysis",
  title: "HAR Analysis",
  category: "performance",
  defaultConfig: {
    // Lightweight in --all: just parses HAR files already on disk. The heavy
    // capture step (Playwright with auth) is opt-in via `bun run audit:har:capture`
    // (full sweep, ~30 routes), `node packages/connections-arkitect/runners/capture-hars.mjs --top`
    // (fast: top 10 highest-impact routes).
    includeInAll: true,
    harDir: "tmp/har-audit/hars",
    manifestPath: "tmp/har-audit/manifest.json",
    refreshCommand: "node packages/connections-arkitect/runners/capture-hars.mjs --public",
    outputPath: "tmp/audits/HAR_ANALYSIS_AUDIT.md",
    // Substrings to match against broken-response URLs; matching URLs are
    // excluded from the har-broken-response rule. Useful for endpoints that
    // are expected to return 4xx in local dev (e.g. /auth/me proxied to AWS
    // API Gateway which cannot validate localhost sessions).
    ignoreBrokenUrls: ["/auth/refresh"],
    // Max dev-module count per page before triggering har-eager-import-bloat.
    // In Vite dev mode every .vue/.ts file is a separate request; production
    // builds collapse these into a few chunks. Raise this for large codebases.
    bloatModuleThreshold: DEFAULT_BLOAT_MODULE_THRESHOLD,
    // Max bytes from a single third-party origin on one captured page before
    // triggering har-large-third-party. HAR capture uses isolated page contexts,
    // so summing shared font/CDN assets across pages would double-count cacheable
    // resources that a real browser session downloads once.
    largeThirdPartyBytes: DEFAULT_LARGE_THIRD_PARTY_BYTES,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const harDir = path.resolve(root, cfg.harDir || "tmp/har-audit/hars");
    const manifestPath = path.resolve(root, cfg.manifestPath || "tmp/har-audit/manifest.json");

    if (!existsSync(harDir)) {
      const missingFindings = [
        {
          ruleId: "har-missing-data",
          severity: "warning",
          message:
            `No HAR data on disk at \`${cfg.harDir}\`. ` +
            `Run \`${cfg.refreshCommand}\` to capture the top-10 routes (fast), ` +
            `or \`bun run audit:har:capture\` for the full ~30-route sweep.`,
          filePath: harDir,
        },
      ];
      return {
        findings: missingFindings,
        filesScanned: 0,
        report: renderHarReport({
          findings: missingFindings,
          analysis: null,
          harDir,
          refreshCommand: cfg.refreshCommand,
        }),
        outputPath: cfg.outputPath,
      };
    }

    let analysis;
    try {
      analysis = await runHarAnalysisEngine({ harDir, manifestPath });
    } catch (err) {
      const errFindings = [
        {
          ruleId: "har-missing-data",
          severity: RULES["har-missing-data"].severity,
          message: `HAR analysis failed: ${err.message}`,
          filePath: harDir,
        },
      ];
      return {
        findings: errFindings,
        filesScanned: 0,
        report: renderHarReport({ findings: errFindings, analysis: null, harDir, refreshCommand: cfg.refreshCommand }),
        outputPath: cfg.outputPath,
      };
    }

    const findings = [];

    // Slow API endpoints
    for (const entry of analysis.apiTable) {
      if (entry.maxMs >= VERY_SLOW_MS) {
        findings.push({
          ruleId: "har-slow-api-endpoint",
          severity: RULES["har-slow-api-endpoint"].severity,
          message: `API ${entry.url}: max=${Math.round(entry.maxMs)}ms avg=${Math.round(entry.totalMs / entry.calls)}ms calls=${entry.calls} pages=${entry.pages.size} errors=${entry.errors}`,
          filePath: entry.url,
          line: 0,
        });
      }
    }

    // Broken responses (skip URLs matching ignoreBrokenUrls patterns)
    const ignorePatterns = cfg.ignoreBrokenUrls || [];
    for (const b of analysis.broken) {
      if (ignorePatterns.some((pattern) => b.url.includes(pattern))) continue;
      findings.push({
        ruleId: "har-broken-response",
        severity: RULES["har-broken-response"].severity,
        message: `${b.status || "ERR"} (${b.cat}) ${b.url} — on ${b.pages.size} page(s)`,
        filePath: b.url,
        line: 0,
      });
    }

    // Cross-page hotspots. API latency already has a dedicated endpoint-level
    // gate above. HAR route capture uses fresh browser contexts, so warning on
    // sub-threshold local APIs just means "every cold deep link bootstraps the
    // workspace" rather than "a user repeatedly pays this during one session."
    for (const [, v] of analysis.hotspots) {
      if ((v.cat === "api" || v.cat === "api-remote") && v.maxMs < VERY_SLOW_MS) {
        continue;
      }
      if (v.pages.size >= 2) {
        findings.push({
          ruleId: "har-cross-page-hotspot",
          severity: RULES["har-cross-page-hotspot"].severity,
          message: `Hotspot (${v.cat}): max=${Math.round(v.maxMs)}ms total=${Math.round(v.totalMs)}ms across ${v.pages.size} pages`,
          filePath: v.cat,
          line: 0,
        });
      }
    }

    // Eager-import bloat
    const bloatThreshold =
      typeof cfg.bloatModuleThreshold === "number" ? cfg.bloatModuleThreshold : DEFAULT_BLOAT_MODULE_THRESHOLD;
    for (const s of analysis.summaries) {
      const devModules = s.byCatCount["dev-module"] || 0;
      if (devModules > bloatThreshold) {
        findings.push({
          ruleId: "har-eager-import-bloat",
          severity: RULES["har-eager-import-bloat"].severity,
          message: `${s.file}: ${devModules} dev modules on first paint (threshold: ${bloatThreshold}). Reduce eager imports.`,
          filePath: s.file,
          line: 0,
        });
      }
    }

    // Large third-party. Use the max single-page weight rather than aggregate
    // bytes because each HAR route is captured in a fresh browser context.
    const largeThirdPartyThreshold =
      typeof cfg.largeThirdPartyBytes === "number" ? cfg.largeThirdPartyBytes : DEFAULT_LARGE_THIRD_PARTY_BYTES;
    for (const tp of analysis.thirdParty) {
      if (tp.maxPageBytes > largeThirdPartyThreshold) {
        findings.push({
          ruleId: "har-large-third-party",
          severity: RULES["har-large-third-party"].severity,
          message: `${tp.host} (${tp.cat}): max page ${(tp.maxPageBytes / 1024).toFixed(0)} KB on ${tp.maxPage ?? "unknown"} (${(tp.totalBytes / 1024).toFixed(0)} KB across ${tp.calls} calls), max latency ${Math.round(tp.maxMs)}ms`,
          filePath: tp.host,
          line: 0,
        });
      }
    }

    return {
      findings,
      filesScanned: analysis.fileCount,
      metadata: {
        harDir,
        fileCount: analysis.fileCount,
        totalRequests: analysis.summaries.reduce((s, sum) => s + sum.totalReqs, 0),
      },
      report: renderHarReport({ findings, analysis, harDir, refreshCommand: cfg.refreshCommand }),
      outputPath: cfg.outputPath,
    };
  },
};

function renderHarReport({ findings, analysis, harDir: _harDir, refreshCommand }) {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;
  const totalRequests = analysis?.summaries?.reduce((s, sum) => s + sum.totalReqs, 0) ?? 0;

  const lines = [
    "# HAR Analysis",
    "",
    `- **HAR files analyzed:** ${analysis?.fileCount ?? 0}`,
    `- **Total requests:** ${totalRequests}`,
    `- **Errors:** ${errorCount}`,
    `- **Warnings:** ${warnCount}`,
    `- **Refresh:** \`${refreshCommand}\``,
    "",
  ];

  if (findings.length === 0) {
    lines.push(
      "Clean — no slow APIs, broken responses, hotspots, eager-import bloat, or large third-parties detected.",
    );
    lines.push("");
    lines.push(`Errors: ${errorCount}`);
    lines.push(`Warnings: ${warnCount}`);
    return lines.join("\n");
  }

  // Group by ruleId so the runner counts severities per heading.
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }

  for (const [ruleId, ruleFindings] of byRule) {
    const groupErrors = ruleFindings.filter((f) => f.severity === "error").length;
    const groupWarnings = ruleFindings.length - groupErrors;
    const severityLabel = groupErrors > 0 ? "error" : "warning";
    lines.push(`## ${ruleId} — ${ruleFindings.length} (${severityLabel})`);
    lines.push("");
    lines.push(`- Errors: ${groupErrors}`);
    lines.push(`- Warnings: ${groupWarnings}`);
    lines.push("");
    for (const f of ruleFindings) {
      const location = f.filePath ? ` \`${f.filePath}\`` : "";
      lines.push(`- **${f.severity.toUpperCase()}**${location} — ${f.message}`);
    }
    lines.push("");
  }

  lines.push(`Errors: ${errorCount}`);
  lines.push(`Warnings: ${warnCount}`);
  return lines.join("\n");
}

export const metadata = {
  rules: RULES,
};
