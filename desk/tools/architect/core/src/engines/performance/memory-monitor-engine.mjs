/**
 * Memory Monitor Engine — connections-arkitect
 * ==============================================
 * Pure analysis engine for memory monitoring data collected from a
 * running browser session. Takes sample snapshots, network requests,
 * console entries, and heap sampling data, then produces:
 *
 *   - Cold-start timing analysis
 *   - Memory growth rate detection (leak signals)
 *   - DOM node inflation analysis
 *   - Largest/slowest network request surfacing
 *   - Console error/warning summaries
 *
 * The browser lifecycle (launch, navigation, CDP session management)
 * stays in `packages/connections-arkitect/runners/memory-monitor.mjs`. This engine only
 * analyzes the collected data.
 *
 * Consumed by: src/checks/memory-monitor.mjs
 */

/**
 * @typedef {Object} MemorySample
 * @property {string} label - e.g. "cold-start", "t+30s /contacts"
 * @property {number} t - timestamp ms
 * @property {{ jsHeapSizeLimit?: number, totalJSHeapSize?: number, usedJSHeapSize?: number } | null} perfMemory
 * @property {{ Nodes?: number, JSEventListeners?: number, Documents?: number, JSHeapUsedSize?: number } | null} perfMetrics
 */

/**
 * @typedef {Object} NetworkRequest
 * @property {string} url
 * @property {string} method
 * @property {string} type
 * @property {number} startTs
 * @property {number} [status]
 * @property {string} [mimeType]
 * @property {boolean} [fromCache]
 * @property {number} [endTs]
 * @property {number} [duration]
 * @property {number} [encodedSize]
 * @property {boolean} [failed]
 * @property {string} [errorText]
 */

/**
 * Detect memory leak signals from a series of samples.
 * Returns a leak score (0-100) and the growth rate in bytes/sec.
 */
export function analyzeMemoryGrowth(samples) {
  if (samples.length < 3) return { leakScore: 0, growthRateBps: 0, peakHeap: 0, baselineHeap: 0, trend: "insufficient-data" };

  // Use post-GC baseline if available, otherwise first sample
  const baselineIdx = samples.findIndex((s) => s.label === "post-gc-baseline");
  const startIdx = baselineIdx >= 0 ? baselineIdx : 0;
  const endIdx = samples.length - 1;

  const startHeap = samples[startIdx]?.perfMemory?.usedJSHeapSize ?? 0;
  const endHeap = samples[endIdx]?.perfMemory?.usedJSHeapSize ?? 0;
  const elapsed = (samples[endIdx]?.t ?? 0) - (samples[startIdx]?.t ?? 0);

  const peakHeap = Math.max(...samples.map((s) => s.perfMemory?.usedJSHeapSize ?? 0));
  const growthRateBps = elapsed > 0 ? ((endHeap - startHeap) / elapsed) * 1000 : 0;

  // Score: 0 = stable/shrinking, 100 = rapid growth
  let leakScore = 0;
  if (growthRateBps > 1_000_000) leakScore = 100; // >1 MB/s
  else if (growthRateBps > 100_000) leakScore = 75; // >100 KB/s
  else if (growthRateBps > 10_000) leakScore = 40; // >10 KB/s
  else if (growthRateBps > 0) leakScore = 10;

  let trend = "stable";
  if (growthRateBps > 100_000) trend = "rapid-growth";
  else if (growthRateBps > 10_000) trend = "moderate-growth";
  else if (growthRateBps > 0) trend = "slow-growth";
  else if (growthRateBps < -10_000) trend = "shrinking";

  return {
    leakScore,
    growthRateBps: Math.round(growthRateBps),
    peakHeap,
    baselineHeap: startHeap,
    trend,
    sampleCount: samples.length,
    elapsedMs: elapsed,
  };
}

/**
 * Analyze DOM node counts for inflation patterns.
 */
