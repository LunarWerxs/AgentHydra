/**
 * span-fields — Canonical span field definitions for arkitect trace analysis
 * ==========================================================================
 * Adapted from Sentry's `SpanFields` enum in `static/app/views/insights/types.tsx`
 * and the backend `Span` TypedDict in `src/sentry/issue_detection/types.py`.
 *
 * This is the single source of truth for ALL span field names used by the
 * arkitect detector pipeline. Every detector, tree builder, and problem
 * model references these constants — no magic strings.
 *
 * ## Organization (matching Sentry's taxonomy)
 *
 *   - CORE       — identity, timing, operation
 *   - HTTP       — request/response metrics
 *   - DB         — database-specific fields
 *   - CACHE      — cache hit/miss, item size
 *   - MESSAGING  — queue/message fields
 *   - MOBILE     — app start, frame timing
 *   - WEB_VITALS — LCP, FCP, CLS, INP, TTFB scores
 *   - AI_LLM     — token usage, cost
 *   - RESOURCE   — asset loading
 *
 * Codebase-agnostic: no framework dependencies.
 */

// ---------------------------------------------------------------------------
// Core span identity & timing
// ---------------------------------------------------------------------------

export const SPAN_ID = "span_id";
export const TRACE_ID = "trace_id";
export const PARENT_SPAN_ID = "parent_span_id";
export const START_TIMESTAMP = "start_timestamp";
export const TIMESTAMP = "timestamp";
export const DURATION = "duration"; // computed: timestamp - start_timestamp
export const EXCLUSIVE_TIME = "exclusive_time"; // self time excluding children

// ---------------------------------------------------------------------------
// Operation & description
// ---------------------------------------------------------------------------

export const OP = "op";
export const DESCRIPTION = "description";
export const HASH = "hash"; // span hash for fingerprinting
export const STATUS = "status";
export const CATEGORY = "category"; // e.g. "http", "db", "cache"
export const ORIGIN = "origin";

// ---------------------------------------------------------------------------
// HTTP fields
// ---------------------------------------------------------------------------

export const HTTP_METHOD = "http.method";
export const HTTP_STATUS_CODE = "http.status_code";
export const HTTP_URL = "http.url";
export const HTTP_RESPONSE_CONTENT_LENGTH = "http.response_content_length";
export const HTTP_RESPONSE_TRANSFER_SIZE = "http.response_transfer_size";
export const HTTP_DECODED_RESPONSE_CONTENT_LENGTH = "http.decoded_response_content_length";
export const HTTP_REQUEST_CONTENT_LENGTH = "http.request_content_length";
export const RAW_DOMAIN = "raw_domain";
export const SPAN_DOMAIN = "span.domain";

// ---------------------------------------------------------------------------
// Database fields
// ---------------------------------------------------------------------------

export const DB_SYSTEM = "db.system"; // e.g. "postgresql", "mysql"
export const DB_OPERATION = "db.operation"; // e.g. "SELECT", "INSERT"
export const DB_TABLE = "db.table";
export const DB_NAME = "db.name";

// ---------------------------------------------------------------------------
// Cache fields
// ---------------------------------------------------------------------------

export const CACHE_HIT = "cache.hit";
export const CACHE_KEY = "cache.key";
export const CACHE_ITEM_SIZE = "cache.item_size";

// ---------------------------------------------------------------------------
// Messaging / queue fields
// ---------------------------------------------------------------------------

export const MESSAGING_SYSTEM = "messaging.system";
export const MESSAGING_DESTINATION = "messaging.destination";
export const MESSAGING_DESTINATION_NAME = "messaging.destination.name";
export const MESSAGING_MESSAGE_ID = "messaging.message.id";
export const MESSAGING_MESSAGE_RECEIVE_LATENCY = "messaging.message.receive.latency";

// ---------------------------------------------------------------------------
// Resource / asset fields
// ---------------------------------------------------------------------------

export const RESOURCE_RENDER_BLOCKING_STATUS = "resource.render_blocking_status";
export const RESOURCE_TYPE = "resource.type"; // script, css, font, img

// ---------------------------------------------------------------------------
// Mobile fields
// ---------------------------------------------------------------------------

export const APP_START_COLD = "app.start.cold";
export const APP_START_WARM = "app.start.warm";
export const TIME_TO_INITIAL_DISPLAY = "time_to_initial_display";
export const TIME_TO_FULL_DISPLAY = "time_to_full_display";
export const FRAMES_TOTAL = "frames.total";
export const FRAMES_SLOW = "frames.slow";
export const FRAMES_FROZEN = "frames.frozen";
export const FRAMES_FROZEN_RATE = "frames.frozen_rate";

// ---------------------------------------------------------------------------
// Web Vitals measurements
// ---------------------------------------------------------------------------

export const MEASUREMENTS_LCP = "measurements.lcp";
export const MEASUREMENTS_FCP = "measurements.fcp";
export const MEASUREMENTS_FID = "measurements.fid";
export const MEASUREMENTS_CLS = "measurements.cls";
export const MEASUREMENTS_INP = "measurements.inp";
export const MEASUREMENTS_TTFB = "measurements.ttfb";
export const MEASUREMENTS_FP = "measurements.fp";

