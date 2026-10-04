import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "@saydeploy/architect/core/files";

const RULES = {
  "m3-surface-tier-monotonicity": {
    severity: "error",
    description: "Surface container tiers must move monotonically by luminance for light and dark schemes.",
  },
  "m3-undefined-token-fallback": {
    severity: "error",
    description: "Fallbacks must not hide references to custom properties that are undefined in the scanned cascade.",
  },
  "m3-text-transform-uppercase": {
    severity: "warn",
    description: "M3 dropped uppercase labels; use typescale and weight instead of text-transform: uppercase.",
  },
  "m3-raw-border-radius": {
    severity: "warn",
    description:
      "Border radius values — in CSS declarations, JS `:style` bindings, or prop→value radius maps — should resolve through the M3 shape scale or --gc-radius-* tokens rather than raw px/rem.",
  },
  "m3-raw-opacity": {
    severity: "warn",
    description: "Raw opacity declarations should use M3 state-layer or disabled opacity tokens.",
  },
  "m3-stale-motion-duration-fallback": {
    severity: "error",
    description: "Motion duration fallbacks must match the canonical duration token value.",
  },
  "m3-raw-multi-stop-shadow": {
    severity: "warn",
    description: "Multi-stop shadows should resolve through M3 elevation tokens or component elevation tokens.",
  },
  "m3-component-token-coverage": {
    severity: "warn",
    description: "Canonical M3 component token families should expose the required shared slots.",
  },
  "m3-outline-vs-outline-variant": {
    severity: "error",
    description: "Resting component outline tokens must use outline, not outline-variant.",
  },
  "m3-card-shape-and-elevation": {
    severity: "error",
    description: "M3 card variants must expose independent shape and elevation tokens that match the spec.",
  },
  "m3-snackbar-shape": {
    severity: "error",
    description: "Snackbars must use the M3 extra-small 4dp container shape.",
  },
  "m3-state-layer-opacity": {
    severity: "error",
    description: "M3 state-layer opacity tokens must match the canonical values.",
  },
  "m3-typescale-spec-conformance": {
    severity: "warn",
    description: "Typescale size and line-height tokens must match canonical M3 values or be explicitly approved.",
  },
  "m3-shape-corner-spec": {
    severity: "error",
    description: "M3 shape corner tokens must resolve to the canonical shape scale.",
  },
  "m3-uppercase-on-button": {
    severity: "error",
    description: "Buttons and button-like selectors must not force uppercase labels.",
  },
  "m3-raw-rgba-fallback-on-role-token": {
    severity: "error",
    description: "Role tokens are required to exist; raw rgba/elevation fallbacks mask token ownership bugs.",
  },
  "m3-emphasized-binding": {
    severity: "warn",
    description: "Active nav/tab label tokens must bind to prominent typescale weights.",
  },
  "m3-public-theme-role-mapping": {
    severity: "warn",
    description: "Public theme tokens should map to M3 color roles instead of raw hex palettes.",
  },
  "m3-scrim-container-opacity": {
    severity: "error",
    description:
      "Modal scrim overlays must apply the canonical 0.32 container opacity from the M3 scrim component spec.",
  },
  "m3-easing-spec-conformance": {
    severity: "error",
    description: "Motion easing tokens must match the canonical M3 cubic-bezier values from md-sys-motion.",
  },
  "m3-surface-tint-usage": {
    severity: "warn",
    description:
      "M3 deprecated surface-tint in favour of elevation level tokens; consumers must not bind to --md-sys-color-surface-tint.",
  },
  "m3-letter-spacing-tokenization": {
    severity: "warn",
    description: "Raw letter-spacing literals should resolve through --md-sys-typescale-*-tracking tokens.",
  },
  "m3-letter-spacing-spec-conformance": {
    severity: "warn",
    description: "Typescale tracking tokens must match canonical M3 values from md-sys-typescale.",
  },
  "m3-component-elevation-spec": {
    severity: "error",
    description:
      "M3 component-elevation table requires specific level tokens per component family (FAB level3, nav-bar level2, banner level1, etc.).",
  },
  "m3-snackbar-inverse-binding": {
    severity: "warn",
    description:
      "Snackbar component tokens must bind to inverse-surface / inverse-on-surface / inverse-primary per the M3 colour-roles spec.",
  },
  "m3-outlined-text-field-outline-width": {
    severity: "warn",
    description: "Outlined text-field outline width must be 1dp resting and 2dp focused per the M3 component spec.",
  },
  "m3-logical-properties": {
    severity: "warn",
    description:
      "Physical inline-axis CSS properties (margin-left/right, padding-left/right, left/right) should use logical equivalents for RTL.",
  },
  "m3-fab-shape-spec": {
    severity: "error",
    description:
      "FAB shape tokens must morph to corner-medium (small), corner-large (default/extended), corner-extra-large (large) per the M3 FAB spec.",
  },
  "m3-navigation-bar-dimensions": {
    severity: "error",
    description:
      "Navigation bar container height (80dp) and 32x64 active indicator at corner-full must match the M3 navigation-bar spec.",
  },
  "m3-fixed-bright-dim-coverage": {
    severity: "error",
    description:
      "Add-on color roles (*-fixed, *-fixed-dim, on-*-fixed, surface-bright, surface-dim) must be declared in every theme block so they hold the correct light/dark behaviour.",
  },
  "m3-icon-size-tokens": {
    severity: "warn",
    description:
      "Icon-sized elements must use the M3 icon scale (18/20/24/40dp) or a documented --md-sys-icon-size-* / --gc-icon-size-* token.",
  },
  "m3-state-layer-coverage": {
    severity: "warn",
    description:
      "Every component family that declares container-color must also declare hover/focus/pressed state-layer slots so interaction feedback stays uniform.",
  },
  "m3-color-mix-on-role-token": {
    severity: "warn",
    description:
      "color-mix() assigned to a state-layer slot or to background on a state pseudo-selector must use a canonical M3 percentage (4/8/10/12/16/38); decorative tints/borders/shadows are exempt.",
  },
  "m3-touch-target-minimum": {
    severity: "warn",
    description:
      "Interactive selectors must reserve at least a 48dp touch target (WCAG 2.5.5 / M3 a11y) unless the selector matches a documented dense/inline exemption.",
  },
  "m3-on-color-pairing": {
    severity: "error",
    description:
      "color: var(--md-sys-color-on-X) must only appear inside a rule whose background resolves to var(--md-sys-color-X); mismatched pairs go invisible under contrast shifts.",
  },
  "m3-background-color-pairing": {
    severity: "warn",
    description:
      "A rule that sets background to an M3 container role (primary, primary-container, secondary, tertiary, error, inverse-surface) should also declare a matching on-role color; missing color leaves text contrast at the mercy of cascade inheritance. Decorative elements (dots, fills, swatches, pseudo-elements) are exempt.",
  },
  "m3-public-theme-on-color-pairing": {
    severity: "warn",
    description:
      "Public theme container tokens (--public-{cta,action,chip,...}-bg) should have a paired -text companion so the public theme stays a paint-by-numbers system.",
  },
  "m3-text-field-supporting-text-typescale": {
    severity: "warn",
    description:
      "Text-field supporting-text comp-token slots must bind to --md-sys-typescale-body-small-* so helper/error text holds the M3 typescale across all field variants.",
  },
  "m3-shape-morph-on-press": {
    severity: "warn",
    description:
      "Expressive interactive component families with a container shape should also expose a pressed-container-shape token.",
  },
  "m3-top-app-bar-container-color-spec": {
    severity: "error",
    description:
      "Top-app-bar container-color must resolve to surface (M3 spec); declaring a surface-container tier defeats the bar's inheritance contract.",
  },
  "m3-search-bar-surface-tier-spec": {
    severity: "error",
    description:
      "Search-bar container-color must resolve to surface-container-high per the M3 search-bar spec (paired with elevation level3).",
  },
  "m3-banner-container-color-spec": {
    severity: "error",
    description:
      "Banner container-color must resolve to surface-container-low per the M3 banner spec; banners should recede, not advance.",
  },
  "m3-navigation-tab-container-color-spec": {
    severity: "error",
    description:
      "Primary/secondary navigation-tab container-color must resolve to surface (M3 spec); tabs inherit from their host surface.",
  },
  "m3-navigation-tab-active-indicator-spec": {
    severity: "warn",
    description:
      "When primary/secondary navigation-tab active-indicator tokens are declared they must match the M3 spec (primary 3px, secondary 2px, color = primary, primary indicator shape = corner-full).",
  },
  "m3-plain-tooltip-container-spec": {
    severity: "error",
    description:
      "When declared, plain-tooltip container-color must resolve to inverse-surface, container-shape to corner-extra-small, and supporting-text-color to inverse-on-surface per the M3 plain-tooltip spec.",
  },
  "m3-transition-property-all": {
    severity: "warn",
    description:
      "Avoid `transition: all` and `transition-property: all`; name the properties explicitly so shape-morph/elevation transitions don't fight each other.",
  },
  "m3-switch-dimensions-spec": {
    severity: "warn",
    description:
      "When switch component tokens are declared they must match the M3 spec (track 32x52, selected handle 24px, unselected handle 16px, state-layer 40px).",
  },
  "m3-slider-dimensions-spec": {
    severity: "warn",
    description:
      "When slider component tokens are declared they must match the M3 spec (handle 20x20, active/inactive track 4px, state-layer 40px).",
  },
  "m3-divider-thickness-color-spec": {
    severity: "error",
    description:
      "When declared, divider thickness must be 1px and color must resolve to outline-variant per the M3 divider spec.",
  },
  "m3-bottom-app-bar-container-spec": {
    severity: "error",
    description:
      "When declared, bottom-app-bar container-color must be surface-container, container-elevation level2, container-height 80px, and container-shape corner-none per the M3 spec.",
  },
  "m3-badge-shape-color-spec": {
    severity: "warn",
    description:
      "When declared, badge color must resolve to error and shape to corner-full; size = 6px (small badge), large-size = 16px (large badge) per the M3 badge spec.",
  },
  "m3-reduced-motion-companion": {
    severity: "warn",
    description:
      "Files that define @keyframes or use `animation:` should include a `@media (prefers-reduced-motion: reduce)` block to honour the M3 motion-accessibility contract.",
  },
  "m3-animation-keyframes-defined": {
    severity: "error",
    description: "CSS animation names must resolve to a @keyframes definition in the scanned cascade.",
  },
  "m3-raw-hover-background-without-state-layer": {
    severity: "warn",
    description:
      ":hover declarations setting background/background-color must compose through a state-layer token (--*-hover-state-layer-color, --md-sys-color-state-hover, or color-mix on a role token at canonical %); raw background swaps break M3 state-layer composition.",
  },
  "m3-forced-colors-component-coverage": {
    severity: "warn",
    description:
      "Every declared --md-comp-<family>-container-color should have at least one rule scoped under @media (forced-colors: active) so forced-colors mode has explicit coverage.",
  },
};

