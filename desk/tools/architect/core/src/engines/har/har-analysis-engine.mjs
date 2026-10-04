/**
 * HAR Analysis Engine — connections-arkitect
 * ===========================================
 * Pure analysis engine for HTTP Archive (HAR) files captured by
 * `packages/connections-arkitect/runners/capture-hars.mjs`. Reads HAR JSON, categorizes
 * requests, and surfaces:
 *
 *   - Slow API endpoints (the real prod signal)
 *   - Broken/4xx/5xx responses
 *   - Cross-page slow hotspots
 *   - Third-party origin breakdown
 *   - Eager-import bloat (dev-module count)
 *
 * Vite dev mode notes:
 *   * playwright `recordHar` strips bodySize/transferSize — we read
 *     Content-Length from response headers instead.
 *   * Each .vue / .ts file is its own request in dev; in prod they
 *     collapse to a few bundle chunks. We categorize requests so
 *     dev-module noise doesn't drown out real-app signals.
 *
 * Consumed by: src/checks/har-analysis.mjs
 */

const SLOW_MS = 300;
const VERY_SLOW_MS = 800;
const HUGE_BYTES = 250_000;

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const n = name.toLowerCase();
  const m = headers.find((h) => h?.name?.toLowerCase() === n);
  return m?.value ?? null;
}

function entrySize(entry) {
  const cl = headerValue(entry?.response?.headers, "content-length");
  const n = cl ? Number(cl) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  const bs = entry?.response?.bodySize;
  return typeof bs === "number" && bs > 0 ? bs : 0;
}

export function classify(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = u.host;
  const hostname = u.hostname;
  const pathname = u.pathname;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    if (pathname === "/" || pathname.endsWith(".html")) return "html";
    if (pathname.startsWith("/functions/")) return "api";
    if (
      pathname.startsWith("/@vite") ||
      pathname.startsWith("/@id") ||
      pathname.startsWith("/@fs") ||
      pathname.startsWith("/@react-refresh") ||
      pathname.startsWith("/node_modules/") ||
      pathname.startsWith("/src/") ||
      pathname.includes("__vite_hmr") ||
      pathname.includes("?import") ||
      /\.(vue|ts|tsx|jsx|mjs|cjs|mts|cts)(\?|$)/.test(pathname) ||
      (/\.(svg|png|jpg|jpeg|webp|gif|ico)(\?|$)/.test(pathname) === false &&
        /\.(css|js)(\?|$)/.test(pathname) === true &&
        /\/src\//.test(pathname))
    ) {
      return "dev-module";
    }
    if (/\.(css|js)(\?|$)/.test(pathname)) return "dev-module";
    if (/\.(svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)(\?|$)/.test(pathname)) return "asset-local";
    return "other-local";
  }

  if (host.endsWith("amazonaws.com") || host.includes("lambda-url") || host.includes("execute-api"))
    return "api-remote";
  if (host.endsWith("cloudfront.net")) return "cdn";
  if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") return "fonts";
  if (host === "ui-avatars.com") return "avatars";
  if (host.endsWith("googleapis.com") || host.endsWith("gstatic.com") || host.endsWith("google.com")) return "google";
  return "third-party";
}

export function shortenUrl(u) {
  try {
    const url = new URL(u);
    let p = url.pathname;
    if (p.length > 100) p = `${p.slice(0, 60)}\u2026${p.slice(-30)}`;
    const q = url.search ? `?\u2026(${url.search.length - 1})` : "";
    return `${url.host}${p}${q}`;
  } catch {
    return (u || "").slice(0, 140);
  }
}

/**
 * Summarize a single HAR file into structured metrics.
 */
export function summarizeHar(file, har) {
  const entries = har.log?.entries ?? [];
  const buckets = {
    html: [],
    api: [],
    "api-remote": [],
    "dev-module": [],
    cdn: [],
    fonts: [],
    avatars: [],
    google: [],
    "third-party": [],
    "asset-local": [],
    "other-local": [],
    other: [],
  };
  let totalBytes = 0;
  let totalReqs = 0;
  const broken = [];
  const slow = [];
  const verySlow = [];
  const huge = [];
  const originCounts = new Map();

  for (const e of entries) {
    totalReqs++;
    const t = e.time ?? 0;
    const status = e.response?.status ?? 0;
    const url = e.request?.url ?? "";
    const size = entrySize(e);
    totalBytes += size;
    const cat = classify(url);
    buckets[cat].push(e);
    try {
      originCounts.set(new URL(url).host, (originCounts.get(new URL(url).host) ?? 0) + 1);
    } catch {
      // Ignore malformed request URLs in HAR entries.
    }
    if (status >= 400 || status === 0) broken.push({ url, status, t, cat });
    if (t >= VERY_SLOW_MS) verySlow.push({ url, status, t, cat, size });
    else if (t >= SLOW_MS) slow.push({ url, status, t, cat, size });
    if (size >= HUGE_BYTES) huge.push({ url, size, cat });
  }

  const byCatBytes = {};
  const byCatCount = {};
  const byCatRawCount = {};
  for (const [k, list] of Object.entries(buckets)) {
    byCatRawCount[k] = list.length;
    byCatCount[k] =
      k === "dev-module" ? new Set(list.map((entry) => entry.request?.url ?? "")).size : list.length;
    byCatBytes[k] = list.reduce((s, e) => s + entrySize(e), 0);
  }

  return {
    file,
    totalReqs,
    totalBytes,
    byCatCount,
    byCatRawCount,
    byCatBytes,
    originCounts: [...originCounts.entries()].sort((a, b) => b[1] - a[1]),
    broken,
    slow,
    verySlow,
    huge,
  };
}

