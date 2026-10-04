// Public entry for the codebase-agnostic UI anti-pattern rule set.
//
// Harvested and adapted from Paul Bakaus' `impeccable` project
// (https://github.com/pbakaus/impeccable), Apache-2.0. The full source-file
// HTML and CSS-cascade detectors require jsdom; this entry exposes only the
// regex-based source scanner, which is enough to flag the bulk of AI-tell and
// quality anti-patterns directly from .vue / .tsx / .jsx / .css / .html files
// without booting a DOM. The original engine, registry, and rule semantics are
// preserved verbatim — see ./registry.mjs.

export {
  ANTIPATTERNS,
  RULE_ENGINE_SUPPORT,
  getAntipattern,
  getRulesForCategory,
  getRuleEngineSupport,
} from "./registry.mjs";
export { detectText, extractStyleBlocks, extractCSSinJS } from "./detect-text.mjs";
export { SAFE_TAGS, BORDER_SAFE_TAGS, OVERUSED_FONTS, GENERIC_FONTS, KNOWN_SERIF_FONTS } from "./constants.mjs";
export {
  isNeutralColor,
  parseRgb,
  relativeLuminance,
  contrastRatio,
  parseGradientColors,
  hasChroma,
  getHue,
  colorToHex,
} from "./color.mjs";
export { isFullPage } from "./page.mjs";
export { finding, getAP } from "./findings.mjs";