// Web Vitals scores (0-100)
export const SCORE_LCP = "measurements.score.lcp";
export const SCORE_FCP = "measurements.score.fcp";
export const SCORE_CLS = "measurements.score.cls";
export const SCORE_TTFB = "measurements.score.ttfb";
export const SCORE_INP = "measurements.score.inp";
export const SCORE_TOTAL = "measurements.score.total";

// ---------------------------------------------------------------------------
// AI / LLM fields
// ---------------------------------------------------------------------------

export const AI_TOTAL_TOKENS_USED = "ai.total_tokens.used";
export const AI_PROMPT_TOKENS_USED = "ai.prompt_tokens.used";
export const AI_COMPLETION_TOKENS_USED = "ai.completion_tokens.used";
export const AI_TOTAL_COST = "ai.total_cost";

// ---------------------------------------------------------------------------
// SDK & environment
// ---------------------------------------------------------------------------

export const SDK_NAME = "sdk.name";
export const SDK_VERSION = "sdk.version";
export const RELEASE = "release";
export const ENVIRONMENT = "environment";
export const PROJECT_ID = "project.id";
export const TRANSACTION = "transaction";
export const TRANSACTION_OP = "transaction.op";
export const TRANSACTION_STATUS = "transaction.status";

// ---------------------------------------------------------------------------
// Span operation constants (matching Sentry's span op taxonomy)
// ---------------------------------------------------------------------------

export const SPAN_OPS = {
  // HTTP
  HTTP_CLIENT: "http.client",
  HTTP_SERVER: "http.server",

  // Database
  DB: "db",
  DB_QUERY: "db.query",
  DB_SQL_QUERY: "db.sql.query",
  DB_REDIS: "db.redis",
  DB_CONNECTION: "db.connection",

  // Cache
  CACHE_GET_ITEM: "cache.get_item",
  CACHE_GET: "cache.get",
  CACHE_PUT: "cache.put",

  // Queue
  QUEUE_PROCESS: "queue.process",
  QUEUE_PUBLISH: "queue.publish",

  // Resource
  RESOURCE_SCRIPT: "resource.script",
  RESOURCE_CSS: "resource.css",
  RESOURCE_FONT: "resource.font",
  RESOURCE_IMG: "resource.img",

  // Browser
  PAGELOAD: "pageload",
  NAVIGATION: "navigation",
  UI_RENDER: "ui.render",
  UI_INTERACTION: "ui.interaction",
  UI_LONG_TASK: "ui.long-task",

  // Mobile
  APP_START_COLD_OP: "app.start.cold",
  APP_START_WARM_OP: "app.start.warm",
  UI_LOAD: "ui.load",

  // AI
  AI_RUN: "ai.run",
  AI_COMPLETION: "ai.completion",
};

// ---------------------------------------------------------------------------
// Module taxonomy (matching Sentry's InsightModules)
// ---------------------------------------------------------------------------

export const MODULES = {
  DB: "db",
  HTTP: "http",
  CACHE: "cache",
  QUEUE: "queue",
  VITAL: "vital",
  RESOURCE: "resource",
  APP_START: "app_start",
  SCREEN_LOAD: "screen_load",
  MOBILE_VITALS: "mobile_vitals",
  AI: "ai",
  OTHER: "other",
};

/**
 * Classify a span into its module based on op and category.
 * Parallel to Sentry's `insights/__init__.py` filter functions.
 *
 * @param {Object} span
 * @returns {string} module name from MODULES
 */
export function classifySpanModule(span) {
  const op = span[OP] ?? "";
  const category = span[CATEGORY] ?? "";

  if (category === "db" || op.startsWith("db.")) {
    if (op.startsWith("db.redis")) return MODULES.CACHE;
    return MODULES.DB;
  }

  if (category === "http" || op === SPAN_OPS.HTTP_CLIENT) {
    return MODULES.HTTP;
  }

  if (op.startsWith("cache.")) return MODULES.CACHE;
  if (op.startsWith("queue.")) return MODULES.QUEUE;
  if (op.startsWith("resource.")) return MODULES.RESOURCE;
  if (op.startsWith("app.start.")) return MODULES.APP_START;
  if (op === SPAN_OPS.UI_LOAD) return MODULES.SCREEN_LOAD;
  if (op === SPAN_OPS.PAGELOAD || op.startsWith("ui.webvital.")) return MODULES.VITAL;
  if (op.startsWith("ai.")) return MODULES.AI;

  return MODULES.OTHER;
}

/**
 * Categorize a span's operation into a high-level bucket.
 * Used by detectors to quickly filter relevant spans.
 *
 * @param {Object} span
 * @returns {"db" | "http" | "cache" | "queue" | "resource" | "browser" | "mobile" | "ai" | "unknown"}
 */
export function categorizeSpanOp(span) {
  const op = span[OP] ?? "";
  if (op.startsWith("db.")) return op.startsWith("db.redis") ? "cache" : "db";
  if (op.startsWith("http.")) return "http";
  if (op.startsWith("cache.")) return "cache";
  if (op.startsWith("queue.")) return "queue";
  if (op.startsWith("resource.")) return "resource";
  if (op === "pageload" || op === "navigation" || op.startsWith("ui.")) return "browser";
  if (op.startsWith("app.")) return "mobile";
  if (op.startsWith("ai.")) return "ai";
  return "unknown";
}
