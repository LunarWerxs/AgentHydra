/**
 * finding-breadcrumbs — Sentry-inspired breadcrumb pattern for arkitect findings
 * ==============================================================================
 * Adapted from Sentry's breadcrumb system (`@sentry/core` types/breadcrumb.ts):
 *
 *   - Breadcrumbs are a trail of events leading up to an error/event
 *   - Each breadcrumb has: type, category, message, data, timestamp, level
 *   - Breadcrumbs are attached to events and sent alongside them
 *   - The SDK automatically adds breadcrumbs for: fetch/XHR, clicks, navigation,
 *     console logs, etc.
 *
 * For arkitect, breadcrumbs trace the audit execution path that led to a finding:
 *   - "parsed file X" → "detected pattern Y" → "matched rule Z" → finding
 *   - Helps debug WHY a finding was produced
 *   - Provides rich context for CI/CD dashboards
 *
 * ## Breadcrumb Types (parallel to Sentry's breadcrumb types)
 *
 *   - `audit`     — a step in the audit check process
 *   - `parse`     — file parsing event
 *   - `match`     — pattern/rule match event
 *   - `query`     — external query (e.g., git log, npm registry)
 *   - `error`     — a non-fatal error during audit
 *   - `info`      — informational event
 *
 * ## Usage
 *
 *   ```js
 *   import { addBreadcrumb, getBreadcrumbs, breadcrumbScope } from "./finding-breadcrumbs.mjs";
 *
 *   // In a check:
 *   addBreadcrumb({ type: "parse", category: "file", message: "Parsed src/foo.ts", data: { lines: 142 } });
 *   addBreadcrumb({ type: "match", category: "pattern", message: "Matched anti-pattern: nested cards" });
 *
 *   // Attach to finding:
 *   const finding = createFinding({ ... });
 *   finding.metadata._breadcrumbs = getBreadcrumbs();
 *   ```
 *
 * Codebase-agnostic: works in any JS environment (uses async-local-storage-style scoping).
 */

// ---------------------------------------------------------------------------
// Types (parallel to Sentry's Breadcrumb type)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ArkitectBreadcrumb
 * @property {string} type      — "audit" | "parse" | "match" | "query" | "error" | "info"
 * @property {string} [category] — sub-category (e.g., "file", "pattern", "network")
 * @property {string} message   — human-readable description
 * @property {Object} [data]    — arbitrary structured data
 * @property {string} timestamp — ISO 8601 timestamp
 * @property {string} [level]   — "critical" | "high" | "medium" | "low" | "info"
 */

const VALID_BREADCRUMB_TYPES = new Set(["audit", "parse", "match", "query", "error", "info"]);

// ---------------------------------------------------------------------------
// Breadcrumb store (async-local-style, using a global with run IDs)
// ---------------------------------------------------------------------------

/**
 * In-memory breadcrumb store keyed by run ID.
 * In a real multi-tenant environment, this would use AsyncLocalStorage.
 * For CLI audit runs, a single global store per process is sufficient.
 */
const breadcrumbStore = new Map();

/** Default run ID when not explicitly scoped. */
const DEFAULT_RUN_ID = "__default__";

/**
 * Get or create the breadcrumb array for the current run.
 *
 * @param {string} [runId]
 * @returns {ArkitectBreadcrumb[]}
 */
function getBreadcrumbArray(runId = DEFAULT_RUN_ID) {
  if (!breadcrumbStore.has(runId)) {
    breadcrumbStore.set(runId, []);
  }
  return breadcrumbStore.get(runId);
}

// ---------------------------------------------------------------------------
// Public API (parallel to Sentry's addBreadcrumb)
// ---------------------------------------------------------------------------

/**
 * Add a breadcrumb to the current audit run.
 *
 * Parallel to Sentry's `addBreadcrumb()`.
 *
 * @param {Object} breadcrumb
 * @param {string} breadcrumb.type
 * @param {string} [breadcrumb.category]
 * @param {string} breadcrumb.message
 * @param {Object} [breadcrumb.data]
 * @param {string} [breadcrumb.level]
 * @param {string} [runId] — optional run ID for scoping
 */
export function addBreadcrumb(breadcrumb, runId) {
  const type = VALID_BREADCRUMB_TYPES.has(breadcrumb.type) ? breadcrumb.type : "info";

  /** @type {ArkitectBreadcrumb} */
  const crumb = {
    type,
    category: breadcrumb.category ?? "general",
    message: breadcrumb.message ?? "",
    data: breadcrumb.data ?? {},
    timestamp: new Date().toISOString(),
    level: breadcrumb.level ?? "info",
  };

  const arr = getBreadcrumbArray(runId);
  arr.push(crumb);

  // Enforce max breadcrumbs (Sentry default: 100)
  const MAX_BREADCRUMBS = 100;
  if (arr.length > MAX_BREADCRUMBS) {
    arr.splice(0, arr.length - MAX_BREADCRUMBS);
  }
}

