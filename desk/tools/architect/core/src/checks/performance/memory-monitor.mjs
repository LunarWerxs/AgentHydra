/**
 * Memory Monitor — connections-arkitect check
 * ============================================
 * Consumes a memory monitor dataset (JSON) produced by
 * `packages/connections-arkitect/runners/memory-monitor.mjs` and flags memory leaks,
 * DOM inflation, storage bloat, and network issues.
 *
 * Rules:
 *   1. memory-rapid-growth — JS heap growing >100 KB/s (score ≥75)
 *   2. memory-moderate-growth — JS heap growing >10 KB/s (score ≥40)
 *   3. memory-dom-inflation — DOM node count >10,000
 *   4. memory-storage-bloat — localStorage >5 MB or sessionStorage >2 MB
 *   5. memory-network-failures — failed network requests detected
 *   6. memory-console-errors — console errors during monitoring
 *
 * Requires pre-collected data. Run `bun packages/connections-arkitect/runners/memory-monitor.mjs` first.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check memory-monitor
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runMemoryAnalysis } from "@saydeploy/architect/engines/performance/memory-monitor-engine";

const RULES = {
  "memory-rapid-growth": {
    severity: "error",
    description:
      "JS heap growing >100 KB/s — strong leak signal. Check for unretained event listeners, growing caches, or subscription accumulation.",
  },
  "memory-moderate-growth": {
    severity: "warning",
    description: "JS heap growing >10 KB/s — possible slow leak. Monitor over longer runs and check component teardown.",
  },
  "memory-dom-inflation": {
    severity: "warning",
    description: "DOM node count exceeds 10,000 — potential node leak. Check for unremoved tooltips, modals, or list items.",
  },
  "memory-storage-bloat": {
    severity: "warning",
    description: "localStorage or sessionStorage approaching quota. Audit stored keys and evict stale entries.",
  },
  "memory-network-failures": {
    severity: "error",
    description: "Failed network requests during monitoring. Check connectivity, CORS, or API availability.",
  },
  "memory-console-errors": {
    severity: "error",
    description: "Console errors detected during monitoring. These may correlate with memory issues or broken functionality.",
  },
  "memory-missing-data": {
    severity: "info",
    description: "No memory monitor data found. Run `bun packages/connections-arkitect/runners/memory-monitor.mjs` first.",
  },
};

const DEFAULT_DATA_PATH = "tmp/audits/memory-monitor-data.json";

export const audit = {
  id: "memory-monitor",
  title: "Memory Monitor",
  category: "performance",
  defaultConfig: {
    includeInAll: false,
    dataPath: DEFAULT_DATA_PATH,
    outputPath: "tmp/audits/MEMORY_MONITOR_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const dataPath = path.resolve(context.root, cfg.dataPath || DEFAULT_DATA_PATH);

    if (!existsSync(dataPath)) {
      return {
        findings: [
          {
            ruleId: "memory-missing-data",
            severity: RULES["memory-missing-data"].severity,
            message: `No data file at ${dataPath}. Run \`bun packages/connections-arkitect/runners/memory-monitor.mjs\` first.`,
            filePath: dataPath,
          },
        ],
        filesScanned: 0,
      };
    }

    let data;
    try {
      data = JSON.parse(readFileSync(dataPath, "utf8"));
    } catch {
      return {
        findings: [
          {
            ruleId: "memory-missing-data",
            severity: RULES["memory-missing-data"].severity,
            message: `Failed to parse ${dataPath}. Delete and re-run the monitor.`,
            filePath: dataPath,
          },
        ],
        filesScanned: 0,
      };
    }

    const analysis = runMemoryAnalysis(data);
    const findings = [];

    // Memory growth
    if (analysis.memory.leakScore >= 75) {
      findings.push({
        ruleId: "memory-rapid-growth",
        severity: RULES["memory-rapid-growth"].severity,
        message: `Heap growing at ${(analysis.memory.growthRateBps / 1024).toFixed(0)} KB/s (score=${analysis.memory.leakScore}). Peak: ${(analysis.memory.peakHeap / 1024 / 1024).toFixed(1)} MB. ${RULES["memory-rapid-growth"].description}`,
        filePath: dataPath,
        line: 0,
      });
    } else if (analysis.memory.leakScore >= 40) {
      findings.push({
        ruleId: "memory-moderate-growth",
        severity: RULES["memory-moderate-growth"].severity,
        message: `Heap growing at ${(analysis.memory.growthRateBps / 1024).toFixed(0)} KB/s (score=${analysis.memory.leakScore}). Trend: ${analysis.memory.trend}.`,
        filePath: dataPath,
        line: 0,
      });
    }

    // DOM inflation
    if (analysis.dom.totalNodes > 10_000) {
      findings.push({
        ruleId: "memory-dom-inflation",
        severity: RULES["memory-dom-inflation"].severity,
        message: `${analysis.dom.totalNodes} DOM nodes. Top tags: ${analysis.dom.topTags.slice(0, 5).map(([tag, n]) => `${tag}=${n}`).join(", ")}. ${analysis.dom.concerns.join("; ")}`,
        filePath: dataPath,
        line: 0,
      });
    }

    // Storage bloat
    if (analysis.storage.totalBytes > 5_000_000) {
      findings.push({
        ruleId: "memory-storage-bloat",
        severity: RULES["memory-storage-bloat"].severity,
        message: `Storage: localStorage=${(analysis.storage.lsBytes / 1024).toFixed(0)} KB, sessionStorage=${(analysis.storage.ssBytes / 1024).toFixed(0)} KB. ${analysis.storage.concerns.join("; ")}`,
        filePath: dataPath,
        line: 0,
      });
    }

    // Network failures
    if (analysis.network.failedCount > 0) {
      findings.push({
        ruleId: "memory-network-failures",
        severity: RULES["memory-network-failures"].severity,
        message: `${analysis.network.failedCount} failed requests out of ${analysis.network.totalRequests} total.`,
        filePath: dataPath,
        line: 0,
      });
    }

    // Console errors
    if (analysis.console.errorCount > 0) {
      findings.push({
        ruleId: "memory-console-errors",
        severity: RULES["memory-console-errors"].severity,
        message: `${analysis.console.errorCount} console errors, ${analysis.console.warningCount} warnings.`,
        filePath: dataPath,
        line: 0,
      });
    }

    return {
      findings,
      filesScanned: analysis.sampleCount,
      metadata: {
        url: analysis.url,
        loggedIn: analysis.loggedIn,
        leakScore: analysis.memory.leakScore,
        peakHeap: analysis.memory.peakHeap,
      },
    };
  },
};

export const metadata = {
  rules: RULES,
};
