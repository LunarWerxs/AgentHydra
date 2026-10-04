/**
 * Browser Performance Metrics Engine — connections-arkitect
 * ==========================================================
 * Pure engine for collecting browser performance metrics from a
 * loaded page. Designed to be called with a Playwright `page` object
 * that has already navigated to the target URL.
 *
 * Returns Core Web Vitals, resource waterfall summary, JS heap size,
 * and slowest resources.
 *
 * Does NOT launch browsers or manage page lifecycle — that stays in
 * `packages/connections-arkitect/runners/browser-perf-audit.mjs`.
 *
 * Consumed by: src/checks/browser-perf.mjs
 */

/**
 * Collect performance metrics from a Playwright page that has already
 * navigated to the target URL.
 *
 * @param {{ evaluate: (fn: Function) => Promise<any> }} page - Playwright page object
 * @returns {Promise<object>} Structured performance metrics
 */
export async function collectPageMetrics(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByType("paint");
    const resources = performance.getEntriesByType("resource");
    const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
    const lsEntries = performance.getEntriesByType("layout-shift");
    const longTasks = performance.getEntriesByType("longtask");
    const mem = performance.memory || {};

    const byType = {};
    let totalTransfer = 0;
    for (const r of resources) {
      byType[r.initiatorType] = (byType[r.initiatorType] || 0) + 1;
      totalTransfer += r.transferSize || 0;
    }

    const slowest = [...resources]
      .filter((r) => r.duration > 100)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10)
      .map((r) => ({
        url: r.name.length > 120 ? r.name.slice(-120) : r.name,
        duration: Math.round(r.duration),
        type: r.initiatorType,
        transferSize: r.transferSize,
      }));

    return {
      url: location.href,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
      loadComplete: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
      ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
      firstPaint: Math.round(paint.find((p) => p.name === "first-paint")?.startTime || 0),
      fcp: Math.round(paint.find((p) => p.name === "first-contentful-paint")?.startTime || 0),
      lcp: lcpEntries.length ? Math.round(lcpEntries[lcpEntries.length - 1].startTime) : null,
      cls: Math.round((lsEntries.reduce((s, e) => s + (e.value || 0), 0) || 0) * 1000) / 1000,
      resourceCount: resources.length,
      totalTransferKB: Math.round(totalTransfer / 1024),
      byType,
      longTaskCount: longTasks.length,
      jsHeapMB: mem.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null,
      slowestResources: slowest.slice(0, 5),
    };
  });
}

/**
 * Page definitions for a standard audit run.
 */
export const DEFAULT_AUDIT_PAGES = [
  { name: "explore", path: "/explore" },
  { name: "signin", path: "/signin" },
  { name: "landing", path: "/" },
];

/**
 * Collect metrics from multiple pages using the provided Playwright page.
 *
 * @param {object} page - Playwright page object
 * @param {string} baseUrl - Base URL (e.g. http://localhost:4173)
 * @param {Array<{name: string, path: string}>} pages - Pages to audit
 * @param {number} settleMs - Wait time after load for lazy content (default 2000)
 * @returns {Promise<Array>} Array of { page, ...metrics } or { page, error }
 */
export async function collectMultiPageMetrics(page, baseUrl, pages = DEFAULT_AUDIT_PAGES, settleMs = 2000) {
  const results = [];

  for (const { name, path: pagePath } of pages) {
    try {
      await page.goto(`${baseUrl}${pagePath}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(settleMs);

      const metrics = await collectPageMetrics(page);
      results.push({ page: name, ...metrics });
    } catch (err) {
      results.push({ page: name, error: err.message });
    }
  }

  return results;
}

/**
 * Build a metrics report envelope matching the format expected by
 * the browser-perf arkitect check.
 *
 * @param {string} baseUrl
 * @param {Array} results - from collectMultiPageMetrics
 * @returns {object}
 */
export function buildMetricsReport(baseUrl, results) {
  return {
    tool: "browser-performance-metrics",
    timestamp: new Date().toISOString(),
    baseUrl,
    results,
  };
}
