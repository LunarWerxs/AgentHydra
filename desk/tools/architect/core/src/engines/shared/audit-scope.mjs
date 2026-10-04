/**
 * audit-scope — Sentry-style Scope management for arkitect audit runs
 * ===================================================================
 * Adapted from Sentry's Scope system in `@sentry/core` (`scope.ts`):
 *
 *   - Global scope: set once at init, applies to ALL findings across ALL checks
 *   - Isolation scope: per-audit-run context (CI job, branch, commit SHA)
 *   - Current scope: per-check or per-finding context
 *   - `withScope(callback)`: create a temporary clone, run callback, discard
 *   - `setTag()`, `setExtra()`, `setContext()`, `setUser()`: Sentry's context API
 *   - `addEventProcessor()`: middleware that transforms findings before output
 *   - `applyToEvent()`: merge scope data into a finding
 *
 * ## Scope hierarchy (matching Sentry's 3-scope model)
 *
 *   Global Scope  ← set once (e.g., project name, environment)
 *   ├── Isolation Scope ← per CI run (commit SHA, branch, run ID)
 *   └── Current Scope   ← per check (check ID, check config)
 *
 * When a finding is processed, all three scopes are merged in order:
 *   Global → Isolation → Current → Finding (scope data merged into metadata)
 *
 * ## Usage
 *
 *   ```js
 *   import { setTag, setExtra, setContext, withScope, applyScopeToFinding } from "./audit-scope.mjs";
 *
 *   // At init time:
 *   setTag("env", "production");
 *   setContext("git", { branch: "main", sha: "abc123" });
 *
 *   // In a check:
 *   withScope((scope) => {
 *     scope.setTag("check", "oversized-files");
 *     // ... run check ...
 *     const finding = scope.applyToFinding({ ruleId: "test", ... });
 *   });
 *   ```
 *
 * Codebase-agnostic: works in any JS environment.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Scope class (parallel to Sentry's Scope)
// ---------------------------------------------------------------------------

/**
 * A scope accumulates tags, extras, context, breadcrumbs, and event processors
 * that will be applied to findings when they are processed.
 *
 * @class
 */
export class AuditScope {
  constructor() {
    /** @type {Object<string, string>} */
    this._tags = {};

    /** @type {Object<string, any>} */
    this._extra = {};

    /** @type {Object<string, Object>} */
    this._contexts = {};

    /** @type {Object<string, string> | null} */
    this._user = null;

    /** @type {string} */
    this._level = "info";

    /** @type {Array<Function>} */
    this._eventProcessors = [];

    /** @type {Object[]} */
    this._breadcrumbs = [];
  }

  // -----------------------------------------------------------------------
  // Tags (Sentry: setTag / setTags)
  // -----------------------------------------------------------------------

  /**
   * Set a single tag on the scope.
   * @param {string} key
   * @param {string} value
   * @returns {AuditScope} this (for chaining)
   */
  setTag(key, value) {
    this._tags[key] = String(value);
    return this;
  }

  /**
   * Set multiple tags at once.
   * @param {Object<string, string>} tags
   * @returns {AuditScope}
   */
  setTags(tags) {
    Object.assign(this._tags, tags);
    return this;
  }

  /**
   * Remove a tag.
   * @param {string} key
   * @returns {AuditScope}
   */
  removeTag(key) {
    delete this._tags[key];
    return this;
  }

  // -----------------------------------------------------------------------
  // Extra (Sentry: setExtra / setExtras)
  // -----------------------------------------------------------------------

  /**
   * Set a single extra key-value on the scope.
   * @param {string} key
   * @param {any} value
   * @returns {AuditScope}
   */
  setExtra(key, value) {
    this._extra[key] = value;
    return this;
  }

  /**
   * Set multiple extras at once.
   * @param {Object<string, any>} extras
   * @returns {AuditScope}
   */
  setExtras(extras) {
    Object.assign(this._extra, extras);
    return this;
  }

  // -----------------------------------------------------------------------
  // Context (Sentry: setContext / setContexts)
  // -----------------------------------------------------------------------

