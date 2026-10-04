/**
 * Auto-discovery for arkitect checks.
 *
 * Scans `src/checks/` at startup. Each `.mjs` file exports an `audit` object
 * or a named export (for multi-audit files like vocabulary-contracts).
 *
 * Group assignment priority:
 *   1. Explicit `audit.group` on the export (future-proof)
 *   2. Override map below (for checks whose directory ≠ their logical group)
 *   3. Parent directory name (kebab-case → camelCase)
 */

import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Directory → group name overrides ──────────────────────────────
const DIRECTORY_GROUP_MAP = {
  "code-quality": "codeRisk",
  contracts: "productContracts",
  i18n: "localization",
  agnostic: "qualityAgnostic",
  e2e: "architecture",
  css: "architecture",
  mobile: "designSystem",
  performance: "architecture",
  "design-system": "designSystem",
};

// ── Per-check overrides (directory inference was wrong) ───────────
// Checks listed here have their group explicitly assigned. All other
// checks are discovered and grouped by their parent directory name.
// Notable checks: mobile-audit (designSystem, via mobile/ dir),
// media-cors (productContracts, includeInAll:false), memory-monitor
// (architecture, includeInAll:false).
const CHECK_GROUP_OVERRIDES = {
  "oversized-files": "surface",
  "profile-placeholder-guard": "architecture",
  "bundle-size-budget": "meta",
  "feature-boundary-matrix": "meta",
  "e2e-capture": "architecture",
  "har-analysis": "architecture",
  "memory-monitor": "architecture",
  "browser-perf": "architecture",
  "workspace-interaction-perf": "architecture",
  "dead-component-events": "architecture",
  "idle-callback-budget": "architecture",
  "boot-graph": "architecture",
  "perf-hot-paths": "architecture",
  "codebase-health": "architecture",
  "ui-drift": "designSystem",
};

// ── Group priority for --all ordering ─────────────────────────────
const GROUP_PRIORITY = [
  "productContracts",
  "architecture",
  "designSystem",
  "surface",
  "localization",
  "intelligence",
  "meta",
  "codeRisk",
  "qualityAgnostic",
  "tests",
];

// ── Known multi-export files (file → export names) ────────────────
const MULTI_EXPORT_FILES = new Set(["contracts/vocabulary/vocabulary-contracts.mjs"]);

/**
 * @param {string} dirName - kebab-case directory name
 * @returns {string} camelCase group name
 */
function dirToGroup(dirName) {
  if (DIRECTORY_GROUP_MAP[dirName]) return DIRECTORY_GROUP_MAP[dirName];
  return dirName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Discover all audits from the checks directory.
 * @param {string} checksRoot - absolute path to src/checks/
 * @returns {Promise<{ audits: Array, auditMap: Map<string, object>, groups: Record<string, Array> }>}
 */
export async function discoverAudits(checksRoot) {
  if (!existsSync(checksRoot)) {
    throw new Error(`Checks directory not found: ${checksRoot}`);
  }

  /** @type {Array<{ id: string, group: string, audit: object }>} */
  const discovered = [];

  const dirs = readdirSync(checksRoot, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const dirPath = path.join(checksRoot, dir.name);
    const files = collectMjsFiles(dirPath);

    for (const relPath of files) {
      const absPath = path.join(dirPath, relPath);
      const fullRelPath = path.join(dir.name, relPath).replace(/\\/g, "/");

      try {
        const mod = await import(pathToFileURL(absPath).href);

        // Handle multi-export files (e.g., vocabulary-contracts)
        if (MULTI_EXPORT_FILES.has(fullRelPath)) {
          for (const key of Object.keys(mod)) {
            if (key.endsWith("Audit") && mod[key]?.id) {
              const audit = mod[key];
              const group = resolveGroup(audit, dir.name, fullRelPath);
              discovered.push({ id: audit.id, group, audit });
            }
          }
        } else if (mod.audit?.id) {
          const group = resolveGroup(mod.audit, dir.name, fullRelPath);
          discovered.push({ id: mod.audit.id, group, audit: mod.audit });
        }
      } catch (err) {
        console.error(`[arkitect] Failed to load check: ${fullRelPath} — ${err.message}`);
      }
    }
  }

  // Build group → audits map, sorted by priority
  /** @type {Record<string, Array>} */
  const groups = {};
  for (const groupName of GROUP_PRIORITY) {
    groups[groupName] = [];
  }

  for (const entry of discovered) {
    if (!groups[entry.group]) {
      groups[entry.group] = [];
    }
    groups[entry.group].push(entry.audit);
  }

  // Flat list in priority order
  const audits = GROUP_PRIORITY.flatMap((g) => groups[g] || []);

  // Also include any groups not in the priority list at the end
  for (const [groupName, groupAudits] of Object.entries(groups)) {
    if (!GROUP_PRIORITY.includes(groupName) && groupAudits.length > 0) {
      audits.push(...groupAudits);
    }
  }

  return { audits, groups };
}

/**
 * Resolve the group for a check.
 */
function resolveGroup(audit, dirName, _relPath) {
  // 1. Explicit group on the audit export
  if (audit.group) return audit.group;
  // 2. Per-check override
  if (CHECK_GROUP_OVERRIDES[audit.id]) return CHECK_GROUP_OVERRIDES[audit.id];
  // 3. Directory → group inference
  return dirToGroup(dirName);
}

/**
 * Recursively collect .mjs files in a directory (relative to dirPath).
 */
function collectMjsFiles(dirPath) {
  const results = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subResults = collectMjsFiles(path.join(dirPath, entry.name));
      for (const sub of subResults) {
        results.push(`${entry.name}/${sub}`);
      }
    } else if (entry.name.endsWith(".mjs")) {
      results.push(entry.name);
    }
  }
  return results;
}