const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const DECLARATION_PATTERN = /(?<![\w-])([-\w]+)\s*:\s*([^;{}]+);/g;
const CUSTOM_PROPERTY_PATTERN = /(?<![\w-])(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
const VAR_FALLBACK_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)\s*,\s*([^)]+)\)/g;
const ROLE_RGBA_FALLBACK_PATTERN =
  /var\(\s*(--md-(?:sys|comp)-[A-Za-z0-9_-]+)\s*,\s*([^)]*(?:rgba?\(|rgb\(|#[0-9a-fA-F]{3,8}|0\s+\d|none)[^)]*)\)/g;

const SURFACE_TIERS = [
  "--md-sys-color-surface-container-lowest",
  "--md-sys-color-surface-container-low",
  "--md-sys-color-surface-container",
  "--md-sys-color-surface-container-high",
  "--md-sys-color-surface-container-highest",
];

// Canonical M3 shape tiers (DESIGN.md § Shapes) plus sanctioned decoratives:
// 4px (tiny inner radius), 32px/48px (oversized media), 9999px (pill). rem values
// are normalized to px before this set is consulted, so 1.5rem (=24px) is off-scale.
const ALLOWED_RADIUS_PX = new Set([
  "0",
  "0px",
  "2px",
  "4px",
  "8px",
  "12px",
  "16px",
  "20px",
  "28px",
  "32px",
  "48px",
  "9999px",
]);
const ALLOWED_OPACITIES = new Set(["0.04", "0.08", "0.10", "0.1", "0.12", "0.16", "0.38"]);

const CANONICAL_DURATIONS = {
  short1: "50ms",
  short2: "100ms",
  short3: "150ms",
  short4: "200ms",
  medium1: "250ms",
  medium2: "300ms",
  medium3: "350ms",
  medium4: "400ms",
  long1: "450ms",
  long2: "500ms",
  long3: "550ms",
  long4: "600ms",
  "extra-long1": "700ms",
  "extra-long2": "800ms",
  "extra-long3": "900ms",
  "extra-long4": "1000ms",
};

const EXPECTED_TYPE_SCALE = {
  "--md-sys-typescale-display-large-size": "3.5625rem",
  "--md-sys-typescale-display-large-line-height": "4rem",
  "--md-sys-typescale-display-medium-size": "2.8125rem",
  "--md-sys-typescale-display-medium-line-height": "3.25rem",
  "--md-sys-typescale-display-small-size": "2.25rem",
  "--md-sys-typescale-display-small-line-height": "2.75rem",
  "--md-sys-typescale-headline-large-size": "2rem",
  "--md-sys-typescale-headline-large-line-height": "2.5rem",
  "--md-sys-typescale-headline-medium-size": "1.75rem",
  "--md-sys-typescale-headline-medium-line-height": "2.25rem",
  "--md-sys-typescale-headline-small-size": "1.5rem",
  "--md-sys-typescale-headline-small-line-height": "2rem",
  "--md-sys-typescale-title-large-size": "1.375rem",
  "--md-sys-typescale-title-large-line-height": "1.75rem",
  "--md-sys-typescale-title-medium-size": "1rem",
  "--md-sys-typescale-title-medium-line-height": "1.5rem",
  "--md-sys-typescale-title-small-size": "0.875rem",
  "--md-sys-typescale-title-small-line-height": "1.25rem",
  "--md-sys-typescale-body-large-size": "1rem",
  "--md-sys-typescale-body-large-line-height": "1.5rem",
  "--md-sys-typescale-body-medium-size": "0.875rem",
  "--md-sys-typescale-body-medium-line-height": "1.25rem",
  "--md-sys-typescale-body-small-size": "0.75rem",
  "--md-sys-typescale-body-small-line-height": "1rem",
  "--md-sys-typescale-label-large-size": "0.875rem",
  "--md-sys-typescale-label-large-line-height": "1.25rem",
  "--md-sys-typescale-label-medium-size": "0.75rem",
  "--md-sys-typescale-label-medium-line-height": "1rem",
  "--md-sys-typescale-label-small-size": "0.6875rem",
  "--md-sys-typescale-label-small-line-height": "1rem",
};

const EXPECTED_SHAPES = {
  "--md-sys-shape-corner-none": "0",
  "--md-sys-shape-corner-extra-small": "4px",
  "--md-sys-shape-corner-small": "8px",
  "--md-sys-shape-corner-medium": "12px",
  "--md-sys-shape-corner-large": "16px",
  "--md-sys-shape-corner-large-increased": "20px",
  "--md-sys-shape-corner-extra-large": "28px",
  "--md-sys-shape-corner-extra-large-increased": "32px",
  "--md-sys-shape-corner-extra-extra-large": "48px",
  "--md-sys-shape-corner-full": "9999px",
};

const EXPECTED_EASINGS = {
  "--md-sys-motion-easing-standard": "cubic-bezier(0.2, 0, 0, 1)",
  "--md-sys-motion-easing-standard-accelerate": "cubic-bezier(0.3, 0, 1, 1)",
  "--md-sys-motion-easing-standard-decelerate": "cubic-bezier(0, 0, 0, 1)",
  "--md-sys-motion-easing-emphasized": "cubic-bezier(0.2, 0, 0, 1)",
  "--md-sys-motion-easing-emphasized-accelerate": "cubic-bezier(0.3, 0, 0.8, 0.15)",
  "--md-sys-motion-easing-emphasized-decelerate": "cubic-bezier(0.05, 0.7, 0.1, 1)",
  "--md-sys-motion-easing-linear": "cubic-bezier(0, 0, 1, 1)",
};

const EXPECTED_LETTER_SPACING = {
  "--md-sys-typescale-display-large-tracking": "-0.015625rem",
  "--md-sys-typescale-display-medium-tracking": "0rem",
  "--md-sys-typescale-display-small-tracking": "0rem",
  "--md-sys-typescale-headline-large-tracking": "0rem",
  "--md-sys-typescale-headline-medium-tracking": "0rem",
  "--md-sys-typescale-headline-small-tracking": "0rem",
  "--md-sys-typescale-title-large-tracking": "0rem",
  "--md-sys-typescale-title-medium-tracking": "0.009375rem",
  "--md-sys-typescale-title-small-tracking": "0.00625rem",
  "--md-sys-typescale-body-large-tracking": "0.03125rem",
  "--md-sys-typescale-body-medium-tracking": "0.015625rem",
  "--md-sys-typescale-body-small-tracking": "0.025rem",
  "--md-sys-typescale-label-large-tracking": "0.00625rem",
  "--md-sys-typescale-label-medium-tracking": "0.03125rem",
  "--md-sys-typescale-label-small-tracking": "0.03125rem",
};

const EXPECTED_COMPONENT_ELEVATION = {
  "--md-comp-fab-primary-container-elevation": "var(--md-sys-elevation-level3)",
  "--md-comp-fab-primary-small-container-elevation": "var(--md-sys-elevation-level3)",
  "--md-comp-fab-primary-large-container-elevation": "var(--md-sys-elevation-level3)",
  "--md-comp-extended-fab-primary-container-elevation": "var(--md-sys-elevation-level3)",
  "--md-comp-navigation-bar-container-elevation": "var(--md-sys-elevation-level2)",
  "--md-comp-top-app-bar-small-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-top-app-bar-medium-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-top-app-bar-large-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-banner-container-elevation": "var(--md-sys-elevation-level1)",
  "--md-comp-sheet-bottom-container-elevation": "var(--md-sys-elevation-level1)",
  "--md-comp-search-bar-container-elevation": "var(--md-sys-elevation-level3)",
  "--md-comp-radio-button-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-segmented-button-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-linear-progress-indicator-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-slider-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-divider-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-list-container-elevation": "var(--md-sys-elevation-level0)",
  "--md-comp-badge-container-elevation": "var(--md-sys-elevation-level0)",
};

const EXPECTED_FAB_SHAPES = {
  "--md-comp-fab-primary-small-container-shape": "var(--md-sys-shape-corner-medium)",
  "--md-comp-fab-primary-container-shape": "var(--md-sys-shape-corner-large)",
  "--md-comp-fab-primary-large-container-shape": "var(--md-sys-shape-corner-extra-large)",
  "--md-comp-extended-fab-primary-container-shape": "var(--md-sys-shape-corner-large)",
};

const EXPECTED_NAV_BAR_DIMENSIONS = {
  "--md-comp-navigation-bar-container-height": "80px",
  "--md-comp-navigation-bar-active-indicator-height": "32px",
  "--md-comp-navigation-bar-active-indicator-width": "64px",
  "--md-comp-navigation-bar-active-indicator-shape": "var(--md-sys-shape-corner-full)",
};

const EXPECTED_OUTLINED_TEXT_FIELD_WIDTHS = {
  "--md-comp-outlined-text-field-outline-width": "1px",
  "--md-comp-outlined-text-field-focus-outline-width": "2px",
};

const EXPECTED_SNACKBAR_INVERSE_BINDING = {
  "--md-comp-snackbar-container-color": "var(--md-sys-color-inverse-surface)",
  "--md-comp-snackbar-supporting-text-color": "var(--md-sys-color-inverse-on-surface)",
  "--md-comp-snackbar-action-label-text-color": "var(--md-sys-color-inverse-primary)",
};

const EXPECTED_TOP_APP_BAR_CONTAINER_COLOR = {
  "--md-comp-top-app-bar-small-container-color": "var(--md-sys-color-surface)",
  "--md-comp-top-app-bar-medium-container-color": "var(--md-sys-color-surface)",
  "--md-comp-top-app-bar-large-container-color": "var(--md-sys-color-surface)",
};

const EXPECTED_SEARCH_BAR_CONTAINER_COLOR = {
  "--md-comp-search-bar-container-color": "var(--md-sys-color-surface-container-high)",
};

const EXPECTED_BANNER_CONTAINER_COLOR = {
  "--md-comp-banner-container-color": "var(--md-sys-color-surface-container-low)",
};

const EXPECTED_NAVIGATION_TAB_CONTAINER_COLOR = {
  "--md-comp-primary-navigation-tab-container-color": "var(--md-sys-color-surface)",
  "--md-comp-secondary-navigation-tab-container-color": "var(--md-sys-color-surface)",
};

const EXPECTED_NAVIGATION_TAB_ACTIVE_INDICATOR = {
  "--md-comp-primary-navigation-tab-active-indicator-color": "var(--md-sys-color-primary)",
  "--md-comp-primary-navigation-tab-active-indicator-height": "3px",
  "--md-comp-primary-navigation-tab-active-indicator-shape": "var(--md-sys-shape-corner-full)",
  "--md-comp-secondary-navigation-tab-active-indicator-color": "var(--md-sys-color-primary)",
  "--md-comp-secondary-navigation-tab-active-indicator-height": "2px",
};

const EXPECTED_PLAIN_TOOLTIP_CONTAINER = {
  "--md-comp-plain-tooltip-container-color": "var(--md-sys-color-inverse-surface)",
  "--md-comp-plain-tooltip-container-shape": "var(--md-sys-shape-corner-extra-small)",
  "--md-comp-plain-tooltip-supporting-text-color": "var(--md-sys-color-inverse-on-surface)",
};

const EXPECTED_SWITCH_DIMENSIONS = {
  "--md-comp-switch-track-height": "32px",
  "--md-comp-switch-track-width": "52px",
  "--md-comp-switch-selected-handle-height": "24px",
  "--md-comp-switch-unselected-handle-height": "16px",
  "--md-comp-switch-state-layer-size": "40px",
};

const EXPECTED_SLIDER_DIMENSIONS = {
  "--md-comp-slider-handle-height": "20px",
  "--md-comp-slider-handle-width": "20px",
  "--md-comp-slider-active-track-height": "4px",
  "--md-comp-slider-inactive-track-height": "4px",
  "--md-comp-slider-state-layer-size": "40px",
};

const EXPECTED_DIVIDER_DIMENSIONS = {
  "--md-comp-divider-thickness": "1px",
  "--md-comp-divider-color": "var(--md-sys-color-outline-variant)",
};

const EXPECTED_BOTTOM_APP_BAR_CONTAINER = {
  "--md-comp-bottom-app-bar-container-color": "var(--md-sys-color-surface-container)",
  "--md-comp-bottom-app-bar-container-elevation": "var(--md-sys-elevation-level2)",
  "--md-comp-bottom-app-bar-container-height": "80px",
  "--md-comp-bottom-app-bar-container-shape": "var(--md-sys-shape-corner-none)",
};

const EXPECTED_BADGE_DIMENSIONS = {
  "--md-comp-badge-color": "var(--md-sys-color-error)",
  "--md-comp-badge-shape": "var(--md-sys-shape-corner-full)",
  "--md-comp-badge-size": "6px",
  "--md-comp-badge-large-color": "var(--md-sys-color-error)",
  "--md-comp-badge-large-shape": "var(--md-sys-shape-corner-full)",
  "--md-comp-badge-large-size": "16px",
};

const SCRIM_MODAL_CONTEXT_PATTERN = /(modal|dialog|backdrop|scrim|overlay|sheet|drawer|menu-surface)/i;

const TRACKING_TOKEN_PATTERN =
  /var\(\s*--(?:md-sys-typescale-[\w-]*tracking|md-comp-[\w-]*tracking|gc-(?:typescale|tracking|letter-spacing)-[\w-]+)/;

const LOGICAL_PROPERTY_PATTERN =
  /^(margin|padding|border)-(left|right)(?:-color|-style|-width)?$|^(left|right|inset-left|inset-right)$/;

const FIXED_DIM_REQUIRED_TOKENS = [
  "--md-sys-color-primary-fixed",
  "--md-sys-color-primary-fixed-dim",
  "--md-sys-color-on-primary-fixed",
  "--md-sys-color-on-primary-fixed-variant",
  "--md-sys-color-secondary-fixed",
  "--md-sys-color-secondary-fixed-dim",
  "--md-sys-color-on-secondary-fixed",
  "--md-sys-color-on-secondary-fixed-variant",
  "--md-sys-color-tertiary-fixed",
  "--md-sys-color-tertiary-fixed-dim",
  "--md-sys-color-on-tertiary-fixed",
  "--md-sys-color-on-tertiary-fixed-variant",
  "--md-sys-color-surface-bright",
  "--md-sys-color-surface-dim",
];

const REQUIRED_STATE_LAYER_SLOTS = ["hover-state-layer-color", "focus-state-layer-color", "pressed-state-layer-color"];

const STATE_LAYER_CONTAINER_VARIANTS = new Set(["dragged", "focus", "hover", "pressed"]);

const ALLOWED_COLOR_MIX_PERCENTAGES = new Set(["4", "8", "10", "12", "16", "38", "32"]);

const COLOR_MIX_AUDITED_ROLES = new Set([
  "--md-sys-color-primary",
  "--md-sys-color-secondary",
  "--md-sys-color-tertiary",
  "--md-sys-color-error",
  "--md-sys-color-on-primary",
  "--md-sys-color-on-secondary",
  "--md-sys-color-on-tertiary",
  "--md-sys-color-on-error",
  "--md-sys-color-on-surface",
  "--md-sys-color-on-surface-variant",
  "--md-sys-color-on-primary-container",
  "--md-sys-color-on-secondary-container",
  "--md-sys-color-on-tertiary-container",
  "--md-sys-color-on-error-container",
  "--md-sys-color-on-background",
  "--md-sys-color-outline",
  "--md-sys-color-outline-variant",
]);

const COLOR_MIX_ROLE_PATTERN =
  /color-mix\(\s*in\s+srgb\s*,\s*var\(\s*(--md-sys-color-[a-z-]+)\s*\)\s*([\d.]+)%\s*,\s*transparent\s*\)/gi;

const TOUCH_TARGET_EXEMPT_PATTERN =
  /(?:^|[-_.[\s])(chip|tag|badge|list-row|list-item|menu-item|table-row|table-cell|table-panel|cell|row|entry-row|inline|eyebrow|overline|breadcrumb|tab|segmented|toolbar|dense|compact|hairline|count-badge|pill-toggle|dot|swatch|detail-pane|detail-panel|title-button|trigger-icon|editor)(?:[-_.\]:\s]|$)/i;

const TOUCH_TARGET_BUTTON_CONTEXT_PATTERN =
  /(?:\.gc-app-button|\.app-button|\[role=['"]?button['"]?\]|(?:^|\s)button(?:\s|:|\.|\[|,|$)|(?:^|\s)a\.[\w-]*(?:button|cta|action))/i;

const ICON_FILE_PATTERN =
  /(?:^|[\\/])(?:Icon[A-Z]\w*\.vue|[A-Z]\w*Icon\.vue|MaterialSymbol\w*\.vue|AppIcon\w*\.vue|AppMaterialSymbol\.vue)$/;

const ICON_SIZE_TOKEN_PATTERN =
  /var\(\s*--(?:md-sys-icon-size|md-comp-icon|gc-icon-size|gc-ms-icon-size|gc-app-icon-button-icon-size)[\w-]*/;

const ALLOWED_ICON_PX = new Set(["18px", "20px", "24px", "40px", "16px", "32px", "48px"]);

// Public-theme families that should follow paint-by-numbers (a -text companion
// for every -bg). Excludes families that intentionally inherit text from
// --public-text-primary (input, surface).
const PUBLIC_THEME_PAIRED_FAMILIES = ["cta", "action", "chip", "side-card"];

const EXPECTED_TEXT_FIELD_SUPPORTING_TEXT = {
  size: "var(--md-sys-typescale-body-small-size)",
  "line-height": "var(--md-sys-typescale-body-small-line-height)",
  tracking: "var(--md-sys-typescale-body-small-tracking)",
};

const EXPECTED_PRESSED_CONTAINER_SHAPES = {
  "elevated-button": "var(--md-sys-shape-corner-small)",
  "filled-button": "var(--md-sys-shape-corner-small)",
  "filled-tonal-button": "var(--md-sys-shape-corner-small)",
  "outlined-button": "var(--md-sys-shape-corner-small)",
  "text-button": "var(--md-sys-shape-corner-small)",
  "icon-button": "var(--md-sys-shape-corner-medium)",
  "filled-icon-button": "var(--md-sys-shape-corner-medium)",
  "filled-tonal-icon-button": "var(--md-sys-shape-corner-medium)",
  "outlined-icon-button": "var(--md-sys-shape-corner-medium)",
  "fab-primary": "var(--md-sys-shape-corner-small)",
  "fab-primary-small": "var(--md-sys-shape-corner-extra-small)",
  "fab-primary-large": "var(--md-sys-shape-corner-medium)",
  "extended-fab-primary": "var(--md-sys-shape-corner-small)",
  "split-button": "var(--md-sys-shape-corner-small)",
};

const EXPECTED_STATE_OPACITIES = {
  "--md-sys-state-hover-state-layer-opacity": "0.08",
  "--md-sys-state-focus-state-layer-opacity": "0.10",
  "--md-sys-state-pressed-state-layer-opacity": "0.12",
  "--md-sys-state-dragged-state-layer-opacity": "0.16",
};

const COMPONENT_FAMILIES = [
  "navigation-bar",
  "primary-navigation-tab",
  "secondary-navigation-tab",
  "filter-chip",
  "suggestion-chip",
  "assist-chip",
  "input-chip",
  "elevated-card",
  "filled-card",
  "outlined-card",
  "filled-text-field",
  "list",
  "top-app-bar-small",
  "top-app-bar-medium",
  "top-app-bar-large",
  "slider",
  "search-bar",
  "sheet-bottom",
  "divider",
  "linear-progress-indicator",
  "radio-button",
  "badge",
  "banner",
  "segmented-button",
  "fab-primary",
  "fab-primary-small",
  "fab-primary-large",
  "extended-fab-primary",
];

const REQUIRED_COMPONENT_SLOTS = [
  "container-color",
  "container-shape",
  "container-elevation",
  "label-text-font",
  "label-text-size",
  "label-text-line-height",
  "label-text-weight",
  "on-container-color",
];

export const audit = {
  id: "m3-guidelines",
  title: "M3 Guidelines",
  category: "design-system",
  defaultConfig: {
    title: "M3 Guideline Audit",
    roots: ["src"],
    extensions: [".css", ".vue", ".ts", ".tsx"],
    skipSegments: [".git", "dist", "node_modules", "tmp"],
    skipFilePatterns: ["\\.spec\\.[cm]?[tj]sx?$", "\\.test\\.[cm]?[tj]sx?$", "(?:^|/)__tests__/"],
    tokenFile: "src/styles/core/tokens.css",
    uppercaseAllowlist: [],
    opacityAllowlist: [],
    // Bespoke marketing/demo landing artwork uses intentionally off-scale shapes
    // and is exempt from the design-system radius tiers (consistent with the
    // network-demo icon/layering exemptions elsewhere in the arkitect).
    borderRadiusAllowlist: ["network-demo.css"],
    boxShadowAllowlist: [],
    maxFindingsPerRule: 1000,
  },
  async run(context) {
    const checkConfig = context.checkConfig;
    const files = await readAuditFiles(context);
    const tokenSource = await fs.readFile(path.resolve(context.root, checkConfig.tokenFile), "utf8");
    const tokenValues = parseCustomPropertyValues(tokenSource);
    const allTokenNames = collectDefinedTokens(files, tokenValues);
    const findings = [];

    auditSurfaceTiers(findings, checkConfig, tokenSource);
    auditFixedBrightDimCoverage(findings, checkConfig, tokenSource);
    auditTokenSpec(findings, checkConfig, tokenSource, tokenValues);
    auditComponentTokens(findings, checkConfig, tokenSource, tokenValues);
    auditFiles(findings, checkConfig, files, allTokenNames);

    const limitedFindings = limitFindings(findings, checkConfig.maxFindingsPerRule);
    limitedFindings.sort(
      (a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line,
    );
    const counts = countFindingsByRuleAndFile(limitedFindings);
    const regressions = findRegressions(counts, context.baseline);

    return {
      baselineDocument: buildBaselineDocument(counts),
      failed: regressions.length > 0,
      jsonPayload: { findings: limitedFindings, rules: RULES, regressions },
      outputPath: checkConfig.outputPath,
      report: renderReport({
        findings: limitedFindings,
        counts,
        regressions,
        title: checkConfig.title,
        format: context.options.format,
      }),
    };
  },
};

async function readAuditFiles(context) {
  const skipFilePatterns = (context.checkConfig.skipFilePatterns ?? []).map((pattern) => new RegExp(pattern));
  const files = (
    await walkFiles({
      root: context.root,
      roots: context.checkConfig.roots,
      extensions: context.checkConfig.extensions,
      skipSegments: context.checkConfig.skipSegments,
    })
  ).filter((filePath) => !skipFilePatterns.some((pattern) => pattern.test(filePath)));

  return Promise.all(
    files.map(async (filePath) => ({
      rel: filePath,
      source: await fs.readFile(path.resolve(context.root, filePath), "utf8"),
    })),
  );
}

function cssSourcesForFile(rel, source) {
  if (rel.endsWith(".css")) {
    return [{ css: source, offset: 0 }];
  }

  if (!rel.endsWith(".vue")) {
    return [];
  }

  const blocks = [];
  for (const match of source.matchAll(STYLE_BLOCK_PATTERN)) {
    blocks.push({
      css: match[1],
      offset: (match.index ?? 0) + match[0].indexOf(match[1]),
    });
  }
  return blocks;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function cleanSnippet(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
}

function addFinding(findings, ruleId, filePath, line, message, snippet = "") {
  findings.push({
    ruleId,
    severity: RULES[ruleId].severity,
    filePath,
    line,
    message,
    snippet: cleanSnippet(snippet),
  });
}

function parseCustomPropertyValues(source) {
  const values = new Map();
  for (const match of source.matchAll(CUSTOM_PROPERTY_PATTERN)) {
    values.set(match[1], cleanSnippet(match[2]));
  }
  return values;
}

function collectDefinedTokens(files, tokenValues) {
  const names = new Set(tokenValues.keys());
  for (const { source } of files) {
    for (const match of source.matchAll(CUSTOM_PROPERTY_PATTERN)) {
      names.add(match[1]);
    }
    // A custom property is also "defined" when it is registered via Houdini
    // `@property --x { ... }` or assigned at runtime from JS (style objects,
    // bracket assignment, setProperty) — none of which match CUSTOM_PROPERTY_PATTERN.
    for (const match of source.matchAll(/@property\s+(--[A-Za-z0-9_-]+)/g)) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/["'](--[A-Za-z0-9_-]+)["']\s*:/g)) {
      names.add(match[1]);
    }
    for (const match of source.matchAll(/(?:\.setProperty\(\s*|\[\s*)["'](--[A-Za-z0-9_-]+)["']/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function auditFixedBrightDimCoverage(findings, checkConfig, tokenSource) {
  const blocks = parseTopLevelBlocks(tokenSource);
  const lightBlocks = blocks.filter(
    (block) =>
      block.selector === ":root" ||
      (block.selector.includes(":root") && !block.selector.includes("[data-resolved-theme=")),
  );
  const darkBlocks = blocks.filter((block) => block.selector.includes('[data-resolved-theme="dark"]'));

  for (const [scheme, schemeBlocks] of [
    ["light", lightBlocks],
    ["dark", darkBlocks],
  ]) {
    if (!schemeBlocks.length) continue;
    const declared = new Set();
    for (const block of schemeBlocks) {
      for (const name of parseCustomPropertyValues(block.body).keys()) {
        declared.add(name);
      }
    }
    const firstBlock = schemeBlocks[0];
    for (const token of FIXED_DIM_REQUIRED_TOKENS) {
      if (declared.has(token)) continue;
      addFinding(
        findings,
        "m3-fixed-bright-dim-coverage",
        checkConfig.tokenFile,
        lineNumberAt(tokenSource, firstBlock.index),
        `${token} is missing from the ${scheme} theme block.`,
        `${scheme} scheme: ${token}`,
      );
    }
  }
}

function auditSurfaceTiers(findings, checkConfig, tokenSource) {
  const blocks = parseTopLevelBlocks(tokenSource);
  const lightBlock =
    blocks.find((block) => block.selector === ":root") ?? blocks.find((block) => block.selector.includes(":root"));
  const darkBlock = blocks.find((block) => block.selector.includes('[data-resolved-theme="dark"]'));
  auditSurfaceTierBlock(findings, checkConfig, tokenSource, lightBlock, "light", "decrease");
  auditSurfaceTierBlock(findings, checkConfig, tokenSource, darkBlock, "dark", "increase");
}

function parseTopLevelBlocks(source) {
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const openIndex = source.indexOf("{", cursor);
    if (openIndex === -1) break;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex === -1) break;
    const selector = source.slice(cursor, openIndex).trim();
    if (selector && !selector.startsWith("@")) {
      blocks.push({ selector, body: source.slice(openIndex + 1, closeIndex), index: cursor });
    }
    cursor = closeIndex + 1;
  }
  return blocks;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function auditSurfaceTierBlock(findings, checkConfig, tokenSource, block, scheme, direction) {
  if (!block) {
    addFinding(
      findings,
      "m3-surface-tier-monotonicity",
      checkConfig.tokenFile,
      1,
      `Could not find ${scheme} color-scheme block for surface-tier monotonicity.`,
      scheme,
    );
    return;
  }

  const values = parseCustomPropertyValues(block.body);
  const luminances = SURFACE_TIERS.map((token) => ({
    token,
    value: values.get(token),
    luminance: luminance(values.get(token)),
  }));
  for (const entry of luminances) {
    if (entry.luminance === null) {
      addFinding(
        findings,
        "m3-surface-tier-monotonicity",
        checkConfig.tokenFile,
        lineNumberAt(tokenSource, block.index + Math.max(block.body.indexOf(entry.token), 0)),
        `${entry.token} must be a hex color in the ${scheme} scheme for luminance validation.`,
        `${entry.token}: ${entry.value ?? "(missing)"}`,
      );
    }
  }

  for (let index = 1; index < luminances.length; index += 1) {
    const previous = luminances[index - 1];
    const current = luminances[index];
    if (previous.luminance === null || current.luminance === null) continue;
    const ok =
      direction === "decrease" ? current.luminance < previous.luminance : current.luminance > previous.luminance;
    if (!ok) {
      addFinding(
        findings,
        "m3-surface-tier-monotonicity",
        checkConfig.tokenFile,
        lineNumberAt(tokenSource, block.index + Math.max(block.body.indexOf(current.token), 0)),
        `${scheme} ${current.token} must be ${direction === "decrease" ? "darker" : "brighter"} than ${previous.token}.`,
        `${previous.token}: ${previous.value}; ${current.token}: ${current.value}`,
      );
    }
  }
}

function luminance(value) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hex = match[1];
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function auditTokenSpec(findings, checkConfig, tokenSource, tokenValues) {
  for (const [token, expected] of Object.entries(EXPECTED_TYPE_SCALE)) {
    const actual = tokenValues.get(token);
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-typescale-spec-conformance",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }

  for (const [token, expected] of Object.entries(EXPECTED_SHAPES)) {
    const resolved = resolveTokenValue(token, tokenValues);
    if (normalizeZero(resolved) === normalizeZero(expected)) continue;
    addTokenFinding(
      findings,
      "m3-shape-corner-spec",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to resolve to ${expected}.`,
      `${token}: ${tokenValues.get(token) ?? "(missing)"} -> ${resolved ?? "(unresolved)"}`,
    );
  }

  for (const [token, expected] of Object.entries(EXPECTED_STATE_OPACITIES)) {
    const actual = tokenValues.get(token);
    if (normalizeOpacityValue(actual) === normalizeOpacityValue(expected)) continue;
    addTokenFinding(
      findings,
      "m3-state-layer-opacity",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }

  auditLegacyColorStatePress(findings, checkConfig, tokenSource);
  auditEasingSpec(findings, checkConfig, tokenSource, tokenValues);
  auditLetterSpacingSpec(findings, checkConfig, tokenSource, tokenValues);
  auditOutlinedTextFieldWidths(findings, checkConfig, tokenSource, tokenValues);
  auditTextFieldSupportingTextTypescale(findings, checkConfig, tokenSource, tokenValues);
}

function auditEasingSpec(findings, checkConfig, tokenSource, tokenValues) {
  for (const [token, expected] of Object.entries(EXPECTED_EASINGS)) {
    const actual = tokenValues.get(token);
    if (normalizeCubicBezier(actual) === normalizeCubicBezier(expected)) continue;
    addTokenFinding(
      findings,
      "m3-easing-spec-conformance",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }
}

function normalizeTrackingValue(value) {
  if (value === undefined || value === null) return "";
  const normalized = cleanSnippet(value).toLowerCase();
  if (normalized === "0" || normalized === "0rem" || normalized === "0em" || normalized === "0px") return "0";
  return normalized;
}

function normalizeCubicBezier(value) {
  if (!value) return "";
  return cleanSnippet(value).toLowerCase().replace(/\s+/g, "");
}

function auditLetterSpacingSpec(findings, checkConfig, tokenSource, tokenValues) {
  for (const [token, expected] of Object.entries(EXPECTED_LETTER_SPACING)) {
    const actual = tokenValues.get(token);
    if (normalizeTrackingValue(actual) === normalizeTrackingValue(expected)) continue;
    addTokenFinding(
      findings,
      "m3-letter-spacing-spec-conformance",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }
}

function auditOutlinedTextFieldWidths(findings, checkConfig, tokenSource, tokenValues) {
  for (const [token, expected] of Object.entries(EXPECTED_OUTLINED_TEXT_FIELD_WIDTHS)) {
    const actual = tokenValues.get(token);
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-outlined-text-field-outline-width",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }
}

function auditLegacyColorStatePress(findings, checkConfig, tokenSource) {
  for (const block of parseTopLevelBlocks(tokenSource)) {
    if (!block.selector.includes(":root")) continue;
    const values = parseCustomPropertyValues(block.body);
    const value = values.get("--md-sys-color-state-press");
    if (!value) continue;
    const alpha = alphaFromColor(value);
    if (alpha === 0.12) continue;
    addFinding(
      findings,
      "m3-state-layer-opacity",
      checkConfig.tokenFile,
      lineNumberAt(tokenSource, block.index + Math.max(block.body.indexOf("--md-sys-color-state-press"), 0)),
      "Expected --md-sys-color-state-press alpha to be 0.12 in every scheme.",
      `--md-sys-color-state-press: ${value}`,
    );
  }
}

function addTokenFinding(findings, ruleId, checkConfig, tokenSource, token, message, snippet) {
  addFinding(
    findings,
    ruleId,
    checkConfig.tokenFile,
    lineNumberAt(tokenSource, Math.max(tokenSource.indexOf(token), 0)),
    message,
    snippet,
  );
}

function normalizeCssValue(value) {
  return cleanSnippet(value).toLowerCase();
}

function normalizeOpacityValue(value) {
  const parsed = Number(normalizeCssValue(value));
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "";
}

function normalizeZero(value) {
  const normalized = normalizeCssValue(value);
  return normalized === "0px" ? "0" : normalized;
}

function resolveTokenValue(token, values, seen = new Set()) {
  if (seen.has(token)) return null;
  seen.add(token);
  const value = values.get(token);
  if (!value) return null;
  const varMatch = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value.trim());
  if (varMatch) {
    return resolveTokenValue(varMatch[1], values, seen);
  }
  return normalizeCssValue(value);
}

function alphaFromColor(value) {
  const rgbaComma = /rgba?\([^,]+,[^,]+,[^,]+,\s*([.\d]+)\s*\)/.exec(value);
  if (rgbaComma) return Number(rgbaComma[1]);
  const rgbSlash = /rgb[a]?\([^)]+\/\s*([.\d]+)\s*\)/.exec(value);
  if (rgbSlash) return Number(rgbSlash[1]);
  return null;
}

function auditComponentTokens(findings, checkConfig, tokenSource, tokenValues) {
  for (const family of COMPONENT_FAMILIES) {
    for (const slot of REQUIRED_COMPONENT_SLOTS) {
      const token = `--md-comp-${family}-${slot}`;
      if (tokenValues.has(token)) continue;
      addTokenFinding(
        findings,
        "m3-component-token-coverage",
        checkConfig,
        tokenSource,
        "--md-comp-",
        `Missing canonical component token ${token}.`,
        token,
      );
    }
  }

  for (const [token, value] of tokenValues) {
    if (!/^--md-comp-.*outline-color$/.test(token)) continue;
    if (/divider|disabled-outline-color/.test(token) || !value.includes("--md-sys-color-outline-variant")) continue;
    addTokenFinding(
      findings,
      "m3-outline-vs-outline-variant",
      checkConfig,
      tokenSource,
      token,
      `${token} is a resting component outline and should resolve to --md-sys-color-outline.`,
      `${token}: ${value}`,
    );
  }

  const expectedCards = {
    "--md-comp-elevated-card-container-shape": "var(--md-sys-shape-corner-medium)",
    "--md-comp-filled-card-container-shape": "var(--md-sys-shape-corner-medium)",
    "--md-comp-outlined-card-container-shape": "var(--md-sys-shape-corner-medium)",
    "--md-comp-elevated-card-container-elevation": "var(--md-sys-elevation-level1)",
    "--md-comp-filled-card-container-elevation": "var(--md-sys-elevation-level0)",
    "--md-comp-outlined-card-container-elevation": "var(--md-sys-elevation-level0)",
  };
  for (const [token, expected] of Object.entries(expectedCards)) {
    const actual = tokenValues.get(token);
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-card-shape-and-elevation",
      checkConfig,
      tokenSource,
      "--md-comp-card",
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }

  const snackbarShape = tokenValues.get("--md-comp-snackbar-container-shape");
  if (normalizeCssValue(snackbarShape) !== "var(--md-sys-shape-corner-extra-small)") {
    addTokenFinding(
      findings,
      "m3-snackbar-shape",
      checkConfig,
      tokenSource,
      "--md-comp-snackbar",
      "Expected --md-comp-snackbar-container-shape to resolve through corner-extra-small.",
      `--md-comp-snackbar-container-shape: ${snackbarShape ?? "(missing)"}`,
    );
  }

  for (const [token, expected] of Object.entries(EXPECTED_COMPONENT_ELEVATION)) {
    const actual = tokenValues.get(token);
    if (actual === undefined) continue;
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-component-elevation-spec",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual}`,
    );
  }

  for (const [token, expected] of Object.entries(EXPECTED_FAB_SHAPES)) {
    const actual = tokenValues.get(token);
    if (actual === undefined) continue;
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-fab-shape-spec",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual}`,
    );
  }

  for (const [token, expected] of Object.entries(EXPECTED_NAV_BAR_DIMENSIONS)) {
    const actual = tokenValues.get(token);
    if (actual === undefined) continue;
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-navigation-bar-dimensions",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual}`,
    );
  }

  const containerColorTokens = [...tokenValues.keys()].filter((token) =>
    /^--md-comp-[a-z-]+-container-color$/.test(token),
  );
  for (const containerToken of containerColorTokens) {
    const family = containerToken.replace(/^--md-comp-/, "").replace(/-container-color$/, "");
    if (shouldSkipStateLayerCoverageFamily(family)) continue;
    for (const slot of REQUIRED_STATE_LAYER_SLOTS) {
      const slotToken = `--md-comp-${family}-${slot}`;
      if (tokenValues.has(slotToken)) continue;
      addTokenFinding(
        findings,
        "m3-state-layer-coverage",
        checkConfig,
        tokenSource,
        containerToken,
        `Missing ${slotToken} — every interactive component family with a container-color should expose hover/focus/pressed state-layer colors.`,
        slotToken,
      );
    }
  }

  for (const [token, expected] of Object.entries(EXPECTED_SNACKBAR_INVERSE_BINDING)) {
    const actual = tokenValues.get(token);
    if (actual === undefined) continue;
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      "m3-snackbar-inverse-binding",
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual}`,
    );
  }

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_TOP_APP_BAR_CONTAINER_COLOR,
    ruleId: "m3-top-app-bar-container-color-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_SEARCH_BAR_CONTAINER_COLOR,
    ruleId: "m3-search-bar-surface-tier-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_BANNER_CONTAINER_COLOR,
    ruleId: "m3-banner-container-color-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_NAVIGATION_TAB_CONTAINER_COLOR,
    ruleId: "m3-navigation-tab-container-color-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_NAVIGATION_TAB_ACTIVE_INDICATOR,
    ruleId: "m3-navigation-tab-active-indicator-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_PLAIN_TOOLTIP_CONTAINER,
    ruleId: "m3-plain-tooltip-container-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_SWITCH_DIMENSIONS,
    ruleId: "m3-switch-dimensions-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_SLIDER_DIMENSIONS,
    ruleId: "m3-slider-dimensions-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_DIVIDER_DIMENSIONS,
    ruleId: "m3-divider-thickness-color-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_BOTTOM_APP_BAR_CONTAINER,
    ruleId: "m3-bottom-app-bar-container-spec",
    silentOnUndeclared: true,
  });

  auditExpectedTokenTable(findings, checkConfig, tokenSource, tokenValues, {
    table: EXPECTED_BADGE_DIMENSIONS,
    ruleId: "m3-badge-shape-color-spec",
    silentOnUndeclared: true,
  });

  auditShapeMorphOnPress(findings, checkConfig, tokenSource, tokenValues);

  const emphasizedBindings = {
    "--md-comp-navigation-bar-active-label-text-weight": "--md-sys-typescale-label-medium-prominent-weight",
    "--md-comp-primary-navigation-tab-active-label-text-weight": "--md-sys-typescale-title-small-prominent-weight",
    "--md-comp-secondary-navigation-tab-active-label-text-weight": "--md-sys-typescale-title-small-prominent-weight",
  };
  for (const [token, expectedRef] of Object.entries(emphasizedBindings)) {
    const actual = tokenValues.get(token);
    if (actual?.includes(expectedRef)) continue;
    addTokenFinding(
      findings,
      "m3-emphasized-binding",
      checkConfig,
      tokenSource,
      "--md-comp-",
      `Expected ${token} to reference ${expectedRef}.`,
      `${token}: ${actual ?? "(missing)"}`,
    );
  }
}

function auditExpectedTokenTable(
  findings,
  checkConfig,
  tokenSource,
  tokenValues,
  { table, ruleId, silentOnUndeclared },
) {
  for (const [token, expected] of Object.entries(table)) {
    const actual = tokenValues.get(token);
    if (actual === undefined) {
      if (silentOnUndeclared) continue;
      addTokenFinding(
        findings,
        ruleId,
        checkConfig,
        tokenSource,
        "--md-comp-",
        `Missing ${token}; expected ${expected}.`,
        `${token}: (missing)`,
      );
      continue;
    }
    if (normalizeCssValue(actual) === expected) continue;
    addTokenFinding(
      findings,
      ruleId,
      checkConfig,
      tokenSource,
      token,
      `Expected ${token} to be ${expected}.`,
      `${token}: ${actual}`,
    );
  }
}

function auditShapeMorphOnPress(findings, checkConfig, tokenSource, tokenValues) {
  for (const [family, expected] of Object.entries(EXPECTED_PRESSED_CONTAINER_SHAPES)) {
    const containerToken = `--md-comp-${family}-container-shape`;
    if (!tokenValues.has(containerToken)) continue;

    const pressedToken = `--md-comp-${family}-pressed-container-shape`;
    const actual = tokenValues.get(pressedToken);
    if (normalizeCssValue(actual) === expected) continue;

    addTokenFinding(
      findings,
      "m3-shape-morph-on-press",
      checkConfig,
      tokenSource,
      containerToken,
      `Expected ${pressedToken} to be ${expected} when ${containerToken} is declared.`,
      `${pressedToken}: ${actual ?? "(missing)"}`,
    );
  }
}

function shouldSkipStateLayerCoverageFamily(family) {
  if (/-fixed$|-disabled$|^divider$|^scrim$/.test(family)) return true;
  const segments = family.split("-");
  const lastSegment = segments.at(-1);
  if (lastSegment === "on") return true;
  return STATE_LAYER_CONTAINER_VARIANTS.has(lastSegment);
}

function auditFiles(findings, checkConfig, files, allTokenNames) {
  const uppercaseAllowlist = patterns(checkConfig.uppercaseAllowlist);
  const opacityAllowlist = patterns(checkConfig.opacityAllowlist);
  const radiusAllowlist = patterns(checkConfig.borderRadiusAllowlist);
  const boxShadowAllowlist = patterns(checkConfig.boxShadowAllowlist);

  for (const file of files) {
    auditTokenFallbacks(findings, file, allTokenNames);
    auditJsRadiusValues(findings, file);
    for (const block of cssSourcesForFile(file.rel, file.source)) {
      for (const match of block.css.matchAll(DECLARATION_PATTERN)) {
        const prop = match[1].trim().toLowerCase();
        const value = match[2].trim();
        const offset = block.offset + (match.index ?? 0);
        const line = lineNumberAt(file.source, offset);
        const snippet = `${prop}: ${value}`;
        const locationKey = `${file.rel}:${line}:${snippet}`;

        if (prop === "text-transform" && /\buppercase\b/i.test(value) && !matchesAny(uppercaseAllowlist, locationKey)) {
          const buttonLike = isButtonLikeContext(block.css, match.index ?? 0);
          const ruleStart = block.css.lastIndexOf("{", match.index ?? 0);
          const ruleEnd = block.css.indexOf("}", match.index ?? 0);
          const ruleBody = ruleStart >= 0 && ruleEnd > ruleStart ? block.css.slice(ruleStart, ruleEnd) : "";
          // The M3 eyebrow/overline label treatment — uppercase paired with an increased
          // tracking token — is a deliberate, accepted pattern, not the accidental
          // uppercase this rule targets; a self-describing `uppercase` utility class is
          // likewise intentional. Buttons must never force uppercase, so are never exempt.
          const isIntentionalLabel =
            !buttonLike &&
            (/letter-spacing\s*:\s*var\(\s*--(?:gc-tracking|md-sys-typescale)-/.test(ruleBody) ||
              /uppercase/i.test(selectorBefore(block.css, match.index ?? 0)));
          if (!isIntentionalLabel) {
            addFinding(
              findings,
              "m3-text-transform-uppercase",
              file.rel,
              line,
              "Uppercase text-transform should be replaced with a typescale/weight treatment or an explicit allowlist.",
              snippet,
            );
            if (buttonLike) {
              addFinding(
                findings,
                "m3-uppercase-on-button",
                file.rel,
                line,
                "Button-like selector forces uppercase labels.",
                selectorBefore(block.css, match.index ?? 0),
              );
            }
          }
        }

        if (prop === "border-radius" && !matchesAny(radiusAllowlist, locationKey)) {
          auditBorderRadiusDeclaration(findings, file, line, value, snippet);
        }

        // Radius custom-prop DEFINITIONS (e.g. `--public-input-control-radius: 1.5rem`)
        // are the other half of the original drift: a raw value laundered through a
        // non-token var and consumed via `border-radius: var(--…)`, which the line
        // above can't see. The token file legitimately defines raw tier values, so it
        // is the one place exempt from this check.
        if (
          /^--[a-z0-9-]*radius[a-z0-9-]*$/i.test(prop) &&
          !file.rel.replaceAll("\\", "/").endsWith(checkConfig.tokenFile) &&
          !matchesAny(radiusAllowlist, locationKey)
        ) {
          auditBorderRadiusDeclaration(findings, file, line, value, snippet);
        }

        if (prop === "opacity" && !matchesAny(opacityAllowlist, locationKey)) {
          auditOpacityDeclaration(findings, file, line, value, snippet, selectorBefore(block.css, match.index ?? 0));
        }

        if (prop === "box-shadow" && !matchesAny(boxShadowAllowlist, locationKey)) {
          auditBoxShadowDeclaration(findings, file, line, value, snippet);
        }

        if (prop === "letter-spacing") {
          auditLetterSpacingDeclaration(findings, file, line, value, snippet);
        }

        if (prop === "transition" || prop === "transition-property") {
          auditTransitionPropertyAll(findings, file, line, prop, value, snippet);
        }

        if (LOGICAL_PROPERTY_PATTERN.test(prop)) {
          auditLogicalPropertyDeclaration(findings, file, line, prop, snippet, block.css, match.index ?? 0);
        }

        auditScrimOpacityDeclaration(findings, file, line, prop, value, snippet, block.css, match.index ?? 0);
        auditMotionFallbackDeclaration(findings, file, line, value, snippet);
        auditColorMixOnRoleToken(findings, file, line, prop, value, snippet, block.css, match.index ?? 0);

        if (ICON_FILE_PATTERN.test(file.rel) && (prop === "width" || prop === "height" || prop === "font-size")) {
          auditIconSizeDeclaration(findings, file, line, prop, value, snippet);
        }

        if (prop === "min-height" || prop === "height" || prop === "min-width" || prop === "width") {
          auditTouchTargetDeclaration(findings, file, line, prop, value, snippet, block.css, match.index ?? 0);
        }
      }
      auditOnColorPairingInBlock(findings, file, block);
      auditBackgroundColorPairingInBlock(findings, file, block);
    }

    auditPublicThemeTokens(findings, file);
    auditPublicThemeOnColorPairing(findings, file);
    auditSnackbarConsumers(findings, file);
    auditSurfaceTintUsage(findings, file);
    auditReducedMotionCompanion(findings, file);
    auditRawHoverBackgroundWithoutStateLayer(findings, file);
  }

  auditAnimationKeyframesDefined(findings, files);
  auditForcedColorsCoverage(findings, checkConfig, files, allTokenNames);
}

const FORCED_COLORS_REQUIRED_FAMILY_SELECTORS = {
  button: /\.gc-app-button|\[role=['"]?button['"]?\]|(?:^|\s)button\b/i,
  "icon-button": /\.gc-app-icon-button|\.app-icon-button/i,
  fab: /\.gc-app-fab|\bfab\b/i,
  checkbox: /\.gc-app-checkbox|\bcheckbox\b/i,
  switch: /\.gc-app-switch|\bswitch\b/i,
  "radio-button": /\.gc-app-radio|\bradio\b/i,
  card: /\.gc-app-card|\bcard\b/i,
  menu: /\.gc-app-menu|\bmenu\b/i,
  list: /\.gc-app-list|\blist\b/i,
  tooltip: /\.gc-tooltip|\btooltip\b/i,
};

function auditForcedColorsCoverage(findings, checkConfig, files, allTokenNames) {
  const forcedColorsFile = files.find((file) => /styles[\\/]core[\\/]forced-colors\.css$/.test(file.rel));
  if (!forcedColorsFile) {
    addFinding(
      findings,
      "m3-forced-colors-component-coverage",
      "src/styles/core/forced-colors.css",
      1,
      "Missing forced-colors.css coverage file; every declared --md-comp-* family needs forced-colors fallbacks.",
      "(missing file)",
    );
    return;
  }

  if (!/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/.test(forcedColorsFile.source)) {
    addFinding(
      findings,
      "m3-forced-colors-component-coverage",
      forcedColorsFile.rel,
      1,
      "forced-colors.css is present but contains no `@media (forced-colors: active)` block.",
      "(no @media (forced-colors: active))",
    );
    return;
  }

  for (const [family, selectorPattern] of Object.entries(FORCED_COLORS_REQUIRED_FAMILY_SELECTORS)) {
    const containerToken = `--md-comp-${family}-container-color`;
    if (!allTokenNames.has(containerToken)) continue;
    if (selectorPattern.test(forcedColorsFile.source)) continue;
    addFinding(
      findings,
      "m3-forced-colors-component-coverage",
      forcedColorsFile.rel,
      lineNumberAt(forcedColorsFile.source, forcedColorsFile.source.indexOf("@media") || 0) + 1,
      `Declared comp family \`${family}\` (token ${containerToken}) has no matching selector inside @media (forced-colors: active).`,
      family,
    );
  }
}

function auditColorMixOnRoleToken(findings, file, line, prop, value, snippet, css, declarationIndex) {
  // Narrow scope: only flag color-mix-on-role usages that are SHAPED like
  // state-layer overlays — assignment to a *-state-layer-* custom property
  // OR a background declaration inside a state pseudo-class. Decorative
  // borders, shadows, glows, and tints can legitimately use any percentage.
  const isStateLayerToken = /^--[a-z][\w-]*state-layer[\w-]*$/i.test(prop);
  const inStatePseudo = isInStatePseudoSelector(css, declarationIndex);
  const isBackgroundProp = prop === "background" || prop === "background-color";
  if (!isStateLayerToken && !(inStatePseudo && isBackgroundProp)) return;

  for (const match of value.matchAll(COLOR_MIX_ROLE_PATTERN)) {
    const role = match[1];
    const pct = match[2];
    if (!COLOR_MIX_AUDITED_ROLES.has(role)) continue;
    const normalized = pct.replace(/\.?0+$/, "");
    if (ALLOWED_COLOR_MIX_PERCENTAGES.has(normalized) || ALLOWED_COLOR_MIX_PERCENTAGES.has(pct)) continue;
    addFinding(
      findings,
      "m3-color-mix-on-role-token",
      file.rel,
      line,
      `state-layer color-mix(${role} ${pct}%) is not a canonical M3 percentage; use 4/8/10/12/16/38 or a documented project state-layer token.`,
      snippet,
    );
  }
}

function isInStatePseudoSelector(css, declarationIndex) {
  const selector = selectorBefore(css, declarationIndex);
  return /:hover|:focus(?:-visible|-within)?|:active|\[aria-pressed=['"]?true['"]?\]|\[data-pressed=['"]?true['"]?\]|\[data-state=['"]?(?:hover|focus|pressed|active)['"]?\]/i.test(
    selector,
  );
}

function auditIconSizeDeclaration(findings, file, line, prop, value, snippet) {
  if (ICON_SIZE_TOKEN_PATTERN.test(value)) return;
  // Typescale tokens are spec-conformant for `font-size` — letter-style icon
  // components (e.g. AppCircleIcon) intentionally bind to the typescale.
  if (/var\(\s*--md-sys-typescale-[\w-]+-size/.test(value)) return;
  if (/^(?:inherit|initial|unset|revert|auto|0)$/i.test(value.trim())) return;
  const pxMatch = value.match(/^([\d.]+)px$/);
  if (pxMatch && ALLOWED_ICON_PX.has(`${pxMatch[1]}px`)) return;
  if (/^[\d.]+(?:rem|em)$/i.test(value.trim())) return;
  addFinding(
    findings,
    "m3-icon-size-tokens",
    file.rel,
    line,
    `${prop} ${value} is not in the M3 icon scale (18/20/24/40dp); resolve through --md-sys-icon-size-* / --gc-ms-icon-size.`,
    snippet,
  );
}

function auditTouchTargetDeclaration(findings, file, line, prop, value, snippet, css, declarationIndex) {
  const selector = selectorBefore(css, declarationIndex);
  if (!TOUCH_TARGET_BUTTON_CONTEXT_PATTERN.test(selector)) return;
  if (TOUCH_TARGET_EXEMPT_PATTERN.test(selector)) return;
  if (TOUCH_TARGET_EXEMPT_PATTERN.test(file.rel)) return;
  const pxMatch = value.match(/^([\d.]+)px$/);
  if (!pxMatch) return;
  const pixels = Number(pxMatch[1]);
  if (pixels >= 48) return;
  if (pixels === 0) return;
  addFinding(
    findings,
    "m3-touch-target-minimum",
    file.rel,
    line,
    `${prop}: ${value} on a button-like selector — interactive touch targets should be at least 48dp (WCAG 2.5.5).`,
    `${selector} { ${snippet} }`,
  );
}

const ON_COLOR_DECLARATION_PATTERN = /(?:^|;|\{)\s*color\s*:\s*var\(\s*(--md-sys-color-on-[a-z-]+)(?:\s*,[^)]*)?\)/gi;
const BACKGROUND_ROLE_PATTERN =
  /(?:background|background-color)\s*:\s*[^;]*var\(\s*(--md-sys-color-[a-z-]+)(?:\s*,[^)]*)?\)/gi;

function auditOnColorPairingInBlock(findings, file, block) {
  const rules = parseTopLevelBlocks(block.css);
  for (const rule of rules) {
    auditRuleOnColorPairing(findings, file, block, rule);
    // Recurse into nested rules (e.g. inside @media, @layer, @container).
    const nested = parseTopLevelBlocks(rule.body);
    for (const inner of nested) {
      auditRuleOnColorPairing(findings, file, block, inner, rule.index);
    }
  }
}

// Container roles that demand a matching on-role color when used as background.
const CONTAINER_ROLES_NEEDING_ON_COLOR = new Set([
  "--md-sys-color-primary",
  "--md-sys-color-primary-container",
  "--md-sys-color-secondary",
  "--md-sys-color-secondary-container",
  "--md-sys-color-tertiary",
  "--md-sys-color-tertiary-container",
  "--md-sys-color-error",
  "--md-sys-color-error-container",
  "--md-sys-color-inverse-surface",
]);

const ON_ROLE_FROM_CONTAINER = {
  "--md-sys-color-primary": "--md-sys-color-on-primary",
  "--md-sys-color-primary-container": "--md-sys-color-on-primary-container",
  "--md-sys-color-secondary": "--md-sys-color-on-secondary",
  "--md-sys-color-secondary-container": "--md-sys-color-on-secondary-container",
  "--md-sys-color-tertiary": "--md-sys-color-on-tertiary",
  "--md-sys-color-tertiary-container": "--md-sys-color-on-tertiary-container",
  "--md-sys-color-error": "--md-sys-color-on-error",
  "--md-sys-color-error-container": "--md-sys-color-on-error-container",
  "--md-sys-color-inverse-surface": "--md-sys-color-inverse-on-surface",
};

// Selectors for purely decorative elements that don't need text color pairing.
const DECORATIVE_ONLY_SELECTOR_PATTERN =
  /__dot|__swatch|__fill|__glyph|__accent|__check|__state-layer|__progress-fill|__day-dot|__image-drop-line|__caption-dot|__track-wrap|__indicator|__ribbon|--drop-before|--drop-after|harness-color-swatch|motion-review-dot|motion-token-marker|map-current-location__(?:ring|pulse)|map-cluster-pin__count|gc-time-picker__(?:center|pointer)|seo-social-card__accent|sms-char-bar-fill|sms-preview-phone|seo-og-image|welcome-page__progress-fill|phantom-graph__caption-dot|pricing-plan__ribbon/;

function isColorMixBackground(matchText) {
  return /color-mix\(\s*in\s+srgb\s*,/.test(matchText);
}

function auditBackgroundColorPairingInBlock(findings, file, block) {
  const rules = parseTopLevelBlocks(block.css);
  for (const rule of rules) {
    auditRuleBackgroundColorPairing(findings, file, block, rule);
    const nested = parseTopLevelBlocks(rule.body);
    for (const inner of nested) {
      auditRuleBackgroundColorPairing(findings, file, block, inner, rule.index);
    }
  }
}

function auditRuleBackgroundColorPairing(findings, file, block, rule, parentOffset = 0) {
  const bgMatches = [...rule.body.matchAll(BACKGROUND_ROLE_PATTERN)];
  if (!bgMatches.length) return;

  const solidBgMatches = bgMatches.filter((m) => !isColorMixBackground(m[0]));
  if (!solidBgMatches.length) return;

  const containerRoles = solidBgMatches.map((m) => m[1]).filter((role) => CONTAINER_ROLES_NEEDING_ON_COLOR.has(role));
  if (!containerRoles.length) return;

  const selector = rule.selector;
  if (DECORATIVE_ONLY_SELECTOR_PATTERN.test(selector)) return;
  // Pseudo-elements and interaction-state rules don't own the element's text — they
  // re-tint a surface whose resting text color is paired on the base rule. Skip them.
  if (/::(?:before|after|placeholder)|:hover|:focus|:active/.test(selector)) return;

  const colorDeclarations = [...rule.body.matchAll(/(?:^|;|\{)\s*color\s*:\s*([^;]+)/gi)].map((m) => m[1].trim());

  // A rule that explicitly sets a text color has made a deliberate pairing decision
  // (e.g. an intentional brand-accent color on a container surface). This rule targets
  // the MISSING-pairing case where the cascade may supply a mismatched text color — not
  // deliberate overrides — so an explicit non-inherited color is accepted.
  const hasExplicitColor = colorDeclarations.some((value) => value && value !== "inherit" && value !== "currentColor");
  if (hasExplicitColor) return;

  for (const containerRole of containerRoles) {
    const expectedOnRole = ON_ROLE_FROM_CONTAINER[containerRole];
    if (!expectedOnRole) continue;

    const hasMatchingColor = colorDeclarations.some((value) => value.includes(expectedOnRole));
    if (hasMatchingColor) continue;

    const hasInheritColor = colorDeclarations.some((value) => value === "inherit" || value === "currentColor");

    const declarationOffset =
      block.offset + parentOffset + rule.index + (bgMatches.find((m) => m[1] === containerRole)?.index ?? 0);
    const line = lineNumberAt(file.source, declarationOffset);
    const snippet = `${selector} { background: var(${containerRole}) … }`;

    if (hasInheritColor) {
      addFinding(
        findings,
        "m3-background-color-pairing",
        file.rel,
        line,
        `background resolves to ${containerRole} but color is set to inherit/currentColor — cascade may supply a mismatched text color. Declare color: var(${expectedOnRole}) explicitly.`,
        snippet,
      );
    } else {
      addFinding(
        findings,
        "m3-background-color-pairing",
        file.rel,
        line,
        `background resolves to ${containerRole} but no color declaration found. Add color: var(${expectedOnRole}) to the same rule block.`,
        snippet,
      );
    }
  }
}

// Collect every --md-sys-color-* role referenced in a rule's background
// declarations. BACKGROUND_ROLE_PATTERN captures only one (greedy-last) role per
// declaration, which mispaints color-mix() backgrounds — `color-mix(… tertiary-container 58%,
// surface 42%)` would resolve to just `surface` and falsely fail on-tertiary-container text.
function backgroundRolesIn(ruleBody) {
  const roles = [];
  for (const decl of ruleBody.matchAll(/(?:^|;|\{)\s*(?:background|background-color)\s*:\s*([^;]*)/gi)) {
    for (const ref of decl[1].matchAll(/var\(\s*(--md-sys-color-[a-z-]+)/gi)) {
      roles.push(ref[1]);
    }
  }
  return roles;
}

function auditRuleOnColorPairing(findings, file, block, rule, parentOffset = 0) {
  const onColorMatches = [...rule.body.matchAll(ON_COLOR_DECLARATION_PATTERN)];
  if (!onColorMatches.length) return;
  const bgRoles = backgroundRolesIn(rule.body);
  if (!bgRoles.length) return;

  for (const match of onColorMatches) {
    const onRole = match[1];
    if (isValidOnColorPairing(onRole, bgRoles)) continue;
    const expected = `--md-sys-color-${onRole.replace(/^--md-sys-color-on-/, "")}`;
    const declarationOffset = block.offset + parentOffset + rule.index + (match.index ?? 0);
    const line = lineNumberAt(file.source, declarationOffset);
    addFinding(
      findings,
      "m3-on-color-pairing",
      file.rel,
      line,
      `color: var(${onRole}) but background resolves to ${bgRoles.join(", ")} (expected ${expected} or a compatible role).`,
      `${rule.selector} { color: var(${onRole}) … background → ${bgRoles.join(", ")} }`,
    );
  }
}

const SURFACE_TIER_ROLES = new Set([
  "--md-sys-color-surface",
  "--md-sys-color-surface-dim",
  "--md-sys-color-surface-bright",
  "--md-sys-color-surface-container-lowest",
  "--md-sys-color-surface-container-low",
  "--md-sys-color-surface-container",
  "--md-sys-color-surface-container-high",
  "--md-sys-color-surface-container-highest",
  "--md-sys-color-surface-variant",
  "--md-sys-color-background",
  "--md-sys-color-surface-tint",
]);

const PRIMARY_FIXED_PAIR = new Set(["--md-sys-color-primary-fixed", "--md-sys-color-primary-fixed-dim"]);
const SECONDARY_FIXED_PAIR = new Set(["--md-sys-color-secondary-fixed", "--md-sys-color-secondary-fixed-dim"]);
const TERTIARY_FIXED_PAIR = new Set(["--md-sys-color-tertiary-fixed", "--md-sys-color-tertiary-fixed-dim"]);

function isValidOnColorPairing(onRole, bgRoles) {
  // on-surface and on-surface-variant validly pair with any surface-tier token
  // per the M3 color-roles spec ("text against any surface or surface container").
  if (onRole === "--md-sys-color-on-surface" || onRole === "--md-sys-color-on-surface-variant") {
    return bgRoles.some((bg) => SURFACE_TIER_ROLES.has(bg));
  }
  // inverse-on-surface pairs with inverse-surface.
  if (onRole === "--md-sys-color-inverse-on-surface") {
    return bgRoles.includes("--md-sys-color-inverse-surface");
  }
  // Fixed-variant on-roles pair with either the base or the -dim sibling.
  if (onRole === "--md-sys-color-on-primary-fixed" || onRole === "--md-sys-color-on-primary-fixed-variant") {
    return bgRoles.some((bg) => PRIMARY_FIXED_PAIR.has(bg));
  }
  if (onRole === "--md-sys-color-on-secondary-fixed" || onRole === "--md-sys-color-on-secondary-fixed-variant") {
    return bgRoles.some((bg) => SECONDARY_FIXED_PAIR.has(bg));
  }
  if (onRole === "--md-sys-color-on-tertiary-fixed" || onRole === "--md-sys-color-on-tertiary-fixed-variant") {
    return bgRoles.some((bg) => TERTIARY_FIXED_PAIR.has(bg));
  }
  // surface-tint is the M3 elevation tint — any on-role over it inherits from the underlying surface.
  if (bgRoles.includes("--md-sys-color-surface-tint")) return true;
  // Strict pairing: on-X validates against X exactly.
  const expected = `--md-sys-color-${onRole.replace(/^--md-sys-color-on-/, "")}`;
  return bgRoles.includes(expected);
}

function auditLetterSpacingDeclaration(findings, file, line, value, snippet) {
  if (TRACKING_TOKEN_PATTERN.test(value)) return;
  if (/^(?:normal|inherit|initial|unset|revert)$/i.test(value.trim())) return;
  addFinding(
    findings,
    "m3-letter-spacing-tokenization",
    file.rel,
    line,
    "letter-spacing should resolve through a typescale tracking token instead of a raw literal.",
    snippet,
  );
}

function auditTransitionPropertyAll(findings, file, line, prop, value, snippet) {
  // Match either `transition-property: all` or `transition: all <duration>...`
  // (the property-list `all` token as a standalone word, not embedded in
  // identifiers like `palette-all` or `--all-things`).
  if (!/(?<![\w-])all(?![\w-])/i.test(value)) return;
  addFinding(
    findings,
    "m3-transition-property-all",
    file.rel,
    line,
    `${prop}: all triggers layout work on every animatable property — name the properties explicitly so shape-morph and elevation transitions don't fight each other.`,
    snippet,
  );
}

function auditLogicalPropertyDeclaration(findings, file, line, prop, snippet, css, declarationIndex) {
  const selector = selectorBefore(css, declarationIndex);
  if (/:dir\(/.test(selector) || /\[dir=/.test(selector)) return;
  addFinding(
    findings,
    "m3-logical-properties",
    file.rel,
    line,
    `${prop} is a physical property; use the logical inline-axis equivalent (e.g. margin-inline-start, inset-inline-start) for RTL support.`,
    snippet,
  );
}

function auditScrimOpacityDeclaration(findings, file, line, prop, value, snippet, css, declarationIndex) {
  if (prop !== "background" && prop !== "background-color") return;
  if (/linear-gradient|radial-gradient|conic-gradient/.test(value)) return;
  const selector = selectorBefore(css, declarationIndex);
  const context = `${file.rel} ${selector}`;
  if (!SCRIM_MODAL_CONTEXT_PATTERN.test(context)) return;

  const colorMixMatch = value.match(
    /^color-mix\(\s*in\s+srgb\s*,\s*var\(\s*--md-sys-color-scrim\s*\)\s*([\d.]+)%\s*,\s*transparent\s*\)\s*$/i,
  );
  if (colorMixMatch) {
    const pct = Number(colorMixMatch[1]);
    if (pct !== 32) {
      addFinding(
        findings,
        "m3-scrim-container-opacity",
        file.rel,
        line,
        `Modal scrim opacity is ${pct}% but the M3 spec requires 32%.`,
        snippet,
      );
    }
    return;
  }

  const rgbaMatch = value.match(/^rgba?\(\s*0\s*,?\s*0\s*,?\s*0\s*[,/]\s*([\d.]+)\s*\)\s*$/);
  if (rgbaMatch) {
    const alpha = Number(rgbaMatch[1]);
    if (Math.abs(alpha - 0.32) > 0.001) {
      addFinding(
        findings,
        "m3-scrim-container-opacity",
        file.rel,
        line,
        `Modal scrim alpha is ${alpha} but the M3 spec requires 0.32.`,
        snippet,
      );
    }
  }
}

function auditPublicThemeOnColorPairing(findings, file) {
  if (!/public-theme|hosted|public/.test(file.rel)) return;
  for (const block of parseTopLevelBlocks(file.source)) {
    if (!/\.public-theme|\.hosted-page|--public-|\bpublic\b/.test(block.selector)) continue;
    const tokens = parseCustomPropertyValues(block.body);
    const declared = new Set(tokens.keys());
    for (const family of PUBLIC_THEME_PAIRED_FAMILIES) {
      const bgToken = `--public-${family}-bg`;
      const textToken = `--public-${family}-text`;
      if (declared.has(bgToken) && !declared.has(textToken)) {
        const offset = block.index + Math.max(block.body.indexOf(bgToken), 0);
        addFinding(
          findings,
          "m3-public-theme-on-color-pairing",
          file.rel,
          lineNumberAt(file.source, offset),
          `${bgToken} is declared but ${textToken} is missing — public theme should be paint-by-numbers.`,
          `${block.selector.split(",")[0].trim()} { ${bgToken} → no ${textToken} }`,
        );
      }
    }
  }
}

function auditTextFieldSupportingTextTypescale(findings, checkConfig, tokenSource, tokenValues) {
  const families = new Set();
  for (const token of tokenValues.keys()) {
    const match = token.match(/^--md-comp-([a-z-]+text-field)-supporting-text-(size|line-height|tracking)$/);
    if (match) families.add(match[1]);
  }
  for (const family of families) {
    for (const [slot, expected] of Object.entries(EXPECTED_TEXT_FIELD_SUPPORTING_TEXT)) {
      const token = `--md-comp-${family}-supporting-text-${slot}`;
      const actual = tokenValues.get(token);
      if (actual === undefined) continue;
      if (normalizeCssValue(actual) === expected) continue;
      addTokenFinding(
        findings,
        "m3-text-field-supporting-text-typescale",
        checkConfig,
        tokenSource,
        token,
        `Expected ${token} to resolve through ${expected}.`,
        `${token}: ${actual}`,
      );
    }
  }
}

const KEYFRAMES_OR_ANIMATION_PATTERN = /@keyframes\s+[\w-]+|(?<![\w-])animation\s*:\s*(?!none\b)[^;{}]+;/;
const KEYFRAMES_NAME_PATTERN = /@(?:-[a-z]+-)?keyframes\s+([_a-zA-Z][\w-]*)/g;
const ANIMATION_CONTROL_KEYWORDS = new Set([
  "alternate",
  "alternate-reverse",
  "backwards",
  "both",
  "ease",
  "ease-in",
  "ease-in-out",
  "ease-out",
  "forwards",
  "infinite",
  "inherit",
  "initial",
  "linear",
  "none",
  "normal",
  "paused",
  "revert",
  "revert-layer",
  "reverse",
  "running",
  "step-end",
  "step-start",
  "unset",
]);
const REDUCED_MOTION_PATTERN = /@media\s*(?:[^{]*\band\s+)?\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;
const REDUCED_MOTION_OPT_OUT_MARKER = /\/\*\s*audit:motion-reduce-handled-elsewhere\s*\*\//;

const HOVER_BACKGROUND_RULE_PATTERN = /([^{}]*:hover[^{}]*)\{([^{}]*?)\}/g;
const STATE_LAYER_TOKEN_VAR_PATTERN = /var\(\s*--[\w-]*(?:hover-state-layer|state-hover|state-layer)[\w-]*/i;
const HOVER_BACKGROUND_BACKGROUND_PROP_PATTERN = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+?)(?=;|$)/g;
const HOVER_BACKGROUND_OPT_OUT_MARKER = /\/\*\s*audit:hover-background-intentional\s*\*\//;

function auditReducedMotionCompanion(findings, file) {
  if (REDUCED_MOTION_OPT_OUT_MARKER.test(file.source)) return;
  if (!KEYFRAMES_OR_ANIMATION_PATTERN.test(file.source)) return;
  if (REDUCED_MOTION_PATTERN.test(file.source)) return;

  // Locate first animation-relevant declaration so the finding has a useful line.
  const match = /@keyframes\s+[\w-]+|(?<![\w-])animation\s*:\s*(?!none\b)[^;{}]+;/.exec(file.source);
  const line = match ? lineNumberAt(file.source, match.index ?? 0) : 1;
  const snippet = match ? cleanSnippet(match[0]) : "";

  addFinding(
    findings,
    "m3-reduced-motion-companion",
    file.rel,
    line,
    "File declares animations but has no `@media (prefers-reduced-motion: reduce)` block; add a reduced-motion override or an `audit:motion-reduce-handled-elsewhere` marker.",
    snippet,
  );
}

function auditAnimationKeyframesDefined(findings, files) {
  const keyframes = new Set();
  const references = [];

  for (const file of files) {
    for (const block of cssSourcesForFile(file.rel, file.source)) {
      for (const match of block.css.matchAll(KEYFRAMES_NAME_PATTERN)) {
        keyframes.add(match[1]);
      }

      for (const match of block.css.matchAll(DECLARATION_PATTERN)) {
        const prop = match[1].trim().toLowerCase();
        if (prop !== "animation" && prop !== "animation-name") continue;

        const value = match[2].trim();
        for (const name of extractAnimationNames(prop, value)) {
          references.push({
            file,
            line: lineNumberAt(file.source, block.offset + (match.index ?? 0)),
            name,
            snippet: `${prop}: ${value}`,
          });
        }
      }
    }
  }

  for (const reference of references) {
    if (keyframes.has(reference.name)) continue;
    addFinding(
      findings,
      "m3-animation-keyframes-defined",
      reference.file.rel,
      reference.line,
      `Animation "${reference.name}" is referenced but no matching @keyframes was found in the scanned cascade.`,
      reference.snippet,
    );
  }
}

function extractAnimationNames(prop, value) {
  const segments = splitCssList(value);
  const names = [];

  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;

    if (prop === "animation-name") {
      const name = normalizeAnimationName(trimmedSegment);
      if (name) names.push(name);
      continue;
    }

    const tokens = tokenizeCssValue(trimmedSegment);
    const name = tokens.map(normalizeAnimationName).find(Boolean);
    if (name) names.push(name);
  }

  return names;
}

function splitCssList(value) {
  const segments = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }

  segments.push(value.slice(start));
  return segments;
}

function tokenizeCssValue(value) {
  const tokens = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (/\s/.test(char) && depth === 0) {
      if (start < index) tokens.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (start < value.length) tokens.push(value.slice(start));
  return tokens;
}

function normalizeAnimationName(token) {
  const value = token.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (ANIMATION_CONTROL_KEYWORDS.has(value)) return null;
  if (/^(?:\d*\.)?\d+m?s$/i.test(value)) return null;
  if (/^(?:\d*\.)?\d+$/.test(value)) return null;
  if (/^(?:var|calc|steps|cubic-bezier|linear)\(/i.test(value)) return null;
  if (!/^[_a-zA-Z][\w-]*$/.test(value)) return null;
  return value;
}

function auditRawHoverBackgroundWithoutStateLayer(findings, file) {
  if (HOVER_BACKGROUND_OPT_OUT_MARKER.test(file.source)) return;
  for (const block of cssSourcesForFile(file.rel, file.source)) {
    for (const ruleMatch of block.css.matchAll(HOVER_BACKGROUND_RULE_PATTERN)) {
      const selector = ruleMatch[1];
      const body = ruleMatch[2];
      // Skip @keyframes/@media wrappers — the selector might not be a true selector.
      if (selector.trim().startsWith("@")) continue;
      // Skip rules that themselves declare a state-layer token (acceptable composition).
      for (const propMatch of body.matchAll(HOVER_BACKGROUND_BACKGROUND_PROP_PATTERN)) {
        const value = propMatch[1].trim();
        if (!value || value === "none" || value === "transparent" || value === "inherit" || value === "initial") {
          continue;
        }
        if (STATE_LAYER_TOKEN_VAR_PATTERN.test(value)) continue;
        // Accept color-mix(in srgb, <role-token> N%, transparent) where N is a canonical state-layer %.
        const colorMixMatch =
          /color-mix\(\s*in\s+srgb\s*,\s*var\(\s*(--md-sys-color-[\w-]+|--gc-[\w-]+)\s*\)\s*([\d.]+)%\s*,\s*transparent\s*\)/i.exec(
            value,
          );
        if (colorMixMatch && ALLOWED_COLOR_MIX_PERCENTAGES.has(colorMixMatch[2])) continue;
        // The rule targets RAW hardcoded hover colors (see its name). A hover background
        // built entirely from design tokens — a dedicated `--*-hover*` token, a flat role
        // token, or a color-mix/gradient over tokens — is not raw; the referenced tokens
        // are audited where they are defined. Only flag values that introduce a raw
        // hex/rgb/hsl color literal.
        if (!/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/.test(value)) continue;
        const declarationOffset = (ruleMatch.index ?? 0) + selector.length + 1 + (propMatch.index ?? 0);
        const fileOffset = block.offset + declarationOffset;
        addFinding(
          findings,
          "m3-raw-hover-background-without-state-layer",
          file.rel,
          lineNumberAt(file.source, fileOffset),
          ":hover background should compose through a state-layer token (--*-hover-state-layer-color / --md-sys-color-state-hover / color-mix on a role token at canonical 4/8/10/12/16/38%).",
          `${selector.trim()} { background: ${cleanSnippet(value)} }`,
        );
      }
    }
  }
}

function auditSurfaceTintUsage(findings, file) {
  if (/styles[\\/]core[\\/]tokens\.css$/.test(file.rel)) return;
  const pattern =
    /var\(\s*--md-sys-color-surface-tint(?:\s*,[^)]*)?\)|--md-comp-[A-Za-z0-9-]*surface-tint[A-Za-z0-9-]*\s*:/g;
  const lines = file.source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(pattern)) {
      addFinding(
        findings,
        "m3-surface-tint-usage",
        file.rel,
        index + 1,
        "M3 deprecated surface-tint; use elevation level tokens instead.",
        match[0],
      );
    }
  }
}

function auditTokenFallbacks(findings, file, allTokenNames) {
  for (const match of file.source.matchAll(VAR_FALLBACK_PATTERN)) {
    const token = match[1];
    if (allTokenNames.has(token)) continue;
    addFinding(
      findings,
      "m3-undefined-token-fallback",
      file.rel,
      lineNumberAt(file.source, match.index ?? 0),
      `${token} has a fallback but is not defined in the scanned cascade.`,
      match[0],
    );
  }

  for (const match of file.source.matchAll(ROLE_RGBA_FALLBACK_PATTERN)) {
    const token = match[1];
    const fallback = match[2];
    if (!/^--md-(?:sys|comp)-(?:color|elevation)-/.test(token)) continue;
    if (!/(?:rgba?\(|rgb\(|#[0-9a-fA-F]{3,8}|\d+\s+\d+px|none)/.test(fallback)) continue;
    addFinding(
      findings,
      "m3-raw-rgba-fallback-on-role-token",
      file.rel,
      lineNumberAt(file.source, match.index ?? 0),
      `${token} should not carry a raw fallback; role tokens are required to exist.`,
      match[0],
    );
  }
}

// Border radius is just as often set through a Vue `:style` binding or a
// prop→value map (e.g. `const RADIUS_STYLES = { sm: "0.375rem", ... }`) as
// through a CSS `border-radius:` rule. The CSS-declaration scanner above never
// sees those JS shapes, so a hardcoded radius can sail through. A radius literal
// living in JS is the same drift as a raw CSS rule — and in a primitive there is
// no reason to bake an even on-scale magnitude when a --gc-radius-* token exists.
const JS_BORDER_RADIUS_BINDING_PATTERN = /\bborderRadius\s*:\s*(["'`])((?:(?!\1)[\s\S])*?)\1/g;
const JS_OBJECT_DECLARATION_PATTERN = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*([^=]*?))?=\s*\{/g;
const JS_OBJECT_ENTRY_PATTERN = /(["'`]?)([A-Za-z0-9_$-]+)\1\s*:\s*(["'`])((?:(?!\3)[\s\S])*?)\3/g;
const RAW_RADIUS_LENGTH_PATTERN = /(?:\d+(?:\.\d+)?|\.\d+)(?:rem|px)\b/;

function isRawRadiusLength(value) {
  const v = value.trim();
  if (!v || v === "0" || /^(?:inherit|unset|initial|auto|none)$/i.test(v)) return false;
  if (/var\(\s*--/.test(v)) return false; // already resolves through a token
  return RAW_RADIUS_LENGTH_PATTERN.test(v);
}

function findBalancedObjectEnd(source, openBraceIndex) {
  let depth = 0;
  for (let cursor = openBraceIndex; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return source.length;
}

function auditJsRadiusValues(findings, file) {
  if (!/\.(?:vue|ts|tsx|js|jsx|mjs|cjs)$/.test(file.rel)) return;

  // 1) Direct `borderRadius: "<raw>"` style bindings.
  for (const match of file.source.matchAll(JS_BORDER_RADIUS_BINDING_PATTERN)) {
    const value = match[2];
    if (!isRawRadiusLength(value)) continue;
    addFinding(
      findings,
      "m3-raw-border-radius",
      file.rel,
      lineNumberAt(file.source, match.index ?? 0),
      `borderRadius is set to a raw "${value.trim()}" in a style object; resolve it through a --gc-radius-* token.`,
      match[0],
    );
  }

  // 2) Radius-named object/Record maps whose entry values are raw lengths.
  for (const decl of file.source.matchAll(JS_OBJECT_DECLARATION_PATTERN)) {
    const name = decl[1] ?? "";
    const typeAnnotation = decl[2] ?? "";
    if (!/radius/i.test(name) && !/radius/i.test(typeAnnotation)) continue;

    const braceIndex = (decl.index ?? 0) + decl[0].lastIndexOf("{");
    const body = file.source.slice(braceIndex + 1, findBalancedObjectEnd(file.source, braceIndex));

    for (const entry of body.matchAll(JS_OBJECT_ENTRY_PATTERN)) {
      const value = entry[4];
      if (!isRawRadiusLength(value)) continue;
      addFinding(
        findings,
        "m3-raw-border-radius",
        file.rel,
        lineNumberAt(file.source, braceIndex + 1 + (entry.index ?? 0)),
        `radius map "${name}" hardcodes "${value.trim()}"; map keys should resolve through --gc-radius-* tokens.`,
        entry[0],
      );
    }
  }
}

function auditBorderRadiusDeclaration(findings, file, line, value, snippet) {
  if (/var\(\s*--(?:md-sys-shape|md-comp|gc-radius)-/.test(value)) return;
  // Match BOTH px and rem lengths (plus bare 0). rem was historically a blind
  // spot: a public field radius like 1.5rem sailed through the px-only scan. We
  // normalize rem→px (×16) so every length is checked against the same tier set.
  const lengths = [...value.matchAll(/(?:\d*\.)?\d+(?:px|rem)\b|\b0\b/g)].map((match) => match[0]);
  if (!lengths.length) return;
  const offScale = lengths.filter((len) => {
    if (len === "0") return false;
    const px = len.endsWith("rem") ? `${parseFloat(len) * 16}px` : len;
    return !ALLOWED_RADIUS_PX.has(px);
  });
  if (!offScale.length) return;
  addFinding(
    findings,
    "m3-raw-border-radius",
    file.rel,
    line,
    `border-radius uses off-scale raw value(s): ${offScale.join(", ")} — resolve through a --gc-radius-* token.`,
    snippet,
  );
}

const STATE_CONTEXT_SELECTOR_PATTERN =
  /:hover|:focus|:active|:disabled|\[disabled\]|:checked|--disabled|--selected|--active|--pressed|--dragged/i;

function auditOpacityDeclaration(findings, file, line, value, snippet, selector = "") {
  if (/var\(\s*--(?:md-sys-state|md-comp|gc)-/.test(value)) return;
  const match = /^0?\.\d+$/.exec(value);
  if (!match || ALLOWED_OPACITIES.has(value)) return;
  // This rule governs opacity used AS an interaction/disabled state treatment (per its
  // description: "state-layer or disabled opacity tokens"). Decorative/content opacity on
  // a resting element — fills, glows, placeholders, semantic dimming — is out of scope.
  if (!STATE_CONTEXT_SELECTOR_PATTERN.test(selector)) return;
  addFinding(
    findings,
    "m3-raw-opacity",
    file.rel,
    line,
    `${value} is not part of the canonical M3 opacity set.`,
    snippet,
  );
}

function auditBoxShadowDeclaration(findings, file, line, value, snippet) {
  if (/var\(\s*--(?:md-sys-elevation-level|md-comp-[\w-]+-container-elevation|gc-elevation)-/.test(value)) return;
  const colorStops = (value.match(/(?:rgba?\(|rgb\()/g) ?? []).length;
  if (colorStops <= 1) return;
  addFinding(
    findings,
    "m3-raw-multi-stop-shadow",
    file.rel,
    line,
    "box-shadow uses multiple raw color stops instead of an elevation token.",
    snippet,
  );
}

function auditMotionFallbackDeclaration(findings, file, line, value, snippet) {
  const pattern = /var\(\s*--(?:md-sys|gc)-motion-duration-([A-Za-z0-9-]+)\s*,\s*(\d+ms)\s*\)/g;
  for (const match of value.matchAll(pattern)) {
    const canonicalKey = normalizeDurationKey(match[1]);
    const expected = CANONICAL_DURATIONS[canonicalKey];
    if (!expected || match[2] === expected) continue;
    addFinding(
      findings,
      "m3-stale-motion-duration-fallback",
      file.rel,
      line,
      `${match[0]} falls back to ${match[2]}, but ${match[1]} is ${expected}.`,
      snippet,
    );
  }
}

function normalizeDurationKey(key) {
  return key
    .replace(/^short-?/, "short")
    .replace(/^medium-?/, "medium")
    .replace(/^long-?/, "long");
}

function auditPublicThemeTokens(findings, file) {
  for (const match of file.source.matchAll(/(?<![\w-])(--public-[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    addFinding(
      findings,
      "m3-public-theme-role-mapping",
      file.rel,
      lineNumberAt(file.source, match.index ?? 0),
      `${match[1]} should map through an --md-sys-color-* role, not a raw hex value.`,
      match[0],
    );
  }
}

function auditSnackbarConsumers(findings, file) {
  if (!file.source.includes("app-snackbar") && !file.source.includes("AppSnackbar")) return;
  const pattern = /(?:rounded-\(--md-sys-shape-corner-small\)|var\(\s*--md-sys-shape-corner-small\s*\))/g;
  const lines = file.source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join("\n");
    if (!context.includes("app-snackbar") && !context.includes("AppSnackbar")) continue;
    for (const match of line.matchAll(pattern)) {
      addFinding(
        findings,
        "m3-snackbar-shape",
        file.rel,
        index + 1,
        "Snackbar consumers should use --md-comp-snackbar-container-shape / corner-extra-small.",
        match[0],
      );
    }
  }
}

function patterns(values = []) {
  return values.map((value) => new RegExp(value));
}

function matchesAny(regexes, value) {
  return regexes.some((regex) => regex.test(value));
}

function selectorBefore(css, declarationIndex) {
  const open = css.lastIndexOf("{", declarationIndex);
  const previousClose = css.lastIndexOf("}", declarationIndex);
  return css.slice(previousClose + 1, open).trim();
}

function isButtonLikeContext(css, declarationIndex) {
  return /(?:button|\[role=['"]?button|\.gc-app-button|__button|--button)/i.test(selectorBefore(css, declarationIndex));
}

function limitFindings(findings, maxPerRule) {
  if (!maxPerRule) return findings;
  const counts = new Map();
  return findings.filter((finding) => {
    const count = counts.get(finding.ruleId) ?? 0;
    counts.set(finding.ruleId, count + 1);
    return count < maxPerRule;
  });
}

function countFindingsByRuleAndFile(findings) {
  const counts = Object.fromEntries(Object.keys(RULES).map((ruleId) => [ruleId, {}]));
  for (const finding of findings) {
    counts[finding.ruleId][finding.filePath] = (counts[finding.ruleId][finding.filePath] ?? 0) + 1;
  }
  return counts;
}

function buildBaselineDocument(counts) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules: Object.fromEntries(
      Object.entries(RULES).map(([ruleId, definition]) => [
        ruleId,
        {
          ...definition,
          files: counts[ruleId] ?? {},
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
  for (const [ruleId, definition] of Object.entries(RULES)) {
    const baselineFiles = baseline.rules?.[ruleId]?.files ?? {};
    const currentFiles = currentCounts[ruleId] ?? {};
    for (const [filePath, currentCount] of Object.entries(currentFiles)) {
      const baselineCount = baselineFiles[filePath] ?? 0;
      if (currentCount <= baselineCount) continue;
      regressions.push({ ruleId, filePath, baselineCount, currentCount, severity: definition.severity });
    }
  }
  return regressions;
}

function renderCounts(counts) {
  const lines = [];
  for (const [ruleId, definition] of Object.entries(RULES)) {
    const fileCounts = counts[ruleId] ?? {};
    const total = Object.values(fileCounts).reduce((sum, count) => sum + count, 0);
    lines.push(`${ruleId} [${definition.severity}] total=${total} files=${Object.keys(fileCounts).length}`);
    for (const [filePath, count] of Object.entries(fileCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${filePath}: ${count}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderReport({ findings, counts, regressions, title, format }) {
  if (format === "counts") {
    return renderCounts(counts);
  }

  const severityCounts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [
    `# ${title}`,
    "",
    `- Total findings: ${findings.length}`,
    `- Errors: ${severityCounts.error ?? 0}`,
    `- Warnings: ${severityCounts.warn ?? 0}`,
    `- Regressions: ${regressions.length}`,
    "",
  ];

  if (regressions.length) {
    lines.push("## Regressions", "");
    for (const regression of regressions) {
      lines.push(
        `- ${regression.severity.toUpperCase()}: \`${regression.ruleId}\` - ${regression.filePath} (${regression.baselineCount} -> ${regression.currentCount})`,
      );
    }
    lines.push("");
  }

  if (!findings.length) {
    lines.push("No M3 guideline drift found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Findings", "");
  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()}: \`${finding.ruleId}\` - ${location} - ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  - ${finding.snippet}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
