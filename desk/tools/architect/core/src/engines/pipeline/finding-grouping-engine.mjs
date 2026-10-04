/**
 * finding-grouping-engine — Sentry-inspired finding grouping & deduplication
 * ==========================================================================
 * Adapted from Sentry's grouping system (src/sentry/grouping/):
 *
 *   - Strategy-based grouping: different "variants" produce grouping hashes
 *     from different slices of finding data.
 *   - Component tree: findings contribute attributes to a component tree,
 *     which is then hashed to produce a stable grouping key.
 *   - Fingerprint rules: allow custom grouping overrides (e.g., "group all
 *     findings about CSS contrast together").
 *   - Regression tracking: when a previously-fixed finding reappears, flag it.
 *
 * This is a lightweight JS port of Sentry's grouping concepts, tailored for
 * arkitect findings instead of error events. No Django/DB dependency.
 *
 * ## Architecture
 *
 *   Finding → extract components → produce variants → hash each variant →
 *   match against known hashes → assign to group (new or existing)
 *
 * ## Variants (parallel to Sentry's "system", "app", "default"):
 *
 *   - `exact`  — hash of (ruleId + filePath + line + normalized message)
 *               Finds exact duplicates across runs.
 *   - `fingerprint` — hash of (ruleId + filePath + messageTemplate)
 *               Groups findings that are "the same issue" even if line numbers shift.
 *   - `category` — hash of (ruleId + severity)
 *               Coarse grouping for dashboards / trend lines.
 *
 * ## Fingerprint rules (Sentry-style)
 *
 *   Rules can override the default grouping. Format:
 *   ```
 *   [{ match: { ruleId: "css-*", filePath: "*.css" }, fingerprint: ["css-quality"] }]
 *   ```
 *   This forces all CSS-related findings into a single group.
 *
 * ## Regression detection
 *
 *   When a finding's fingerprint hash matches a previously-resolved group,
 *   it's flagged as a regression with metadata about when it was last seen.
 *
 * Codebase-agnostic: works on any array of arkitect findings.
 */

import { createHash } from "node:crypto";

/**
 * @typedef {Object} GroupedFinding
 * @property {string} groupId          — stable group identifier (hash)
 * @property {string} variant          — which variant produced this group ("exact" | "fingerprint" | "category")
 * @property {Object} finding          — the original finding
 * @property {boolean} isNew           — first time this group has been seen
 * @property {boolean} isRegression    — previously resolved, now reappeared
 * @property {number} occurrenceCount  — how many findings are in this group
 * @property {string[]} findingIds     — all finding IDs in this group (for cross-reference)
 * @property {Object} [previousState]  — if regression, what was the prior resolution state
 */

/**
 * @typedef {Object} GroupingState
 * @property {Map<string, GroupRecord>} groups — groupId → record
 * @property {string} stateVersion            — schema version for forward compat
 */

/**
 * @typedef {Object} GroupRecord
 * @property {string} groupId
 * @property {string} variant
 * @property {string} primaryHash            — the main hash for this group
 * @property {string[]} allHashes            — all hashes associated with this group
 * @property {string} status                 — "open" | "resolved" | "ignored"
 * @property {string} firstSeen              — ISO timestamp
 * @property {string} lastSeen               — ISO timestamp
 * @property {string} [resolvedAt]           — ISO timestamp when resolved
 * @property {number} findingCount           — total findings ever in this group
 * @property {string} representativeMessage  — the most recent finding's message
 * @property {string} representativeFile     — the most recent finding's filePath
 */

