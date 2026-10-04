/**
 * Central source of truth for where shared UI primitives live on disk.
 *
 * The shared primitive layer is being extracted from `src/components/shared/`
 * into an in-repo package at `packages/connections-ui/`. While that migration
 * is in progress, audit checks must look in BOTH places:
 *   - the package (migrated Tier B primitives + styles + composables)
 *   - the legacy `src/components/shared/` (Tier C primitives not yet migrated:
 *     analytics, editor, table)
 *
 * See docs/architecture/UI_PACKAGE_EXTRACTION_PLAN.md.
 *
 * Every audit check/engine MUST import its primitive-location knowledge from
 * this module instead of hardcoding `packages/connections-ui/...` path strings.
 * When the package root moves again, this is the only file to edit.
 */

// ── Roots ────────────────────────────────────────────────────────────────────

/** Root of the extracted shared UI package (relative to repo root). */
export const UI_PACKAGE_ROOT = "packages/connections-ui/src";
export const UI_PACKAGE_COMPONENTS_ROOT = `${UI_PACKAGE_ROOT}/components`;
export const UI_PACKAGE_STYLES_ROOT = `${UI_PACKAGE_ROOT}/styles`;
export const UI_PACKAGE_PRIMITIVE_STYLES_ROOT = `${UI_PACKAGE_STYLES_ROOT}/primitives`;
export const UI_PACKAGE_COMPOSABLES_ROOT = `${UI_PACKAGE_ROOT}/composables`;

/** Legacy in-app shared layer — still holds Tier C primitives (analytics, editor, table). */
export const LEGACY_SHARED_COMPONENTS_ROOT = "src/components/shared";
/** All public-facing components. */
export const PUBLIC_COMPONENTS_ROOT = "src/components/public";
/** Public-facing shared primitives. */
export const PUBLIC_SHARED_COMPONENTS_ROOT = "src/components/public/shared";

// ── Prefix sets ──────────────────────────────────────────────────────────────

/**
 * Path prefixes (trailing slash) that mark a file as a shared / canonical
 * workspace primitive. Drift checks use this to decide "is this the canonical
 * primitive layer, or feature-local code?".
 */
export const SHARED_PRIMITIVE_PATH_PREFIXES = [
  `${LEGACY_SHARED_COMPONENTS_ROOT}/`,
  `${PUBLIC_SHARED_COMPONENTS_ROOT}/`,
  `${UI_PACKAGE_COMPONENTS_ROOT}/`,
];

/**
 * Broader prefixes for primitive *shape* audits — includes ALL public
 * components (not only public/shared).
 */
export const PRIMITIVE_SHAPE_AUDIT_PATH_PREFIXES = [
  `${LEGACY_SHARED_COMPONENTS_ROOT}/`,
  `${PUBLIC_COMPONENTS_ROOT}/`,
  `${UI_PACKAGE_COMPONENTS_ROOT}/`,
];

// ── Scan roots ───────────────────────────────────────────────────────────────

/**
 * Directory roots to walk when an audit scans the primitive + style surface.
 * Covers app styles, the legacy shared layer, and the extracted package.
 */
export const PRIMITIVE_SCAN_ROOTS = ["src/styles", LEGACY_SHARED_COMPONENTS_ROOT, UI_PACKAGE_ROOT];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when `filePath` lives under any shared-primitive prefix. */
export function isSharedPrimitivePath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  return SHARED_PRIMITIVE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
