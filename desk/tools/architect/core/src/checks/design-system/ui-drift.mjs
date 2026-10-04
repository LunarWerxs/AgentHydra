/*
 * Shared primitives audit.
 *
 * This file is the canonical shared primitives audit implementation.
 * Keep the real logic here so an engineer or AI reviewer can open one file and
 * understand how the audit runs, what checks exist, and how output is emitted.
 *
 * Primary commands:
 * - `bun run audit:shared-primitives -- list`
 * - `bun run audit:shared-primitives -- ui-drift`
 * - `bun run audit:shared-primitives -- ui-drift --format markdown`
 * - `bun run audit:shared-primitives -- ui-drift --format markdown --output tmp/audits/UI_DRIFT_REPORT.md`
 *
 * Operational notes:
 * - Bun entrypoints should target this file directly.
 * - `ui-drift` is the first built-in shared primitives check.
 * - If this audit grows, prefer keeping the canonical behavior here until there
 *   is a strong reason to split it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_SHARED_COMPONENTS_ROOT,
  PRIMITIVE_SHAPE_AUDIT_PATH_PREFIXES,
  SHARED_PRIMITIVE_PATH_PREFIXES,
  UI_PACKAGE_STYLES_ROOT,
} from "@saydeploy/architect/core/primitive-locations";
import { collectSuppressions, matchingSuppression } from "@saydeploy/architect/core/suppressions";

export const CHECK_ID = "ui-drift";
export const CHECK_DESCRIPTION = "Shared primitive, motion, and workspace-surface drift audit.";

const RULE_DEFINITIONS = {
  "raw-button-outside-shared": {
    severity: "error",
    description: "Raw <button> in Vue SFCs outside approved shared primitive implementation paths.",
  },
  "raw-input-outside-shared": {
    severity: "error",
    description: "Raw tracked <input> in Vue SFCs outside approved shared primitive implementation paths.",
  },
  "raw-select-outside-shared": {
    severity: "error",
    description: "Raw <select> in Vue SFCs outside shared primitive paths — use AppSelect / PublicSelectField.",
  },
  "raw-textarea-outside-shared": {
    severity: "error",
    description: "Raw <textarea> in Vue SFCs outside shared primitive paths — use AppTextField (multiline).",
  },
  "tailwind-important-modifier": {
    severity: "warn",
    description: "Tailwind ! important modifiers in feature Vue components require an allowlist entry.",
  },
  "feature-local-primitive-class-without-import": {
    severity: "warn",
    description:
      "Feature-local chip/button/tab/toggle/card/row classes should import the matching shared primitive or document why they stay local.",
  },
  "bespoke-primitive-surface-candidate": {
    severity: "warn",
    description:
      "High-signal feature-local surfaces/actions look hand-rolled and should usually use shared primitives.",
  },
  "shared-primitive-conversion-candidate": {
    severity: "warn",
    description:
      "Feature-local markup structurally matches a shared primitive family and should be migrated or justified.",
  },
  "title-attr-on-non-form": {
    severity: "warn",
    description: "Native title= on non-form elements.",
  },
  "clipboard-write-outside-app-copy-field": {
    severity: "error",
    description: "navigator.clipboard.writeText used outside the shared clipboard helper.",
  },
  "public-hardcoded-theme-utility": {
    severity: "warn",
    description: "Hard-coded Tailwind color utilities in public Vue templates bypass public theme tokens.",
  },
  "raw-motion-transition-utility": {
    severity: "warn",
    description: "Raw transition utility classes bypass shared gc-transition motion utilities.",
  },
  "raw-motion-timing-utility": {
    severity: "warn",
    description: "Raw duration/ease/delay utility classes bypass shared motion timing tokens.",
  },
  "raw-surface-transition-literal": {
    severity: "error",
    description:
      "Raw shared-surface transform transition literals should use named motion tokens or primitive presets.",
  },
  "legacy-gc-subsurface-card": {
    severity: "error",
    description: "Legacy gc-subsurface-card template classes are forbidden in Vue templates.",
  },
  "legacy-gc-surface-card": {
    severity: "error",
    description: "Legacy gc-surface-card template classes are forbidden in Vue templates.",
  },
  "legacy-gc-empty-state": {
    severity: "error",
    description: "Legacy gc-empty-state template classes are forbidden in Vue templates.",
  },
  "legacy-gc-detail-card-surface": {
    severity: "error",
    description: "Legacy gc-detail-card-surface template classes are forbidden in Vue templates.",
  },
  "workspace-raw-shadow-utility": {
    severity: "warn",
    description: "Raw Tailwind shadow utilities are forbidden on in-page workspace surfaces.",
  },
  "workspace-custom-shadow-utility": {
    severity: "warn",
    description:
      "Custom shadow-[...] utilities are forbidden on in-page workspace surfaces outside reviewed exceptions.",
  },
  "app-flyout-panel-z-utility": {
    severity: "error",
    description: "AppFlyoutSurface panel-class should not manage z-* utilities directly; use zIndexVar instead.",
  },
  "feature-local-teleport": {
    severity: "error",
    description: "Feature-local Teleport usage is forbidden; shared overlay primitives should own body teleporting.",
  },
  "feature-local-detail-pane-card": {
    severity: "warn",
    description: "Feature-local gc-app-detail-pane-card usage should migrate to AppDetailPaneCard.",
  },
  "feature-local-dismissable-wiring": {
    severity: "error",
    description: "Feature-local useDismissable wiring should migrate into shared overlay, dock, or sheet primitives.",
  },
  "shared-primitive-callsite-class-drift": {
    severity: "warn",
    description:
      "Audited shared primitive callsites should not override classes directly; use explicit props or wrappers.",
  },
  "sfc-md-sys-color-token-redefinition": {
    severity: "error",
    description:
      "Vue SFC style blocks must not re-declare --md-sys-color-* palette tokens; define theme palettes in src/styles/tokens.css.",
  },
  "workspace-root-state-import": {
    severity: "error",
    description:
      "New imports from useWorkspaceRootState are forbidden; migrate state into feature-scoped composables instead.",
  },
  "shared-field-typography-contract": {
    severity: "error",
    description: "Shared field typography utilities that size controls must forward AppTextField control vars.",
  },
  "shared-floating-field-position-contract": {
    severity: "error",
    description:
      "Shared floating field labels, textarea resting labels, and leading affordances must keep their canonical position anchors.",
  },
  "shared-search-native-reset-contract": {
    severity: "error",
    description:
      "Shared search input primitives must suppress native browser search clear/result affordances when they render custom search UI.",
  },
  "editor-command-search-chrome-contract": {
    severity: "error",
    description:
      "Editor header command search must stay outline-only and use the shared outlined text-field stroke token.",
  },
  "primitive-shape-contract-missing": {
    severity: "error",
    description:
      "Shape-bearing shared/public primitive classes used in templates must have a nonzero radius contract in CSS.",
  },
  "stateful-shape-token-snap-risk": {
    severity: "warn",
    description:
      "Persistent state selectors that mutate shape/radius can snap during open/close; prefer a stable animated radius var or reviewed suppression.",
  },
  "section-card-radius-contract": {
    severity: "error",
    description: "Canonical section-card primitives must default to the shared 20px section-card radius contract.",
  },
  "bespoke-section-card-radius": {
    severity: "warn",
    description:
      "Section-card-like surfaces should use AppCard/PublicCard or gc-radius-section-card instead of bespoke rounded utilities.",
  },
  "hand-rolled-progress-bar": {
    severity: "error",
    description:
      "Hand-rolled percentage-width fill bars (inline :style width:`${…}%`) must use AppProgressBar. The analytics data-viz family (src/components/shared/analytics/**) is exempt — those are gradient/glow charts, not UI progress.",
  },
};

const DEFAULT_FIXTURE_PATH = "src/components/TestFixture.vue";
// Hand-rolled progress-bar detector. An inline `:style` that drives a fill to a
// percentage width via a template literal (`width: `${pct}%``) is the signature
// of a manual progress bar; AppProgressBar owns this with tokens + a11y. The
// analytics data-viz family is exempt — those bars use gradient fills / glow /
// per-row colors AppProgressBar deliberately does not model, and already share
// the canonical `--gc-transition-progress-fill-motion` token.
const HAND_ROLLED_PROGRESS_BAR_PATTERN = /(?::style|v-bind:style)\s*=\s*"(?=[^"]*\bwidth:\s*`[^`]*%`)[^"]*"/g;
const DATA_VIZ_PROGRESS_FILL_PATH_PREFIXES = ["src/components/shared/analytics/"];
// Form controls accept `title` as an accessibility tooltip; `iframe` requires
// `title` per WCAG (4.1.2) to name the embedded frame for assistive tech.
const ALLOWED_TITLE_TAGS = new Set(["input", "textarea", "select", "option", "iframe"]);
// SHARED_PRIMITIVE_PATH_PREFIXES is imported from ../core/primitive-locations.mjs
const DEFAULT_RAW_CONTROL_FEATURE_ALLOWLIST = ["src/SharedPrimitivesLiveHarness.vue"];
const DEFAULT_RAW_CONTROL_ALLOWLIST_PREFIXES = ["src/shared-primitives-live/"];
const DEFAULT_RAW_BUTTON_PRIMITIVE_ALLOWLIST = [
  "src/components/public/hosted-event-public/shared/HostedEventRsvpFeedback.vue",
  "packages/connections-ui/src/components/actions/AppColorSwatchButton.vue",
  "packages/connections-ui/src/components/actions/AppDragHandle.vue",
  "packages/connections-ui/src/components/actions/AppFAB.vue",
  "packages/connections-ui/src/components/actions/AppFabMenu.vue",
  "packages/connections-ui/src/components/actions/AppIconButton.vue",
  "packages/connections-ui/src/components/selection/AppChoiceOptionList.vue",
  "src/components/shared/display/AppCompactMonthCalendarCard.vue",
  "packages/connections-ui/src/components/display/AppPersonInfoCard.vue",
  "src/components/shared/editor/AppRichTextEditor.vue",
  "packages/connections-ui/src/components/fields/AppCheckbox.vue",
  "packages/connections-ui/src/components/fields/BaseComboboxControl.vue",
  "src/components/shared/fields/AppDateRangePicker.vue",
  "packages/connections-ui/src/components/fields/AppExpandingSearchField.vue",
  "packages/connections-ui/src/components/fields/AppFileTrigger.vue",
  "packages/connections-ui/src/components/fields/AppImageUploadTile.vue",
  "src/components/shared/fields/AppSelect.vue",
  "packages/connections-ui/src/components/fields/AppSwitch.vue",
  "packages/connections-ui/src/components/fields/BaseSelectControl.vue",
  "packages/connections-ui/src/components/layout/AppDetailPanePanel.vue",
  "packages/connections-ui/src/components/navigation/AppAccountSwitcherPanel.vue",
  "packages/connections-ui/src/components/navigation/AppTabs.vue",
  "packages/connections-ui/src/components/overlays/AppBackdrop.vue",
  "packages/connections-ui/src/components/overlays/AppRichTooltip.vue",
  "packages/connections-ui/src/components/pickers/AppDatePickerDialog.vue",
  "packages/connections-ui/src/components/selection/AppChip.vue",
  "packages/connections-ui/src/components/selection/AppSegmentedToggle.vue",
  "packages/connections-ui/src/components/selection/AppSelectionRow.vue",
  "src/components/shared/table/AppTable.vue",
  "src/components/shared/table/AppTableRowInternal.vue",
  "src/components/shared/table/AppTableSelectionHeader.vue",
];
const DEFAULT_RAW_TRACKED_INPUT_PRIMITIVE_ALLOWLIST = [
  "packages/connections-ui/src/components/fields/BaseComboboxControl.vue",
  "src/components/shared/fields/AppEditableTitleField.vue",
  "src/components/shared/fields/AppInlineSearchField.vue",
  "packages/connections-ui/src/components/fields/AppOtpCodeField.vue",
  "packages/connections-ui/src/components/fields/AppRangeField.vue",
  "packages/connections-ui/src/components/fields/AppTextField.vue",
  "packages/connections-ui/src/components/fields/AppTokenField.vue",
];
const DEFAULT_FEATURE_LOCAL_TELEPORT_ALLOWLIST = ["src/components/AppModal.vue"];
const DEFAULT_FEATURE_LOCAL_DISMISSABLE_ALLOWLIST = [
  "src/components/AppModal.vue",
  "src/components/UnifiedMobileSheet.vue",
];
const UNTRACKED_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const SOURCE_FILE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".vue"]);
const AUDIT_FILE_EXTENSIONS = new Set([...SOURCE_FILE_EXTENSIONS, ".css"]);
const TEST_FILE_PATTERN = /(?:^|\/)__tests__\/|(?:^|\.)(?:spec|test)\.[^.]+$/;
const OPENING_TAG_PATTERN = /<([A-Za-z][\w-]*)([\s\S]*?)>/g;
const NATIVE_TITLE_ATTR_PATTERN = /(?:^|\s)(?:title|:title|v-bind:title)\s*=/;
const DIRECT_CLIPBOARD_WRITE_PATTERN = /\bnavigator\.clipboard\s*(?:\.|\?\.)\s*writeText\s*\(/g;
const CLASS_ATTR_VALUE_PATTERN = /(?:^|\s)(?:class|:class|v-bind:class)\s*=\s*(["'])([\s\S]*?)\1/g;
// Matches both Tailwind v3 prefix syntax (`!class`, `hover:bg-primary!`) and
// Tailwind v4 suffix syntax (`class!`, `hover:bg-primary!`).
// Tailwind class identifiers are strictly lowercase letters/digits/hyphens
// (with optional arbitrary-value brackets/parens); JS boolean negations like
// `!isMyLink` or contractions like `don't` use uppercase or apostrophes that
// don't fit this shape, so this pattern excludes them.
const TAILWIND_IMPORTANT_MODIFIER_PATTERN =
  /(?<![\w-])(?:[a-z][a-z0-9-]*:)*!(?:[a-z][a-z0-9/-]*|\[[^\]]+\]|\([^)]+\))(?=$|[\s"'`,\]}])|(?<=[a-z0-9\])])!(?=$|\s|\}|\])/g;
const PUBLIC_LITERAL_THEME_UTILITY_PATTERN =
  /(?:bg-white(?:\/\d{1,3})?|(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-[0-9]{2,3})?(?:\/\d{1,3})?|(?:bg|text|border|ring|from|via|to)-\[(?=[^\]]*(?:#|(?:ok)?lch|rgb|hsl|color-mix))[^\]]+\])!?/g;
const RAW_MOTION_TRANSITION_UTILITY_PATTERN = /(?:^|[^\w-])transition-(?:colors|opacity|shadow|all)(?![\w-])/g;
const RAW_MOTION_TIMING_UTILITY_PATTERN =
  /(?<![\w-])(?:duration-(?:\[[^\]]+\]|[0-9]+)|ease-(?:\[[^\]]+\]|linear|in|out|in-out)|delay-(?:\[[^\]]+\]|[0-9]+))(?![\w-])/g;
const DEFAULT_LEGACY_SURFACE_CLASS_NAMES = {
  "legacy-gc-subsurface-card": ["gc-subsurface-card"],
  "legacy-gc-surface-card": ["gc-surface-card"],
  "legacy-gc-empty-state": ["gc-empty-state"],
  "legacy-gc-detail-card-surface": ["gc-detail-card-surface"],
};
const FEATURE_LOCAL_DETAIL_PANE_CARD_PATTERN = /\bgc-app-detail-pane-card(?:--[\w-]+)?\b/g;
const SHARED_PRIMITIVE_CLASS_ATTR_PATTERN = /(?:^|\s)(?:class|:class|v-bind:class)\s*=/;
const SHARED_PRIMITIVE_CLASS_AUDIT_PATTERNS = {
  AppEmptyState: SHARED_PRIMITIVE_CLASS_ATTR_PATTERN,
  AppSettingsNavItem: SHARED_PRIMITIVE_CLASS_ATTR_PATTERN,
  AppSettingsSection: SHARED_PRIMITIVE_CLASS_ATTR_PATTERN,
  AppStickyMobileBar:
    /(?:^|\s)(?:class|:class|v-bind:class|root-class|:root-class|v-bind:root-class|surface-class|:surface-class|v-bind:surface-class|z-class|:z-class|v-bind:z-class)\s*=/,
  AppSegmentedToggle: SHARED_PRIMITIVE_CLASS_ATTR_PATTERN,
  WorkspaceMobileSegmentSelect: SHARED_PRIMITIVE_CLASS_ATTR_PATTERN,
};
const RAW_WORKSPACE_SHADOW_UTILITY_PATTERN = /(?<![\w-])(?:[\w-]+:)*shadow-(?:sm|md|lg|xl|2xl)(?![\w-])/g;
const CUSTOM_WORKSPACE_SHADOW_UTILITY_PATTERN = /(?<![\w-])(?:[\w-]+:)*shadow-\[[^\]]+\]/g;
const RAW_SURFACE_TRANSITION_LITERAL_PATTERN =
  /transform\s+var\(--gc-motion-duration-overlay\)\s+var\(--gc-motion-easing-overlay-spatial\)|transform\s+var\(--gc-motion-duration-sheet\)\s+var\(--gc-motion-easing-sheet-spatial\)/g;
const FEATURE_LOCAL_DISMISSABLE_PATTERN = /\buseDismissable\s*\(/g;
const SFC_MD_SYS_COLOR_TOKEN_REDEFINITION_PATTERN = /(?<![\w-])--md-sys-color-[\w-]+\s*:/g;
// Match VALUE imports from `useWorkspaceRootState` only — type-only imports
// (`import type { ... }`) shape function signatures without creating runtime
// coupling to the legacy state hub, so they aren't drift. The negative
// lookbehind on `type ` rejects `import type { ... } from "...useWorkspaceRootState"`
// while still flagging `import { useWorkspaceRootState } from "..."` and
// default/namespace imports.
const WORKSPACE_ROOT_STATE_IMPORT_PATTERN =
  /(?<!\bimport\s+type\s+\{[^}]*\}\s+)\bimport\s+(?!type\s)[^;]*from\s*["'][^"']*useWorkspaceRootState(?:\.ts)?["']/g;
// The single canonical orchestrator that instantiates the root workspace
// state. Every workspace shell needs exactly one of these; the audit's intent
// is to prevent OTHER files from coupling to the root hub.
const DEFAULT_WORKSPACE_ROOT_STATE_OWNER_PATHS = ["src/composables/workspace/useWorkspaceAppController.ts"];
const PRIMITIVE_CLASS_TERMS = [
  { term: "chip", imports: ["AppChip", "AppChipSet", "AppBadge", "PublicChip", "PublicPill"] },
  { term: "button", imports: ["AppButton", "AppIconButton", "PublicButton"] },
  { term: "tab", imports: ["AppTabs"] },
  { term: "toggle", imports: ["AppSegmentedToggle", "AppSwitch"] },
  { term: "card", imports: ["AppCard", "PublicCard", "PublicStateCard", "PublicTinyHeaderCard"] },
  { term: "row", imports: ["AppListRow", "AppSelectionRow", "AppSettingsRow", "AppTable"] },
];
const PRIMITIVE_CLASS_SEGMENTS = new Set(PRIMITIVE_CLASS_TERMS.map(({ term }) => term));
const FEATURE_LOCAL_PRIMITIVE_CLASS_PATTERN = /\b[A-Za-z0-9_-]*(?:chip|button|tab|toggle|card|row)[A-Za-z0-9_-]*\b/g;
const STATIC_CLASS_ATTR_PATTERN = /(?:^|\s)class\s*=\s*(["'])([\s\S]*?)\1/g;
const NATIVE_BESPOKE_PRIMITIVE_TAGS = new Set(["a", "article", "button", "div", "label", "li", "section"]);
const BESPOKE_PRIMITIVE_SHARED_TOKEN_PATTERN =
  /^(?:gc-|public-card|public-button|public-chip|public-pill|app-card|app-button|app-chip|app-list-row)/;
const BESPOKE_PRIMITIVE_RADIUS_TOKEN_PATTERN = /^(?:[\w-]+:)*rounded(?:-(?!none\b)[\w/.[\]-]+)?!?$/;
const BESPOKE_PRIMITIVE_SURFACE_TOKEN_PATTERN =
  /^(?:[\w-]+:)*(?:bg|border|ring|shadow|from|via|to)-(?:surface|primary|secondary|tertiary|error|success|warning|public|outline|inverse|state|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|\[)/;
const BESPOKE_PRIMITIVE_PADDING_TOKEN_PATTERN = /^(?:[\w-]+:)*p[xytrblse]?-[\w/.[\]-]+!?$/;
const BESPOKE_PRIMITIVE_LAYOUT_TOKEN_PATTERN = /^(?:[\w-]+:)*(?:flex|inline-flex|grid)$/;
const BESPOKE_PRIMITIVE_INTERACTIVE_TOKEN_PATTERN =
  /^(?:[\w-]+:)*(?:cursor-pointer|hover:|focus:|focus-visible:|active:)/;
const SHARED_PRIMITIVE_CONVERSION_TAGS = new Set([
  "a",
  "article",
  "aside",
  "button",
  "div",
  "footer",
  "header",
  "label",
  "li",
  "nav",
  "section",
  "span",
  "summary",
]);
const SHARED_PRIMITIVE_CONVERSION_FAMILIES = [
  {
    id: "collapsible-section",
    suggestions: ["AppCollapsibleSection", "AppCollapse", "AppSettingsNavItem"],
    semantic: /(?:^|[-_])(?:accordion|collapsible|collapse|disclosure|section-toggle|expandable|expander)(?:$|[-_])/i,
    matches({ attrs, tagName, tokens }) {
      const hasExpansionSemantics = /\baria-expanded\b/.test(attrs) || tagName === "summary";
      return hasExpansionSemantics && tokenMatches(tokens, this.semantic);
    },
  },
  {
    id: "menu-picker",
    suggestions: ["AppMenuList", "AppPickerListItem", "AppFlyoutSurface", "AppKebabMenu"],
    semantic: /(?:^|[-_])(?:command|dropdown|flyout|menu|option|palette|picker|popover|listbox)(?:$|[-_])/i,
    matches({ attrs, tagName, tokens }) {
      const roleDriven = /\brole\s*=\s*["'](?:menu|menuitem|listbox|option)["']/.test(attrs);
      const triggerDriven = tagName === "button" && /\baria-haspopup\b/.test(attrs);
      return (
        roleDriven ||
        triggerDriven ||
        (tokenMatches(tokens, this.semantic) && hasPrimitiveSurfaceSignal(tokens) && hasPrimitivePaddingSignal(tokens))
      );
    },
  },
  {
    id: "status-chip",
    suggestions: ["AppBadge", "AppChip", "AppIconChip", "PublicChip", "PublicPill"],
    semantic: /(?:^|[-_])(?:badge|chip|count|label|pill|status|tag)(?:$|[-_])/i,
    matches({ tokens }) {
      return (
        tokenMatches(tokens, this.semantic) &&
        hasPrimitiveRadiusSignal(tokens) &&
        hasPrimitivePaddingSignal(tokens) &&
        hasPrimitiveSurfaceSignal(tokens)
      );
    },
  },
  {
    id: "alert-feedback",
    suggestions: ["AppInlineAlert", "AppSnackbar", "AppLoadErrorView"],
    semantic: /(?:^|[-_])(?:alert|banner|feedback|notice|snackbar|toast)(?:$|[-_])/i,
    matches({ attrs, tokens }) {
      const roleDriven = /\brole\s*=\s*["']alert["']/.test(attrs) && hasPrimitiveSurfaceSignal(tokens);
      return roleDriven || (tokenMatches(tokens, this.semantic) && hasPrimitiveSurfaceSignal(tokens));
    },
  },
  {
    id: "empty-loading",
    suggestions: ["AppEmptyState", "AppSkeletonStack", "AppSkeletonBlock", "AppLoadingIndicator", "PublicStateCard"],
    semantic: /(?:^|[-_])(?:empty|loading|placeholder|skeleton|state-card)(?:$|[-_])/i,
    matches({ attrs, tokens }) {
      const roleDriven =
        /\brole\s*=\s*["']status["']/.test(attrs) &&
        (tokenMatches(tokens, this.semantic) || hasPrimitiveSurfaceSignal(tokens));
      const loadingDriven = tokenMatches(tokens, /^(?:[\w-]+:)*(?:animate-spin|skeleton)(?:$|[-_])/i);
      const iconOnlyLoading =
        tokenMatches(tokens, /^(?:[\w-]+:)*ms-icon(?:$|[-_])/i) && !hasPrimitiveSurfaceSignal(tokens);
      return (
        roleDriven ||
        (loadingDriven && !iconOnlyLoading) ||
        (tokenMatches(tokens, this.semantic) && hasPrimitiveSurfaceSignal(tokens))
      );
    },
  },
  {
    id: "navigation-tile",
    suggestions: ["AppNavigationTile", "AppNavItem", "AppInteractiveTile"],
    semantic: /(?:^|[-_])(?:destination|launcher|nav-item|navigation-tile|tile)(?:$|[-_])/i,
    matches({ attrs, tagName, tokens }) {
      const interactive =
        tagName === "a" || tagName === "button" || /(?:^|\s)(?:@click|v-on:click|role\s*=)/.test(attrs);
      return (
        interactive &&
        tokenMatches(tokens, this.semantic) &&
        hasPrimitiveRadiusSignal(tokens) &&
        hasPrimitivePaddingSignal(tokens)
      );
    },
  },
];
// Class tokens that contain a primitive word as a `-`-separated segment but
// don't represent feature-local drift toward a missing shared primitive.
// Three categories:
//   1. Tailwind layout/typography utilities that happen to use primitive words
//   2. Shape/radius tokens (e.g. `gc-radius-card` is just a 28px corner radius)
//   3. Shared CSS primitive classes defined in src/styles/primitives/ — they
//      are themselves the canonical primitive surface; using them is not drift
const TAILWIND_UTILITY_EXACT_EXCLUSIONS = new Set([
  // Tailwind layout/typography utilities
  "flex-row",
  "flex-row-reverse",
  "grid-flow-row",
  "grid-flow-row-dense",
  "grid-rows-none",
  "row-auto",
  "tabular-nums",
  // Shape/radius tokens — `gc-radius-*` are corner-radius tokens applied
  // across surfaces; their names mention primitives but they don't assert one
  "gc-radius-card",
  "gc-radius-section-card",
  "gc-radius-chip",
  "gc-radius-button",
  "gc-radius-button-tight",
  // Shared CSS primitive classes (src/styles/primitives/*.css). These are the
  // canonical primitive surface markup contracts; consumers should use them.
  "gc-popup-modal-card",
  "gc-detail-item-card",
  "gc-detail-card-section",
  "gc-detail-section-row",
  "gc-density-preview-row",
  "gc-detail-accent-chip",
  "gc-checkbox-row",
  "gc-app-switch-row",
  "gc-app-radio-row",
  "gc-app-settings-row",
  "gc-app-chip-set",
  "gc-app-table-row",
  "gc-app-table-row-detail",
  "gc-color-swatch-button",
  "gc-create-action-button",
  "gc-outline-button",
  "gc-tonal-button",
  "gc-row-actions-fade",
  "gc-segmented-toggle",
  "gc-table-header-button",
  "gc-editor-segmented-toggle",
  "gc-editor-status-chip",
  "gc-editor-status-row",
  "gc-editor-team-row",
  "gc-editor-team-search-row",
  "gc-editor-summary-card",
  "gc-editor-manual-entry-row",
  "gc-editor-tabs-strip",
  "gc-file-trigger-card",
  "gc-density-animated-row",
  "gc-contact-row",
  // Mobile directory row primitive family (src/styles/routes/workspace/directory.css)
  "gc-mobile-directory-row-shell",
  "gc-mobile-directory-row-main",
  "gc-mobile-directory-row-copy",
  "gc-mobile-directory-row-title",
  "gc-mobile-directory-row-subtitle",
  "gc-mobile-directory-row-leading",
  "gc-mobile-directory-row-actions",
  // Workspace table primitive family (src/styles/legacy/components-centralized.css)
  "gc-table-row-symbol",
  "gc-app-table-row-subdetail",
  // MyLink preview themed primitive blocks. These are shared across MyConnect
  // public surfaces and the workspace MyLink preview canvas; they are the
  // canonical themed row markup contracts for that feature.
  "my-link-profile-row",
  "my-link-link-row",
  "my-link-hub-icon-row",
  "myconnect-link-row",
  // Public hosted-event meta sidebar click-targets. Declared once in
  // `src/styles/routes/public/hosted-event.css` with their own state-layer +
  // public-theme styling; they are the canonical click-row markup contract
  // for the public meta sidebar and don't represent feature-local drift.
  "hosted-meta-click-row",
  // Host console view containers. Each host-console tab (Quick/Page/etc.) has
  // a route-scoped layout-grid class declared in
  // `src/styles/routes/host-console/editor.css`. The `-tab` suffix here names
  // the tab VIEW ("the Quick tab page"), not an `AppTabs` instance.
  "host-quick-tab",
  // Sign-in passkey illustration shapes. `<rect class="spki-card">` paints
  // a stylized passkey card inside an SVG illustration; it is not a UI card
  // surface and the `AppCard` primitive doesn't apply to SVG geometry.
  "spki-card",
  // AppCard variant="detail-pane" emits this class. The dedicated
  // `feature-local-detail-pane-card` rule already flags raw usage in feature
  // workspace components, so the generic primitive-class rule shouldn't
  // double-flag it.
  "gc-app-detail-pane-card",
]);
const TAILWIND_UTILITY_PREFIX_EXCLUSIONS = [
  "auto-rows-",
  "grid-rows-",
  "row-span-",
  "row-start-",
  "row-end-",
  "tab-size-",
];
function escapeRegexFragment(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLegacySurfaceRulePatterns(legacySurfaceClassNames = DEFAULT_LEGACY_SURFACE_CLASS_NAMES) {
  return Object.fromEntries(
    Object.entries(legacySurfaceClassNames).map(([ruleId, classNames]) => {
      const pattern = classNames.length
        ? new RegExp(
            classNames.map((className) => `\\b${escapeRegexFragment(className)}(?:--[\\w-]+)?\\b`).join("|"),
            "g",
          )
        : /$^/g;
      return [ruleId, pattern];
    }),
  );
}

function buildUiDriftPolicy(overrides = {}) {
  return {
    rawControlFeatureAllowlist: new Set(overrides.rawControlFeatureAllowlist ?? DEFAULT_RAW_CONTROL_FEATURE_ALLOWLIST),
    rawControlAllowlistPrefixes: overrides.rawControlAllowlistPrefixes ?? DEFAULT_RAW_CONTROL_ALLOWLIST_PREFIXES,
    rawButtonPrimitiveAllowlist: new Set(
      overrides.rawButtonPrimitiveAllowlist ?? DEFAULT_RAW_BUTTON_PRIMITIVE_ALLOWLIST,
    ),
    rawTrackedInputPrimitiveAllowlist: new Set(
      overrides.rawTrackedInputPrimitiveAllowlist ?? DEFAULT_RAW_TRACKED_INPUT_PRIMITIVE_ALLOWLIST,
    ),
    featureLocalTeleportAllowlist: new Set(
      overrides.featureLocalTeleportAllowlist ?? DEFAULT_FEATURE_LOCAL_TELEPORT_ALLOWLIST,
    ),
    featureLocalDismissableAllowlist: new Set(
      overrides.featureLocalDismissableAllowlist ?? DEFAULT_FEATURE_LOCAL_DISMISSABLE_ALLOWLIST,
    ),
    workspaceRootStateOwnerPaths: new Set(
      overrides.workspaceRootStateOwnerPaths ?? DEFAULT_WORKSPACE_ROOT_STATE_OWNER_PATHS,
    ),
    legacySurfaceRulePatterns: buildLegacySurfaceRulePatterns(
      overrides.legacySurfaceClassNames ?? DEFAULT_LEGACY_SURFACE_CLASS_NAMES,
    ),
  };
}

let UI_DRIFT_POLICY = buildUiDriftPolicy();

const DEFAULT_TAILWIND_IMPORTANT_ALLOWLIST_PATH = path.resolve(
  process.cwd(),
  "packages",
  "connections-arkitect",
  "policies",
  "connections",
  "allowlists/ui-drift-tailwind-important-allowlist.json",
);
const SHADOW_AUDIT_INLINE_IGNORE_PATTERN = /css-audit-ignore:\s*shadow\s+-\s*[A-Za-z0-9]/i;
// PRIMITIVE_SHAPE_AUDIT_PATH_PREFIXES is imported from ../core/primitive-locations.mjs
const GENERATED_SHAPE_AUDIT_PATH_PREFIXES = [
  "src/lib/maps/",
  "src/composables/maps/",
  "src/components/sign-in/DemoWorkspacePreview.vue",
  "src/components/public/explore/",
];
const PRIMITIVE_SHAPE_CLASS_PREFIX_PATTERN = /^(?:gc-|public-|myconnect-|hosted-|signin-|discover-|app-)/;
const PRIMITIVE_SHAPE_CLASS_SEGMENT_PATTERN =
  /(?:^|[-_])(?:button|btn|trigger|action|row|item|chip|pill|toggle|select|input|menu|card|surface|panel|shell|cta|field|current-email|marker|cluster|pin|indicator|badge|count|ring|pulse|dot|tooltip)(?:$|[-_])/;
const GENERATED_SHAPE_CLASS_PREFIX_PATTERN = /^(?:custom-map-|map-|event-schedule-|discover-beta-marker|demo-map-)/;
const ROUNDED_UTILITY_CLASS_PATTERN = /(?:^|:)rounded-(?!none\b)[\w/.[\]-]+$/;
const PRIMITIVE_SHAPE_NON_SURFACE_CLASS_PATTERN = /(?:^|[-_])(?:backdrop|scrim|input)(?:$|[-_])/;
const GENERATED_SHAPE_NON_SURFACE_CLASS_PATTERN = /__(?:avatar|count|fallback|icon|image|star|tip|votes)$/;
const PRIMITIVE_SHAPE_NON_SURFACE_INPUT_TYPES = new Set(["checkbox", "color", "file", "hidden", "radio", "range"]);
const STATEFUL_SHAPE_SNAP_SUPPRESS_DIRECTIVE_PATTERN = /ui-drift-ignore:\s*stateful-shape-snap\s+-\s*[A-Za-z0-9]/i;
const STATEFUL_SHAPE_SELECTOR_PATTERN =
  /--(?:[a-z0-9]+-)*(?:open|active|expanded|selected|checked|pressed|current|visible)\b|\.(?:is|has)-(?:open|active|expanded|selected|checked|pressed|current|visible)\b|\.(?:open|active|expanded|selected|checked|pressed|current|visible)\b|\[(?:aria-expanded|aria-selected|aria-pressed|data-(?:state|open|active|expanded|selected|current|visible))\s*(?:=|\])/i;
const SHAPE_MUTATION_DECLARATION_PATTERN =
  /(?:^|[;\s])(?:--[a-z0-9_-]*(?:shape|radius)[a-z0-9_-]*|border(?:-(?:top|right|bottom|left))?(?:-(?:left|right))?-radius|border-(?:start|end)-(?:start|end)-radius)\s*:/i;
const SECTION_CARD_RADIUS_TOKEN = "gc-radius-section-card";
const SECTION_CARD_RADIUS_ATTR_PATTERN =
  /(?:^|\s)((?:class|:class|v-bind:class|[\w-]*-class|:[\w-]*-class|v-bind:[\w-]*-class))\s*=\s*(["'])([\s\S]*?)\2/g;
const BESPOKE_SECTION_CARD_RADIUS_TOKEN_PATTERN =
  /^(?:[\w-]+:)*rounded-(?:2xl|3xl|\[(?:2[4-9]|3[0-9])px\]|\[(?:1\.5|1\.75|2(?:\.0)?)rem\])!?$/;
const SECTION_CARD_SURFACE_TOKEN_PATTERN =
  /(?:^|[-_])(?:card|panel|surface|section|shell|tile|stage|preview|container|notice|empty|state)(?:$|[-_])/i;
const SECTION_CARD_RADIUS_EXEMPT_TOKEN_PATTERN =
  /(?:^|[-_])(?:alert|avatar|badge|button|calendar|chip|date|dialog|icon|image|img|logo|map|media|menu|modal|phone|pill|popover|qr|sheet|toast|tooltip|video)(?:$|[-_])/i;
const SECTION_CARD_RADIUS_CONTRACTS = {
  "packages/connections-ui/src/components/layout/AppCard.vue": [
    {
      label: "AppCard default radius prop",
      pattern: /\bwithDefaults\([\s\S]*?\{[\s\S]*?\bradius:\s*"section"/,
    },
    {
      label: "AppCard section radius class",
      pattern: /case\s+"section":\s*return\s+"gc-radius-section-card";/,
    },
  ],
  "src/components/public/shared/PublicCard.vue": [
    {
      label: "PublicCard default radius prop",
      pattern: /\bwithDefaults\([\s\S]*?\{[\s\S]*?\bradius:\s*"section"/,
    },
    {
      label: "PublicCard AppCard bridge radius",
      pattern: /<AppCard[\s\S]*?\bradius="section"/,
    },
  ],
  "packages/connections-ui/src/components/layout/AppListRow.vue": [
    {
      label: "AppListRow default rounded shape",
      pattern: /\bshape:\s*"rounded"/,
    },
    {
      label: "AppListRow rounded shape radius",
      pattern: /default:\s*return\s+"gc-radius-section-card";/,
    },
  ],
  "packages/connections-ui/src/components/layout/AppEmptyState.vue": [
    {
      label: "AppEmptyState section-card radius",
      pattern: /\bgc-app-empty-state\b[\s\S]*?\bgc-radius-section-card\b/,
    },
  ],
  "packages/connections-ui/src/components/display/AppTimelineItem.vue": [
    {
      label: "AppTimelineItem AppCard radius",
      pattern: /<AppCard[\s\S]*?\bradius="section"/,
    },
  ],
  "packages/connections-ui/src/components/fields/AppDropZone.vue": [
    {
      label: "AppDropZone section-card radius",
      pattern: /\bgc-app-drop-zone\b[\s\S]*?\bgc-radius-section-card\b/,
    },
  ],
  "packages/connections-ui/src/components/fields/AppFileTrigger.vue": [
    {
      label: "AppFileTrigger section-card radius",
      pattern: /\bgc-file-trigger-card\b[\s\S]*?\bgc-radius-section-card\b/,
    },
  ],
  "src/styles/routes/public/shared/public-chrome.css": [
    {
      label: "public-card default radius token",
      pattern: /\.public-card\s*\{[\s\S]*?--public-card-radius:\s*var\(--gc-radius-section-card,\s*20px\)/,
    },
    {
      label: "public-card large radius variants collapse to section",
      // All large/section-and-up public-card variants must collapse onto the
      // shared --gc-radius-section-card token. The canonical shape is a single
      // grouped selector block that lists every variant (lg, section, xl,
      // 2xl, 4xl) and sets one --public-card-radius. This regex enforces that
      // every variant is named in the same group above one shared token line.
      pattern:
        /\.public-card--radius-lg,[\s\S]*?\.public-card--radius-section,[\s\S]*?\.public-card--radius-xl,[\s\S]*?\.public-card--radius-2xl,[\s\S]*?\.public-card--radius-4xl\s*\{[\s\S]*?--public-card-radius:\s*var\(--gc-radius-section-card,\s*20px\)/,
    },
  ],
  "src/styles/shared-declarations.css": [
    {
      label: "gc-radius-section-card utility",
      pattern: /\.gc-radius-section-card\s*\{[\s\S]*?border-radius:\s*var\(--gc-radius-section-card\);/,
    },
  ],
  "packages/connections-ui/src/styles/primitives/detail-pane.css": [
    {
      label: "detail pane cards use section radius",
      pattern:
        /\.gc-app-detail-pane-card,[\s\S]*?\.gc-detail-item-card[\s\S]*?\{[\s\S]*?border-radius:\s*var\(--gc-radius-section-card\);/,
    },
    {
      label: "desktop detail pane cards use section radius",
      pattern:
        /\.gc-desktop-detail-pane--page \.gc-app-detail-pane-card,[\s\S]*?\.gc-desktop-detail-pane--page \.gc-detail-item-card[\s\S]*?\{[\s\S]*?border-radius:\s*var\(--gc-radius-section-card\);/,
    },
  ],
};
const SHARED_FIELD_TYPOGRAPHY_CONTRACTS = {
  "src/styles/core/base.css": [
    /\.gc-overline,[\s\S]*?\.gc-text-label-sm\s*\{\s*--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-label-small-size\);\s*font-size:\s*var\(--md-sys-typescale-label-small-size\);\s*\}/,
    /\.gc-overline,[\s\S]*?\.gc-text-label-sm\s*\{\s*--gc-floating-field-control-line-height:\s*var\(--md-sys-typescale-label-small-line-height\);\s*line-height:\s*var\(--md-sys-typescale-label-small-line-height\);\s*\}/,
    /\.gc-text-label,[\s\S]*?\.gc-text-more-subtle\s*\{\s*--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-body-small-size\);\s*font-size:\s*var\(--md-sys-typescale-body-small-size\);\s*\}/,
    /\.gc-text-label,[\s\S]*?\.gc-text-more-subtle\s*\{\s*--gc-floating-field-control-line-height:\s*var\(--md-sys-typescale-body-small-line-height\);\s*line-height:\s*var\(--md-sys-typescale-body-small-line-height\);\s*\}/,
    /\.gc-text-body,[\s\S]*?\.gc-text-subtle\s*\{\s*--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-body-medium-size\);\s*font-size:\s*var\(--md-sys-typescale-body-medium-size\);\s*\}/,
    /\.gc-text-body,[\s\S]*?\.gc-text-subtle\s*\{\s*--gc-floating-field-control-line-height:\s*var\(--md-sys-typescale-body-medium-line-height\);\s*line-height:\s*var\(--md-sys-typescale-body-medium-line-height\);\s*\}/,
    /\.gc-section-title\s*\{[\s\S]*?--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-title-small-size\);[\s\S]*?--gc-floating-field-control-line-height:\s*var\(--md-sys-typescale-title-small-line-height\);/,
  ],
  "packages/connections-ui/src/styles/primitives/app-copy-field.css": [
    /\.gc-copy-field__code\s*\{[\s\S]*?--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-label-small-size\);[\s\S]*?--gc-floating-field-control-line-height:\s*var\(--md-sys-typescale-label-small-line-height\);/,
  ],
  "packages/connections-ui/src/styles/primitives/app-editable-title-field.css": [
    /\.app-editable-title-field--md\s*\{\s*--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-title-large-size\);\s*\}/,
    /\.app-editable-title-field--lg\s*\{\s*--gc-floating-field-control-font-size:\s*var\(--md-sys-typescale-headline-medium-size\);\s*\}/,
  ],
};
const SHARED_FLOATING_FIELD_POSITION_CONTRACTS = {
  "packages/connections-ui/src/styles/primitives/app-floating-field.css": [
    /--gc-floating-field-label-left-base:\s*1\.25rem;/,
    /--gc-floating-field-floating-label-unoffset-left:\s*(?:var\(--gc-floating-field-label-left-base\)|calc\(\s*var\(--gc-floating-field-control-padding-inline-start-base\)\s*\+\s*0\.35rem\s*\));/,
    /\.gc-floating-field--floating-label-leading-unoffset\s*\{\s*--gc-floating-field-floating-label-left:\s*var\(--gc-floating-field-floating-label-unoffset-left\);\s*\}/,
    /\.gc-floating-field--textarea\s+\.gc-floating-field__label[\s\S]*?\{\s*top:\s*var\(--gc-floating-field-control-center-y\);/,
    /\.gc-floating-field__leading,\s*\.gc-floating-field__trailing,\s*\.gc-floating-field__label\s*\{\s*top:\s*var\(--gc-floating-field-control-center-y\);/,
  ],
};
const SHARED_SEARCH_NATIVE_RESET_CONTRACTS = {
  "packages/connections-ui/src/styles/primitives/app-floating-field.css": [
    /\.gc-floating-field__control\[type="search"\]::-webkit-search-decoration,[\s\S]*?\.gc-floating-field__control\[type="search"\]::-webkit-search-results-decoration\s*\{[\s\S]*?appearance:\s*none;/,
    /\.gc-floating-field__control\[type="search"\]::-ms-clear,[\s\S]*?\.gc-floating-field__control\[type="search"\]::-ms-reveal\s*\{[\s\S]*?display:\s*none;[\s\S]*?width:\s*0;[\s\S]*?height:\s*0;/,
  ],
  "packages/connections-ui/src/styles/primitives/app-combobox.css": [
    /\.gc-combobox__input::-webkit-search-cancel-button,[\s\S]*?\.gc-combobox__input::-webkit-search-results-decoration[\s\S]*?\{[\s\S]*?appearance:\s*none;/,
    /\.gc-combobox__input::-ms-clear,[\s\S]*?\.gc-combobox__input::-ms-reveal[\s\S]*?\{[\s\S]*?display:\s*none;[\s\S]*?width:\s*0;[\s\S]*?height:\s*0;/,
  ],
};
const EDITOR_COMMAND_SEARCH_CHROME_CONTRACTS = {
  "src/styles/routes/shared/navigation.css": [
    /\.gc-editor-header-command-search\s+\.gc-page-command-search__field,\s*\.gc-editor-header-command-search\s+\.gc-page-command-search__field:focus-within,\s*\.gc-editor-header-command-search\s+\.gc-page-command-search__field\[data-open="true"\]\s*\{[^}]*?border-color:\s*var\(--md-comp-outlined-text-field-outline-color\);/,
    /\.gc-editor-header-command-search\s+\.gc-page-command-search__field,\s*\.gc-editor-header-command-search\s+\.gc-page-command-search__field:focus-within,\s*\.gc-editor-header-command-search\s+\.gc-page-command-search__field\[data-open="true"\]\s*\{[^}]*?background:\s*transparent;/,
  ],
};

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function buildEmptyCounts() {
  return Object.fromEntries(Object.keys(RULE_DEFINITIONS).map((ruleId) => [ruleId, {}]));
}

function isVueFile(filePath) {
  return path.extname(filePath).toLowerCase() === ".vue";
}

function isCssFile(filePath) {
  return path.extname(filePath).toLowerCase() === ".css";
}

function isPublicComponentPath(filePath) {
  return normalizePath(filePath).startsWith("src/components/public/");
}

function isWorkspaceComponentPath(filePath) {
  return normalizePath(filePath).startsWith("src/components/workspace/");
}

function isSharedPrimitivePath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return SHARED_PRIMITIVE_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

function shouldAuditHandRolledProgressBarPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  if (!isVueFile(normalizedPath)) {
    return false;
  }
  // Shared primitives (incl. AppProgressBar itself) implement bars; the
  // analytics data-viz family is intentionally bespoke (gradient/glow charts).
  if (isSharedPrimitivePath(normalizedPath)) {
    return false;
  }
  return !DATA_VIZ_PROGRESS_FILL_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}

function shouldAuditRawButtonPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  if (
    UI_DRIFT_POLICY.rawControlFeatureAllowlist.has(normalizedPath) ||
    UI_DRIFT_POLICY.rawButtonPrimitiveAllowlist.has(normalizedPath) ||
    UI_DRIFT_POLICY.rawControlAllowlistPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  ) {
    return false;
  }

  if (isSharedPrimitivePath(normalizedPath)) {
    return !UI_DRIFT_POLICY.rawButtonPrimitiveAllowlist.has(normalizedPath);
  }

  return isVueFile(normalizedPath);
}

function shouldAuditRawTrackedInputPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  if (
    UI_DRIFT_POLICY.rawControlFeatureAllowlist.has(normalizedPath) ||
    UI_DRIFT_POLICY.rawTrackedInputPrimitiveAllowlist.has(normalizedPath) ||
    UI_DRIFT_POLICY.rawControlAllowlistPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  ) {
    return false;
  }

  if (isSharedPrimitivePath(normalizedPath)) {
    return !UI_DRIFT_POLICY.rawTrackedInputPrimitiveAllowlist.has(normalizedPath);
  }

  return isVueFile(normalizedPath);
}

// Gate for native <select>/<textarea>. Unlike button/input there is no
// per-file primitive allowlist: the shared-primitive impls (AppSelect,
// PublicSelectField, AppTextField) live under shared-primitive paths and
// legitimately render these natives, so excluding all shared-primitive paths is
// sufficient. Everything else is a feature callsite that should use the primitive.
function shouldAuditRawNativeControlPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  if (
    UI_DRIFT_POLICY.rawControlFeatureAllowlist.has(normalizedPath) ||
    UI_DRIFT_POLICY.rawControlAllowlistPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  ) {
    return false;
  }
  if (isSharedPrimitivePath(normalizedPath)) {
    return false;
  }
  return isVueFile(normalizedPath);
}

function shouldAuditFeatureLocalPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return (
    isVueFile(normalizedPath) &&
    !isSharedPrimitivePath(normalizedPath) &&
    !UI_DRIFT_POLICY.rawControlFeatureAllowlist.has(normalizedPath) &&
    !UI_DRIFT_POLICY.rawControlAllowlistPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  );
}

function mergeRuleCounts(target, source) {
  for (const [ruleId, fileCounts] of Object.entries(source)) {
    const targetRuleCounts = target[ruleId];
    for (const [filePath, count] of Object.entries(fileCounts)) {
      targetRuleCounts[filePath] = (targetRuleCounts[filePath] ?? 0) + count;
    }
  }
}

function buildLineIndex(source) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

function lineNumberForOffset(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

function snippetForOffset(source, offset, { width = 80 } = {}) {
  const lineEnd = source.indexOf("\n", offset);
  const startOfLine = source.lastIndexOf("\n", offset - 1) + 1;
  const end = lineEnd === -1 ? source.length : lineEnd;
  const line = source.slice(startOfLine, end);
  const trimmed = line.trim();
  return trimmed.length > width ? `${trimmed.slice(0, width - 1)}…` : trimmed;
}

// Blank out `<!-- … -->` comment spans while preserving every byte position and
// newline. Raw-tag scanners must not match an element mentioned *inside* a
// comment — e.g. an explanatory comment naming `<button>` is not a raw button.
// Length preservation keeps `templateBlock.start + match.index` → line-number
// translation exact. Applied narrowly at the raw-tag scan sites (NOT at template
// extraction), because some rules — e.g. the workspace shadow-utility
// inline-review exception — legitimately read directive markers from comments.
function maskHtmlCommentsPreserveLayout(text) {
  const length = text.length;
  const out = new Array(length);
  let i = 0;
  while (i < length) {
    if (text[i] === "<" && text[i + 1] === "!" && text[i + 2] === "-" && text[i + 3] === "-") {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? length : end + 3;
      while (i < stop) {
        out[i] = text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out[i] = text[i];
    i += 1;
  }
  return out.join("");
}

function extractTemplateBlock(source) {
  // Offset-aware sibling of `extractTemplateSource` — preserves the byte offset
  // of the returned slice inside `source` so downstream rules can translate
  // template-relative match indices back to absolute line numbers without
  // re-scanning the file.
  const openMatch = source.match(/<template\b[^>]*>/);
  if (!openMatch) {
    return { text: source, start: 0 };
  }
  const sliceStart = openMatch.index + openMatch[0].length;
  const lastCloseIndex = source.lastIndexOf("</template>");
  if (lastCloseIndex === -1 || lastCloseIndex < sliceStart) {
    return { text: source, start: 0 };
  }
  return { text: source.slice(sliceStart, lastCloseIndex), start: sliceStart };
}

function extractScriptBlocks(source) {
  // Offset-aware list of `<script>` blocks for findings collection. Each entry
  // carries the absolute start offset inside the original source so per-match
  // line numbers can be derived without re-extracting.
  const blocks = [];
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    blocks.push({ text: match[1], start: match.index + match[0].indexOf(match[1]) });
  }
  return blocks;
}

function extractTemplateSource(source) {
  // Find the outermost `<template>` block. The previous non-greedy match closed
  // at the first nested `</template>` (e.g. `<template v-for>`, `<template
  // #leading>`), causing the audit to skip everything after the first nested
  // close — under-counting class drift dramatically. We grab from the first
  // `<template>` opening to the LAST `</template>` close so nested template
  // tags inside the outer block are preserved as audited content.
  const openMatch = source.match(/<template\b[^>]*>/);
  if (!openMatch) {
    return source;
  }
  const lastCloseIndex = source.lastIndexOf("</template>");
  if (lastCloseIndex === -1 || lastCloseIndex < openMatch.index + openMatch[0].length) {
    return source;
  }
  return source.slice(openMatch.index + openMatch[0].length, lastCloseIndex);
}

function extractScriptSource(source, filePath) {
  if (!isVueFile(filePath)) {
    return source;
  }

  const scriptBlocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n");

  return scriptBlocks;
}

function extractStyleSource(source, filePath) {
  if (!isVueFile(filePath)) {
    return "";
  }

  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n");
}

function countTags(templateSource, targetTagName) {
  let count = 0;
  // A tag named inside an HTML comment is not markup — mask comments first.
  for (const match of maskHtmlCommentsPreserveLayout(templateSource).matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    if (tagName === targetTagName) {
      count += 1;
    }
  }

  return count;
}

function countRawTrackedInputs(templateSource) {
  let count = 0;

  // A tag named inside an HTML comment is not markup — mask comments first.
  for (const match of maskHtmlCommentsPreserveLayout(templateSource).matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    if (tagName !== "input") {
      continue;
    }

    const staticTypeMatch = attrs.match(/(?:^|\s)type\s*=\s*(["'])(.*?)\1/i);
    const staticType = staticTypeMatch?.[2]?.trim().toLowerCase();
    if (staticType && UNTRACKED_INPUT_TYPES.has(staticType)) {
      continue;
    }

    count += 1;
  }

  return count;
}

function countNativeTitleAttrs(templateSource) {
  let count = 0;
  for (const match of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    if (!/^[a-z]/.test(tagName) || ALLOWED_TITLE_TAGS.has(tagName)) {
      continue;
    }

    if (!NATIVE_TITLE_ATTR_PATTERN.test(attrs)) {
      continue;
    }

    // Icon-only links/buttons commonly pair `aria-label` (for screen readers)
    // with `title` (for the sighted-mouse hover tooltip). When both are
    // present, `title` is intentional dual-cue accessibility, not drift.
    if (/(?:^|\s)(?:aria-label|:aria-label|v-bind:aria-label)\s*=/.test(attrs)) {
      continue;
    }

    count += 1;
  }

  return count;
}

function countClassLikePatternMatches(source, pattern) {
  let count = 0;

  for (const match of source.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    count += countPatternMatches(match[2] ?? "", pattern);
  }

  return count;
}

function countTailwindImportantModifiers(templateSource, scriptSource, allowlistFragments = []) {
  const combinedSource = `${templateSource}\n${scriptSource}`;
  if (allowlistFragments.some((fragment) => combinedSource.includes(fragment))) {
    return 0;
  }

  return (
    countClassLikePatternMatches(templateSource, TAILWIND_IMPORTANT_MODIFIER_PATTERN) +
    countPatternMatchesInStringLiterals(scriptSource, TAILWIND_IMPORTANT_MODIFIER_PATTERN)
  );
}

function collectTailwindImportantModifierFindings({
  source,
  lineStarts,
  templateBlock,
  scriptBlocks,
  allowlistFragments = [],
}) {
  const combinedSource = `${templateBlock.text}\n${scriptBlocks.map((b) => b.text).join("\n")}`;
  if (allowlistFragments.some((fragment) => combinedSource.includes(fragment))) {
    return [];
  }

  const findings = [];

  for (const attrMatch of templateBlock.text.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    const value = attrMatch[2] ?? "";
    const valueStart = templateBlock.start + attrMatch.index + attrMatch[0].indexOf(value);
    for (const hit of value.matchAll(TAILWIND_IMPORTANT_MODIFIER_PATTERN)) {
      const absoluteOffset = valueStart + hit.index;
      findings.push({
        line: lineNumberForOffset(lineStarts, absoluteOffset),
        match: hit[0],
        snippet: snippetForOffset(source, absoluteOffset),
      });
    }
  }

  for (const block of scriptBlocks) {
    const maskedBlock = maskJsCommentsPreserveLayout(block.text);
    for (const stringMatch of scanJsStringLiterals(maskedBlock)) {
      const literalStart = block.start + stringMatch.index;
      for (const hit of stringMatch.text.matchAll(TAILWIND_IMPORTANT_MODIFIER_PATTERN)) {
        const absoluteOffset = literalStart + hit.index;
        findings.push({
          line: lineNumberForOffset(lineStarts, absoluteOffset),
          match: hit[0],
          snippet: snippetForOffset(source, absoluteOffset),
        });
      }
    }
  }

  return findings;
}

function countAppFlyoutPanelZUtilities(templateSource) {
  let count = 0;

  for (const match of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    if (tagName !== "AppFlyoutSurface") {
      continue;
    }

    const panelClassMatch = attrs.match(/(?:^|\s)(?::panel-class|panel-class)\s*=\s*(["'])([\s\S]*?)\1/);
    const presentationMatch = attrs.match(/(?:^|\s):presentation\s*=\s*(["'])([\s\S]*?)\1/);
    const presentationPanelClassMatch = presentationMatch?.[2]?.match(
      /(?:^|[,{]\s*)panelClass\s*:\s*(["'`])([\s\S]*?)\1/,
    );
    const panelClassValue = panelClassMatch?.[2] ?? presentationPanelClassMatch?.[2] ?? "";
    if (!panelClassValue) {
      continue;
    }

    if (/(?<![\w-])z-(?:\([^)]+\)|\[[^\]]+\]|[0-9]+)(?![\w-])/.test(panelClassValue)) {
      count += 1;
    }
  }

  return count;
}

function extractClassLikeTokens(templateSource, scriptSource) {
  const tokens = [];

  for (const match of templateSource.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    tokens.push(...(match[2] ?? "").split(/\s+/).filter(Boolean));
  }

  // Script-side string literals are scanned narrowly: only literals that look
  // like a class string (multiple hyphenated tokens AND no spaces that suggest
  // sentences/labels) get tokenized. The previous broad scan caught testIds
  // (`"toggle-slug-editor"`), URL slugs, and translation keys as fake class
  // tokens, producing noisy feature-local-primitive findings.
  const maskedScriptSource = maskJsCommentsPreserveLayout(scriptSource);
  for (const match of scanJsStringLiterals(maskedScriptSource)) {
    const value = match.text.slice(1, -1);
    if (!looksLikeClassListLiteral(value)) {
      continue;
    }
    tokens.push(...value.split(/\s+/).filter(Boolean));
  }

  return tokens;
}

function extractClassLikeTokensWithOffsets(templateBlock, scriptBlocks) {
  // Offset-aware sibling of `extractClassLikeTokens`. Each emitted token carries
  // its absolute byte offset inside the original SFC source so callers can
  // translate it to a line number for human-readable explanations.
  const tokens = [];

  for (const match of templateBlock.text.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    const value = match[2] ?? "";
    const valueAttrStart = match.index + match[0].indexOf(value);
    const absValueStart = templateBlock.start + valueAttrStart;
    let cursor = 0;
    for (const tokenMatch of value.matchAll(/\S+/g)) {
      tokens.push({ token: tokenMatch[0], offset: absValueStart + tokenMatch.index });
      cursor = tokenMatch.index + tokenMatch[0].length;
    }
    void cursor;
  }

  for (const block of scriptBlocks) {
    const maskedBlock = maskJsCommentsPreserveLayout(block.text);
    for (const stringMatch of scanJsStringLiterals(maskedBlock)) {
      const value = stringMatch.text.slice(1, -1);
      if (!looksLikeClassListLiteral(value)) {
        continue;
      }
      const absValueStart = block.start + stringMatch.index + 1;
      for (const tokenMatch of value.matchAll(/\S+/g)) {
        tokens.push({ token: tokenMatch[0], offset: absValueStart + tokenMatch.index });
      }
    }
  }

  return tokens;
}

function looksLikeClassListLiteral(value) {
  // Multi-token class strings always have spaces between hyphenated tokens.
  // Single-token literals are typically component prop strings (testIds, refs,
  // translation keys) and should not be scanned for class drift.
  if (!value.includes(" ")) {
    return false;
  }
  // Class literals don't contain syntax characters from sentences or expressions.
  // The period `.` is intentionally NOT included here — sentence punctuation
  // is handled by the hyphen-density check below so legitimate Tailwind
  // arbitrary-value tokens like `pt-[1.5rem]` still pass.
  if (/[<>{}();,@!?$\\]/.test(value)) {
    return false;
  }
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return false;
  }
  // Each token must look like a CSS class (alphanumeric + standard CSS-class
  // characters, reasonable length). Sentences with words like "card games" or
  // translation keys with periods won't pass this filter.
  if (!tokens.every((t) => /^[\w:[\]()/.,#%-]+$/.test(t) && t.length <= 80)) {
    return false;
  }
  // Sentence text in JS string literals ("You can copy this key again later
  // from the saved key card.") otherwise slips past the syntax filter above:
  // each word is alphanumeric and shorter than 80 chars. Real class lists are
  // dominated by hyphenated tokens (Tailwind utilities `flex-row`, BEM names
  // `gc-radius-section-card`, etc.). Require at least half of the tokens to
  // contain a hyphen so prose copy never reaches the primitive-segment scan.
  const hyphenatedCount = tokens.reduce((n, t) => (t.includes("-") ? n + 1 : n), 0);
  if (hyphenatedCount * 2 < tokens.length) {
    return false;
  }
  // Finally, the literal must contain at least one primitive-word token —
  // otherwise there's nothing the rule could flag anyway.
  FEATURE_LOCAL_PRIMITIVE_CLASS_PATTERN.lastIndex = 0;
  const hasPrimitive = FEATURE_LOCAL_PRIMITIVE_CLASS_PATTERN.test(value);
  FEATURE_LOCAL_PRIMITIVE_CLASS_PATTERN.lastIndex = 0;
  return hasPrimitive;
}

function stripTailwindVariantPrefixes(token) {
  // Tailwind variant chains live before the final `:` (e.g. `sm:flex-row`,
  // `lg:hover:flex-row`, `dark:hover:tabular-nums`). Strip them so the
  // utility-name exclusion matches.
  const lastColon = token.lastIndexOf(":");
  return lastColon === -1 ? token : token.slice(lastColon + 1);
}

function isTailwindUtilityException(token) {
  const bare = stripTailwindVariantPrefixes(token);
  if (TAILWIND_UTILITY_EXACT_EXCLUSIONS.has(bare)) return true;
  for (const prefix of TAILWIND_UTILITY_PREFIX_EXCLUSIONS) {
    if (bare.startsWith(prefix)) return true;
  }
  return false;
}

function findPrimitiveSegmentInClassToken(rawToken) {
  // Inside `:class` JS expressions (`:class="cond ? 'foo' : 'bar'"`) the
  // template extractor splits on whitespace, leaving stray punctuation on the
  // outer tokens (e.g. `'myconnect-link-row` from a quoted array literal).
  // Trim non-class characters off both ends so exclusion + segment lookup
  // see the canonical class name.
  if (rawToken.includes("${") || rawToken.includes("`")) return null;
  const token = rawToken.replace(/^[^\w-]+/, "").replace(/[^\w-]+$/, "");
  if (!token) return null;
  // BEM child elements (`block__element`) belong to a parent block whose own
  // class will already be evaluated; the child should not separately demand a
  // primitive import.
  if (token.includes("__")) return null;
  if (isTailwindUtilityException(token)) return null;

  // Strip BEM modifier (`block--variant`) before splitting; `--` is not a
  // segment separator. Also drop arbitrary-value brackets (`[...]`, `(...)`)
  // which would otherwise produce nonsense segments. Re-check exclusions
  // against the stripped base so e.g. `my-link-hub-icon-row--${placement}`
  // resolves to its base `my-link-hub-icon-row` and matches the exclusion.
  const base = token
    .split("--")[0]
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "");
  if (isTailwindUtilityException(base)) return null;

  for (const segment of base.split(/[-_]/)) {
    const normalized = segment.toLowerCase();
    if (PRIMITIVE_CLASS_SEGMENTS.has(normalized)) {
      return normalized;
    }
  }
  return null;
}

function countFeatureLocalPrimitiveClassesWithoutImport(templateSource, scriptSource) {
  const tokens = extractClassLikeTokens(templateSource, scriptSource);
  let count = 0;

  for (const token of tokens) {
    const segment = findPrimitiveSegmentInClassToken(token);
    if (!segment) {
      continue;
    }

    const matchedTerm = PRIMITIVE_CLASS_TERMS.find(({ term }) => term === segment);
    if (!matchedTerm) {
      continue;
    }

    const importsMatchingPrimitive = matchedTerm.imports.some((primitiveName) =>
      new RegExp(`\\bimport\\s+(?:[^;]*\\b${primitiveName}\\b|\\{[^}]*\\b${primitiveName}\\b[^}]*\\})`).test(
        scriptSource,
      ),
    );
    if (!importsMatchingPrimitive) {
      count += 1;
    }
  }

  return count;
}

function collectFeatureLocalPrimitiveClassFindings({ source, lineStarts, templateBlock, scriptBlocks, scriptSource }) {
  const tokens = extractClassLikeTokensWithOffsets(templateBlock, scriptBlocks);
  const findings = [];

  for (const { token, offset } of tokens) {
    const segment = findPrimitiveSegmentInClassToken(token);
    if (!segment) {
      continue;
    }

    const matchedTerm = PRIMITIVE_CLASS_TERMS.find(({ term }) => term === segment);
    if (!matchedTerm) {
      continue;
    }

    const importsMatchingPrimitive = matchedTerm.imports.some((primitiveName) =>
      new RegExp(`\\bimport\\s+(?:[^;]*\\b${primitiveName}\\b|\\{[^}]*\\b${primitiveName}\\b[^}]*\\})`).test(
        scriptSource,
      ),
    );
    if (importsMatchingPrimitive) {
      continue;
    }

    findings.push({
      line: lineNumberForOffset(lineStarts, offset),
      match: token,
      segment,
      suggestedImports: matchedTerm.imports,
      snippet: snippetForOffset(source, offset),
    });
  }

  return findings;
}

function hasImportForPrimitiveSegment(scriptSource, segment) {
  const matchedTerm = PRIMITIVE_CLASS_TERMS.find(({ term }) => term === segment);
  if (!matchedTerm) {
    return false;
  }

  return matchedTerm.imports.some((primitiveName) =>
    new RegExp(`\\bimport\\s+(?:[^;]*\\b${primitiveName}\\b|\\{[^}]*\\b${primitiveName}\\b[^}]*\\})`).test(
      scriptSource,
    ),
  );
}

function suggestedPrimitiveNamesForSegment(segment) {
  return PRIMITIVE_CLASS_TERMS.find(({ term }) => term === segment)?.imports ?? [];
}

function hasImportForAnyPrimitive(scriptSource, primitiveNames) {
  return primitiveNames.some((primitiveName) =>
    new RegExp(`\\bimport\\s+(?:[^;]*\\b${primitiveName}\\b|\\{[^}]*\\b${primitiveName}\\b[^}]*\\})`).test(
      scriptSource,
    ),
  );
}

function tokenMatches(tokens, pattern) {
  return tokens.some((token) => pattern.test(stripTailwindVariantPrefixes(token)));
}

function hasPrimitiveRadiusSignal(tokens) {
  return tokens.some((token) => BESPOKE_PRIMITIVE_RADIUS_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)));
}

function hasPrimitiveSurfaceSignal(tokens) {
  return tokens.some((token) => {
    const bare = stripTailwindVariantPrefixes(token);
    return token === "border" || token === "shadow" || BESPOKE_PRIMITIVE_SURFACE_TOKEN_PATTERN.test(bare);
  });
}

function hasPrimitivePaddingSignal(tokens) {
  return tokens.some((token) => BESPOKE_PRIMITIVE_PADDING_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)));
}

function hasBespokePrimitiveSharedToken(tokens) {
  return tokens.some((token) => BESPOKE_PRIMITIVE_SHARED_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)));
}

function hasBespokePrimitiveSurfaceSignals(tokens, segment, tagName) {
  const hasRadius = tokens.some((token) =>
    BESPOKE_PRIMITIVE_RADIUS_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)),
  );
  const hasSurface = tokens.some(
    (token) =>
      token === "border" ||
      token === "shadow" ||
      BESPOKE_PRIMITIVE_SURFACE_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)),
  );
  const hasPadding = tokens.some((token) =>
    BESPOKE_PRIMITIVE_PADDING_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)),
  );
  const hasLayout = tokens.some((token) =>
    BESPOKE_PRIMITIVE_LAYOUT_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)),
  );
  const isInteractive =
    tagName === "a" ||
    tagName === "button" ||
    tokens.some((token) => BESPOKE_PRIMITIVE_INTERACTIVE_TOKEN_PATTERN.test(token));

  switch (segment) {
    case "card":
      return hasRadius && hasSurface && hasPadding;
    case "row":
      return hasPadding && hasLayout && (hasSurface || isInteractive);
    case "button":
    case "tab":
    case "toggle":
    case "chip":
      return isInteractive && (hasRadius || hasSurface) && hasPadding;
    default:
      return false;
  }
}

function collectBespokePrimitiveSurfaceCandidateGroups(templateSource, scriptSource, filePath) {
  if (!shouldAuditFeatureLocalPath(filePath)) {
    return [];
  }

  const groups = [];

  for (const tagMatch of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = tagMatch;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!") || !NATIVE_BESPOKE_PRIMITIVE_TAGS.has(tagName)) {
      continue;
    }

    for (const attrMatch of attrs.matchAll(STATIC_CLASS_ATTR_PATTERN)) {
      const tokens = splitStaticClassTokens(attrMatch[2] ?? "");
      if (tokens.length === 0 || hasBespokePrimitiveSharedToken(tokens)) {
        continue;
      }

      const primitiveToken = tokens.find((token) => findPrimitiveSegmentInClassToken(token));
      const segment = primitiveToken ? findPrimitiveSegmentInClassToken(primitiveToken) : null;
      if (!segment || hasImportForPrimitiveSegment(scriptSource, segment)) {
        continue;
      }

      if (!hasBespokePrimitiveSurfaceSignals(tokens, segment, tagName)) {
        continue;
      }

      const suggestions = suggestedPrimitiveNamesForSegment(segment);
      groups.push(`${tagName}.${primitiveToken} -> ${suggestions.slice(0, 3).join("/") || `shared ${segment}`}`.trim());
    }
  }

  return groups;
}

function findSharedPrimitiveConversionCandidate({ attrs, tagName, tokens, scriptSource }) {
  if (
    tokens.length === 0 ||
    hasBespokePrimitiveSharedToken(tokens) ||
    !SHARED_PRIMITIVE_CONVERSION_TAGS.has(tagName)
  ) {
    return null;
  }

  for (const family of SHARED_PRIMITIVE_CONVERSION_FAMILIES) {
    if (hasImportForAnyPrimitive(scriptSource, family.suggestions)) {
      continue;
    }

    if (family.matches({ attrs, tagName, tokens })) {
      return family;
    }
  }

  return null;
}

function collectSharedPrimitiveConversionCandidateGroups(templateSource, scriptSource, filePath) {
  if (!shouldAuditFeatureLocalPath(filePath)) {
    return [];
  }

  const groups = [];

  for (const tagMatch of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = tagMatch;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    for (const attrMatch of attrs.matchAll(STATIC_CLASS_ATTR_PATTERN)) {
      const tokens = splitStaticClassTokens(attrMatch[2] ?? "");
      const family = findSharedPrimitiveConversionCandidate({ attrs, tagName, tokens, scriptSource });
      if (!family) {
        continue;
      }

      groups.push(`${tagName}.${family.id} -> ${family.suggestions.slice(0, 3).join("/")}`);
      break;
    }
  }

  return groups;
}

function collectSharedPrimitiveConversionCandidateFindings({
  source,
  lineStarts,
  templateBlock,
  scriptSource,
  filePath,
}) {
  if (!shouldAuditFeatureLocalPath(filePath)) {
    return [];
  }

  const findings = [];

  for (const tagMatch of templateBlock.text.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = tagMatch;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    for (const attrMatch of attrs.matchAll(STATIC_CLASS_ATTR_PATTERN)) {
      const value = attrMatch[2] ?? "";
      const tokens = splitStaticClassTokens(value);
      const family = findSharedPrimitiveConversionCandidate({ attrs, tagName, tokens, scriptSource });
      if (!family) {
        continue;
      }

      const absoluteOffset = templateBlock.start + tagMatch.index;
      findings.push({
        line: lineNumberForOffset(lineStarts, absoluteOffset),
        match: `${tagName}.${family.id}`,
        suggestedImports: family.suggestions,
        snippet: snippetForOffset(source, absoluteOffset),
      });
      break;
    }
  }

  return findings;
}

function collectRawTagFindings({ source, lineStarts, templateBlock, targetTagName }) {
  // Offset-aware counterpart to `countTags`. Returns each raw <button>/<input>
  // hit with its absolute line number and a snippet so explanations can point
  // a developer directly at the offending element.
  const findings = [];
  // Mask HTML comments so a `<button>`/`<input>` mentioned inside one is not
  // scanned as markup (length-preserving → offsets stay exact).
  const scannableTemplate = maskHtmlCommentsPreserveLayout(templateBlock.text);
  for (const match of scannableTemplate.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }
    if (tagName !== targetTagName) {
      continue;
    }
    const absoluteOffset = templateBlock.start + match.index;
    findings.push({
      line: lineNumberForOffset(lineStarts, absoluteOffset),
      match: `<${tagName}>`,
      snippet: snippetForOffset(source, absoluteOffset),
    });
  }
  return findings;
}

function collectSharedPrimitiveCallsiteClassDriftFindings({ source, lineStarts, templateBlock }) {
  // Offset-aware counterpart to `countSharedPrimitiveCallsiteClassDrift`. Each
  // hit identifies the shared primitive callsite (`<AppButton class="…">`) and
  // the drift pattern that fired so a developer can move the override into the
  // primitive's prop API.
  const findings = [];
  for (const match of templateBlock.text.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }
    const auditPattern = SHARED_PRIMITIVE_CLASS_AUDIT_PATTERNS[tagName];
    if (!auditPattern) {
      continue;
    }
    const attrHit = attrs.match(auditPattern);
    if (!attrHit) {
      continue;
    }
    const absoluteOffset = templateBlock.start + match.index;
    findings.push({
      line: lineNumberForOffset(lineStarts, absoluteOffset),
      match: `<${tagName}> ${attrHit[0]}`,
      snippet: snippetForOffset(source, absoluteOffset),
    });
  }
  return findings;
}

function shouldAuditFeatureLocalTeleportPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return (
    isVueFile(normalizedPath) &&
    !isSharedPrimitivePath(normalizedPath) &&
    !UI_DRIFT_POLICY.featureLocalTeleportAllowlist.has(normalizedPath)
  );
}

function countFeatureLocalTeleportUsage(templateSource) {
  return countTags(templateSource, "Teleport");
}

function shouldAuditFeatureLocalDetailPaneCardPath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return (
    isVueFile(normalizedPath) && isWorkspaceComponentPath(normalizedPath) && !isSharedPrimitivePath(normalizedPath)
  );
}

function shouldAuditFeatureLocalDismissablePath(filePath) {
  const normalizedPath = normalizePath(filePath);
  return (
    normalizedPath !== "src/composables/useDismissable.ts" &&
    normalizedPath !== "packages/connections-ui/src/composables/useDismissable.ts" &&
    !isSharedPrimitivePath(normalizedPath) &&
    !UI_DRIFT_POLICY.featureLocalDismissableAllowlist.has(normalizedPath)
  );
}

function countFeatureLocalDetailPaneCardUsage(templateSource, scriptSource) {
  return (
    countPatternMatches(templateSource, FEATURE_LOCAL_DETAIL_PANE_CARD_PATTERN) +
    countPatternMatchesInStringLiterals(scriptSource, FEATURE_LOCAL_DETAIL_PANE_CARD_PATTERN)
  );
}

function countFeatureLocalDismissableWiring(source) {
  return countPatternMatches(source, FEATURE_LOCAL_DISMISSABLE_PATTERN);
}

function countWorkspaceRootStateImports(source) {
  return countPatternMatches(source, WORKSPACE_ROOT_STATE_IMPORT_PATTERN);
}

function countSharedFieldTypographyContractViolations(source, filePath) {
  const contracts = SHARED_FIELD_TYPOGRAPHY_CONTRACTS[filePath];
  if (!contracts) {
    return 0;
  }

  return contracts.reduce((count, pattern) => count + (pattern.test(source) ? 0 : 1), 0);
}

function countSharedFloatingFieldPositionContractViolations(source, filePath) {
  const contracts = SHARED_FLOATING_FIELD_POSITION_CONTRACTS[filePath];
  if (!contracts) {
    return 0;
  }

  return contracts.reduce((count, pattern) => count + (pattern.test(source) ? 0 : 1), 0);
}

function countSharedSearchNativeResetContractViolations(source, filePath) {
  const contracts = SHARED_SEARCH_NATIVE_RESET_CONTRACTS[filePath];
  if (!contracts) {
    return 0;
  }

  return contracts.reduce((count, pattern) => count + (pattern.test(source) ? 0 : 1), 0);
}

function countEditorCommandSearchChromeContractViolations(source, filePath) {
  const contracts = EDITOR_COMMAND_SEARCH_CHROME_CONTRACTS[filePath];
  if (!contracts) {
    return 0;
  }

  return contracts.reduce((count, pattern) => count + (pattern.test(source) ? 0 : 1), 0);
}

function normalizeClassToken(token) {
  return token.replace(/^[^\w:-]+/, "").replace(/[^\w/.[\]:-]+$/, "");
}

function splitStaticClassTokens(value) {
  return value
    .split(/\s+/)
    .map(normalizeClassToken)
    .filter((token) => token && !/[`'"{}()?,]/.test(token) && !token.includes("${"));
}

function extractStaticClassTokensFromAttrs(attrs) {
  const tokens = [];

  for (const match of attrs.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    const value = match[2] ?? "";
    tokens.push(...splitStaticClassTokens(value));
  }

  return tokens;
}

function isShapeBearingPrimitiveClass(className) {
  if (!PRIMITIVE_SHAPE_CLASS_PREFIX_PATTERN.test(className) && !GENERATED_SHAPE_CLASS_PREFIX_PATTERN.test(className)) {
    return false;
  }

  return PRIMITIVE_SHAPE_CLASS_SEGMENT_PATTERN.test(className);
}

function readStaticAttr(attrs, name) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2]?.trim() ?? "";
}

function isShapeAuditedNativeInteractiveTag(tagName, attrs, classes) {
  if (!/^[a-z]/.test(tagName)) {
    return false;
  }

  if (tagName === "input") {
    const type = readStaticAttr(attrs, "type").toLowerCase();
    if (PRIMITIVE_SHAPE_NON_SURFACE_INPUT_TYPES.has(type)) {
      return false;
    }
  }

  if (classes.some((className) => PRIMITIVE_SHAPE_NON_SURFACE_CLASS_PATTERN.test(className))) {
    return false;
  }

  if (["button", "a", "input", "select", "textarea", "summary"].includes(tagName)) {
    return true;
  }

  return /(?:^|\s)(?:@click|v-on:click|role\s*=\s*["'](?:button|menuitem|option)|tabindex\s*=)/.test(attrs);
}

function extractPrimitiveShapeClassGroups(templateSource) {
  const groups = [];

  for (const match of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    const classes = extractStaticClassTokensFromAttrs(attrs).filter(isShapeBearingPrimitiveClass);
    if (!isShapeAuditedNativeInteractiveTag(tagName, attrs, classes)) {
      continue;
    }

    if (classes.length > 0) {
      groups.push(classes);
    }
  }

  return groups;
}

function buildRadiusOwnedClassSet() {
  const styleRoots = ["src/styles", UI_PACKAGE_STYLES_ROOT, LEGACY_SHARED_COMPONENTS_ROOT, "src/components/public"];
  const owned = new Set();
  const radiusDeclarationPattern =
    /(?:border(?:-(?:top|right|bottom|left))?(?:-(?:left|right))?-radius|border-(?:start|end)-(?:start|end)-radius)\s*:\s*(?!0(?:\s|;|$))(?:var\([^)]*\)|[\d.]+(?:px|rem|em|%)|inherit)/;

  function walk(relativeDir) {
    const absoluteDir = path.resolve(process.cwd(), relativeDir);
    if (!fs.existsSync(absoluteDir)) {
      return;
    }

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const fullPath = path.join(absoluteDir, entry.name);
      const relativePath = normalizePath(path.relative(process.cwd(), fullPath));
      if (entry.isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (!/[.](?:css|vue)$/.test(entry.name)) {
        continue;
      }

      const source = fs.readFileSync(fullPath, "utf8");
      const styleSource = isVueFile(relativePath) ? extractStyleSource(source, relativePath) : source;
      for (const ruleMatch of styleSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = ruleMatch[1] ?? "";
        const body = ruleMatch[2] ?? "";
        if (!radiusDeclarationPattern.test(body)) {
          continue;
        }
        for (const classMatch of selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) {
          owned.add(classMatch[1]);
        }
      }
    }
  }

  for (const root of styleRoots) {
    walk(root);
  }

  return owned;
}

let radiusOwnedClassSet = null;

function getRadiusOwnedClassSet() {
  radiusOwnedClassSet ??= buildRadiusOwnedClassSet();
  return radiusOwnedClassSet;
}

function shouldAuditPrimitiveShapePath(filePath) {
  return PRIMITIVE_SHAPE_AUDIT_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function shouldAuditGeneratedShapePath(filePath) {
  return GENERATED_SHAPE_AUDIT_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function collectPrimitiveShapeContractMissing(templateSource) {
  const radiusOwnedClasses = getRadiusOwnedClassSet();
  return extractPrimitiveShapeClassGroups(templateSource)
    .filter(
      (classes) =>
        !classes.some(
          (className) => radiusOwnedClasses.has(className) || ROUNDED_UTILITY_CLASS_PATTERN.test(className),
        ),
    )
    .map((classes) => classes.join(" "));
}

function collectGeneratedShapeContractMissing(source) {
  const radiusOwnedClasses = getRadiusOwnedClassSet();
  const tokens = new Set();

  for (const match of source.matchAll(CLASS_ATTR_VALUE_PATTERN)) {
    for (const token of splitStaticClassTokens(match[2] ?? "")) {
      tokens.add(token);
    }
  }

  for (const match of source.matchAll(/\breturn\s+`\s*<[^>]+\bclass=(['"])([^'"]+)\1/g)) {
    for (const token of splitStaticClassTokens(match[2] ?? "")) {
      tokens.add(token);
    }
  }

  for (const match of source.matchAll(/\bclassName\s*(?::|=)\s*(["'`])([\s\S]*?)\1/g)) {
    for (const token of splitStaticClassTokens(match[2] ?? "")) {
      tokens.add(token);
    }
  }

  return [...tokens]
    .filter(isShapeBearingPrimitiveClass)
    .filter((className) => !GENERATED_SHAPE_NON_SURFACE_CLASS_PATTERN.test(className))
    .filter((className) => !radiusOwnedClasses.has(className) && !ROUNDED_UTILITY_CLASS_PATTERN.test(className));
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function normalizeCssSelector(selector) {
  return selector
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isStatefulShapeSnapSuppressed(source, index) {
  const commentWindow = source.slice(Math.max(0, index - 240), index);
  return STATEFUL_SHAPE_SNAP_SUPPRESS_DIRECTIVE_PATTERN.test(commentWindow);
}

function collectStatefulShapeSnapRisks(styleSource) {
  const risks = [];

  for (const ruleMatch of styleSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rawSelector = ruleMatch[1] ?? "";
    const selector = normalizeCssSelector(rawSelector);
    const body = ruleMatch[2] ?? "";

    if (
      !selector ||
      selector.startsWith("@") ||
      SHAPE_MUTATION_DECLARATION_PATTERN.test(selector) ||
      STATEFUL_SHAPE_SNAP_SUPPRESS_DIRECTIVE_PATTERN.test(rawSelector) ||
      isStatefulShapeSnapSuppressed(styleSource, ruleMatch.index ?? 0)
    ) {
      continue;
    }

    if (!STATEFUL_SHAPE_SELECTOR_PATTERN.test(selector) || !SHAPE_MUTATION_DECLARATION_PATTERN.test(body)) {
      continue;
    }

    const line = lineNumberAt(styleSource, ruleMatch.index ?? 0);
    risks.push(`line ${line} ${selector.slice(0, 120)}`);
  }

  return risks;
}

function collectSectionCardRadiusContractViolations(source, filePath) {
  const contracts = SECTION_CARD_RADIUS_CONTRACTS[filePath];
  if (!contracts) {
    return [];
  }

  return contracts.filter(({ pattern }) => !pattern.test(source)).map(({ label }) => label);
}

function shouldAuditBespokeSectionCardRadiusPath(filePath) {
  return filePath.startsWith("src/shared-primitives-live/") || filePath.startsWith("src/components/public/");
}

function isBespokeSectionCardRadiusToken(token) {
  return BESPOKE_SECTION_CARD_RADIUS_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token));
}

function hasBespokeSectionCardSurfaceContext(tokens, filePath) {
  const semanticTokens = tokens
    .map(stripTailwindVariantPrefixes)
    .filter((token) => !/^(?:bg|border|text|ring|from|via|to|shadow|p[trblxy]?|m[trblxy]?|gap|flex|grid)-/.test(token))
    .filter((token) => !["bg", "border", "text", "shadow", "flex", "grid"].includes(token));

  if (semanticTokens.some((token) => SECTION_CARD_SURFACE_TOKEN_PATTERN.test(token))) {
    return true;
  }

  if (!filePath.startsWith("src/shared-primitives-live/")) {
    return false;
  }

  const hasBorder = tokens.some((token) => token === "border" || token.startsWith("border-"));
  const hasSurfaceBackground = tokens.some((token) =>
    /^bg-(?:surface|public|state|error|primary|secondary|tertiary)/.test(token),
  );
  return hasBorder && hasSurfaceBackground;
}

function isBespokeSectionCardRadiusExempt(tokens) {
  return tokens.some((token) => SECTION_CARD_RADIUS_EXEMPT_TOKEN_PATTERN.test(stripTailwindVariantPrefixes(token)));
}

function collectBespokeSectionCardRadiusGroups(templateSource, filePath) {
  if (!shouldAuditBespokeSectionCardRadiusPath(filePath)) {
    return [];
  }

  const groups = [];

  for (const tagMatch of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = tagMatch;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    for (const attrMatch of attrs.matchAll(SECTION_CARD_RADIUS_ATTR_PATTERN)) {
      const attrName = attrMatch[1] ?? "class";
      const value = attrMatch[3] ?? "";
      const tokens = splitStaticClassTokens(value);
      const bespokeRadiusTokens = tokens.filter(isBespokeSectionCardRadiusToken);
      if (bespokeRadiusTokens.length === 0 || tokens.includes(SECTION_CARD_RADIUS_TOKEN)) {
        continue;
      }

      if (isBespokeSectionCardRadiusExempt(tokens) || !hasBespokeSectionCardSurfaceContext(tokens, filePath)) {
        continue;
      }

      groups.push(`${tagName} ${attrName} ${bespokeRadiusTokens.join(",")} in ${tokens.slice(0, 8).join(" ")}`.trim());
    }
  }

  return groups;
}

function countSharedPrimitiveCallsiteClassDrift(templateSource) {
  let count = 0;

  for (const match of templateSource.matchAll(OPENING_TAG_PATTERN)) {
    const [rawTag, tagName, attrs = ""] = match;
    if (rawTag.startsWith("</") || rawTag.startsWith("<!")) {
      continue;
    }

    const auditPattern = SHARED_PRIMITIVE_CLASS_AUDIT_PATTERNS[tagName];
    if (!auditPattern) {
      continue;
    }

    if (auditPattern.test(attrs)) {
      count += 1;
    }
  }

  return count;
}

function countPublicLiteralThemeUtilities(templateSource) {
  return [...templateSource.matchAll(PUBLIC_LITERAL_THEME_UTILITY_PATTERN)].length;
}

function countPatternMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function countPatternMatchesInStringLiterals(source, pattern) {
  let count = 0;

  const masked = maskJsCommentsPreserveLayout(source);
  for (const match of scanJsStringLiterals(masked)) {
    count += countPatternMatches(match.text, pattern);
  }

  return count;
}

function scanJsStringLiterals(source) {
  const literals = [];
  let index = 0;

  while (index < source.length) {
    const quote = source[index];
    if (quote === "/" && isLikelyRegexLiteralStart(source, index)) {
      index = skipRegexLiteral(source, index);
      continue;
    }

    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (char === quote) {
        break;
      }
    }

    literals.push({
      index: start,
      text: source.slice(start, index),
    });
  }

  return literals;
}

function isLikelyRegexLiteralStart(source, index) {
  const next = source[index + 1];
  if (!next || next === "/" || next === "*") {
    return false;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      continue;
    }
    return /[=(:,;[!{?]/.test(char);
  }

  return true;
}

function skipRegexLiteral(source, index) {
  let cursor = index + 1;
  let inCharacterClass = false;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      cursor += 1;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      cursor += 1;
      continue;
    }
    if (char === "/" && !inCharacterClass) {
      cursor += 1;
      while (/[a-z]/i.test(source[cursor] ?? "")) {
        cursor += 1;
      }
      return cursor;
    }
    cursor += 1;
  }

  return cursor;
}

// Replace JS comment ranges with spaces while preserving every newline so that
// downstream regex offsets and line numbers stay accurate. This is required
// because comment-internal apostrophes (e.g. "row's content") otherwise open a
// fake string literal that spans hundreds of lines, dragging unrelated code
// (like `if (!end || ...)`) into the "string-literal" scan and producing
// false-positive drift findings. Strings, templates, and regex literals are
// preserved so quote pairing inside real code remains intact.
function maskJsCommentsPreserveLayout(source) {
  const length = source.length;
  const out = new Array(length);
  let i = 0;
  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment: replace through end-of-line (but keep the newline).
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < length && source[j] !== "\n") {
        out[j] = source[j] === "\n" ? "\n" : " ";
        j++;
      }
      i = j;
      continue;
    }

    // Block comment: replace through closing */ (keep newlines).
    if (ch === "/" && next === "*") {
      let j = i + 2;
      out[i] = " ";
      out[i + 1] = " ";
      while (j < length && !(source[j] === "*" && source[j + 1] === "/")) {
        out[j] = source[j] === "\n" ? "\n" : " ";
        j++;
      }
      if (j < length) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
      continue;
    }

    // String / template literal: copy through verbatim so quote pairing matches
    // the original source.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out[i] = ch;
      let j = i + 1;
      while (j < length) {
        const c = source[j];
        out[j] = c;
        if (c === "\\" && j + 1 < length) {
          out[j + 1] = source[j + 1];
          j += 2;
          continue;
        }
        if (c === quote) {
          j++;
          break;
        }
        // Template literal `${ ... }` interpolation: copy through, including
        // any nested strings, until matching closing brace.
        if (quote === "`" && c === "$" && source[j + 1] === "{") {
          out[j + 1] = "{";
          let depth = 1;
          let k = j + 2;
          while (k < length && depth > 0) {
            const cc = source[k];
            out[k] = cc;
            if (cc === "{") depth++;
            else if (cc === "}") depth--;
            k++;
          }
          j = k;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }

    out[i] = ch;
    i++;
  }
  return out.join("");
}