  /**
   * Set a named context object on the scope.
   * @param {string} name — e.g., "git", "ci", "runtime"
   * @param {Object} context
   * @returns {AuditScope}
   */
  setContext(name, context) {
    this._contexts[name] = { ...context };
    return this;
  }

  // -----------------------------------------------------------------------
  // User (Sentry: setUser)
  // -----------------------------------------------------------------------

  /**
   * Set user context on the scope.
   * @param {{ id?: string, email?: string, username?: string } | null} user
   * @returns {AuditScope}
   */
  setUser(user) {
    this._user = user ?? null;
    return this;
  }

  // -----------------------------------------------------------------------
  // Level (Sentry: setLevel)
  // -----------------------------------------------------------------------

  /**
   * Set the minimum severity level for findings in this scope.
   * @param {string} level
   * @returns {AuditScope}
   */
  setLevel(level) {
    this._level = level;
    return this;
  }

  // -----------------------------------------------------------------------
  // Breadcrumbs (Sentry: addBreadcrumb)
  // -----------------------------------------------------------------------

  /**
   * Add a breadcrumb to the scope.
   * @param {Object} breadcrumb
   * @returns {AuditScope}
   */
  addBreadcrumb(breadcrumb) {
    const MAX_BREADCRUMBS = 100;
    this._breadcrumbs.push({
      type: breadcrumb.type ?? "info",
      category: breadcrumb.category ?? "general",
      message: breadcrumb.message ?? "",
      data: breadcrumb.data ?? {},
      timestamp: new Date().toISOString(),
      level: breadcrumb.level ?? "info",
    });
    if (this._breadcrumbs.length > MAX_BREADCRUMBS) {
      this._breadcrumbs.splice(0, this._breadcrumbs.length - MAX_BREADCRUMBS);
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Event processors (Sentry: addEventProcessor)
  // -----------------------------------------------------------------------

  /**
   * Add an event processor — a function that transforms findings.
   * Processors run in order. If a processor returns null, the finding is dropped.
   *
   * @param {(finding: Object) => Object | null} processor
   * @returns {AuditScope}
   */
  addEventProcessor(processor) {
    this._eventProcessors.push(processor);
    return this;
  }

  // -----------------------------------------------------------------------
  // Apply to finding (Sentry: applyToEvent)
  // -----------------------------------------------------------------------

  /**
   * Apply all scope data to a finding.
   * Merges tags, extras, context, user, breadcrumbs, and level.
   * Runs event processors in order.
   *
   * @param {Object} finding — the finding to enrich
   * @param {Object} [hint] — additional hint data
   * @returns {Object | null} — enriched finding, or null if a processor dropped it
   */
  applyToFinding(finding, hint = {}) {
    let enriched = { ...finding };

    // Merge scope data into metadata
    enriched.metadata = { ...(enriched.metadata ?? {}) };

    // Tags
    if (Object.keys(this._tags).length > 0) {
      enriched.metadata._tags = { ...this._tags, ...(enriched.metadata._tags ?? {}) };
    }

    // Extras
    if (Object.keys(this._extra).length > 0) {
      enriched.metadata._extra = { ...this._extra, ...(enriched.metadata._extra ?? {}) };
    }

    // Contexts
    if (Object.keys(this._contexts).length > 0) {
      enriched.metadata._contexts = { ...this._contexts, ...(enriched.metadata._contexts ?? {}) };
    }

    // User
    if (this._user) {
      enriched.metadata._user = this._user;
    }

    // Breadcrumbs
    if (this._breadcrumbs.length > 0) {
      const existing = enriched.metadata._breadcrumbs ?? [];
      enriched.metadata._breadcrumbs = [...existing, ...this._breadcrumbs];
    }

    // Level override (scope level is advisory — doesn't change finding severity,
    // but provides context)
    enriched.metadata._scopeLevel = this._level;

    // Run event processors
    for (const processor of this._eventProcessors) {
      try {
        enriched = processor(enriched, hint);
        if (enriched === null) return null;
      } catch {
        // Don't lose findings because of broken processors
      }
    }

    return enriched;
  }

  // -----------------------------------------------------------------------
  // Clone (Sentry: clone)
  // -----------------------------------------------------------------------

  /**
   * Create a deep clone of this scope.
   * Used by `withScope()` to create a temporary child scope.
   *
   * @returns {AuditScope}
   */
  clone() {
    const cloned = new AuditScope();
    cloned._tags = { ...this._tags };
    cloned._extra = { ...this._extra };
    cloned._contexts = {};
    for (const [key, val] of Object.entries(this._contexts)) {
      cloned._contexts[key] = { ...val };
    }
    cloned._user = this._user ? { ...this._user } : null;
    cloned._level = this._level;
    cloned._eventProcessors = [...this._eventProcessors];
    cloned._breadcrumbs = [...this._breadcrumbs];
    return cloned;
  }

  // -----------------------------------------------------------------------
  // Clear
  // -----------------------------------------------------------------------

  /**
   * Reset this scope to empty state.
   */
  clear() {
    this._tags = {};
    this._extra = {};
    this._contexts = {};
    this._user = null;
    this._level = "info";
    this._eventProcessors = [];
    this._breadcrumbs = [];
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize scope to a plain object (for logging/debugging).
   * @returns {Object}
   */
  toJSON() {
    return {
      tags: { ...this._tags },
      extra: { ...this._extra },
      contexts: { ...this._contexts },
      user: this._user ? { ...this._user } : null,
      level: this._level,
      breadcrumbCount: this._breadcrumbs.length,
      processorCount: this._eventProcessors.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Global scope stack (parallel to Sentry's getGlobalScope / getIsolationScope)
// ---------------------------------------------------------------------------

/**
 * Global scope — set once at init, applies to all findings.
 * In Sentry, this is `getGlobalScope()`.
 *
 * @type {AuditScope}
 */
let _globalScope = new AuditScope();

/**
 * Isolation scope — per-audit-run context (e.g., CI job, branch).
 * In Sentry, this is `getIsolationScope()`.
 *
 * @type {AuditScope}
 */
let _isolationScope = new AuditScope();

/**
 * Current scope — the currently active scope (per-check, per-finding).
 * In Sentry, this is `getCurrentScope()`.
 *
 * @type {AuditScope}
 */
let _currentScope = new AuditScope();

// ---------------------------------------------------------------------------
// Public API (parallel to Sentry's top-level exports)
// ---------------------------------------------------------------------------

/**
 * Get the global scope.
 * @returns {AuditScope}
 */
export function getGlobalScope() {
  return _globalScope;
}

/**
 * Get the isolation scope.
 * @returns {AuditScope}
 */
export function getIsolationScope() {
  return _isolationScope;
}

/**
 * Get the current scope.
 * @returns {AuditScope}
 */
export function getCurrentScope() {
  return _currentScope;
}

/**
 * Set a new global scope.
 * @param {AuditScope} scope
 */
export function setGlobalScope(scope) {
  _globalScope = scope;
}

/**
 * Set a new isolation scope (typically at the start of an audit run).
 * @param {AuditScope} scope
 */
export function setIsolationScope(scope) {
  _isolationScope = scope;
}

/**
 * Set a new current scope.
 * @param {AuditScope} scope
 */
export function setCurrentScope(scope) {
  _currentScope = scope;
}

// ---------------------------------------------------------------------------
// Convenience helpers (parallel to Sentry's setTag / setExtra / etc.)
// These operate on the CURRENT scope by default.
// ---------------------------------------------------------------------------

/**
 * Set a tag on the current scope.
 * @param {string} key
 * @param {string} value
 */
export function setTag(key, value) {
  _currentScope.setTag(key, value);
}

/**
 * Set multiple tags on the current scope.
 * @param {Object<string, string>} tags
 */
export function setTags(tags) {
  _currentScope.setTags(tags);
}

/**
 * Set an extra on the current scope.
 * @param {string} key
 * @param {any} value
 */
export function setExtra(key, value) {
  _currentScope.setExtra(key, value);
}

/**
 * Set multiple extras on the current scope.
 * @param {Object<string, any>} extras
 */
export function setExtras(extras) {
  _currentScope.setExtras(extras);
}

/**
 * Set a context on the current scope.
 * @param {string} name
 * @param {Object} context
 */
export function setContext(name, context) {
  _currentScope.setContext(name, context);
}

/**
 * Set user on the current scope.
 * @param {{ id?: string, email?: string, username?: string } | null} user
 */
export function setUser(user) {
  _currentScope.setUser(user);
}

/**
 * Set severity level on the current scope.
 * @param {string} level
 */
export function setLevel(level) {
  _currentScope.setLevel(level);
}

/**
 * Add a breadcrumb to the current scope.
 * @param {Object} breadcrumb
 */
export function addBreadcrumb(breadcrumb) {
  _currentScope.addBreadcrumb(breadcrumb);
}

/**
 * Add an event processor to the current scope.
 * @param {(finding: Object) => Object | null} processor
 */
export function addEventProcessor(processor) {
  _currentScope.addEventProcessor(processor);
}

// ---------------------------------------------------------------------------
// withScope (parallel to Sentry's withScope)
// ---------------------------------------------------------------------------

/**
 * Run a callback with a temporary clone of the current scope.
 * Changes to the clone do NOT affect the parent scope.
 * If the callback returns a finding, it's enriched with the temp scope.
 *
 * @param {(scope: AuditScope) => any} callback
 * @returns {any} the callback's return value
 */
export function withScope(callback) {
  const previousScope = _currentScope;
  const tempScope = _currentScope.clone();
  _currentScope = tempScope;

  try {
    return callback(tempScope);
  } finally {
    _currentScope = previousScope;
  }
}

/**
 * Run a callback with a fresh, empty scope.
 * Like Sentry's `withIsolationScope()`.
 *
 * @param {(scope: AuditScope) => any} callback
 * @returns {any}
 */
export function withIsolationScope(callback) {
  const previousScope = _currentScope;
  _currentScope = new AuditScope();

  try {
    return callback(_currentScope);
  } finally {
    _currentScope = previousScope;
  }
}

// ---------------------------------------------------------------------------
// applyAllScopesToFinding
// Merges global → isolation → current scopes into a finding.
// This is the equivalent of Sentry's `_prepareEvent` applying scopes.
// ---------------------------------------------------------------------------

/**
 * Apply all three scopes (global → isolation → current) to a finding.
 * Each scope's data is merged in order; later scopes override earlier ones
 * for same-named tags/extras.
 *
 * @param {Object} finding
 * @param {Object} [hint]
 * @returns {Object | null}
 */
export function applyAllScopesToFinding(finding, hint = {}) {
  // Apply in order: global → isolation → current
  let enriched = _globalScope.applyToFinding(finding, hint);
  if (enriched === null) return null;

  enriched = _isolationScope.applyToFinding(enriched, hint);
  if (enriched === null) return null;

  enriched = _currentScope.applyToFinding(enriched, hint);
  return enriched;
}

// ---------------------------------------------------------------------------
// Reset all scopes (for testing / start of new run)
// ---------------------------------------------------------------------------

/**
 * Reset all scopes to fresh state.
 */
export function resetAllScopes() {
  _globalScope.clear();
  _isolationScope.clear();
  _currentScope.clear();
}

// ---------------------------------------------------------------------------
// Scope fingerprint — generate a stable hash of the current scope state
// Useful for caching/deduplication in distributed audit runs.
// ---------------------------------------------------------------------------

/**
 * Generate a fingerprint of the current scope state.
 * Two runs with identical scope config will produce the same fingerprint.
 *
 * @returns {string} hex hash
 */
export function scopeFingerprint() {
  const data = {
    tags: _currentScope._tags,
    level: _currentScope._level,
    user: _currentScope._user,
    contextKeys: Object.keys(_currentScope._contexts).sort(),
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").substring(0, 12);
}
