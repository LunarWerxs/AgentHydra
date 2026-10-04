/**
 * HAR Capture Route Engine — connections-arkitect
 * =================================================
 * Defines the canonical route lists and discovery rules used by
 * `packages/connections-arkitect/runners/capture-hars.mjs` for HAR-based auditing.
 *
 * Keeping route definitions here ensures the arkitect HAR analysis
 * check knows exactly which routes are expected in the HAR directory,
 * and prevents drift between the capture script and the analysis.
 *
 * Consumed by: packages/connections-arkitect/runners/capture-hars.mjs, src/checks/har-analysis.mjs
 */

/**
 * Static routes to capture — no parameters needed.
 */
export const HAR_STATIC_ROUTES = [
  // Public / marketing
  "/explore",
  "/explore-legacy",
  "/pricing",
  "/calendly-alternative",
  "/billing/success",
  "/account/billing",
  "/account/subscriptions",
  // Workspace shell (auth required)
  "/",
  "/feedback",
  "/map",
  "/events",
  "/host",
  "/calendar",
  "/calendar/host",
  "/bookings",
  "/fixes",
  "/import",
  "/trash",
  "/myconnect",
  "/forms",
  "/communities",
  "/ai",
  "/admin",
  "/admin/fixes",
  "/dev",
];

/**
 * Public routes that do not require a saved auth storage state.
 *
 * Used by `capture-hars.mjs --public` so CI/AI sessions can refresh HAR data
 * without blocking on an interactive login.
 */
export const HAR_PUBLIC_ROUTES = [
  "/explore",
  "/explore-legacy",
  "/pricing",
  "/calendly-alternative",
  "/billing/success",
];

/**
 * Top-10 routes used by the `--top` fast HAR capture mode.
 *
 * The picks intentionally cover the highest-impact surfaces:
 *   - Workspace shell `/` (default landing after login)
 *   - Public funnel: `/explore`, `/pricing`
 *   - Heaviest workspace surfaces: `/events`, `/host`, `/calendar`, `/forms`,
 *     `/communities`, `/ai`
 *   - Billing surface
 *
 * Use the `--top` flag on `bun packages/connections-arkitect/runners/capture-hars.mjs` to record
 * just these routes. Useful when the AI needs a heaviness check without the
 * 30+ route full sweep.
 */
export const HAR_TOP_ROUTES = [
  "/",
  "/explore",
  "/pricing",
  "/events",
  "/host",
  "/calendar",
  "/forms",
  "/communities",
  "/ai",
  "/account/billing",
];

/**
 * Parameterized route discovery: each entry lists a page to visit and
 * a link pattern to match for discovering one real instance.
 */
export const HAR_PARAM_DISCOVERY = [
  { listPath: "/", pattern: /^\/contacts\/[^/]+$/, label: "contact-detail" },
  { listPath: "/events", pattern: /^\/events\/[^/]+$/, label: "event-detail" },
  { listPath: "/calendar", pattern: /^\/calendars\/[^/]+$/, label: "calendar-detail" },
  { listPath: "/bookings", pattern: /^\/bookings\/[^/]+$/, label: "booking-detail" },
  { listPath: "/bookings", pattern: /^\/bookings\/events\/[^/]+$/, label: "booking-event-detail" },
  { listPath: "/forms", pattern: /^\/forms\/[^/]+$/, label: "form-detail" },
  { listPath: "/communities", pattern: /^\/communities\/[^/]+$/, label: "community-detail" },
  { listPath: "/feedback", pattern: /^\/feedback\/[^/]+$/, label: "feedback-detail" },
  { listPath: "/trash", pattern: /^\/trash\/[^/]+$/, label: "trash-detail" },
  { listPath: "/explore", pattern: /^\/e\/[^/]+$/, label: "hosted-event-public" },
];

/**
 * Convert a URL path to a safe filename slug.
 */
export function safeHarName(urlPath) {
  if (urlPath === "/") return "root";
  return urlPath
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 120) || "root";
}

/**
 * Build the full target list: static routes + discovered param URLs.
 */
export function buildHarTargets(discoveredParams) {
  const staticTargets = HAR_STATIC_ROUTES.map((p) => ({
    urlPath: p,
    label: safeHarName(p),
  }));
  const paramTargets = Object.entries(discoveredParams).map(([label, urlPath]) => ({
    urlPath,
    label,
  }));
  return [...staticTargets, ...paramTargets];
}

/**
 * Expected HAR filenames for a given discovered params map.
 * Used by the har-analysis check to verify capture completeness.
 */
export function expectedHarFiles(discoveredParams = {}) {
  const targets = buildHarTargets(discoveredParams);
  return targets.map((t) => `${t.label}.har`);
}