const STATE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Component extraction (parallel to Sentry's grouping components)
// ---------------------------------------------------------------------------

/**
 * Normalize a finding message for stable hashing.
 * Strips variable parts like numbers, quoted strings, and URLs that would
 * cause semantically-identical messages to produce different hashes.
 *
 * Inspired by Sentry's `normalize_message_for_grouping()` in
 * `src/sentry/grouping/utils.py`.
 */
export function normalizeMessage(message) {
  return message
    .replace(/[0-9]+/g, "<NUM>")
    .replace(/"[^"]*"/g, '"<STR>"')
    .replace(/'[^']*'/g, "'<STR>'")
    .replace(/`[^`]*`/g, "`<STR>`")
    .replace(/https?:\/\/[^\s]+/g, "<URL>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract the "message template" — the message with all dynamic parts removed.
 * This is what Sentry would call the "message component".
 */
export function extractMessageTemplate(message) {
  return normalizeMessage(message);
}

/**
 * Build grouping components from a finding.
 * Returns an object with the components used by different variant strategies.
 *
 * Parallel to Sentry's strategy functions that extract FrameGroupingComponent,
 * ExceptionGroupingComponent, etc. from event data.
 */
export function extractComponents(finding) {
  const normMessage = normalizeMessage(finding.message || "");
  const messageTemplate = extractMessageTemplate(finding.message || "");

  return {
    ruleId: finding.ruleId || "unknown",
    filePath: (finding.filePath || "").replaceAll("\\", "/"),
    line: finding.line ?? 0,
    severity: finding.severity || "warn",
    message: finding.message || "",
    normMessage,
    messageTemplate,
    snippet: (finding.snippet || "").trim().substring(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Hash computation (parallel to Sentry's hash_from_values)
// ---------------------------------------------------------------------------

/**
 * Compute a stable SHA-256 hash from an array of string values.
 * Parallel to Sentry's `hash_from_values()` in `src/sentry/grouping/utils.py`.
 */
export function hashFromValues(values) {
  const joined = values.filter(Boolean).join("\x00");
  return createHash("sha256").update(joined).digest("hex").substring(0, 16);
}

// ---------------------------------------------------------------------------
// Variant strategies (parallel to Sentry's strategy functions)
// ---------------------------------------------------------------------------

/**
 * "exact" variant — hashes (ruleId + filePath + line + normMessage).
 * Two findings with the exact same location and normalized message get the same hash.
 * This is the most precise grouping — catches duplicate findings.
 */
export function exactVariant(components) {
  const hash = hashFromValues([
    components.ruleId,
    components.filePath,
    String(components.line),
    components.normMessage,
  ]);
  return { variant: "exact", hash, contributes: true };
}

/**
 * "fingerprint" variant — hashes (ruleId + filePath + messageTemplate).
 * Groups findings that are semantically the same issue even when line numbers
 * or minor details shift. This is the primary grouping variant.
 */
export function fingerprintVariant(components) {
  const hash = hashFromValues([components.ruleId, components.filePath, components.messageTemplate]);
  return { variant: "fingerprint", hash, contributes: true };
}

/**
 * "category" variant — hashes (ruleId + severity).
 * Coarse grouping for trend analysis and dashboards.
 */
export function categoryVariant(components) {
  const hash = hashFromValues([components.ruleId, components.severity]);
  return { variant: "category", hash, contributes: true };
}

/**
 * Apply custom fingerprint rules to override the default grouping.
 *
 * Rules format (Sentry-style):
 *   [{ match: { ruleId: "css-*" }, fingerprint: ["css-quality"] }]
 *
 * If a rule matches, the fingerprint values are hashed together to produce
 * a custom group ID that overrides all other variants.
 *
 * @param {Object} components
 * @param {Array<{match: Object, fingerprint: string[]}>} fingerprintRules
 * @returns {{ variant: string, hash: string, contributes: boolean } | null}
 */
export function applyFingerprintRules(components, fingerprintRules = []) {
  for (const rule of fingerprintRules) {
    if (matchesFingerprintRule(components, rule.match)) {
      const hash = hashFromValues(rule.fingerprint);
      return { variant: "custom-fingerprint", hash, contributes: true };
    }
  }
  return null;
}

/**
 * Simple glob-style matching for fingerprint rules.
 * Supports * wildcards: `"css-*"` matches `"css-dedupe"`, `"*.css"` matches `"style.css"`.
 */
function matchesFingerprintRule(components, match) {
  for (const [key, pattern] of Object.entries(match)) {
    const value = components[key] ?? "";
    if (!wildcardMatch(String(pattern), String(value))) {
      return false;
    }
  }
  return true;
}

function wildcardMatch(pattern, value) {
  const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  return regex.test(value);
}

// ---------------------------------------------------------------------------
// Grouping engine (parallel to Sentry's assign_event_to_group)
// ---------------------------------------------------------------------------

/**
 * Group an array of findings using Sentry-style multi-variant grouping.
 *
 * For each finding:
 *   1. Extract components
 *   2. Try fingerprint rules first (custom grouping)
 *   3. Fall back to variant strategies (exact → fingerprint → category)
 *   4. Match against known groups or create new ones
 *   5. Detect regressions (previously-resolved groups that reappear)
 *
 * @param {Object[]} findings — array of arkitect finding objects
 * @param {Object} [options]
 * @param {GroupingState} [options.previousState] — previous grouping state for regression detection
 * @param {Array} [options.fingerprintRules] — custom fingerprint rules
 * @returns {{ groupedFindings: GroupedFinding[], newState: GroupingState, stats: Object }}
 */
export function groupFindings(findings, options = {}) {
  const { previousState, fingerprintRules = [] } = options;
  const prevGroups = previousState?.groups ?? new Map();
  const newGroups = new Map(prevGroups); // start with previous state
  const groupedFindings = [];
  const now = new Date().toISOString();

  for (const finding of findings) {
    const components = extractComponents(finding);

    // 1. Try fingerprint rules first (they take precedence)
    const fingerprintResult = applyFingerprintRules(components, fingerprintRules);

    // 2. Build variants in priority order (exact > fingerprint > category)
    const variants = fingerprintResult
      ? [fingerprintResult]
      : [exactVariant(components), fingerprintVariant(components), categoryVariant(components)];

    // 3. Find the first variant whose hash matches an existing group
    let matchedGroup = null;

    for (const variant of variants) {
      if (!variant.contributes) continue;
      const existing = findGroupByHash(newGroups, variant.hash);
      if (existing) {
        matchedGroup = existing;
        break;
      }
    }

    // 4. If no match, create a new group using the fingerprint variant as primary
    if (!matchedGroup) {
      const primaryVariant = fingerprintResult || fingerprintVariant(components);
      const groupId = `group_${primaryVariant.hash}`;

      const wasResolved = prevGroups.has(groupId) && prevGroups.get(groupId).status === "resolved";

      /** @type {GroupRecord} */
      const newGroup = {
        groupId,
        variant: primaryVariant.variant,
        primaryHash: primaryVariant.hash,
        allHashes: variants.map((v) => v.hash),
        status: wasResolved ? "open" : "open", // reopen if previously resolved
        firstSeen: prevGroups.get(groupId)?.firstSeen ?? now,
        lastSeen: now,
        resolvedAt: wasResolved ? undefined : prevGroups.get(groupId)?.resolvedAt,
        findingCount: (prevGroups.get(groupId)?.findingCount ?? 0) + 1,
        representativeMessage: finding.message,
        representativeFile: finding.filePath,
      };

      newGroups.set(groupId, newGroup);

      groupedFindings.push({
        groupId,
        variant: primaryVariant.variant,
        finding,
        isNew: !prevGroups.has(groupId),
        isRegression: wasResolved,
        occurrenceCount: newGroup.findingCount,
        findingIds: [groupId],
        previousState: wasResolved ? prevGroups.get(groupId) : undefined,
      });
    } else {
      // 5. Update existing group
      matchedGroup.lastSeen = now;
      matchedGroup.findingCount += 1;
      matchedGroup.representativeMessage = finding.message;
      matchedGroup.representativeFile = finding.filePath;

      // Add any new hashes
      for (const variant of variants) {
        if (!matchedGroup.allHashes.includes(variant.hash)) {
          matchedGroup.allHashes.push(variant.hash);
        }
      }

      // Reactivate if resolved
      const wasResolved = matchedGroup.status === "resolved";
      if (wasResolved) {
        matchedGroup.status = "open";
        matchedGroup.resolvedAt = undefined;
      }

      newGroups.set(matchedGroup.groupId, matchedGroup);

      groupedFindings.push({
        groupId: matchedGroup.groupId,
        variant: matchedGroup.variant,
        finding,
        isNew: false,
        isRegression: wasResolved,
        occurrenceCount: matchedGroup.findingCount,
        findingIds: [matchedGroup.groupId],
        previousState: wasResolved ? { ...matchedGroup, status: "resolved" } : undefined,
      });
    }
  }

  // Build stats
  const stats = {
    totalFindings: findings.length,
    totalGroups: newGroups.size,
    newGroups: 0,
    regressions: 0,
    openGroups: 0,
    resolvedGroups: 0,
    ignoredGroups: 0,
  };

  for (const [, group] of newGroups) {
    if (group.status === "open") stats.openGroups++;
    if (group.status === "resolved") stats.resolvedGroups++;
    if (group.status === "ignored") stats.ignoredGroups++;
  }

  for (const gf of groupedFindings) {
    if (gf.isNew) stats.newGroups++;
    if (gf.isRegression) stats.regressions++;
  }

  /** @type {GroupingState} */
  const newState = {
    groups: newGroups,
    stateVersion: STATE_VERSION,
  };

  return { groupedFindings, newState, stats };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a group by any of its known hashes.
 */
function findGroupByHash(groups, hash) {
  for (const [, group] of groups) {
    if (group.allHashes.includes(hash)) {
      return group;
    }
  }
  return null;
}

/**
 * Resolve a group (mark as fixed).
 * Returns updated state.
 *
 * @param {GroupingState} state
 * @param {string} groupId
 * @returns {GroupingState}
 */
export function resolveGroup(state, groupId) {
  const group = state.groups.get(groupId);
  if (!group) return state;

  const updated = new Map(state.groups);
  updated.set(groupId, {
    ...group,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
  });

  return { ...state, groups: updated, stateVersion: STATE_VERSION };
}

/**
 * Ignore a group (mark as not actionable).
 *
 * @param {GroupingState} state
 * @param {string} groupId
 * @returns {GroupingState}
 */
export function ignoreGroup(state, groupId) {
  const group = state.groups.get(groupId);
  if (!group) return state;

  const updated = new Map(state.groups);
  updated.set(groupId, { ...group, status: "ignored" });

  return { ...state, groups: updated, stateVersion: STATE_VERSION };
}

/**
 * Serialize grouping state to JSON for persistence.
 *
 * @param {GroupingState} state
 * @returns {Object}
 */
export function serializeState(state) {
  return {
    stateVersion: state.stateVersion,
    groups: Object.fromEntries(state.groups),
  };
}

/**
 * Deserialize grouping state from JSON.
 *
 * @param {Object} json
 * @returns {GroupingState}
 */
export function deserializeState(json) {
  if (!json || json.stateVersion !== STATE_VERSION) {
    return { groups: new Map(), stateVersion: STATE_VERSION };
  }
  return {
    groups: new Map(Object.entries(json.groups ?? {})),
    stateVersion: STATE_VERSION,
  };
}
