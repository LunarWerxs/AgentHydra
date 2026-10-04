/**
 * E2E Capture Analysis — connections-arkitect check
 * ==================================================
 * Consumes e2e capture data produced by `packages/connections-arkitect/runners/e2e-capture.mjs`
 * and flags performance regressions, broken pages, console errors,
 * and memory issues.
 *
 * Rules:
 *   1. e2e-page-timeout
 *      A page timed out during navigation (>30s). These are likely
 *      broken routes, infinite loading states, or heavy bundles.
 *
 *   2. e2e-slow-dcl
 *      DOM Content Loaded event exceeded 400ms. Indicates slow
 *      initial parse or render-blocking resources.
 *
 *   3. e2e-slow-fcp
 *      First Contentful Paint exceeded 2000ms. Users see a blank
 *      screen for too long.
 *
 *   4. e2e-console-errors
 *      Console errors were emitted during page load. These are
 *      real runtime failures — 500s, missing modules, auth failures.
 *
 *   5. e2e-heap-growth
 *      JS heap grew by more than 150MB across the navigation sequence.
 *      May indicate a memory leak in the SPA router or unreleased
 *      component state.
 *
 *   6. e2e-missing-data
 *      No e2e capture data found. Run `bun packages/connections-arkitect/runners/e2e-capture.mjs`
 *      first, then re-run this check.
 *
 * Because this requires pre-captured e2e data, it is NOT included in
 * `check:github`. Run `packages/connections-arkitect/runners/e2e-capture.mjs` first, then:
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check e2e-capture
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { E2E_STATIC_ROUTES, PERF_THRESHOLDS } from "@saydeploy/architect/engines/e2e/e2e-routes-engine";

const RULES = {
  "e2e-page-timeout": {
    severity: "error",
    description:
      "Page timed out during navigation (>30s). Likely broken route, infinite loading state, or heavy bundle.",
  },
  "e2e-slow-dcl": {
    severity: "warning",
    description: `DOM Content Loaded exceeded ${PERF_THRESHOLDS.slowDclMs}ms. Investigate render-blocking resources or large HTML payload.`,
  },
  "e2e-slow-fcp": {
    severity: "warning",
    description: `First Contentful Paint exceeded ${PERF_THRESHOLDS.slowFcpMs}ms. Users see a blank screen too long.`,
  },
  "e2e-console-errors": {
    severity: "error",
    description:
      "Console errors emitted during page load. Real runtime failures — 500s, missing modules, auth failures.",
  },
  "e2e-heap-growth": {
    severity: "warning",
    description: "JS heap grew significantly across the navigation sequence. Possible SPA memory leak.",
  },
  "e2e-missing-data": {
    severity: "info",
    description: "No e2e capture data found. Run `bun packages/connections-arkitect/runners/e2e-capture.mjs` first.",
  },
};

export const audit = {
  id: "e2e-capture",
  title: "E2E Capture Analysis",
  category: "performance",
  defaultConfig: {
    includeInAll: false,
    /** Relative to repo root — where the capture script writes data */
    dataDir: "tmp/e2e-logs",
    /** If true, fail when any error-severity finding exists */
    failOnError: false,
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const dataDir = path.resolve(root, cfg.dataDir || "tmp/e2e-logs");
    const manifestPath = path.join(dataDir, "manifest.json");
    const perfPath = path.join(dataDir, "performance", "all-pages.json");
    const consolePath = path.join(dataDir, "console", "all-pages-verbose.log");

    if (!existsSync(dataDir) || !existsSync(manifestPath)) {
      return {
        findings: [
          {
            ruleId: "e2e-missing-data",
            severity: RULES["e2e-missing-data"].severity,
            message: `No e2e capture data found at ${dataDir}. Run \`bun packages/connections-arkitect/runners/e2e-capture.mjs\` to capture data first.`,
            filePath: dataDir,
          },
        ],
        filesScanned: 0,
      };
    }

    const findings = [];
    let filesScanned = 0;

    // ── Parse manifest ──────────────────────────────────────────
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      filesScanned++;
    } catch {
      findings.push({
        ruleId: "e2e-missing-data",
        severity: RULES["e2e-missing-data"].severity,
        message: `Cannot parse manifest at ${manifestPath}. Re-run capture.`,
        filePath: manifestPath,
      });
      return { findings, filesScanned };
    }

    // ── Parse performance data ──────────────────────────────────
    let perfPages = [];
    if (existsSync(perfPath)) {
      try {
        perfPages = JSON.parse(readFileSync(perfPath, "utf8"));
        filesScanned++;
      } catch {
        // Non-fatal — perf data is optional
      }
    }

    // ── Parse console log ───────────────────────────────────────
    let consoleLines = [];
    if (existsSync(consolePath)) {
      try {
        consoleLines = readFileSync(consolePath, "utf8").split("\n").filter(Boolean);
        filesScanned++;
      } catch {
        // Non-fatal
      }
    }

    // ── Rule: Missing pages ─────────────────────────────────────
    const capturedLabels = new Set((manifest.pages || []).map((p) => p.label));
    const missingPages = E2E_STATIC_ROUTES.filter((r) => !capturedLabels.has(r.label));
    if (missingPages.length > 0) {
      findings.push({
        ruleId: "e2e-missing-data",
        severity: "warning",
        message: `${missingPages.length} pages not captured: ${missingPages.map((r) => r.path).join(", ")}`,
        filePath: manifestPath,
      });
    }

    // ── Rule: Page timeouts / errors ────────────────────────────
    const errorPages = (manifest.pages || []).filter((p) => p.status === "nav-error" || p.status === "timeout");
    for (const p of errorPages) {
      findings.push({
        ruleId: "e2e-page-timeout",
        severity: RULES["e2e-page-timeout"].severity,
        message: `${p.label} (${p.urlPath || p.route}): ${p.error || p.status}`,
        filePath: manifestPath,
      });
    }

    // ── Rule: Slow DCL ──────────────────────────────────────────
    for (const p of perfPages) {
      if (p.dclMs != null && p.dclMs > PERF_THRESHOLDS.slowDclMs) {
        findings.push({
          ruleId: "e2e-slow-dcl",
          severity: RULES["e2e-slow-dcl"].severity,
          message: `${p.label}: DCL ${p.dclMs}ms (threshold ${PERF_THRESHOLDS.slowDclMs}ms)`,
          filePath: perfPath,
        });
      }
    }

    // ── Rule: Slow FCP ──────────────────────────────────────────
    for (const p of perfPages) {
      if (p.fcpMs != null && p.fcpMs > PERF_THRESHOLDS.slowFcpMs) {
        findings.push({
          ruleId: "e2e-slow-fcp",
          severity: RULES["e2e-slow-fcp"].severity,
          message: `${p.label}: FCP ${p.fcpMs}ms (threshold ${PERF_THRESHOLDS.slowFcpMs}ms)`,
          filePath: perfPath,
        });
      }
    }

    // ── Rule: Console errors ────────────────────────────────────
    const consoleErrors = consoleLines.filter((l) => l.includes("[ERROR]") && !l.includes("ERR_ABORTED"));
    // Group identical errors to avoid noise
    const errorGroups = new Map();
    for (const line of consoleErrors) {
      // Extract just the error message (strip timestamps and URLs)
      const normalized = line.replace(/\[\s*\d+ms\]\s*/, "").replace(/http:\/\/[^\s]+/g, "<url>");
      errorGroups.set(normalized, (errorGroups.get(normalized) || 0) + 1);
    }

    for (const [msg, count] of errorGroups) {
      findings.push({
        ruleId: "e2e-console-errors",
        severity: RULES["e2e-console-errors"].severity,
        message: `[x${count}] ${msg.slice(0, 200)}`,
        filePath: consolePath,
      });
    }

    // ── Rule: Heap growth ───────────────────────────────────────
    const heapValues = perfPages.filter((p) => p.jsHeapSizeMB != null).map((p) => p.jsHeapSizeMB);
    if (heapValues.length >= 2) {
      const firstHeap = heapValues[0];
      const maxHeap = Math.max(...heapValues);
      const growth = maxHeap - firstHeap;
      if (growth > 150) {
        findings.push({
          ruleId: "e2e-heap-growth",
          severity: RULES["e2e-heap-growth"].severity,
          message: `JS heap grew from ${firstHeap}MB to ${maxHeap}MB (+${growth}MB) across ${heapValues.length} pages`,
          filePath: perfPath,
        });
      }
    }

    // ── Summary ─────────────────────────────────────────────────
    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;
    const infoCount = findings.filter((f) => f.severity === "info").length;

    // Add a summary finding
    findings.unshift({
      ruleId: "e2e-missing-data",
      severity: "info",
      message: [
        `E2E capture summary: ${manifest.totalPages || manifest.pages?.length || "?"} pages captured`,
        `${errorPages.length} timeouts/errors`,
        `${perfPages.length} pages with perf data`,
        `${consoleErrors.length} console errors`,
      ].join(" | "),
      filePath: manifestPath,
    });

    return {
      findings,
      filesScanned,
      summary: {
        totalPages: manifest.totalPages || manifest.pages?.length || 0,
        errorPages: errorPages.length,
        perfPages: perfPages.length,
        consoleErrors: consoleErrors.length,
        errorCount,
        warningCount,
        infoCount,
      },
    };
  },
};
