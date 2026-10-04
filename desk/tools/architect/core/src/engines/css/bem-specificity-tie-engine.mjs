/**
 * bem-specificity-tie engine
 * ==========================
 * Detects CSS rules where a BEM modifier selector (--modifier) sets a
 * property to override a base selector, but both have the SAME specificity
 * and the modifier rule comes EARLIER in source order — meaning the base
 * rule silently wins and the modifier has no effect.
 *
 * This is a common BEM anti-pattern. Because `--modifier` is on the same
 * element as the base class, it doesn't increase specificity. Example:
 *
 *   .block__element--modifier { opacity: 1; }   ← specificity (0,1,0)
 *   .block__element             { opacity: 0; }   ← same specificity, wins!
 *
 * The fix is to increase the modifier's specificity, e.g. by chaining
 * a parent modifier class:
 *
 *   .block--modifier .block__element::after { opacity: 1; }
 *
 * Usage (via check):
 *   bun packages/connections-arkitect/bin/audit.mjs --check bem-specificity-tie
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createFinding } from "@saydeploy/architect/core/finding";
import { walkFiles } from "@saydeploy/architect/core/files";

const CRITICAL_PROPS = new Set([
  "opacity",
  "display",
  "visibility",
  "content",
  "pointer-events",
  "position",
  "overflow",
]);

/**
 * Parse CSS rules with position tracking.
 */
function parseRules(css) {
  const rules = [];
  const regex = /([^{]+)\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    const rawSelector = match[1].trim();
    const body = match[2].trim();
    const selectors = rawSelector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const props = {};
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon === -1) continue;
      const prop = decl.substring(0, colon).trim();
      const value = decl.substring(colon + 1).trim();
      if (prop && value) props[prop] = value;
    }
    if (Object.keys(props).length > 0) {
      for (const sel of selectors) {
        rules.push({ selector: sel, props: { ...props }, position: match.index });
      }
    }
  }
  return rules;
}

/**
 * Extract the last BEM class from a selector (stripping pseudo-classes/elements).
 * Returns { className, pseudoElement } to distinguish ::after from plain selectors.
 */
function extractBemElement(sel) {
  const pseudoMatch = sel.match(/(::[\w-]+)/g);
  const pseudoElement = pseudoMatch ? pseudoMatch[pseudoMatch.length - 1] : "";
  const clean = sel.replace(/::[\w-]+/g, "").replace(/:[\w-]+(\([^)]*\))?/g, "");
  const classes = clean.match(/\.[\w-]+/g) || [];
  return {
    className: classes[classes.length - 1] || "",
    pseudoElement,
  };
}

/**
 * Strip BEM modifier (--something) from a class name.
 */
function baseElementName(className) {
  return className.replace(/--[\w-]+/g, "");
}

/**
 * Count class selectors + pseudo-classes + pseudo-elements for simplified specificity.
 * Pseudo-classes (:hover, :focus, :not(...)) contribute to the class column.
 */
function specificityLevel(sel) {
  const classes = (sel.match(/\.[a-zA-Z_-][\w-]*/g) || []).length;
  const pseudoClasses = (
    sel.match(
      /:(?:not|is|where|has|hover|focus|active|disabled|focus-visible|focus-within|nth-child|nth-of-type|first-child|last-child|only-child|empty|checked|enabled|valid|invalid|required|optional|target|lang|root|link|visited)[\w-]*(?:\([^)]*\))?/g,
    ) || []
  ).length;
  const pseudoElements = (sel.match(/::[\w-]+/g) || []).length;
  return classes + pseudoClasses + pseudoElements;
}

export async function runBemSpecificityTieAudit({ root, roots, extensions }) {
  const findings = [];
  const files = await walkFiles({ root, roots, extensions });
  const seen = new Set();

  for (const file of files) {
    const absolutePath = path.resolve(root, file);
    let css;
    try {
      css = await fs.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const rules = parseRules(css);

    for (const prop of CRITICAL_PROPS) {
      const propRules = rules.filter((r) => r.props[prop] !== undefined);

      for (let i = 0; i < propRules.length; i++) {
        for (let j = i + 1; j < propRules.length; j++) {
          const a = propRules[i];
          const b = propRules[j];

          const valA = a.props[prop];
          const valB = b.props[prop];
          if (valA === valB) continue;

          const elemA = extractBemElement(a.selector);
          const elemB = extractBemElement(b.selector);
          const baseA = baseElementName(elemA.className);
          const baseB = baseElementName(elemB.className);

          // Same base element name, different final class
          if (baseA !== baseB || elemA.className === elemB.className) continue;

          // Must target the same pseudo-element (or both target the element directly)
          if (elemA.pseudoElement !== elemB.pseudoElement) continue;

          // Only flag when EXACTLY ONE has a modifier (base vs modifier pattern)
          const aHasMod = elemA.className.includes("--");
          const bHasMod = elemB.className.includes("--");
          if (aHasMod === bHasMod) continue; // both modified or both unmodified

          const specA = specificityLevel(a.selector);
          const specB = specificityLevel(b.selector);
          if (specA !== specB) continue;

          // Identify modifier vs base rule
          const modRule = aHasMod ? a : b;
          const baseRule = aHasMod ? b : a;

          // An !important declaration wins over a non-important one regardless of
          // specificity or source order. A modifier that uses !important is
          // therefore NOT ineffectual even when it ties the base on specificity,
          // so this is not a real tie. (A non-important base can never override
          // an !important modifier.)
          const modImportant = /!important/i.test(modRule.props[prop]);
          const baseImportant = /!important/i.test(baseRule.props[prop]);
          if (modImportant && !baseImportant) continue;

          // Only flag when modifier comes BEFORE base (dangerous pattern)
          if (modRule.position >= baseRule.position) continue;

          const key = [file, prop, modRule.selector, baseRule.selector].join("|");
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push(
            createFinding({
              file: absolutePath,
              severity: "warning",
              category: "css",
              ruleId: "bem-specificity-tie",
              message: `BEM modifier "${modRule.selector.substring(0, 60)}..." sets ${prop}: ${modRule.props[prop]} but base rule "${baseRule.selector.substring(0, 60)}..." sets ${prop}: ${baseRule.props[prop]} with equal specificity (${specA}) and comes later — modifier has no effect.`,
              snippet: `${modRule.selector} { ${prop}: ${modRule.props[prop]}; } ← overridden by → ${baseRule.selector} { ${prop}: ${baseRule.props[prop]}; }`,
              metadata: {
                prop,
                modifierValue: modRule.props[prop],
                baseValue: baseRule.props[prop],
                modifierSelector: modRule.selector,
                baseSelector: baseRule.selector,
                specificity: specA,
                modPosition: modRule.position,
                basePosition: baseRule.position,
              },
            }),
          );
        }
      }
    }
  }

  return {
    failed: findings.length > 0,
    findings,
  };
}