/**
 * Find URLs that are slow across multiple pages (cross-page hotspots).
 */
export function crossPageHotspots(summaries) {
  const m = new Map();
  for (const s of summaries) {
    for (const r of [...s.verySlow, ...s.slow]) {
      if (r.cat === "dev-module" || r.cat === "html") continue;
      const key = shortenUrl(r.url);
      if (!m.has(key)) m.set(key, { occurrences: 0, totalMs: 0, maxMs: 0, pages: new Set(), cat: r.cat });
      const v = m.get(key);
      v.occurrences += 1;
      v.totalMs += r.t;
      v.maxMs = Math.max(v.maxMs, r.t);
      v.pages.add(s.file);
    }
  }
  return [...m.entries()].sort((a, b) => b[1].pages.size - a[1].pages.size || b[1].maxMs - a[1].maxMs).slice(0, 50);
}

/**
 * Find broken responses that appear across multiple pages.
 */
export function crossPageBroken(summaries) {
  const m = new Map();
  for (const s of summaries) {
    for (const b of s.broken) {
      const key = `${b.status}|${shortenUrl(b.url)}`;
      if (!m.has(key)) m.set(key, { status: b.status, url: shortenUrl(b.url), pages: new Set(), cat: b.cat });
      m.get(key).pages.add(s.file);
    }
  }
  return [...m.values()].sort((a, b) => b.pages.size - a.pages.size);
}

/**
 * Build an API endpoint latency table across all entries.
 */
export function detailedApiTable(allEntries) {
  const m = new Map();
  for (const { e, page } of allEntries) {
    const cat = classify(e.request.url);
    if (cat !== "api" && cat !== "api-remote") continue;
    const key = shortenUrl(e.request.url);
    if (!m.has(key))
      m.set(key, { url: key, calls: 0, totalMs: 0, maxMs: 0, minMs: Infinity, pages: new Set(), errors: 0 });
    const v = m.get(key);
    v.calls++;
    v.totalMs += e.time ?? 0;
    v.maxMs = Math.max(v.maxMs, e.time ?? 0);
    v.minMs = Math.min(v.minMs, e.time ?? 0);
    v.pages.add(page);
    if ((e.response?.status ?? 0) >= 400 || (e.response?.status ?? 0) === 0) v.errors++;
  }
  return [...m.values()].sort((a, b) => b.maxMs - a.maxMs);
}

/**
 * Build a third-party origin breakdown across all entries.
 */
export function thirdPartyBreakdown(allEntries) {
  const m = new Map();
  for (const { e, page } of allEntries) {
    const cat = classify(e.request.url);
    if (!["cdn", "fonts", "avatars", "google", "third-party", "api-remote"].includes(cat)) continue;
    let host = "?";
    try {
      host = new URL(e.request.url).host;
    } catch {
      // Keep unknown host for malformed request URLs.
    }
    if (!m.has(host)) {
      m.set(host, {
        host,
        cat,
        calls: 0,
        totalMs: 0,
        totalBytes: 0,
        maxMs: 0,
        pageBytes: new Map(),
      });
    }
    const v = m.get(host);
    const size = entrySize(e);
    v.calls++;
    v.totalMs += e.time ?? 0;
    v.totalBytes += size;
    v.maxMs = Math.max(v.maxMs, e.time ?? 0);
    v.pageBytes.set(page, (v.pageBytes.get(page) ?? 0) + size);
  }
  return [...m.values()]
    .map((entry) => {
      const pageByteEntries = [...entry.pageBytes.entries()].sort((a, b) => b[1] - a[1]);
      return {
        ...entry,
        maxPageBytes: pageByteEntries[0]?.[1] ?? 0,
        maxPage: pageByteEntries[0]?.[0] ?? null,
        pageBytes: pageByteEntries,
      };
    })
    .sort((a, b) => b.maxPageBytes - a.maxPageBytes || b.totalBytes - a.totalBytes || b.calls - a.calls);
}

/**
 * Main engine entry point: given a directory of HAR files, produce
 * structured analysis results.
 *
 * @param {{ harDir: string, manifestPath?: string }} opts
 * @returns {Promise<{ summaries: Array, allEntries: Array, hotspots: Array, broken: Array, apiTable: Array, thirdParty: Array }>}
 */
export async function runHarAnalysisEngine({ harDir, manifestPath }) {
  const fs = await import("node:fs");
  const path = await import("node:path");

  let manifest = [];
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      // Invalid manifest should not block analysis.
    }
  }

  if (!fs.existsSync(harDir)) {
    throw new Error(`HAR directory not found: ${harDir}`);
  }

  const files = fs
    .readdirSync(harDir)
    .filter((f) => f.endsWith(".har"))
    .sort();

  if (!files.length) {
    throw new Error(`No .har files found in ${harDir}`);
  }

  const summaries = [];
  const allEntries = [];

  for (const f of files) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(harDir, f), "utf8"));
      summaries.push(summarizeHar(f, json));
      for (const e of json.log?.entries ?? []) allEntries.push({ e, page: f });
    } catch {
      // Skip unparseable HARs
    }
  }

  const hotspots = crossPageHotspots(summaries);
  const broken = crossPageBroken(summaries);
  const apiTable = detailedApiTable(allEntries);
  const thirdParty = thirdPartyBreakdown(allEntries);

  return {
    summaries,
    allEntries,
    hotspots,
    broken,
    apiTable,
    thirdParty,
    manifest,
    fileCount: files.length,
  };
}