export function analyzeDomGrowth(heapSampling) {
  if (!heapSampling?.domCounts) return { totalNodes: 0, topTags: [], concerns: [] };

  const domCounts = heapSampling.domCounts;
  const totalNodes = Object.values(domCounts).reduce((a, b) => a + b, 0);
  const topTags = Object.entries(domCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const concerns = [];
  if (totalNodes > 10_000) concerns.push(`DOM node count (${totalNodes}) exceeds 10,000 — possible node leak`);
  if (domCounts.div && domCounts.div > 5000) concerns.push(`div count (${domCounts.div}) exceeds 5,000`);
  if (domCounts.span && domCounts.span > 3000) concerns.push(`span count (${domCounts.span}) exceeds 3,000`);

  return { totalNodes, topTags, concerns };
}

/**
 * Analyze storage usage.
 */
export function analyzeStorage(heapSampling) {
  const lsBytes = heapSampling?.lsBytes ?? 0;
  const ssBytes = heapSampling?.ssBytes ?? 0;
  const concerns = [];

  if (lsBytes > 5_000_000) concerns.push(`localStorage (${fmtBytes(lsBytes)}) exceeds 5 MB — near quota`);
  if (ssBytes > 2_000_000) concerns.push(`sessionStorage (${fmtBytes(ssBytes)}) exceeds 2 MB`);

  return { lsBytes, ssBytes, totalBytes: lsBytes + ssBytes, concerns };
}

/**
 * Summarize network requests: slowest, largest, failed.
 */
export function analyzeNetworkRequests(requests) {
  const allReqs = requests.filter((r) => r.endTs || r.failed);

  const slowest = [...allReqs]
    .filter((r) => r.duration != null)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10);

  const largest = [...allReqs]
    .filter((r) => r.encodedSize != null)
    .sort((a, b) => b.encodedSize - a.encodedSize)
    .slice(0, 10);

  const failed = allReqs.filter((r) => r.failed);

  const byType = {};
  for (const r of allReqs) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  return {
    totalRequests: allReqs.length,
    failedCount: failed.length,
    slowest,
    largest,
    failed,
    byType,
  };
}

/**
 * Summarize console entries.
 */
export function analyzeConsole(consoleEntries) {
  const errorCount = consoleEntries.filter((e) => e.type === "error").length;
  const warningCount = consoleEntries.filter((e) => e.type === "warning").length;
  const errorSamples = consoleEntries.filter((e) => e.type === "error").slice(0, 20);
  const warnSamples = consoleEntries.filter((e) => e.type === "warning").slice(0, 10);

  return {
    errorCount,
    warningCount,
    errorSamples,
    warnSamples,
    totalEntries: consoleEntries.length,
  };
}

/**
 * Main engine: given a complete memory monitor dataset, produce
 * structured analysis results.
 *
 * @param {Object} data
 * @param {Array<MemorySample>} data.samples
 * @param {Array<NetworkRequest>} data.networkRequests
 * @param {Array<{type:string, text:string, time:number}>} data.consoleEntries
 * @param {Object} data.heapSampling
 * @param {Object|null} data.navTimings
 * @param {string} data.url
 * @param {string} data.postLoginUrl
 * @param {boolean} data.loggedIn
 * @returns {Object} Structured analysis
 */
export function runMemoryAnalysis(data) {
  const memory = analyzeMemoryGrowth(data.samples || []);
  const dom = analyzeDomGrowth(data.heapSampling);
  const storage = analyzeStorage(data.heapSampling);
  const network = analyzeNetworkRequests(data.networkRequests || []);
  const console_ = analyzeConsole(data.consoleEntries || []);

  return {
    memory,
    dom,
    storage,
    network,
    console: console_,
    navTimings: data.navTimings || null,
    url: data.url,
    postLoginUrl: data.postLoginUrl,
    loggedIn: data.loggedIn,
    sampleCount: data.samples?.length || 0,
  };
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}
