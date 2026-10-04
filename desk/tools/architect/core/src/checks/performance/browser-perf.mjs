/**
 * Browser Performance Audit — connections-arkitect check
 * =======================================================
 * Consumes the output of `bun packages/connections-arkitect/runners/browser-perf-audit.mjs` and
 * surfaces performance regressions as arkitect findings.
 *
 * Metrics checked:
 *   1. perf-slow-fcp
 *      First Contentful Paint > 2500ms. Flags when the page takes too long
 *      to render the first visible content.
 *
 *   2. perf-high-resource-count
 *      More than 300 resources loaded on a single page. In dev this is
 *      expected (unbundled modules); in production each extra resource is a
 *      round-trip. Run against a production build for accurate signal.
 *
 *   3. perf-large-js-heap
 *      JS heap > 500 MB. Indicates a potential memory leak or excessive
 *      retained objects.
 *
 *   4. perf-slow-resource
 *      Any single resource load > 3000ms. Surfaces slow API calls, large
 *      bundles, or network issues.
 *
 *   5. perf-high-cls
 *      Cumulative Layout Shift > 0.25. Indicates unstable layouts that
 *      harm user experience.
 *
 *   6. perf-long-tasks
 *      More than 5 long tasks (>50ms) detected. Long tasks block the main
 *      thread and cause jank.
 *
 * Because this is a dynamic check that requires the dev server to be
 * running, it is NOT included in `check:github` — it runs separately via
 * `bun run audit:browser-perf` or `bun run audit:browser-perf:metrics`.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check browser-perf
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const RULES = {
  "perf-slow-fcp": {
    severity: "error",
    description:
      "First Contentful Paint exceeds 2500ms threshold. Consider reducing render-blocking resources, optimizing the critical rendering path, or code-splitting the entry point.",
  },
  "perf-high-resource-count": {
    severity: "warning",
    description:
      "Page loads more than 300 resources. In production, each resource is a round-trip. Bundle modules, use code splitting, and audit for duplicate or unnecessary fetches.",
  },
  "perf-large-js-heap": {
    severity: "warning",
    description:
      "JavaScript heap exceeds 500 MB. Investigate memory leaks, retained DOM nodes, or excessive observable subscriptions.",
  },
  "perf-slow-resource": {
    severity: "error",
    description:
      "A resource took more than 3000ms to load. This blocks page readiness. Check the URL — it may be an unresponsive API endpoint or an oversized bundle.",
  },
  "perf-high-cls": {
    severity: "error",
    description:
      "Cumulative Layout Shift exceeds 0.25. Layout shifts harm user experience and Core Web Vitals. Reserve space for images, embeds, and dynamically-loaded content.",
  },
  "perf-long-tasks": {
    severity: "warning",
    description:
      "More than 5 long tasks (>50ms) detected. Long tasks block the main thread. Break up expensive synchronous work or move it off the main thread.",
  },
  "perf-missing-metrics": {
    severity: "info",
    description:
      "No browser performance metrics found. Run `bun run audit:browser-perf:metrics` first to collect data, then re-run this check.",
  },
};

const DEFAULT_METRICS_PATH = "tmp/browser-perf-audit/metrics.json";

const THRESHOLDS = {
  fcp: 2500, // ms — "needs improvement" per Lighthouse
  lcp: 2500, // ms — Core Web Vital threshold
  cls: 0.25, // score — "poor" per Web Vitals
  resourceCount: 300, // files
  jsHeapMB: 500, // MB
  slowResourceMs: 3000, // ms
  longTaskCount: 5, // tasks
};

export const audit = {
  id: "browser-perf",
  title: "Browser Performance Audit",
  category: "performance",
  defaultConfig: {
    includeInAll: false, // requires dev server + browser, not for CI
    metricsPath: DEFAULT_METRICS_PATH,
    outputPath: "tmp/audits/BROWSER_PERF_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const metricsPath = path.resolve(context.root, cfg.metricsPath || DEFAULT_METRICS_PATH);

    if (!existsSync(metricsPath)) {
      return {
        findings: [
          {
            ruleId: "perf-missing-metrics",
            severity: RULES["perf-missing-metrics"].severity,
            message: `No metrics file found at ${metricsPath}. Run \`bun run audit:browser-perf:metrics\` first.`,
            filePath: metricsPath,
          },
        ],
        filesScanned: 0,
      };
    }

    let report;
    try {
      report = JSON.parse(readFileSync(metricsPath, "utf8"));
    } catch {
      return {
        findings: [
          {
            ruleId: "perf-missing-metrics",
            severity: RULES["perf-missing-metrics"].severity,
            message: `Failed to parse metrics file at ${metricsPath}. Delete it and re-run \`bun run audit:browser-perf:metrics\`.`,
            filePath: metricsPath,
          },
        ],
        filesScanned: 0,
      };
    }

    const findings = [];
    const results = report.results || [];

    for (const pageResult of results) {
      if (pageResult.error) {
        findings.push({
          ruleId: "perf-missing-metrics",
          severity: "error",
          message: `Page "${pageResult.page}" failed to collect metrics: ${pageResult.error}`,
          filePath: pageResult.url || pageResult.page,
        });
        continue;
      }

      const page = pageResult.page || pageResult.url || "unknown";

      // FCP check
      if (pageResult.fcp && pageResult.fcp > THRESHOLDS.fcp) {
        findings.push({
          ruleId: "perf-slow-fcp",
          severity: RULES["perf-slow-fcp"].severity,
          message: `${page}: FCP = ${pageResult.fcp}ms (threshold: ${THRESHOLDS.fcp}ms). ${RULES["perf-slow-fcp"].description}`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // LCP check
      if (pageResult.lcp && pageResult.lcp > THRESHOLDS.lcp) {
        findings.push({
          ruleId: "perf-slow-lcp",
          severity: "error",
          message: `${page}: LCP = ${pageResult.lcp}ms (threshold: ${THRESHOLDS.lcp}ms). Largest Contentful Paint is too slow.`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // CLS check
      if (pageResult.cls != null && pageResult.cls > THRESHOLDS.cls) {
        findings.push({
          ruleId: "perf-high-cls",
          severity: RULES["perf-high-cls"].severity,
          message: `${page}: CLS = ${pageResult.cls} (threshold: ${THRESHOLDS.cls}). ${RULES["perf-high-cls"].description}`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // Resource count
      if (pageResult.resourceCount > THRESHOLDS.resourceCount) {
        findings.push({
          ruleId: "perf-high-resource-count",
          severity: RULES["perf-high-resource-count"].severity,
          message: `${page}: ${pageResult.resourceCount} resources loaded (threshold: ${THRESHOLDS.resourceCount}). ${RULES["perf-high-resource-count"].description}`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // JS Heap
      if (pageResult.jsHeapMB && pageResult.jsHeapMB > THRESHOLDS.jsHeapMB) {
        findings.push({
          ruleId: "perf-large-js-heap",
          severity: RULES["perf-large-js-heap"].severity,
          message: `${page}: JS heap = ${pageResult.jsHeapMB} MB (threshold: ${THRESHOLDS.jsHeapMB} MB). ${RULES["perf-large-js-heap"].description}`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // Long tasks
      if (pageResult.longTaskCount && pageResult.longTaskCount > THRESHOLDS.longTaskCount) {
        findings.push({
          ruleId: "perf-long-tasks",
          severity: RULES["perf-long-tasks"].severity,
          message: `${page}: ${pageResult.longTaskCount} long tasks detected (threshold: ${THRESHOLDS.longTaskCount}). ${RULES["perf-long-tasks"].description}`,
          filePath: metricsPath,
          line: 0,
        });
      }

      // Slow individual resources
      if (pageResult.slowestResources) {
        for (const res of pageResult.slowestResources) {
          if (res.duration > THRESHOLDS.slowResourceMs) {
            findings.push({
              ruleId: "perf-slow-resource",
              severity: RULES["perf-slow-resource"].severity,
              message: `${page}: ${res.type} resource took ${res.duration}ms — ${res.url}`,
              filePath: res.url,
              line: 0,
            });
          }
        }
      }
    }

    return {
      findings,
      filesScanned: results.length,
      metadata: {
        timestamp: report.timestamp,
        baseUrl: report.baseUrl,
        pagesTested: results.map((r) => r.page || r.url).filter(Boolean),
      },
    };
  },
};

export const metadata = {
  rules: RULES,
  thresholds: THRESHOLDS,
};