/**
 * Get all breadcrumbs for the current audit run.
 *
 * @param {string} [runId]
 * @returns {ArkitectBreadcrumb[]}
 */
export function getBreadcrumbs(runId) {
  return [...getBreadcrumbArray(runId)];
}

/**
 * Clear breadcrumbs for a run (call at the end of each audit run).
 *
 * @param {string} [runId]
 */
export function clearBreadcrumbs(runId) {
  breadcrumbStore.delete(runId ?? DEFAULT_RUN_ID);
}

// ---------------------------------------------------------------------------
// Breadcrumb scope manager (parallel to Sentry's withScope)
// ---------------------------------------------------------------------------

/**
 * Run a function in a new breadcrumb scope.
 * Breadcrumbs added inside the callback are isolated to that scope.
 * When the callback completes, the scope's breadcrumbs are merged back
 * into the parent scope.
 *
 * Parallel to Sentry's `withScope()`.
 *
 * @param {Function} callback — receives a scope object with addBreadcrumb
 * @param {string} [runId]
 * @returns {Promise<any>}
 */
export async function withBreadcrumbScope(callback, runId) {
  const scopeBreadcrumbs = [];

  const scopeAddBreadcrumb = (breadcrumb) => {
    const type = VALID_BREADCRUMB_TYPES.has(breadcrumb.type) ? breadcrumb.type : "info";
    scopeBreadcrumbs.push({
      type,
      category: breadcrumb.category ?? "general",
      message: breadcrumb.message ?? "",
      data: breadcrumb.data ?? {},
      timestamp: new Date().toISOString(),
      level: breadcrumb.level ?? "info",
    });
  };

  try {
    return await callback({ addBreadcrumb: scopeAddBreadcrumb });
  } finally {
    // Merge scope breadcrumbs into parent
    const parentArr = getBreadcrumbArray(runId);
    parentArr.push(...scopeBreadcrumbs);
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers (parallel to Sentry's auto-breadcrumb integrations)
// ---------------------------------------------------------------------------

/**
 * Add a breadcrumb for a file parse event.
 *
 * @param {string} filePath
 * @param {Object} [data]
 * @param {string} [runId]
 */
export function breadcrumbFileParsed(filePath, data = {}, runId) {
  addBreadcrumb(
    {
      type: "parse",
      category: "file",
      message: `Parsed ${filePath}`,
      data: { filePath, ...data },
    },
    runId,
  );
}

/**
 * Add a breadcrumb for a pattern match event.
 *
 * @param {string} ruleId
 * @param {string} filePath
 * @param {Object} [data]
 * @param {string} [runId]
 */
export function breadcrumbRuleMatched(ruleId, filePath, data = {}, runId) {
  addBreadcrumb(
    {
      type: "match",
      category: "pattern",
      message: `Rule ${ruleId} matched in ${filePath}`,
      data: { ruleId, filePath, ...data },
    },
    runId,
  );
}

/**
 * Add a breadcrumb for an external query (e.g., git log, npm API).
 *
 * @param {string} queryDescription
 * @param {Object} [data]
 * @param {string} [runId]
 */
export function breadcrumbQuery(queryDescription, data = {}, runId) {
  addBreadcrumb(
    {
      type: "query",
      category: "external",
      message: queryDescription,
      data,
    },
    runId,
  );
}

/**
 * Add a breadcrumb for a non-fatal error during audit.
 *
 * @param {string} message
 * @param {Object} [data]
 * @param {string} [runId]
 */
export function breadcrumbError(message, data = {}, runId) {
  addBreadcrumb(
    {
      type: "error",
      category: "audit",
      message,
      data,
      level: "high",
    },
    runId,
  );
}

/**
 * Attach accumulated breadcrumbs to a finding.
 * Call this before returning a finding from a check.
 *
 * @param {Object} finding — the finding object
 * @param {string} [runId]
 * @returns {Object} the finding with breadcrumbs attached
 */
export function attachBreadcrumbsToFinding(finding, runId) {
  const breadcrumbs = getBreadcrumbs(runId);
  if (breadcrumbs.length === 0) return finding;

  return {
    ...finding,
    metadata: {
      ...finding.metadata,
      _breadcrumbs: breadcrumbs,
    },
  };
}
