/**
 * E2E Routes Engine — connections-arkitect
 * =========================================
 * Canonical route definitions for comprehensive e2e page capture.
 *
 * Mirrors the HAR capture routes engine but includes additional pages
 * and metadata for performance tracing, console collection, and
 * screenshot capture.
 *
 * Consumed by:
 *   - packages/connections-arkitect/runners/e2e-capture.mjs (the capture runner)
 *   - src/checks/e2e/e2e-capture.mjs (the analysis check)
 */

/**
 * Static routes — no parameters needed. Every route is visited.
 *
 * Organized by category for readability; the capture script visits
 * them in order so the JS heap profile tells a story.
 */
export const E2E_STATIC_ROUTES = [
  // ── Workspace shell (auth required) ──────────────────────────
  { path: "/", label: "root", category: "workspace" },
  { path: "/calendar", label: "calendar", category: "workspace" },
  { path: "/calendar/host", label: "calendar-host", category: "workspace" },
  { path: "/events", label: "events", category: "workspace" },
  { path: "/host", label: "host", category: "workspace" },
  { path: "/bookings", label: "bookings", category: "workspace" },
  { path: "/map", label: "map", category: "workspace" },
  { path: "/fixes", label: "fixes", category: "workspace" },
  { path: "/import", label: "import", category: "workspace" },
  { path: "/trash", label: "trash", category: "workspace" },
  { path: "/myconnect", label: "myconnect", category: "workspace" },
  { path: "/forms", label: "forms", category: "workspace" },
  { path: "/communities", label: "communities", category: "workspace" },
  { path: "/ai", label: "ai", category: "workspace" },
  { path: "/admin", label: "admin", category: "workspace" },
  { path: "/admin/fixes", label: "admin-fixes", category: "workspace" },
  { path: "/dev", label: "dev", category: "workspace" },
  { path: "/feedback", label: "feedback", category: "workspace" },
  // ── Account pages ────────────────────────────────────────────
  { path: "/account/billing", label: "account-billing", category: "account" },
  { path: "/account/subscriptions", label: "account-subscriptions", category: "account" },
  // ── Public / marketing ───────────────────────────────────────
  { path: "/explore", label: "explore", category: "public" },
  { path: "/explore/browse", label: "explore-browse", category: "public" },
  { path: "/pricing", label: "pricing", category: "public" },
  { path: "/calendly-alternative", label: "booking-landing", category: "public" },
  { path: "/demo", label: "demo", category: "public" },
  { path: "/intelligence", label: "intelligence", category: "public" },
  { path: "/welcome", label: "welcome", category: "public" },
];

/**
 * Parameterized route discovery rules.
 * Each entry visits a list page and scrapes the first matching link
 * to discover one real parameterized page instance.
 */
export const E2E_PARAM_DISCOVERY = [
  { listPath: "/contacts", pattern: "/contacts/", label: "contact-detail" },
  { listPath: "/events", pattern: "/events/", label: "event-detail" },
  { listPath: "/calendar", pattern: "/calendars/", label: "calendar-detail" },
  { listPath: "/bookings", pattern: "/bookings/", label: "booking-detail" },
  { listPath: "/forms", pattern: "/forms/", label: "form-detail" },
  { listPath: "/communities", pattern: "/communities/", label: "community-detail" },
  { listPath: "/feedback", pattern: "/feedback/", label: "feedback-detail" },
  { listPath: "/trash", pattern: "/trash/", label: "trash-detail" },
  { listPath: "/explore", pattern: "/e/", label: "hosted-event-public" },
];

/**
 * Convert a URL path to a safe filename slug.
 */
export function safeE2eName(urlPath) {
  if (urlPath === "/") return "root";
  return (
    urlPath
      .replace(/^\/+/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 120) || "root"
  );
}

/**
 * Build the full target list: static routes + discovered param URLs.
 */
export function buildE2eTargets(discoveredParams = {}) {
  const staticTargets = E2E_STATIC_ROUTES.map((r) => ({
    urlPath: r.path,
    label: r.label,
    category: r.category,
  }));
  const paramTargets = Object.entries(discoveredParams).map(([label, urlPath]) => ({
    urlPath,
    label,
    category: "param",
  }));
  return [...staticTargets, ...paramTargets];
}

/**
 * Performance thresholds for reporting.
 */
export const PERF_THRESHOLDS = {
  /** DCL above this is flagged as slow (ms) */
  slowDclMs: 400,
  /** FCP above this is flagged as slow (ms) */
  slowFcpMs: 2000,
  /** Navigation timeout (ms) */
  navTimeoutMs: 30_000,
  /** Network idle timeout (ms) */
  netIdleTimeoutMs: 20_000,
  /** Extra quiet wait after load (ms) */
  quietMs: 2_500,
};

/**
 * Default output base directory (relative to repo root).
 */
export const DEFAULT_OUT_DIR = "tmp/e2e-logs";