function loadTailwindImportantAllowlist(allowlistPath = DEFAULT_TAILWIND_IMPORTANT_ALLOWLIST_PATH) {
  if (!fs.existsSync(allowlistPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

let TAILWIND_IMPORTANT_ALLOWLIST = loadTailwindImportantAllowlist();

const UI_DRIFT_POLICY_KEYS = [
  "rawControlFeatureAllowlist",
  "rawControlAllowlistPrefixes",
  "rawButtonPrimitiveAllowlist",
  "rawTrackedInputPrimitiveAllowlist",
  "featureLocalTeleportAllowlist",
  "featureLocalDismissableAllowlist",
  "workspaceRootStateOwnerPaths",
  "legacySurfaceClassNames",
];

function loadUiDriftPolicyFile(policyPath) {
  if (!policyPath || !fs.existsSync(policyPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function resolveUiDriftCheckConfig(checkConfig, rootDir) {
  if (!checkConfig?.policyPath) {
    return checkConfig ?? {};
  }

  const policyPath = path.resolve(rootDir, checkConfig.policyPath);
  const filePolicy = loadUiDriftPolicyFile(policyPath);
  const merged = { ...checkConfig };
  for (const key of UI_DRIFT_POLICY_KEYS) {
    if (merged[key] === undefined && filePolicy[key] !== undefined) {
      merged[key] = filePolicy[key];
    }
  }
  return merged;
}

function configureUiDriftAudit(checkConfig, rootDir = process.cwd()) {
  const resolvedConfig = resolveUiDriftCheckConfig(checkConfig, rootDir);
  UI_DRIFT_POLICY = buildUiDriftPolicy(resolvedConfig ?? {});
  const allowlistPath = resolvedConfig?.tailwindImportantAllowlistPath
    ? path.resolve(rootDir, resolvedConfig.tailwindImportantAllowlistPath)
    : DEFAULT_TAILWIND_IMPORTANT_ALLOWLIST_PATH;
  TAILWIND_IMPORTANT_ALLOWLIST = loadTailwindImportantAllowlist(allowlistPath);
}

function countPatternMatchesByLine(source, pattern, allowlistFragments = [], inlineIgnorePattern = null) {
  const lines = source.split(/\r?\n/);

  return lines.reduce((count, line, index) => {
    const context = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 3)).join("\n");

    if (allowlistFragments.some((fragment) => context.includes(fragment)) || inlineIgnorePattern?.test(context)) {
      return count;
    }

    return count + [...line.matchAll(pattern)].length;
  }, 0);
}

function getTailwindImportantAllowlistFragments(filePath) {
  return TAILWIND_IMPORTANT_ALLOWLIST?.["tailwind-important-modifier"]?.[filePath] ?? [];
}

function countDirectClipboardWrites(scriptSource) {
  return [...scriptSource.matchAll(DIRECT_CLIPBOARD_WRITE_PATTERN)].length;
}

function countRawMotionTransitionUtilities(source) {
  return [...source.matchAll(RAW_MOTION_TRANSITION_UTILITY_PATTERN)].length;
}

function countRawMotionTimingUtilities(source, { stringLiteralsOnly = false } = {}) {
  if (stringLiteralsOnly) {
    return countPatternMatchesInStringLiterals(source, RAW_MOTION_TIMING_UTILITY_PATTERN);
  }

  return countPatternMatches(source, RAW_MOTION_TIMING_UTILITY_PATTERN);
}

function shouldAuditRawSurfaceTransitionLiteralPath(filePath) {
  return !isSharedPrimitivePath(filePath);
}

function countRawSurfaceTransitionLiterals(source) {
  return countPatternMatches(source, RAW_SURFACE_TRANSITION_LITERAL_PATTERN);
}

export function collectCountsForSource(source, filePath = DEFAULT_FIXTURE_PATH) {
  const normalizedPath = normalizePath(filePath);
  const counts = buildEmptyCounts();
  const scriptSource = extractScriptSource(source, normalizedPath);
  const importSource = isVueFile(normalizedPath) ? scriptSource : source;
  const sharedFieldTypographyContractCount = countSharedFieldTypographyContractViolations(source, normalizedPath);
  const sharedFloatingFieldPositionContractCount = countSharedFloatingFieldPositionContractViolations(
    source,
    normalizedPath,
  );
  const sharedSearchNativeResetContractCount = countSharedSearchNativeResetContractViolations(source, normalizedPath);
  const editorCommandSearchChromeContractCount = countEditorCommandSearchChromeContractViolations(
    source,
    normalizedPath,
  );
  const sectionCardRadiusContractViolations = collectSectionCardRadiusContractViolations(source, normalizedPath);

  if (sharedFieldTypographyContractCount > 0) {
    counts["shared-field-typography-contract"][normalizedPath] = sharedFieldTypographyContractCount;
  }

  if (sharedFloatingFieldPositionContractCount > 0) {
    counts["shared-floating-field-position-contract"][normalizedPath] = sharedFloatingFieldPositionContractCount;
  }

  if (sharedSearchNativeResetContractCount > 0) {
    counts["shared-search-native-reset-contract"][normalizedPath] = sharedSearchNativeResetContractCount;
  }

  if (editorCommandSearchChromeContractCount > 0) {
    counts["editor-command-search-chrome-contract"][normalizedPath] = editorCommandSearchChromeContractCount;
  }

  if (sectionCardRadiusContractViolations.length > 0) {
    counts["section-card-radius-contract"][`${normalizedPath} :: ${sectionCardRadiusContractViolations.join(" | ")}`] =
      sectionCardRadiusContractViolations.length;
  }

  // The AppController is the canonical orchestrator of root workspace state —
  // every workspace shell needs ONE call site for `useWorkspaceRootState()`.
  // It's the owner, not drift; new feature composables should still be flagged.
  if (!UI_DRIFT_POLICY.workspaceRootStateOwnerPaths.has(normalizedPath)) {
    const workspaceRootStateImportCount = countWorkspaceRootStateImports(importSource);
    if (workspaceRootStateImportCount > 0) {
      counts["workspace-root-state-import"][normalizedPath] = workspaceRootStateImportCount;
    }
  }

  if (isCssFile(normalizedPath)) {
    const statefulShapeSnapRisks = collectStatefulShapeSnapRisks(source);
    if (statefulShapeSnapRisks.length > 0) {
      counts["stateful-shape-token-snap-risk"][`${normalizedPath} :: ${statefulShapeSnapRisks.join(" | ")}`] =
        statefulShapeSnapRisks.length;
    }

    return counts;
  }

  if (isVueFile(normalizedPath)) {
    const templateSource = extractTemplateSource(source);
    const styleSource = extractStyleSource(source, normalizedPath);

    const bespokeSectionCardRadiusGroups = collectBespokeSectionCardRadiusGroups(templateSource, normalizedPath);
    if (bespokeSectionCardRadiusGroups.length > 0) {
      counts["bespoke-section-card-radius"][`${normalizedPath} :: ${bespokeSectionCardRadiusGroups.join(" | ")}`] =
        bespokeSectionCardRadiusGroups.length;
    }

    const statefulShapeSnapRisks = collectStatefulShapeSnapRisks(styleSource);
    if (statefulShapeSnapRisks.length > 0) {
      counts["stateful-shape-token-snap-risk"][`${normalizedPath} :: ${statefulShapeSnapRisks.join(" | ")}`] =
        statefulShapeSnapRisks.length;
    }

    if (shouldAuditPrimitiveShapePath(normalizedPath)) {
      const primitiveShapeContractMissing = collectPrimitiveShapeContractMissing(templateSource);
      if (primitiveShapeContractMissing.length > 0) {
        counts["primitive-shape-contract-missing"][
          `${normalizedPath} :: ${primitiveShapeContractMissing.join(" | ")}`
        ] = primitiveShapeContractMissing.length;
      }
    }

    if (shouldAuditRawButtonPath(normalizedPath)) {
      const rawButtonCount = countTags(templateSource, "button");
      if (rawButtonCount > 0) {
        counts["raw-button-outside-shared"][normalizedPath] = rawButtonCount;
      }
    }

    if (shouldAuditRawTrackedInputPath(normalizedPath)) {
      const rawInputCount = countRawTrackedInputs(templateSource);
      if (rawInputCount > 0) {
        counts["raw-input-outside-shared"][normalizedPath] = rawInputCount;
      }
    }

    if (shouldAuditRawNativeControlPath(normalizedPath)) {
      const rawSelectCount = countTags(templateSource, "select");
      if (rawSelectCount > 0) {
        counts["raw-select-outside-shared"][normalizedPath] = rawSelectCount;
      }
      const rawTextareaCount = countTags(templateSource, "textarea");
      if (rawTextareaCount > 0) {
        counts["raw-textarea-outside-shared"][normalizedPath] = rawTextareaCount;
      }
    }

    if (shouldAuditFeatureLocalPath(normalizedPath)) {
      const tailwindImportantModifierCount = countTailwindImportantModifiers(
        templateSource,
        scriptSource,
        getTailwindImportantAllowlistFragments(normalizedPath),
      );
      if (tailwindImportantModifierCount > 0) {
        counts["tailwind-important-modifier"][normalizedPath] = tailwindImportantModifierCount;
      }

      const featureLocalPrimitiveClassCount = countFeatureLocalPrimitiveClassesWithoutImport(
        templateSource,
        scriptSource,
      );
      if (featureLocalPrimitiveClassCount > 0) {
        counts["feature-local-primitive-class-without-import"][normalizedPath] = featureLocalPrimitiveClassCount;
      }

      const bespokePrimitiveSurfaceCandidates = collectBespokePrimitiveSurfaceCandidateGroups(
        templateSource,
        scriptSource,
        normalizedPath,
      );
      if (bespokePrimitiveSurfaceCandidates.length > 0) {
        counts["bespoke-primitive-surface-candidate"][
          `${normalizedPath} :: ${bespokePrimitiveSurfaceCandidates.join(" | ")}`
        ] = bespokePrimitiveSurfaceCandidates.length;
      }

      const sharedPrimitiveConversionCandidates = collectSharedPrimitiveConversionCandidateGroups(
        templateSource,
        scriptSource,
        normalizedPath,
      );
      if (sharedPrimitiveConversionCandidates.length > 0) {
        counts["shared-primitive-conversion-candidate"][
          `${normalizedPath} :: ${sharedPrimitiveConversionCandidates.join(" | ")}`
        ] = sharedPrimitiveConversionCandidates.length;
      }
    }

    const titleAttrCount = countNativeTitleAttrs(templateSource);
    if (titleAttrCount > 0) {
      counts["title-attr-on-non-form"][normalizedPath] = titleAttrCount;
    }

    const appFlyoutPanelZUtilityCount = countAppFlyoutPanelZUtilities(templateSource);
    if (appFlyoutPanelZUtilityCount > 0) {
      counts["app-flyout-panel-z-utility"][normalizedPath] = appFlyoutPanelZUtilityCount;
    }

    const sharedPrimitiveClassDriftCount = countSharedPrimitiveCallsiteClassDrift(templateSource);
    if (sharedPrimitiveClassDriftCount > 0) {
      counts["shared-primitive-callsite-class-drift"][normalizedPath] = sharedPrimitiveClassDriftCount;
    }

    const sfcMdSysColorTokenRedefinitionCount = countPatternMatches(
      styleSource,
      SFC_MD_SYS_COLOR_TOKEN_REDEFINITION_PATTERN,
    );
    if (sfcMdSysColorTokenRedefinitionCount > 0) {
      counts["sfc-md-sys-color-token-redefinition"][normalizedPath] = sfcMdSysColorTokenRedefinitionCount;
    }

    if (shouldAuditFeatureLocalTeleportPath(normalizedPath)) {
      const featureLocalTeleportCount = countFeatureLocalTeleportUsage(templateSource);
      if (featureLocalTeleportCount > 0) {
        counts["feature-local-teleport"][normalizedPath] = featureLocalTeleportCount;
      }
    }

    if (shouldAuditFeatureLocalDetailPaneCardPath(normalizedPath)) {
      const featureLocalDetailPaneCardCount = countFeatureLocalDetailPaneCardUsage(templateSource, scriptSource);
      if (featureLocalDetailPaneCardCount > 0) {
        counts["feature-local-detail-pane-card"][normalizedPath] = featureLocalDetailPaneCardCount;
      }
    }

    if (isPublicComponentPath(normalizedPath)) {
      const hardcodedUtilityCount = countPublicLiteralThemeUtilities(templateSource);
      if (hardcodedUtilityCount > 0) {
        counts["public-hardcoded-theme-utility"][normalizedPath] = hardcodedUtilityCount;
      }
    }

    const rawMotionTransitionUtilityCount = countRawMotionTransitionUtilities(`${templateSource}\n${scriptSource}`);
    if (rawMotionTransitionUtilityCount > 0) {
      counts["raw-motion-transition-utility"][normalizedPath] = rawMotionTransitionUtilityCount;
    }

    if (shouldAuditHandRolledProgressBarPath(normalizedPath)) {
      const handRolledProgressBarCount = countPatternMatches(templateSource, HAND_ROLLED_PROGRESS_BAR_PATTERN);
      if (handRolledProgressBarCount > 0) {
        counts["hand-rolled-progress-bar"][normalizedPath] = handRolledProgressBarCount;
      }
    }

    const rawMotionTimingUtilityCount =
      countRawMotionTimingUtilities(templateSource) +
      countRawMotionTimingUtilities(scriptSource, { stringLiteralsOnly: true });
    if (rawMotionTimingUtilityCount > 0) {
      counts["raw-motion-timing-utility"][normalizedPath] = rawMotionTimingUtilityCount;
    }

    if (shouldAuditRawSurfaceTransitionLiteralPath(normalizedPath)) {
      const rawSurfaceTransitionLiteralCount = countRawSurfaceTransitionLiterals(source);
      if (rawSurfaceTransitionLiteralCount > 0) {
        counts["raw-surface-transition-literal"][normalizedPath] = rawSurfaceTransitionLiteralCount;
      }
    }

    for (const [ruleId, pattern] of Object.entries(UI_DRIFT_POLICY.legacySurfaceRulePatterns)) {
      const legacyClassCount = countPatternMatches(templateSource, pattern);
      if (legacyClassCount > 0) {
        counts[ruleId][normalizedPath] = legacyClassCount;
      }
    }

    if (isWorkspaceComponentPath(normalizedPath)) {
      const rawShadowUtilityCount = countPatternMatchesByLine(
        templateSource,
        RAW_WORKSPACE_SHADOW_UTILITY_PATTERN,
        [],
        SHADOW_AUDIT_INLINE_IGNORE_PATTERN,
      );
      if (rawShadowUtilityCount > 0) {
        counts["workspace-raw-shadow-utility"][normalizedPath] = rawShadowUtilityCount;
      }

      const customShadowUtilityCount = countPatternMatchesByLine(
        templateSource,
        CUSTOM_WORKSPACE_SHADOW_UTILITY_PATTERN,
        [],
        SHADOW_AUDIT_INLINE_IGNORE_PATTERN,
      );
      if (customShadowUtilityCount > 0) {
        counts["workspace-custom-shadow-utility"][normalizedPath] = customShadowUtilityCount;
      }
    }

    if (shouldAuditFeatureLocalDismissablePath(normalizedPath)) {
      const featureLocalDismissableCount = countFeatureLocalDismissableWiring(scriptSource);
      if (featureLocalDismissableCount > 0) {
        counts["feature-local-dismissable-wiring"][normalizedPath] = featureLocalDismissableCount;
      }
    }
  }

  if (normalizedPath !== "src/lib/clipboard.ts" && normalizedPath !== "src/lib/browser/clipboard.ts") {
    const clipboardWriteCount = countDirectClipboardWrites(scriptSource);
    if (clipboardWriteCount > 0) {
      counts["clipboard-write-outside-app-copy-field"][normalizedPath] = clipboardWriteCount;
    }
  }

  if (!isVueFile(normalizedPath)) {
    if (shouldAuditGeneratedShapePath(normalizedPath)) {
      const generatedShapeContractMissing = collectGeneratedShapeContractMissing(source);
      if (generatedShapeContractMissing.length > 0) {
        counts["primitive-shape-contract-missing"][
          `${normalizedPath} :: ${generatedShapeContractMissing.join(" | ")}`
        ] = generatedShapeContractMissing.length;
      }
    }

    const rawMotionTransitionUtilityCount = countRawMotionTransitionUtilities(source);
    if (rawMotionTransitionUtilityCount > 0) {
      counts["raw-motion-transition-utility"][normalizedPath] = rawMotionTransitionUtilityCount;
    }

    const rawMotionTimingUtilityCount = countRawMotionTimingUtilities(source, {
      stringLiteralsOnly: true,
    });
    if (rawMotionTimingUtilityCount > 0) {
      counts["raw-motion-timing-utility"][normalizedPath] = rawMotionTimingUtilityCount;
    }

    if (shouldAuditRawSurfaceTransitionLiteralPath(normalizedPath)) {
      const rawSurfaceTransitionLiteralCount = countRawSurfaceTransitionLiterals(source);
      if (rawSurfaceTransitionLiteralCount > 0) {
        counts["raw-surface-transition-literal"][normalizedPath] = rawSurfaceTransitionLiteralCount;
      }
    }

    if (shouldAuditFeatureLocalDismissablePath(normalizedPath)) {
      const featureLocalDismissableCount = countFeatureLocalDismissableWiring(source);
      if (featureLocalDismissableCount > 0) {
        counts["feature-local-dismissable-wiring"][normalizedPath] = featureLocalDismissableCount;
      }
    }
  }

  return counts;
}

export function collectCountsForVueSource(source, filePath = DEFAULT_FIXTURE_PATH) {
  return collectCountsForSource(source, filePath);
}

// Findings collection mirrors `collectCountsForSource` but records the exact
// line + snippet for each hit. This is what powers `--explain`: instead of the
// audit reporting "tailwind-important-modifier: foo.vue (0 -> 1)" with no clue
// where, the reporter can print "foo.vue:1313 — !sponsor.displayOnEventPage".
//
// Only rules where the count alone isn't enough to act are wired in here.
// Rules that already include their own location info in the count key (e.g.
// `primitive-shape-contract-missing` keys files as `path :: violations…`) do
// not need an explain hook and are intentionally omitted.
const EXPLAINABLE_RULE_IDS = new Set([
  "tailwind-important-modifier",
  "feature-local-primitive-class-without-import",
  "shared-primitive-conversion-candidate",
  "raw-button-outside-shared",
  "raw-input-outside-shared",
  "raw-select-outside-shared",
  "raw-textarea-outside-shared",
  "shared-primitive-callsite-class-drift",
]);

export function collectFindingsForSource(source, filePath = DEFAULT_FIXTURE_PATH) {
  const normalizedPath = normalizePath(filePath);
  const findings = Object.fromEntries(Object.keys(RULE_DEFINITIONS).map((ruleId) => [ruleId, []]));

  if (!isVueFile(normalizedPath)) {
    return findings;
  }

  const lineStarts = buildLineIndex(source);
  const templateBlock = extractTemplateBlock(source);
  const scriptBlocks = extractScriptBlocks(source);
  const scriptSource = scriptBlocks.map((block) => block.text).join("\n");

  if (shouldAuditFeatureLocalPath(normalizedPath)) {
    findings["tailwind-important-modifier"] = collectTailwindImportantModifierFindings({
      source,
      lineStarts,
      templateBlock,
      scriptBlocks,
      allowlistFragments: getTailwindImportantAllowlistFragments(normalizedPath),
    });

    findings["feature-local-primitive-class-without-import"] = collectFeatureLocalPrimitiveClassFindings({
      source,
      lineStarts,
      templateBlock,
      scriptBlocks,
      scriptSource,
    });

    findings["shared-primitive-conversion-candidate"] = collectSharedPrimitiveConversionCandidateFindings({
      source,
      lineStarts,
      templateBlock,
      scriptSource,
      filePath: normalizedPath,
    });
  }

  if (shouldAuditRawButtonPath(normalizedPath)) {
    findings["raw-button-outside-shared"] = collectRawTagFindings({
      source,
      lineStarts,
      templateBlock,
      targetTagName: "button",
    });
  }

  if (shouldAuditRawTrackedInputPath(normalizedPath)) {
    // Tracked-input scanner mirrors the counted variant: any raw <input> in the
    // template is reported. Per-attribute filtering remains in the count path
    // and could be added here if/when that rule has actual false positives.
    findings["raw-input-outside-shared"] = collectRawTagFindings({
      source,
      lineStarts,
      templateBlock,
      targetTagName: "input",
    });
  }

  if (shouldAuditRawNativeControlPath(normalizedPath)) {
    findings["raw-select-outside-shared"] = collectRawTagFindings({
      source,
      lineStarts,
      templateBlock,
      targetTagName: "select",
    });
    findings["raw-textarea-outside-shared"] = collectRawTagFindings({
      source,
      lineStarts,
      templateBlock,
      targetTagName: "textarea",
    });
  }

  findings["shared-primitive-callsite-class-drift"] = collectSharedPrimitiveCallsiteClassDriftFindings({
    source,
    lineStarts,
    templateBlock,
  });

  return findings;
}

function collectRepoFindings(rootDir = path.resolve(process.cwd(), "src"), { ruleFilter = null } = {}) {
  const all = {};

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!AUDIT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const relativePath = normalizePath(path.relative(process.cwd(), fullPath));
      if (TEST_FILE_PATTERN.test(relativePath)) {
        continue;
      }

      const source = fs.readFileSync(fullPath, "utf8");
      const fileFindings = collectFindingsForSource(source, relativePath);
      for (const [ruleId, items] of Object.entries(fileFindings)) {
        if (items.length === 0) continue;
        if (ruleFilter && !ruleFilter.has(ruleId)) continue;
        (all[ruleId] ??= {})[relativePath] = items;
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return all;
}

function collectRepoCounts(rootDir = path.resolve(process.cwd(), "src")) {
  const counts = buildEmptyCounts();

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!AUDIT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const relativePath = normalizePath(path.relative(process.cwd(), fullPath));
      if (TEST_FILE_PATTERN.test(relativePath)) {
        continue;
      }

      const source = fs.readFileSync(fullPath, "utf8");
      mergeRuleCounts(counts, collectCountsForSource(source, relativePath));
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return counts;
}

// ─── Programmatic drift queue (actionable vs justified) ───────────────────────
//
// The high-noise heuristic rules below commingle genuine drift with intentional
// KEEPs. Instead of re-triaging that soup by hand every audit, each KEEP is
// annotated AT ITS CALLSITE with a reason-bearing inline directive:
//
//   <!-- arkitect-ignore-next-line raw-button-outside-shared — branded CTA, currentColor-themed -->
//   <button class="…">
//
// The audit then partitions every finding into:
//   • actionable — no directive → the genuine migration queue
//   • justified  — a directive WITH a reason
//   • invalid    — a directive with NO reason (loud: a KEEP must say why)
//
// This is co-located, reason-bearing, and diff-reviewable — not a central
// baseline snapshot. A new raw control surfaces as exactly one actionable
// finding at its exact line; an unjustified suppression fails the audit.
const SUPPRESSIBLE_HEURISTIC_RULES = [
  "raw-button-outside-shared",
  "raw-input-outside-shared",
  "raw-select-outside-shared",
  "raw-textarea-outside-shared",
  "feature-local-primitive-class-without-import",
  "shared-primitive-conversion-candidate",
  "shared-primitive-callsite-class-drift",
  "tailwind-important-modifier",
];

function computeSuppressionAudit(rootDir = path.resolve(process.cwd(), "src")) {
  const perRule = {};
  function bucketFor(ruleId) {
    return (perRule[ruleId] ??= { total: 0, actionable: [], justified: 0, invalid: [] });
  }

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!AUDIT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const relativePath = normalizePath(path.relative(process.cwd(), fullPath));
      if (TEST_FILE_PATTERN.test(relativePath)) {
        continue;
      }

      const source = fs.readFileSync(fullPath, "utf8");
      const fileFindings = collectFindingsForSource(source, relativePath);
      let suppressions = null;
      for (const ruleId of SUPPRESSIBLE_HEURISTIC_RULES) {
        const items = fileFindings[ruleId];
        if (!items || items.length === 0) continue;
        suppressions ??= collectSuppressions(source);
        const bucket = bucketFor(ruleId);
        for (const item of items) {
          bucket.total += 1;
          const directive = matchingSuppression(suppressions, item.line, ruleId);
          if (!directive) {
            bucket.actionable.push({ filePath: relativePath, line: item.line, snippet: item.snippet });
          } else if (directive.reason) {
            bucket.justified += 1;
          } else {
            bucket.invalid.push({ filePath: relativePath, line: item.line });
          }
        }
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return perRule;
}

function summarizeSuppressionAudit(audit) {
  let actionable = 0;
  let actionableBlocking = 0;
  let justified = 0;
  let invalid = 0;
  for (const [ruleId, bucket] of Object.entries(audit)) {
    actionable += bucket.actionable.length;
    justified += bucket.justified;
    invalid += bucket.invalid.length;
    // Error-severity rules ratchet: once a rule has 0 actionable findings, any
    // NEW un-annotated finding fails the audit. Warn-severity rules stay
    // informational (surfaced in the queue, but never block).
    if (RULE_DEFINITIONS[ruleId]?.severity === "error") {
      actionableBlocking += bucket.actionable.length;
    }
  }
  return { actionable, actionableBlocking, justified, invalid };
}

function formatSuppressionAuditReport(audit) {
  const ruleIds = Object.keys(audit).sort();
  if (ruleIds.length === 0) return "";

  const { actionable, justified, invalid } = summarizeSuppressionAudit(audit);
  const lines = [
    "",
    "## Drift queue — actionable vs justified",
    "",
    `Σ **${actionable} actionable** · ${justified} justified · ${invalid} invalid-suppression${invalid === 1 ? "" : "s"}`,
    "",
  ];
  for (const ruleId of ruleIds) {
    const bucket = audit[ruleId];
    lines.push(
      `- **${ruleId}** — ${bucket.actionable.length} actionable / ${bucket.justified} justified / ${bucket.total} total`,
    );
    for (const hit of bucket.actionable.slice(0, 12)) {
      lines.push(`  - \`${hit.filePath}:${hit.line}\``);
    }
    if (bucket.actionable.length > 12) {
      lines.push(`  - … +${bucket.actionable.length - 12} more`);
    }
    for (const bad of bucket.invalid) {
      lines.push(`  - ⚠ \`${bad.filePath}:${bad.line}\` — suppression is missing a reason (add \` — <why>\`)`);
    }
  }
  lines.push("");
  lines.push("Annotate a KEEP at its callsite: `<!-- arkitect-ignore-next-line <rule> — <why> -->`");
  return lines.join("\n");
}

function buildBaselineDocument(counts) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules: Object.fromEntries(
      Object.entries(RULE_DEFINITIONS).map(([ruleId, definition]) => [
        ruleId,
        {
          ...definition,
          files: counts[ruleId],
        },
      ]),
    ),
  };
}

function findRegressions(currentCounts, baseline) {
  if (!baseline?.rules) {
    return [];
  }

  const regressions = [];

  for (const ruleId of Object.keys(RULE_DEFINITIONS)) {
    const baselineFiles = baseline.rules?.[ruleId]?.files ?? {};
    const currentFiles = currentCounts[ruleId] ?? {};

    for (const [filePath, currentCount] of Object.entries(currentFiles)) {
      const baselineCount = baselineFiles[filePath] ?? 0;
      if (currentCount > baselineCount) {
        regressions.push({
          ruleId,
          filePath,
          baselineCount,
          currentCount,
          severity: RULE_DEFINITIONS[ruleId].severity,
        });
      }
    }
  }

  return regressions;
}

function printCounts(counts) {
  for (const [ruleId, definition] of Object.entries(RULE_DEFINITIONS)) {
    const fileCounts = counts[ruleId] ?? {};
    const total = Object.values(fileCounts).reduce((sum, count) => sum + count, 0);
    console.log(`${ruleId} [${definition.severity}] total=${total} files=${Object.keys(fileCounts).length}`);

    for (const [filePath, count] of Object.entries(fileCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${filePath}: ${count}`);
    }
  }
}

function countTotalFindings(counts) {
  return Object.values(counts).reduce(
    (sum, fileCounts) => sum + Object.values(fileCounts).reduce((ruleSum, count) => ruleSum + count, 0),
    0,
  );
}

function getRulesWithFindings(counts) {
  return Object.entries(RULE_DEFINITIONS)
    .map(([ruleId, definition]) => {
      const fileCounts = counts[ruleId] ?? {};
      const total = Object.values(fileCounts).reduce((sum, count) => sum + count, 0);

      return {
        ruleId,
        definition,
        fileCounts,
        total,
      };
    })
    .filter((rule) => rule.total > 0)
    .sort((a, b) => {
      if (a.definition.severity !== b.definition.severity) {
        return a.definition.severity === "error" ? -1 : 1;
      }

      if (a.total !== b.total) {
        return b.total - a.total;
      }

      return a.ruleId.localeCompare(b.ruleId);
    });
}

function formatRegressionLine(regression) {
  return [
    `- \`${regression.filePath}\``,
    `current ${regression.currentCount}`,
    `baseline ${regression.baselineCount}`,
    `delta +${regression.currentCount - regression.baselineCount}`,
  ].join(" | ");
}

export function buildUiDriftMarkdownReport(
  result,
  { rootDir = path.resolve(process.cwd(), "src"), generatedAt = new Date().toISOString() } = {},
) {
  const rulesWithFindings = getRulesWithFindings(result.counts);
  const totalFindings = countTotalFindings(result.counts);
  const lines = [
    "# Sharedpry UI Drift Report",
    "",
    `- Generated: \`${generatedAt}\``,
    `- Check: \`${CHECK_ID}\``,
    `- Root: \`${normalizePath(path.relative(process.cwd(), rootDir) || ".")}\``,
    `- Mode: \`audit\``,
    "",
    "## Summary",
    "",
    `- Total findings: ${totalFindings}`,
    `- Rules with findings: ${rulesWithFindings.length}`,
    `- Error regressions: ${result.blockingRegressions.length}`,
    `- Warning regressions: ${result.warningRegressions.length}`,
  ];

  if (result.blockingRegressions.length === 0 && result.warningRegressions.length === 0) {
    lines.push("- Regression status: no regressions detected");
  } else {
    lines.push("- Regression status: regressions detected");
  }

  lines.push(
    "",
    "## Review Guidance",
    "",
    "- Prioritize error regressions first, then warn-level regressions, then remaining findings.",
    "- File paths and counts below are meant to be machine-readable so a follow-on AI pass can inspect the exact hotspots.",
  );

  if (result.blockingRegressions.length > 0 || result.warningRegressions.length > 0) {
    lines.push("", "## Regressions", "");

    if (result.blockingRegressions.length > 0) {
      lines.push("### Error Regressions", "");
      for (const regression of result.blockingRegressions) {
        lines.push(
          `#### \`${regression.ruleId}\``,
          "",
          `- Severity: \`error\``,
          `- Description: ${RULE_DEFINITIONS[regression.ruleId].description}`,
          formatRegressionLine(regression),
          "",
        );
      }
    }

    if (result.warningRegressions.length > 0) {
      lines.push("### Warning Regressions", "");
      for (const regression of result.warningRegressions) {
        lines.push(
          `#### \`${regression.ruleId}\``,
          "",
          `- Severity: \`warn\``,
          `- Description: ${RULE_DEFINITIONS[regression.ruleId].description}`,
          formatRegressionLine(regression),
          "",
        );
      }
    }
  }

  lines.push("", "## Findings By Rule", "");

  if (rulesWithFindings.length === 0) {
    lines.push("- No current findings.", "");
    return `${lines.join("\n")}\n`;
  }

  for (const rule of rulesWithFindings) {
    const regressionByFile = new Map(
      result.regressions
        .filter((regression) => regression.ruleId === rule.ruleId)
        .map((regression) => [regression.filePath, regression]),
    );

    lines.push(
      `### \`${rule.ruleId}\``,
      "",
      `- Severity: \`${rule.definition.severity}\``,
      `- Description: ${rule.definition.description}`,
      `- Total findings: ${rule.total}`,
      `- Files: ${Object.keys(rule.fileCounts).length}`,
      "",
    );

    for (const [filePath, count] of Object.entries(rule.fileCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
      const regression = regressionByFile.get(filePath);
      if (regression) {
        lines.push(
          `- \`${filePath}\` | count ${count} | baseline ${regression.baselineCount} | delta +${regression.currentCount - regression.baselineCount} | regression`,
        );
        continue;
      }

      lines.push(`- \`${filePath}\` | count ${count}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function runUiDriftCheck({
  rootDir = path.resolve(process.cwd(), "src"),
  outputFormat = "text",
  outputPath = "",
} = {}) {
  configureUiDriftAudit({}, process.cwd());
  const counts = collectRepoCounts(rootDir);

  const regressions = findRegressions(counts, {});

  const blockingRegressions = regressions.filter((regression) => regression.severity === "error");
  const warningRegressions = regressions.filter((regression) => regression.severity === "warn");

  const suppressionAudit = computeSuppressionAudit(rootDir);
  const suppressionSummary = summarizeSuppressionAudit(suppressionAudit);
  const queueReport = formatSuppressionAuditReport(suppressionAudit);

  if (outputFormat === "markdown") {
    const result = {
      counts,
      regressions,
      blockingRegressions,
      warningRegressions,
      suppressionAudit,
      suppressionSummary,
    };
    const markdownReport = buildUiDriftMarkdownReport(result, {
      rootDir,
    });
    const markdownWithQueue = queueReport ? `${markdownReport}\n${queueReport}\n` : markdownReport;
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, markdownWithQueue, "utf8");
    } else {
      process.stdout.write(markdownWithQueue);
    }
  } else {
    printCounts(counts);
    if (queueReport) {
      console.log(queueReport);
    }

    if (warningRegressions.length > 0) {
      console.warn("\nUI drift warnings detected:");
      for (const regression of warningRegressions) {
        console.warn(
          `  ${regression.ruleId}: ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
        );
      }
    }

    if (blockingRegressions.length > 0) {
      console.error("\nUI drift regressions detected:");
      for (const regression of blockingRegressions) {
        console.error(
          `  ${regression.ruleId}: ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
        );
      }
      process.exitCode = 1;
    }
  }

  // A reasonless suppression is a loud failure regardless of output format — a
  // KEEP must declare why it is a KEEP.
  if (suppressionSummary.invalid > 0) {
    console.error(
      `\nUI drift: ${suppressionSummary.invalid} suppression(s) missing a reason — add " — <why>" to each directive.`,
    );
    process.exitCode = 1;
  }

  // Ratchet: any NEW un-annotated finding on an error-severity rule fails the
  // audit. Migrate it, or annotate the KEEP with `arkitect-ignore-next-line
  // <rule> — <why>`.
  if (suppressionSummary.actionableBlocking > 0) {
    console.error(
      `\nUI drift: ${suppressionSummary.actionableBlocking} new actionable drift finding(s) — migrate to the shared primitive or annotate the KEEP with a reason.`,
    );
    process.exitCode = 1;
  }

  return {
    counts,
    regressions,
    blockingRegressions,
    warningRegressions,
    suppressionAudit,
    suppressionSummary,
  };
}

function parseUiDriftCommandArgs(args = []) {
  let outputFormat = "text";
  let outputPath = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--format" || arg === "--output-format") {
      const requestedFormat = args[index + 1] ?? "";
      if (requestedFormat === "md" || requestedFormat === "markdown") {
        outputFormat = "markdown";
        index += 1;
        continue;
      }

      if (requestedFormat === "text") {
        outputFormat = "text";
        index += 1;
        continue;
      }
    }

    if (arg === "--output") {
      outputPath = args[index + 1] ?? "";
      index += 1;
      continue;
    }
  }

  return {
    outputFormat,
    outputPath: outputPath ? path.resolve(process.cwd(), outputPath) : "",
  };
}

export function runUiDriftCommand(args = []) {
  return runUiDriftCheck(parseUiDriftCommandArgs(args));
}

function buildUiDriftTextReport(result, { explain = null } = {}) {
  const lines = [];
  for (const [ruleId, definition] of Object.entries(RULE_DEFINITIONS)) {
    const fileCounts = result.counts[ruleId] ?? {};
    const total = Object.values(fileCounts).reduce((sum, count) => sum + count, 0);
    lines.push(`${ruleId} [${definition.severity}] total=${total} files=${Object.keys(fileCounts).length}`);

    for (const [filePath, count] of Object.entries(fileCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${filePath}: ${count}`);
    }
  }

  if (result.warningRegressions.length > 0) {
    lines.push("", "UI drift warnings detected:");
    for (const regression of result.warningRegressions) {
      lines.push(
        `  ${regression.ruleId}: ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
      );
    }
  }

  if (result.blockingRegressions.length > 0) {
    lines.push("", "UI drift regressions detected:");
    for (const regression of result.blockingRegressions) {
      lines.push(
        `  ${regression.ruleId}: ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
      );
    }
  }

  if (explain && result.findings) {
    appendExplainSection(lines, result.findings, explain);
  }

  return `${lines.join("\n")}\n`;
}

function appendExplainSection(lines, findings, explain) {
  const ruleIds = explain.ruleFilter ? [...explain.ruleFilter] : [...EXPLAINABLE_RULE_IDS];
  const hasAny = ruleIds.some((ruleId) => Object.keys(findings[ruleId] ?? {}).length > 0);

  lines.push("", "Explanations:");
  if (!hasAny) {
    lines.push(`  no findings for ${ruleIds.join(", ")}`);
    return;
  }

  for (const ruleId of ruleIds) {
    const byFile = findings[ruleId] ?? {};
    const filePaths = Object.keys(byFile).sort();
    if (filePaths.length === 0) continue;

    lines.push("", `  ${ruleId}:`);
    for (const filePath of filePaths) {
      const items = byFile[filePath];
      for (const item of items) {
        const suffix = item.suggestedImports ? ` (consider importing ${item.suggestedImports.join(" / ")})` : "";
        lines.push(`    ${filePath}:${item.line}  ${item.match}${suffix}`);
        lines.push(`      ${item.snippet}`);
      }
    }
  }
}

function normalizeBaselineForUiDrift(baseline) {
  if (baseline?.rules) {
    return baseline;
  }

  return {};
}

export const audit = {
  id: CHECK_ID,
  title: "UI Drift",
  category: "ui",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: {
    roots: ["src"],
    outputPath: "tmp/audits/UI_DRIFT_REPORT.md",
  },
  async run(context) {
    configureUiDriftAudit(context.checkConfig, context.root);
    const rootDir = path.resolve(context.root, context.checkConfig.roots?.[0] ?? "src");
    const counts = collectRepoCounts(rootDir);
    const baseline = normalizeBaselineForUiDrift(context.baseline);
    const regressions = findRegressions(counts, baseline);
    const result = {
      counts,
      regressions,
      blockingRegressions: regressions.filter((regression) => regression.severity === "error"),
      warningRegressions: regressions.filter((regression) => regression.severity === "warn"),
    };

    const explainRequest = parseExplainRequest(context.checkArgs ?? []);
    if (explainRequest) {
      result.findings = collectRepoFindings(rootDir, { ruleFilter: explainRequest.ruleFilter });
    }

    // Programmatic drift queue: partition heuristic findings into actionable
    // (un-annotated) vs justified (reason-bearing inline suppression). Phase 1
    // is informational for `actionable` (the queue), but a reasonless
    // suppression (`invalid`) fails loudly — a KEEP must declare why.
    const suppressionAudit = computeSuppressionAudit(rootDir);
    const suppressionSummary = summarizeSuppressionAudit(suppressionAudit);
    result.suppressionAudit = suppressionAudit;
    result.suppressionSummary = suppressionSummary;

    const format = context.options.format === "markdown" || context.options.format === "md" ? "markdown" : "text";
    const baseReport =
      format === "markdown"
        ? buildUiDriftMarkdownReport(result, {
            rootDir,
          })
        : buildUiDriftTextReport(result, { explain: explainRequest });
    const queueReport = formatSuppressionAuditReport(suppressionAudit);
    const report = queueReport ? `${baseReport}\n${queueReport}\n` : baseReport;

    return {
      baselineDocument: buildBaselineDocument(counts),
      failed:
        result.blockingRegressions.length > 0 ||
        suppressionSummary.invalid > 0 ||
        suppressionSummary.actionableBlocking > 0,
      jsonPayload: result,
      outputPath: format === "markdown" ? context.checkConfig.outputPath : "",
      report,
    };
  },
};

function parseExplainRequest(checkArgs) {
  // `--explain` (alone) explains every rule we have an explainer for; an
  // optional rule id (`--explain rule-id` or `--explain=rule-id` or
  // `--explain rule-a,rule-b`) narrows the output. Unknown rule ids are
  // rejected loudly so a typo doesn't silently produce an empty report.
  let requested = null;
  for (let i = 0; i < checkArgs.length; i += 1) {
    const arg = checkArgs[i];
    if (arg === "--explain") {
      requested = checkArgs[i + 1] && !checkArgs[i + 1].startsWith("--") ? checkArgs[i + 1] : "";
      break;
    }
    if (arg.startsWith("--explain=")) {
      requested = arg.slice("--explain=".length);
      break;
    }
  }
  if (requested === null) return null;

  if (!requested) {
    return { ruleFilter: null };
  }

  const ids = requested
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = ids.filter((id) => !EXPLAINABLE_RULE_IDS.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `--explain: unknown rule id(s): ${invalid.join(", ")}. Available: ${[...EXPLAINABLE_RULE_IDS].join(", ")}`,
    );
  }
  return { ruleFilter: new Set(ids) };
}

export const CHECKS = [
  {
    id: CHECK_ID,
    description: CHECK_DESCRIPTION,
    run: runUiDriftCommand,
  },
];

export function listChecks() {
  return CHECKS;
}

export function getCheck(checkId) {
  return CHECKS.find((check) => check.id === checkId) ?? null;
}

function printUsage() {
  console.log("audit-shared-primitives");
  console.log("");
  console.log("Usage:");
  console.log("  bun run audit:shared-primitives -- list");
  console.log("  bun run audit:shared-primitives -- ui-drift");
  console.log("  bun run audit:shared-primitives -- check ui-drift");
  console.log("  bun run audit:shared-primitives -- ui-drift --format markdown [--output path/to/report.md]");
}

function resolveInvocation(args) {
  if (args.length === 0) {
    return { command: "help" };
  }

  const [firstArg, ...rest] = args;
  if (firstArg === "help" || firstArg === "--help" || firstArg === "-h") {
    return { command: "help" };
  }

  if (firstArg === "list") {
    return { command: "list" };
  }

  if (firstArg === "check") {
    return {
      command: "run",
      checkId: rest[0] ?? "",
      checkArgs: rest.slice(1),
    };
  }

  return {
    command: "run",
    checkId: firstArg,
    checkArgs: rest,
  };
}

export function runSharedPrimitivesAuditCli(args = process.argv.slice(2)) {
  const invocation = resolveInvocation(args);

  if (invocation.command === "help") {
    printUsage();
    return;
  }

  if (invocation.command === "list") {
    for (const check of CHECKS) {
      console.log(`${check.id}\t${check.description}`);
    }
    return;
  }

  const check = getCheck(invocation.checkId);
  if (!check) {
    console.error(`Unknown shared primitives audit check: ${invocation.checkId || "(missing check id)"}`);
    console.error("");
    printUsage();
    process.exitCode = 1;
    return;
  }

  return check.run(invocation.checkArgs);
}

const isDirectExecution =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  Promise.resolve(runSharedPrimitivesAuditCli(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
