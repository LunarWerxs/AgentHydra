// Shared utility for scanning HTML/Vue template `style="..."` attributes.
// Used by design-system and motion-policy checks so both audits see the same surface.
//
// Returns iterators over both static and bound (`:style="..."`) attributes,
// plus a small string-form CSS declaration parser. Bound :style values that
// look like JS objects (`:style="{ width: x + 'px' }"`) are not split into
// declarations, but the raw expression is yielded so callers can still pattern
// match against it (e.g., regex for `transition:` substrings).

const STATIC_STYLE_ATTR_PATTERN = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/g;
const BOUND_STYLE_ATTR_PATTERN = /\b(?::style|v-bind:style)\s*=\s*(["'])([\s\S]*?)\1/g;

export function* iterateInlineStyles(source) {
  STATIC_STYLE_ATTR_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(STATIC_STYLE_ATTR_PATTERN)) {
    const valueStart = match.index + match[0].indexOf(match[2]);
    yield {
      kind: "static",
      attrIndex: match.index,
      valueIndex: valueStart,
      value: match[2],
      raw: match[0],
      tag: extractEnclosingTag(source, match.index),
    };
  }

  BOUND_STYLE_ATTR_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(BOUND_STYLE_ATTR_PATTERN)) {
    const valueStart = match.index + match[0].indexOf(match[2]);
    yield {
      kind: "bound",
      attrIndex: match.index,
      valueIndex: valueStart,
      value: match[2],
      raw: match[0],
      tag: extractEnclosingTag(source, match.index),
    };
  }
}

function extractEnclosingTag(source, attrIndex) {
  const tagStart = source.lastIndexOf("<", attrIndex);
  const tagEnd = source.indexOf(">", attrIndex);
  if (tagStart === -1 || tagEnd === -1) {
    return "";
  }
  return source.slice(tagStart, tagEnd + 1);
}

// Splits a static style value into { property, value, index } records. The
// `index` is the offset within the original style attribute value where the
// declaration starts, useful for line-number computation.
export function parseInlineDeclarations(styleValue) {
  const decls = [];

  for (const part of splitStyleValue(styleValue)) {
    if (!part.text.trim()) {
      continue;
    }

    const colon = part.text.indexOf(":");
    if (colon !== -1) {
      const property = part.text.slice(0, colon).trim().toLowerCase();
      const value = part.text.slice(colon + 1).trim();
      if (property) {
        decls.push({ property, value, index: part.start });
      }
    }
  }

  return decls;
}

function splitStyleValue(styleValue) {
  // Split on `;`, but skip `;` inside `(...)` (e.g., `var(--x, foo;bar)`).
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < styleValue.length; i += 1) {
    const ch = styleValue[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push({ text: styleValue.slice(start, i), start });
      start = i + 1;
    }
  }
  if (start < styleValue.length) {
    parts.push({ text: styleValue.slice(start), start });
  }
  return parts;
}

// Helper: returns true if any declaration in the static style value matches
// a property predicate. Convenience for callers that don't need offsets.
export function hasInlineDeclaration(styleValue, propertyPredicate) {
  for (const decl of parseInlineDeclarations(styleValue)) {
    if (propertyPredicate(decl.property)) {
      return true;
    }
  }
  return false;
}
