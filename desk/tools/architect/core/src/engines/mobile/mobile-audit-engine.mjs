#!/usr/bin/env bun
/*
 * Mobile UX, A11y, SEO, PWA, Perf & Security Audit
 * =================================================
 * Single-file Node tool. Loads URL via Playwright in real device emulation,
 * then runs ~50 checks across 9 audit families and emits a scored report.
 *
 * Audit families (toggleable via --no-<family>):
 *   - axe       Axe-core accessibility engine
 *   - mobile    Touch targets, tap spacing, viewport, overflow, fixed els, contrast,
 *               typography, form inputs, images, hover-dep, interstitials
 *   - ios       iOS-specific: 16px input font (auto-zoom), tap-highlight, safe-area, web-app-capable
 *   - layout    CLS sources: <img>/<iframe> without dimensions, font-display
 *   - seo       <title>, meta description, canonical, Open Graph, charset, lang
 *   - pwa       manifest.json, service worker, theme-color, apple-touch-icon, maskable icons
 *   - a11y2     Heading hierarchy, skip link, label assoc, :focus-visible,
 *               prefers-reduced-motion, prefers-color-scheme, ARIA landmarks
 *   - security  HTTPS, mixed content, security headers, SRI on cross-origin scripts
 *   - perf      TTFB, DOM-load, weight, resource counts, render-blocking
 *   - cwv       Core Web Vitals: LCP, CLS, FCP, long-task TBT
 *
 * Provenance: several heuristics borrow logic verbatim from Lighthouse and Axe
 *   (rect-helpers, tappable-rects, content-width, target-size, target-offset,
 *   meta-viewport-scale).
 *
 * CLI:
 *   bun packages/connections-arkitect/src/engines/mobile-audit-engine.mjs <url> [url2 ...] [options]
 *
 * Options:
 *   -d, --device <name>          Device profile (default: iphone_13)
 *       --devices <a,b,c>        Audit multiple devices, one report each
 *   -f, --format <fmt>           console | json | html | markdown
 *   -o, --output <file>          Write report to file (- for stdout)
 *       --screenshot <path>      Save device-emulated screenshot
 *       --timeout <ms>           Per-page navigation timeout (default 30000)
 *       --header "K: V"          Extra request header (repeatable)
 *       --cookie "k=v"           Cookie (repeatable)
 *       --ua <string>            Override User-Agent
 *   -q, --quiet                  Suppress progress logs
 *       --no-axe / --no-mobile / --no-ios / --no-layout / --no-seo
 *       --no-pwa / --no-a11y2 / --no-security / --no-perf / --no-cwv
 *   -h, --help                   Show help
 */

import { chromium, devices } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// =============================================================================
// CONSTANTS
// =============================================================================

export const DEVICE_PROFILES = {
  iphone_13: "iPhone 13",
  iphone_13_pro_max: "iPhone 13 Pro Max",
  iphone_se: "iPhone SE",
  iphone_15_pro: "iPhone 15 Pro",
  pixel_5: "Pixel 5",
  pixel_7: "Pixel 7",
  galaxy_s9: "Galaxy S9+",
  galaxy_s24: "Galaxy S24",
  ipad: "iPad (gen 7)",
  ipad_pro: "iPad Pro 11",
};

// Score weights. Minor is informational only (0 deduction). Each category
// contributes its max-severity penalty once, no count overflow.
const SEVERITY_SCORES = { critical: 12, serious: 7, moderate: 3, minor: 0 };
const SEVERITY_RANK = { minor: 1, moderate: 2, serious: 3, critical: 4 };
const SEVERITY_EMOJI = { critical: "🔴", serious: "🟠", moderate: "🟡", minor: "🔵" };
const GRADE_THRESHOLDS = [
  [90, "A", "🏆"],
  [80, "B", "✅"],
  [70, "C", "⚠️"],
  [60, "D", "❌"],
  [0, "F", "💀"],
];

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1223", "chrome-win64", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(
  (candidate, index, candidates) => candidate && candidates.indexOf(candidate) === index && existsSync(candidate),
);

async function launchMobileAuditBrowser({ headless }) {
  const candidates = CHROMIUM_CANDIDATES.length > 0 ? CHROMIUM_CANDIDATES : [undefined];
  let lastError = null;

  for (const executablePath of candidates) {
    try {
      return await chromium.launch({
        headless,
        executablePath,
        timeout: 45_000,
        args: process.platform === "win32" ? ["--disable-gpu"] : [],
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No usable Chromium browser found for mobile audit.");
}

function shouldRunBrowserAuditInNode() {
  return (
    process.platform === "win32" &&
    Boolean(process.versions?.bun) &&
    process.env.CONNECTIONS_MOBILE_AUDIT_NODE_BRIDGE !== "1"
  );
}

function runMobileAuditInNode(options) {
  const payload = Buffer.from(JSON.stringify({ ...options, quiet: true }), "utf8").toString("base64");
  const code = `
    import { runMobileAudit } from ${JSON.stringify(import.meta.url)};
    const options = JSON.parse(Buffer.from(process.env.CONNECTIONS_MOBILE_AUDIT_PAYLOAD, "base64").toString("utf8"));
    const result = await runMobileAudit(options);
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync("node", ["--input-type=module", "--eval", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONNECTIONS_MOBILE_AUDIT_NODE_BRIDGE: "1",
      CONNECTIONS_MOBILE_AUDIT_PAYLOAD: payload,
    },
    timeout: 300_000,
  });

  if (child.error) throw child.error;
  if (child.status !== 0) {
    const detail = child.stderr?.trim() || child.stdout?.trim() || `node exited with status ${child.status}`;
    throw new Error(detail);
  }

  return JSON.parse(child.stdout);
}

export function getGrade(score) {
  for (const [t, g, e] of GRADE_THRESHOLDS) if (score >= t) return [g, e];
  return ["F", "💀"];
}

function createResult({ url, device, viewport }) {
  return {
    url,
    device,
    viewport,
    timestamp: new Date().toISOString(),
    issues: [],
    metrics: {},
    score: 100,
    addIssue(issue) {
      this.issues.push(issue);
    },
  };
}

// Score = 100 - sum over each category of (worst-severity-penalty + small overflow bump).
// Caps blast radius from a single category that fires many issues for one root cause.
function computeScore(issues) {
  const byCategory = new Map();
  for (const i of issues) {
    const list = byCategory.get(i.category) || [];
    list.push(i);
    byCategory.set(i.category, list);
  }
  let penalty = 0;
  for (const list of byCategory.values()) {
    let maxSev = "minor";
    for (const i of list) {
      if ((SEVERITY_RANK[i.severity] || 0) > (SEVERITY_RANK[maxSev] || 0)) maxSev = i.severity;
    }
    penalty += SEVERITY_SCORES[maxSev] ?? 3;
  }
  return Math.max(0, 100 - penalty);
}

// stderr-progress so JSON/HTML to stdout stays clean.
let QUIET = false;
function log(...args) {
  if (!QUIET) console.error(...args);
}

async function safe(name, fn) {
  try {
    await fn();
  } catch (err) {
    log(`⚠️  Check "${name}" threw: ${err.message}`);
  }
}

// =============================================================================
// MOBILE UX CHECKS (the original 16, hardened)
// =============================================================================

async function checkViewportMeta(page, result) {
  // Logic borrowed verbatim from Axe meta-viewport-scale-evaluate.js
  const meta = await page.$('meta[name="viewport"]');
  if (!meta) {
    result.addIssue({
      category: "Viewport",
      severity: "critical",
      title: "Missing viewport meta tag",
      description: "Page lacks a viewport meta tag, causing improper scaling on mobile devices.",
      recommendation: 'Add: <meta name="viewport" content="width=device-width, initial-scale=1">',
      wcag: "WCAG 1.4.10",
    });
    return;
  }
  const content = (await meta.getAttribute("content")) || "";
  const properties = {};
  for (const part of content.replace(/;/g, ",").split(",")) {
    if (part.includes("=")) {
      const [k, v] = part.split("=");
      properties[k.trim().toLowerCase()] = v.trim().toLowerCase();
    }
  }
  const SCALE_MIN = 2;
  const userScalable = properties["user-scalable"];
  let userOk = true;
  if (userScalable === "no") userOk = false;
  else if (userScalable !== undefined) {
    const n = parseFloat(userScalable);
    if (!Number.isNaN(n) && n >= -1 && n < 1) userOk = false;
  }
  if (!userOk) {
    result.addIssue({
      category: "Viewport",
      severity: "serious",
      title: "Zoom disabled via viewport",
      description: `user-scalable=${userScalable} prevents users from zooming, harming accessibility.`,
      selector: 'meta[name="viewport"]',
      recommendation: "Remove user-scalable restriction to allow pinch-to-zoom.",
      wcag: "WCAG 1.4.4",
    });
  }
  const maxScale = properties["maximum-scale"];
  if (maxScale !== undefined) {
    const v = maxScale === "yes" ? 1 : parseFloat(maxScale);
    if (!Number.isNaN(v) && v < SCALE_MIN) {
      result.addIssue({
        category: "Viewport",
        severity: "moderate",
        title: `Maximum scale restricted to ${v}x`,
        description: `maximum-scale=${maxScale} limits zoom below ${SCALE_MIN}x (WCAG requires 200% zoom).`,
        selector: 'meta[name="viewport"]',
        recommendation: `Remove maximum-scale or set to ${SCALE_MIN} or higher.`,
        wcag: "WCAG 1.4.4",
      });
    }
  }
}

// Browser-side helper injected via page.evaluate string concat. WCAG 2.5.8
// explicitly exempts inline links inside text-flow content (e.g. Wikipedia's
// citation links inside <sup>, inline links in <p>, etc.). We walk up the
// ancestor chain to the nearest block-level container and exempt the link if
// that container is a flow-text element.
const UI_CONTROL_FN = `
function __isUIControl(el) {
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  const role = el.getAttribute('role');
  if (role === 'button') return true;
  if (tag === 'A' || role === 'link') {
    const display = window.getComputedStyle(el).display;
    if (display === 'block' || display === 'flex' || display === 'grid' || display === 'inline-block') {
      // Block-ish layout suggests an intentional UI button shape; treat as UI.
      // (inline-block is the typical pattern for nav buttons styled as <a>.)
      // But still allow "inline-block link in flowing text" — check below.
    }
    const FLOW_CONTAINERS = new Set(['P','LI','DD','DT','TD','TH','BLOCKQUOTE','CITE',
      'CAPTION','FIGCAPTION','H1','H2','H3','H4','H5','H6']);
    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur !== document.body && depth < 8) {
      const cs = window.getComputedStyle(cur);
      const cd = cs.display;
      const isBlock = cd === 'block' || cd === 'flex' || cd === 'grid' || cd === 'list-item' || cd === 'table-cell' || cd === 'table';
      if (isBlock) {
        // Reached the containing block. If it's a flow-text element, the link is inline prose.
        if (FLOW_CONTAINERS.has(cur.tagName)) return false;
        // Heuristic: if the containing block has substantially more text than the link,
        // it's prose with an inline link, regardless of tag.
        const linkText = (el.textContent || '').trim().length;
        const blockText = (cur.textContent || '').trim().length;
        if (linkText > 0 && blockText > linkText * 4 && blockText > 60) return false;
        return true;
      }
      cur = cur.parentElement;
      depth++;
    }
    return true;
  }
  return false;
}`;

async function checkTouchTargets(page, result) {
  // Axe target-size-evaluate.js: minSize = 24 (WCAG 2.5.8 AA)
  const minSize = 24;
  const small = await page.evaluate(`(() => {
    ${UI_CONTROL_FN}
    const min = ${minSize};
    const sels = ['a[href]','button','input:not([type="hidden"])','[role="button"]','[role="link"]','[onclick]','select','textarea','[tabindex]:not([tabindex="-1"])'];
    const out = [];
    document.querySelectorAll(sels.join(",")).forEach((el) => {
      if (!__isUIControl(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.width < min || r.height < min) {
        const text = (el.innerText || "").trim().slice(0, 30);
        const tag = el.tagName.toLowerCase();
        out.push({ selector: text ? tag + ': ' + text : tag, size: Math.round(r.width) + 'x' + Math.round(r.height) + 'px' });
      }
    });
    return out;
  })()`);

  if (small.length) {
    result.addIssue({
      category: "Touch Targets",
      severity: small.length > 10 ? "serious" : small.length > 3 ? "moderate" : "minor",
      title: `${small.length} touch targets below 24x24px`,
      description: `Found ${small.length} UI controls smaller than WCAG 2.5.8 minimum 24x24px.`,
      selector: small
        .slice(0, 5)
        .map((t) => `${t.selector} (${t.size})`)
        .join("; "),
      recommendation: "Increase padding/size of interactive elements for better touch usability.",
      wcag: "WCAG 2.5.8",
    });
  }
}

async function checkTapSpacing(_page, _result) {
  // Note: this check used to count every pair of nearby UI controls — n² noise that
  // produced thousands of "issues" on dense layouts (Wikipedia, GitHub, Apple). Replaced
  // by checkTargetOffset (24px center-to-center) and checkVisualOverlap (real overlap),
  // which cover the actual WCAG 2.5.8 violations without quadratic blowup.
  return;
}

async function checkTargetOffset(page, result) {
  // Axe target-offset-evaluate.js: minOffset = 24px (WCAG 2.5.8)
  const violations = await page.evaluate(`(() => {
    ${UI_CONTROL_FN}
    const MIN_OFFSET = 24;
    const interactive = Array.from(document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [onclick]'
    )).filter((el) => {
      if (!__isUIControl(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const targets = interactive.map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const all = [];
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const dx = Math.abs(targets[i].cx - targets[j].cx);
        const dy = Math.abs(targets[i].cy - targets[j].cy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < MIN_OFFSET) all.push({ el1: targets[i].tag, el2: targets[j].tag, offset: Math.round(d) });
      }
    }
    all.sort((a, b) => a.offset - b.offset);
    return all.slice(0, 5);
  })()`);

  if (violations.length) {
    result.addIssue({
      category: "Touch Targets",
      severity: "minor",
      title: `${violations.length} target pairs with insufficient offset`,
      description: "Target centers are less than 24px apart (WCAG 2.5.8 minimum).",
      selector: violations
        .slice(0, 3)
        .map((v) => `${v.el1}<->${v.el2} (${v.offset}px)`)
        .join("; "),
      recommendation: "Ensure at least 24px spacing between target centers.",
      wcag: "WCAG 2.5.8",
    });
  }
}

async function checkHorizontalScroll(page, result) {
  // Lighthouse content-width.js: scrollWidth vs clientWidth, 1px tolerance
  await page.waitForLoadState("networkidle").catch(() => {});
  const data = await page.evaluate(() => {
    const sw = document.documentElement.scrollWidth;
    const cw = document.documentElement.clientWidth;
    const w = window.innerWidth;
    const out = [];
    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (el.tagName === "HTML" || el.tagName === "BODY" || s.position === "fixed") return;
      if (r.width > w + 5 || r.right > w + 5) {
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id ? "#" + el.id : "",
          class:
            el.className && typeof el.className === "string"
              ? "." + el.className.split(" ").filter(Boolean).join(".")
              : "",
          overflow: Math.round(Math.max(r.width - w, r.right - w)),
        });
      }
    });
    return { sw, cw, offenders: out.sort((a, b) => b.overflow - a.overflow).slice(0, 3) };
  });

  if (data.sw > data.cw + 1) {
    const overflow = data.sw - data.cw;
    const info = data.offenders.length
      ? " | Offenders: " + data.offenders.map((o) => `${o.tag}${o.id}${o.class} (+${o.overflow}px)`).join(", ")
      : "";
    result.addIssue({
      category: "Layout",
      severity: "serious",
      title: `Horizontal scroll detected (${overflow}px overflow)`,
      description: `Page content extends beyond viewport, causing horizontal scrolling.${info}`,
      recommendation: "Check for fixed-width elements, overflowing images, or pre-formatted text.",
      wcag: "WCAG 1.4.10",
    });
  }
}

async function checkIntrusiveInterstitials(page, result) {
  // Tightened: cookie banners cover 30-50% with z<1000 and live at the bottom — exclude
  // those. Real intrusive interstitials are large modals (60%+) with very high z.
  const interstitial = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const area = w * h;
    const out = [];
    const THRESHOLD = 0.6;
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      if (s.position !== "fixed" && s.position !== "absolute") return;
      const r = el.getBoundingClientRect();
      const coverage = (r.width * r.height) / area;
      const z = parseInt(s.zIndex) || 0;
      // Only flag: covers ≥60%, z >= 1000 (modal-tier), and starts above the fold center.
      if (coverage > THRESHOLD && z >= 1000 && r.top < h * 0.3) {
        // Skip likely consent/cookie patterns by class/id heuristic.
        const ident = ((el.id || "") + " " + (typeof el.className === "string" ? el.className : "")).toLowerCase();
        if (/cookie|consent|gdpr|privacy|onetrust/i.test(ident)) return;
        out.push({
          tag: el.tagName.toLowerCase(),
          class: typeof el.className === "string" ? el.className.slice(0, 40) : "",
          coverage: Math.round(coverage * 100),
        });
      }
    });
    return out;
  });
  if (interstitial.length) {
    result.addIssue({
      category: "Layout",
      severity: "minor",
      title: "Potential intrusive interstitial detected",
      description: `A large fixed/absolute element (${interstitial[0].coverage}% coverage, z≥1000) may be blocking content. Could also be a hero banner — verify manually.`,
      selector: `${interstitial[0].tag}.${interstitial[0].class}`,
      recommendation: "If this is a popup blocking content, replace with a less intrusive banner.",
      wcag: "Google SEO Best Practice",
    });
  }
}

async function checkHoverDependency(page, result) {
  // Only `display: none` -> `display: ...` on hover is genuinely broken on touch.
  // `opacity`/`visibility` patterns work via iOS tap-to-hover, so we ignore them.
  // We also exempt selectors that have a sibling :focus / :active rule (touch fallback).
  const offenders = await page.evaluate(() => {
    // Match `display: <not-none>` ONLY when the rule contains a state pseudo-class.
    const DISPLAY_RE = /display\s*:\s*(?!none)([a-z-]+)/i;
    const stripState = (s) => s.replace(/:(hover|focus|focus-visible|active)\b/g, "").trim();
    const states = new Map();
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (!rule.selectorText || !rule.cssText) return;
          if (!DISPLAY_RE.test(rule.cssText)) return;
          rule.selectorText.split(",").forEach((sel) => {
            sel = sel.trim();
            const has = (st) => new RegExp(":" + st + "\\b").test(sel);
            if (!(has("hover") || has("focus") || has("active") || has("focus-visible"))) return;
            const base = stripState(sel);
            const entry = states.get(base) || { hover: false, active: false, focus: false };
            if (has("hover")) entry.hover = true;
            if (has("active")) entry.active = true;
            if (has("focus") || has("focus-visible")) entry.focus = true;
            states.set(base, entry);
          });
        });
      } catch {
        /* cross-origin */
      }
    });
    const offending = [];
    for (const [base, e] of states) {
      if (e.hover && !e.active && !e.focus) offending.push(base);
    }
    return offending.slice(0, 5);
  });

  if (offenders.length) {
    result.addIssue({
      category: "UX",
      severity: "moderate",
      title: `${offenders.length} hover-only display selectors`,
      description:
        "Selectors that toggle display on :hover with no :focus or :active fallback hide content from touch users entirely.",
      selector: offenders.join(", "),
      recommendation:
        "Add an equivalent :focus-visible or :active rule, or render the content always visible on touch.",
      wcag: "WCAG 2.1",
    });
  }
}

async function checkTextClipping(page, result) {
  // Pure ellipsis truncation is usually intentional. Only flag overflow:hidden
  // WITHOUT text-overflow:ellipsis — that's the case where text is genuinely cut off
  // with no visual indicator.
  const clipped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("p, span, h1, h2, h3, button, a, div").forEach((el) => {
      if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
        const s = window.getComputedStyle(el);
        const truncatedWithoutEllipsis =
          el.scrollWidth > el.clientWidth + 2 && s.overflow === "hidden" && s.textOverflow !== "ellipsis";
        if (truncatedWithoutEllipsis) {
          out.push({
            tag: el.tagName.toLowerCase(),
            text: el.textContent.trim().substring(0, 15),
            overflow: el.scrollWidth - el.clientWidth,
          });
        }
      }
    });
    return out.slice(0, 5);
  });
  if (clipped.length) {
    result.addIssue({
      category: "Typography",
      severity: "minor",
      title: "Text clipping without ellipsis",
      description: "Text is cut off with overflow:hidden but no ellipsis to signal truncation.",
      selector: clipped.map((c) => `${c.tag}: '${c.text}...'`).join(", "),
      recommendation: "Add text-overflow: ellipsis, or allow text to wrap.",
    });
  }
}

async function checkLineHeight(page, result) {
  const cramped = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("h1, h2, h3, p").forEach((el) => {
      const s = window.getComputedStyle(el);
      const fs = parseFloat(s.fontSize);
      const lh = parseFloat(s.lineHeight);
      if (fs > 20 && !Number.isNaN(lh) && lh < fs * 1.1) {
        out.push({ tag: el.tagName.toLowerCase(), size: fs, lh });
      }
    });
    return out.slice(0, 5);
  });
  if (cramped.length) {
    result.addIssue({
      category: "Typography",
      severity: "minor",
      title: "Cramped line height",
      description: "Large text has a line-height too close to its font-size, reducing readability.",
      selector: cramped.map((c) => `${c.tag} (${c.size}px / ${c.lh}px)`).join(", "),
      recommendation: "Increase line-height to at least 1.2-1.4 for better readability.",
      wcag: "WCAG 1.4.8",
    });
  }
}

async function checkVisualOverlap(page, result) {
  const overlap = await page.evaluate(`(() => {
    ${UI_CONTROL_FN}
    const interactive = document.querySelectorAll('button, a, input, [role="button"]');
    const rects = [];
    interactive.forEach((el) => {
      if (!__isUIControl(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ el, r });
    });
    const out = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const eA = rects[i].el, eB = rects[j].el;
        const a = rects[i].r, b = rects[j].r;
        // Skip pairs in same DOM subtree (nested clickable patterns)
        if (eA.contains(eB) || eB.contains(eA)) continue;
        // Skip rect-containment (button + its sibling icon button visually inside)
        const aContainsB = a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
        const bContainsA = b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom;
        if (aContainsB || bContainsA) continue;
        // Compute overlap area dimensions; only flag if it's substantial.
        const ow = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ow < 5 || oh < 5) continue;
        out.push({ t1: eA.tagName.toLowerCase(), t2: eB.tagName.toLowerCase() });
      }
    }
    return out.slice(0, 3);
  })()`);
  if (overlap.length) {
    result.addIssue({
      category: "Touch Targets",
      severity: "serious",
      title: "Overlapping interactive elements",
      description: "Interactive elements are physically overlapping, making them difficult to tap.",
      selector: overlap.map((o) => `${o.t1} over ${o.t2}`).join(", "),
      recommendation: "Ensure elements have sufficient margin and do not overlap.",
      wcag: "WCAG 2.5.5",
    });
  }
}

async function checkFontSizes(page, result) {
  // <10px because every site has 10-11px legal text intentionally. Also exempt
  // the universal sr-only pattern (1×1 hidden text for screen readers) and any
  // element rendered effectively invisible (clip/clip-path/opacity:0).
  const small = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const checked = new Set();
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || checked.has(parent)) continue;
      if (!walker.currentNode.textContent.trim()) continue;
      checked.add(parent);
      const s = window.getComputedStyle(parent);
      const size = parseFloat(s.fontSize);
      if (size >= 10) continue;
      const r = parent.getBoundingClientRect();
      // Screen-reader-only pattern: 1×1 absolute, clip, or 0 opacity.
      if (r.width <= 2 && r.height <= 2) continue;
      if (s.opacity === "0" || s.visibility === "hidden" || s.display === "none") continue;
      if (s.clip && s.clip !== "auto" && s.clip !== "none") continue;
      if (s.clipPath && s.clipPath !== "none" && /(inset\(.*100%|circle\(0)/.test(s.clipPath)) continue;
      out.push({ tag: parent.tagName, size });
    }
    return out.slice(0, 10);
  });
  if (small.length > 2) {
    result.addIssue({
      category: "Typography",
      severity: small.length > 8 ? "moderate" : "minor",
      title: `${small.length} elements with font-size below 10px`,
      description: "Text below 10px is hard to read on mobile.",
      selector: small
        .slice(0, 5)
        .map((t) => `${t.tag} (${t.size}px)`)
        .join(", "),
      recommendation: "Use minimum 14-16px for body text on mobile; 12px+ for footnotes.",
      wcag: "WCAG 1.4.4",
    });
  }
}

async function checkFormInputs(page, result) {
  const issues = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      const type = el.getAttribute("type") || "text";
      const autocomplete = el.getAttribute("autocomplete");
      const name = (el.getAttribute("name") || "").toLowerCase();
      const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
      if ((name.includes("email") || placeholder.includes("email")) && type !== "email") {
        out.push('email field without type="email"');
      }
      if ((name.includes("phone") || name.includes("tel")) && type !== "tel") {
        out.push('phone field without type="tel"');
      }
      if (["text", "email", "tel"].includes(type) && !autocomplete) {
        out.push(`input[name='${name}'] missing autocomplete attribute`);
      }
    });
    return [...new Set(out)].slice(0, 5);
  });
  if (issues.length) {
    result.addIssue({
      category: "Forms",
      severity: "moderate",
      title: "Form inputs not optimized for mobile",
      description: "Some form fields lack proper input types or autocomplete attributes.",
      selector: issues.join("; "),
      recommendation: "Use appropriate input types (email, tel, number) and autocomplete attributes.",
    });
  }
}

async function checkImages(page, result) {
  const data = await page.evaluate(() => {
    const vh = window.innerHeight;
    let missingAlt = 0;
    let lazyMissing = 0;
    const examples = [];
    document.querySelectorAll("img").forEach((img) => {
      if (img.getAttribute("alt") === null) {
        missingAlt++;
        if (examples.length < 3) examples.push(img.getAttribute("src")?.slice(0, 60) || "(no src)");
      }
      const r = img.getBoundingClientRect();
      const loading = img.getAttribute("loading");
      if (r.top > vh + 100 && loading !== "lazy") lazyMissing++;
    });
    return { missingAlt, lazyMissing, examples };
  });

  if (data.missingAlt) {
    result.addIssue({
      category: "Images",
      severity: "serious",
      title: `${data.missingAlt} images missing alt text`,
      description: "Images without alt text are inaccessible to screen reader users.",
      selector: data.examples.join(", "),
      recommendation: "Add descriptive alt attributes to all meaningful images.",
      wcag: "WCAG 1.1.1",
    });
  }
  if (data.lazyMissing > 2) {
    result.addIssue({
      category: "Images",
      severity: "minor",
      title: `${data.lazyMissing} below-fold images without lazy loading`,
      description: "Below-fold images load eagerly, slowing initial paint on mobile.",
      recommendation: 'Add loading="lazy" to images outside the initial viewport.',
    });
  }
}

async function checkOrientation(page, result) {
  const orientationAware = await page.evaluate(() => {
    const styles = [...document.styleSheets]
      .flatMap((s) => {
        try {
          return [...s.cssRules].map((r) => r.cssText);
        } catch {
          return [];
        }
      })
      .join(" ");
    return styles.includes("orientation: portrait") || styles.includes("orientation: landscape");
  });
  result.metrics.orientation_aware = orientationAware;
  if (!orientationAware) {
    result.addIssue({
      category: "Layout",
      severity: "minor",
      title: "No orientation-aware styles detected",
      description: "No @media (orientation: ...) rules found. Page may not adapt to landscape on mobile.",
      recommendation: "Test in landscape and add @media queries if layout breaks.",
    });
  }
}

async function checkFixedElements(page, result) {
  const fixed = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      if (s.position === "fixed" || s.position === "sticky") {
        const r = el.getBoundingClientRect();
        if (r.height > 100) {
          out.push({ tag: el.tagName, height: Math.round(r.height), position: s.position });
        }
      }
    });
    return out;
  });
  const large = fixed.filter((f) => f.height > 150);
  if (large.length) {
    result.addIssue({
      category: "Layout",
      severity: "moderate",
      title: `${large.length} large fixed/sticky elements`,
      description: "Large fixed elements reduce visible content area on mobile.",
      selector: large.map((f) => `${f.tag} (${f.height}px)`).join("; "),
      recommendation: "Consider hiding or minimizing fixed headers/footers on scroll.",
    });
  }
}

async function checkTextContrast(page, result) {
  // Supplemental — Axe is the rigorous source.
  const lowContrast = await page.evaluate(() => {
    const lum = (r, g, b) => {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };
    const parse = (color) => {
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?/);
      if (!m) return null;
      return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
    };
    const ratio = (fg, bg) => {
      const l1 = lum(fg[0], fg[1], fg[2]);
      const l2 = lum(bg[0], bg[1], bg[2]);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const out = [];
    document.querySelectorAll("p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6").forEach((el) => {
      // Skip nodes with no rendered text (icons, empty wrappers, whitespace)
      const visibleText = (el.textContent || "").trim();
      if (!visibleText) return;
      // Skip if any child element wraps the text (we want leaf text-bearing nodes)
      const hasOnlyTextChildren = [...el.childNodes].every(
        (n) => n.nodeType === 3 || (n.nodeType === 1 && !n.textContent.trim()),
      );
      if (!hasOnlyTextChildren) return;
      const s = window.getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return;
      // Skip sr-only patterns: 1×1 size, clip, etc.
      const box = el.getBoundingClientRect();
      if (box.width <= 2 && box.height <= 2) return;
      if (s.clip && s.clip !== "auto" && s.clip !== "none") return;
      const fg = parse(s.color);
      const bg = parse(s.backgroundColor);
      // Skip transparent/translucent backgrounds — we can't reliably resolve them
      if (!fg || !bg || bg[3] < 0.5) return;
      if (bg[0] + bg[1] + bg[2] === 0 && bg[3] === 0) return;
      const r = ratio(fg, bg);
      const fs = parseFloat(s.fontSize);
      const fw = parseInt(s.fontWeight) || 400;
      // WCAG large text: ≥18pt (24px) OR ≥14pt (18.66px) bold
      const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
      const min = isLarge ? 3 : 4.5;
      if (r < min) {
        out.push({ tag: el.tagName, ratio: r.toFixed(2), text: visibleText.substring(0, 20) });
      }
    });
    return out.slice(0, 5);
  });
  if (lowContrast.length) {
    result.addIssue({
      category: "Contrast",
      severity: "serious",
      title: `${lowContrast.length} potential contrast issues`,
      description: "Some text may not meet WCAG contrast requirements.",
      selector: lowContrast.map((c) => `${c.tag}: "${c.text}" (${c.ratio}:1)`).join("; "),
      recommendation: "Ensure text has at least 4.5:1 contrast ratio (3:1 for large text).",
      wcag: "WCAG 1.4.3",
    });
  }
}

// =============================================================================
// iOS-SPECIFIC CHECKS
// =============================================================================

async function checkInputAutoZoom(page, result) {
  // iOS Safari auto-zooms on input focus when font-size < 16px.
  const small = await page.evaluate(() => {
    const out = [];
    document
      .querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
      )
      .forEach((el) => {
        const fs = parseFloat(window.getComputedStyle(el).fontSize);
        if (fs < 16) {
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            size: fs,
          });
        }
      });
    return out.slice(0, 5);
  });
  if (small.length) {
    result.addIssue({
      category: "iOS",
      severity: "moderate",
      title: `${small.length} inputs with font-size <16px (iOS auto-zoom)`,
      description: "iOS Safari auto-zooms when focusing inputs <16px, disorienting users.",
      selector: small.map((s) => `${s.tag}[name=${s.name}] (${s.size}px)`).join("; "),
      recommendation: "Set form inputs to font-size: 16px (or larger) to prevent auto-zoom.",
    });
  }
}

async function checkSafeAreaInsets(page, result) {
  // Notched iPhones need viewport-fit=cover + env(safe-area-inset-*) usage.
  const data = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const content = (meta && meta.getAttribute("content")) || "";
    const hasViewportFit = /viewport-fit\s*=\s*cover/i.test(content);
    let usesSafeArea = false;
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (rule.cssText && /env\(\s*safe-area-inset/i.test(rule.cssText)) usesSafeArea = true;
        });
      } catch {
        /* ignore */
      }
    });
    return { hasViewportFit, usesSafeArea };
  });
  if (data.hasViewportFit && !data.usesSafeArea) {
    result.addIssue({
      category: "iOS",
      severity: "minor",
      title: "viewport-fit=cover without safe-area-inset usage",
      description:
        "Page declares viewport-fit=cover but doesn't use env(safe-area-inset-*) anywhere — content may be hidden under the notch/home indicator.",
      recommendation: "Use padding: env(safe-area-inset-*) on header/footer/fixed elements.",
    });
  } else if (!data.hasViewportFit && data.usesSafeArea) {
    result.addIssue({
      category: "iOS",
      severity: "minor",
      title: "safe-area-inset used without viewport-fit=cover",
      description:
        "env(safe-area-inset-*) is in CSS but viewport doesn't declare viewport-fit=cover, so insets resolve to 0.",
      recommendation: "Add viewport-fit=cover to the viewport meta tag.",
    });
  }
}

async function checkAppleMetaTags(page, result) {
  const data = await page.evaluate(() => ({
    appleTouchIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    webAppCapable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
    statusBarStyle: !!document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]'),
  }));
  if (!data.appleTouchIcon) {
    result.addIssue({
      category: "iOS",
      severity: "minor",
      title: "No apple-touch-icon",
      description:
        "Page lacks an apple-touch-icon link — iOS will use a screenshot fallback when added to home screen.",
      recommendation: 'Add: <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    });
  }
}

async function checkTapHighlight(page, result) {
  // Optional but a polish marker — many sites blanket-disable it.
  const blanketDisabled = await page.evaluate(() => {
    let count = 0;
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (
            rule.cssText &&
            /-webkit-tap-highlight-color\s*:\s*(transparent|rgba?\(0,\s*0,\s*0,\s*0\))/i.test(rule.cssText)
          ) {
            if (
              rule.selectorText &&
              (rule.selectorText.includes("*") || rule.selectorText === "html" || rule.selectorText === "body")
            ) {
              count++;
            }
          }
        });
      } catch {
        /* ignore */
      }
    });
    return count;
  });
  if (blanketDisabled > 0) {
    result.addIssue({
      category: "iOS",
      severity: "minor",
      title: "Tap highlight blanket-disabled",
      description: "-webkit-tap-highlight-color: transparent on universal selectors removes touch feedback.",
      recommendation: "Replace with custom :active styles so users still see tap feedback.",
    });
  }
}

// =============================================================================
// LAYOUT / CLS-SOURCE CHECKS
// =============================================================================

async function checkImageDimensions(page, result) {
  // Cross-reference with observed CLS — sites using <picture> + CSS aspect-ratio
  // often "look" like they're missing dimensions but have stable layout.
  const data = await page.evaluate(() => {
    let missing = 0;
    const examples = [];
    document.querySelectorAll("img").forEach((img) => {
      const hasW = img.hasAttribute("width") || !!img.style.width;
      const hasH = img.hasAttribute("height") || !!img.style.height;
      const cs = window.getComputedStyle(img);
      const arOk = cs.aspectRatio && cs.aspectRatio !== "auto";
      // Also accept fixed-pixel CSS sizing (a class set width/height in stylesheet).
      const cssExplicit =
        cs.width !== "auto" && cs.height !== "auto" && !cs.width.endsWith("%") && !cs.height.endsWith("%");
      // Exempt images inside <picture> with explicit sizes attribute on a <source>.
      const inPicture = img.parentElement && img.parentElement.tagName === "PICTURE";
      const pictureSized =
        inPicture &&
        [...img.parentElement.querySelectorAll("source")].some(
          (s) => s.hasAttribute("sizes") || s.hasAttribute("media"),
        );
      if (!(hasW && hasH) && !arOk && !cssExplicit && !pictureSized) {
        missing++;
        if (examples.length < 3) examples.push((img.getAttribute("src") || "").slice(0, 60));
      }
    });
    return { missing, examples };
  });
  // Only flag when CLS shows actual layout shift; otherwise the apparent "missing"
  // dimensions aren't producing user-visible issues.
  const cls = result.metrics.cwv?.cls ?? 0;
  if (data.missing > 2 && cls > 0.05) {
    result.addIssue({
      category: "Layout Shift",
      severity: cls > 0.1 ? "moderate" : "minor",
      title: `${data.missing} images without explicit dimensions (CLS ${cls.toFixed(3)})`,
      description:
        "Images without width/height (or CSS aspect-ratio) likely contribute to the observed Cumulative Layout Shift.",
      selector: data.examples.join(", "),
      recommendation: "Add width/height attributes or aspect-ratio CSS to all <img> elements.",
    });
  }
}

async function checkIframeDimensions(page, result) {
  const missing = await page.evaluate(() => {
    let m = 0;
    document.querySelectorAll("iframe").forEach((f) => {
      const hasW = f.hasAttribute("width") || f.style.width;
      const hasH = f.hasAttribute("height") || f.style.height;
      const cs = window.getComputedStyle(f);
      const cssExplicit = cs.width !== "auto" && cs.height !== "auto" && !cs.height.endsWith("%");
      if (!(hasW && hasH) && !cssExplicit) m++;
    });
    return m;
  });
  const cls = result.metrics.cwv?.cls ?? 0;
  if (missing > 0 && cls > 0.05) {
    result.addIssue({
      category: "Layout Shift",
      severity: "minor",
      title: `${missing} iframes without explicit dimensions`,
      description: "Iframes without width/height likely contribute to the observed Cumulative Layout Shift.",
      recommendation: "Add width and height attributes to all <iframe> elements.",
    });
  }
}

async function checkFontDisplay(page, result) {
  const missing = await page.evaluate(() => {
    let total = 0;
    let withDisplay = 0;
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (rule instanceof CSSFontFaceRule || rule.constructor.name === "CSSFontFaceRule") {
            total++;
            if (rule.style && rule.style.getPropertyValue && rule.style.getPropertyValue("font-display")) {
              withDisplay++;
            } else if (rule.cssText && /font-display\s*:/i.test(rule.cssText)) {
              withDisplay++;
            }
          }
        });
      } catch {
        /* ignore */
      }
    });
    return total - withDisplay;
  });
  if (missing > 0) {
    result.addIssue({
      category: "Layout Shift",
      severity: "minor",
      title: `${missing} @font-face rules missing font-display`,
      description: "Without font-display: swap, web fonts can block text rendering or cause flash of invisible text.",
      recommendation: "Add font-display: swap to @font-face rules.",
    });
  }
}

// =============================================================================
// SEO / META CHECKS
// =============================================================================

async function checkSEO(page, result) {
  const data = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
    robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
    ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "",
    ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "",
    twitterCard: document.querySelector('meta[name="twitter:card"]')?.getAttribute("content") || "",
    charset: document.characterSet,
    htmlLang: document.documentElement.lang || "",
    htmlDir: document.documentElement.dir || "",
  }));
  result.metrics.seo = data;

  if (!data.title) {
    result.addIssue({
      category: "SEO",
      severity: "serious",
      title: "Missing <title>",
      description: "Page has no <title>. Critical for SEO and browser tab labels.",
      recommendation: "Add a unique, descriptive <title> 50-60 characters.",
    });
  } else if (data.title.length > 70) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: `<title> too long (${data.title.length} chars)`,
      description: "Search engines truncate titles around 60 characters.",
      recommendation: "Shorten the page title to under 60 characters.",
    });
  } else if (data.title.length < 4) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: `<title> very short (${data.title.length} chars)`,
      description: "Title too short to be descriptive.",
      recommendation: "Expand the title to be more descriptive.",
    });
  }

  if (!data.description) {
    result.addIssue({
      category: "SEO",
      severity: "moderate",
      title: "Missing meta description",
      description: 'No <meta name="description"> — search engines fabricate snippets.',
      recommendation: "Add a 120-160 character meta description.",
    });
  } else if (data.description.length > 170) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: `Meta description too long (${data.description.length} chars)`,
      description: "Search engines truncate descriptions around 160 characters.",
      recommendation: "Trim meta description to under 160 characters.",
    });
  }

  if (!data.canonical) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: "Missing canonical link",
      description: 'No <link rel="canonical"> — duplicate content risk if URL has variants.',
      recommendation: 'Add <link rel="canonical" href="..."> to the document head.',
    });
  }

  if (!data.htmlLang) {
    result.addIssue({
      category: "SEO",
      severity: "serious",
      title: "<html> missing lang attribute",
      description: "Screen readers can't pick the right voice without lang. Affects SEO and a11y.",
      recommendation: 'Add lang="en" (or appropriate IETF tag) to the <html> element.',
      wcag: "WCAG 3.1.1",
    });
  }

  if (data.charset && data.charset.toLowerCase() !== "utf-8") {
    result.addIssue({
      category: "SEO",
      severity: "moderate",
      title: `Document charset is ${data.charset}`,
      description: "Non-UTF-8 charsets are legacy and can mangle international characters.",
      recommendation: 'Use <meta charset="utf-8"> as the first child of <head>.',
    });
  }

  if (!data.ogTitle && !data.ogImage) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: "No Open Graph metadata",
      description: "Missing og:title/og:image — bare social shares with no preview card.",
      recommendation: 'Add <meta property="og:title">, og:description, og:image (≥1200x630).',
    });
  }

  if (!data.twitterCard) {
    result.addIssue({
      category: "SEO",
      severity: "minor",
      title: "No twitter:card meta",
      description: "Twitter/X falls back to a small preview without an explicit card type.",
      recommendation: 'Add <meta name="twitter:card" content="summary_large_image">.',
    });
  }

  if (data.robots && /noindex|nofollow/i.test(data.robots)) {
    result.addIssue({
      category: "SEO",
      severity: "moderate",
      title: `Robots meta blocks indexing (${data.robots})`,
      description: "Page is excluded from search results — verify this is intentional.",
      recommendation: "Remove noindex/nofollow if the page should be indexed.",
    });
  }
}

// =============================================================================
// PWA CHECKS
// =============================================================================

async function checkPWA(page, result, _mainResponse) {
  const data = await page
    .evaluate(async () => {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      const manifestHref = manifestLink ? manifestLink.getAttribute("href") : null;
      const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") || "";
      const swActive = !!(
        navigator.serviceWorker && (await (navigator.serviceWorker.getRegistrations?.() ?? Promise.resolve([]))).length
      );
      return { manifestHref, themeColor, swActive };
    })
    .catch(() => ({ manifestHref: null, themeColor: "", swActive: false }));

  if (!data.themeColor) {
    result.addIssue({
      category: "PWA",
      severity: "minor",
      title: "Missing theme-color meta",
      description: 'No <meta name="theme-color"> — Chrome/Android won\'t tint the URL bar.',
      recommendation: 'Add <meta name="theme-color" content="#yourbrand">.',
    });
  }

  if (!data.manifestHref) {
    result.addIssue({
      category: "PWA",
      severity: "minor",
      title: "No web app manifest linked",
      description: "Site is not installable as a PWA without a manifest.json.",
      recommendation: 'Add <link rel="manifest" href="/manifest.json"> with name, icons, start_url, display.',
    });
    return;
  }

  // Try to fetch and parse the manifest
  try {
    const manifestUrl = new URL(data.manifestHref, page.url()).href;
    const resp = await page.context().request.get(manifestUrl);
    if (!resp.ok()) {
      result.addIssue({
        category: "PWA",
        severity: "moderate",
        title: `Manifest returned ${resp.status()}`,
        description: `Manifest URL ${manifestUrl} did not return 200.`,
        recommendation: "Make the manifest publicly accessible.",
      });
      return;
    }
    const manifest = await resp.json();
    const required = ["name", "icons", "start_url", "display"];
    const missing = required.filter((k) => !manifest[k] || (Array.isArray(manifest[k]) && !manifest[k].length));
    if (missing.length) {
      result.addIssue({
        category: "PWA",
        severity: "moderate",
        title: `Manifest missing required fields: ${missing.join(", ")}`,
        description: "Web App Manifest is incomplete — install prompt may not appear.",
        recommendation: "Add name, icons (≥192px and ≥512px), start_url, and display fields.",
      });
    }
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const has192 = icons.some((i) => /(^|x)192/.test(i.sizes || ""));
    const has512 = icons.some((i) => /(^|x)512/.test(i.sizes || ""));
    if (!has192 || !has512) {
      result.addIssue({
        category: "PWA",
        severity: "minor",
        title: "Manifest icons missing 192/512 sizes",
        description: "Chrome requires both 192x192 and 512x512 icons for installability.",
        recommendation: "Provide both 192x192 and 512x512 PNG icons in the manifest.",
      });
    }
    const hasMaskable = icons.some((i) => /maskable/.test(i.purpose || ""));
    if (!hasMaskable) {
      result.addIssue({
        category: "PWA",
        severity: "minor",
        title: 'Manifest missing maskable icon (purpose: "maskable")',
        description: "Without a maskable icon, Android home-screen icons may be cropped awkwardly.",
        recommendation: 'Add an icon with "purpose": "maskable" to the manifest.',
      });
    }
  } catch (err) {
    result.addIssue({
      category: "PWA",
      severity: "minor",
      title: "Could not parse manifest.json",
      description: err.message,
      recommendation: "Ensure manifest is valid JSON and reachable.",
    });
  }

  if (!data.swActive) {
    result.metrics.serviceWorker = false;
  } else {
    result.metrics.serviceWorker = true;
  }
}

// =============================================================================
// A11Y SUPPLEMENTARY (beyond Axe)
// =============================================================================

async function checkHeadings(page, result) {
  const data = await page.evaluate(() => {
    const hs = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((el) => parseInt(el.tagName[1]));
    const h1Count = hs.filter((l) => l === 1).length;
    let skipped = 0;
    for (let i = 1; i < hs.length; i++) {
      if (hs[i] - hs[i - 1] > 1) skipped++;
    }
    return { total: hs.length, h1Count, skipped };
  });
  if (data.total === 0) {
    result.addIssue({
      category: "A11y",
      severity: "moderate",
      title: "No headings on the page",
      description: "Page has no <h1>-<h6> — screen reader users have no way to navigate by structure.",
      recommendation: "Add a single <h1> for the page title and use h2/h3 for sections.",
      wcag: "WCAG 2.4.6",
    });
  } else if (data.h1Count === 0) {
    result.addIssue({
      category: "A11y",
      severity: "moderate",
      title: "Page has no <h1>",
      description: "Every page should have exactly one top-level heading.",
      recommendation: "Add a single, descriptive <h1>.",
      wcag: "WCAG 2.4.6",
    });
  } else if (data.h1Count > 1) {
    result.addIssue({
      category: "A11y",
      severity: "minor",
      title: `Page has ${data.h1Count} <h1> elements`,
      description: "Multiple <h1>s blur the document outline for screen readers.",
      recommendation: "Use exactly one <h1>; switch lower headings to <h2>/<h3>.",
    });
  }
  if (data.skipped > 0) {
    result.addIssue({
      category: "A11y",
      severity: "minor",
      title: `${data.skipped} skipped heading levels`,
      description: "Heading levels increase by more than one (e.g., h2 → h4), confusing structure navigation.",
      recommendation: "Don't skip heading levels — restructure or reassign.",
      wcag: "WCAG 2.4.6",
    });
  }
}

async function checkSkipLink(page, result) {
  const hasSkip = await page.evaluate(() => {
    const links = [...document.querySelectorAll("body a")].slice(0, 5);
    return links.some((a) => /skip|jump.*content|skip.*nav/i.test(a.textContent));
  });
  if (!hasSkip) {
    result.addIssue({
      category: "A11y",
      severity: "minor",
      title: "No skip-to-content link",
      description: "Keyboard users have to tab through nav on every page without a skip link.",
      recommendation: 'Add <a href="#main" class="skip-link">Skip to content</a> as the first body element.',
      wcag: "WCAG 2.4.1",
    });
  }
}

async function checkFormLabels(page, result) {
  const data = await page.evaluate(() => {
    let unlabeled = 0;
    const examples = [];
    document
      .querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')
      .forEach((el) => {
        const id = el.getAttribute("id");
        const ariaLabel = el.getAttribute("aria-label");
        const ariaLabelledBy = el.getAttribute("aria-labelledby");
        const wrapping = el.closest("label");
        const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (!wrapping && !explicit && !ariaLabel && !ariaLabelledBy) {
          unlabeled++;
          if (examples.length < 3) examples.push(`${el.tagName.toLowerCase()}[name=${el.getAttribute("name") || "?"}]`);
        }
      });
    return { unlabeled, examples };
  });
  if (data.unlabeled > 0) {
    result.addIssue({
      category: "A11y",
      severity: "serious",
      title: `${data.unlabeled} form fields without labels`,
      description: "Inputs without <label> / aria-label are unidentifiable to screen readers.",
      selector: data.examples.join(", "),
      recommendation: "Wrap with <label>, link via for/id, or add aria-label/aria-labelledby.",
      wcag: "WCAG 1.3.1, 4.1.2",
    });
  }
}

async function checkFocusVisible(page, result) {
  // Has anyone defined :focus-visible styles? Heuristic.
  const hasFocusStyles = await page.evaluate(() => {
    let count = 0;
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (rule.selectorText && /:focus(-visible)?/.test(rule.selectorText)) count++;
        });
      } catch {
        /* ignore */
      }
    });
    return count;
  });
  if (hasFocusStyles === 0) {
    result.addIssue({
      category: "A11y",
      severity: "moderate",
      title: "No :focus or :focus-visible styles defined",
      description: "Keyboard users can't see where focus is. Browser defaults are often suppressed by resets.",
      recommendation: "Add visible :focus-visible outline styles for interactive elements.",
      wcag: "WCAG 2.4.7",
    });
  }
}

async function checkReducedMotion(page, result) {
  const data = await page.evaluate(() => {
    let foundRules = 0;
    let unreadableSheets = 0;
    [...document.styleSheets].forEach((sheet) => {
      try {
        [...sheet.cssRules].forEach((rule) => {
          if (rule.cssText && /prefers-reduced-motion/.test(rule.cssText)) foundRules++;
        });
      } catch {
        // Cross-origin sheet: we can't introspect. Many CDN-hosted CSS files trip this.
        unreadableSheets++;
      }
    });
    let animated = 0;
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      if (
        (s.animationName && s.animationName !== "none") ||
        (s.transitionDuration && parseFloat(s.transitionDuration) > 0.5)
      ) {
        animated++;
      }
    });
    return { foundRules, unreadableSheets, animated };
  });
  // Benefit of the doubt: skip the check if we can't read all stylesheets.
  // The reduced-motion rule may live in a cross-origin sheet we can't introspect.
  if (data.unreadableSheets > 0) {
    result.metrics.reducedMotionUncheckable = true;
    return;
  }
  if (data.animated > 5 && data.foundRules === 0) {
    result.addIssue({
      category: "A11y",
      severity: "moderate",
      title: "Animations present but no prefers-reduced-motion handler",
      description: `${data.animated} animated elements detected but no @media (prefers-reduced-motion: reduce) rules.`,
      recommendation: "Wrap motion in @media (prefers-reduced-motion: reduce) { ... } and disable.",
      wcag: "WCAG 2.3.3",
    });
  }
}

async function checkLandmarks(page, result) {
  const data = await page.evaluate(() => ({
    main: document.querySelectorAll('main, [role="main"]').length,
    nav: document.querySelectorAll('nav, [role="navigation"]').length,
    header: document.querySelectorAll('body > header, [role="banner"]').length,
    footer: document.querySelectorAll('body > footer, [role="contentinfo"]').length,
  }));
  if (data.main === 0) {
    result.addIssue({
      category: "A11y",
      severity: "moderate",
      title: "No <main> landmark",
      description: "Screen reader users rely on <main> to skip past navigation directly to content.",
      recommendation: 'Wrap primary content in <main> (or role="main").',
      wcag: "WCAG 1.3.1",
    });
  }
  if (data.main > 1) {
    result.addIssue({
      category: "A11y",
      severity: "minor",
      title: `${data.main} <main> landmarks`,
      description: "Only one <main> should exist per page.",
      recommendation: "Reduce to a single <main>.",
    });
  }
}

// =============================================================================
// SECURITY CHECKS
// =============================================================================

async function checkSecurity(page, result, mainResponse) {
  const url = page.url();
  if (!url.startsWith("https:")) {
    result.addIssue({
      category: "Security",
      severity: "critical",
      title: "Page served over HTTP, not HTTPS",
      description: "Plain HTTP exposes traffic to interception and downgrades search ranking.",
      recommendation: "Serve all content over HTTPS, redirect HTTP→HTTPS, set HSTS.",
    });
  }

  // Mixed content: http: subresources on https: page
  const mixed = await page.evaluate(() => {
    if (location.protocol !== "https:") return [];
    const out = [];
    document.querySelectorAll("script[src], link[href], img[src], iframe[src]").forEach((el) => {
      const attr = el.tagName === "LINK" ? "href" : "src";
      const v = el.getAttribute(attr);
      if (v && /^http:\/\//i.test(v)) out.push(`${el.tagName.toLowerCase()}: ${v.slice(0, 60)}`);
    });
    return out.slice(0, 5);
  });
  if (mixed.length) {
    result.addIssue({
      category: "Security",
      severity: "serious",
      title: `${mixed.length} mixed-content resources`,
      description: "Subresources loaded over HTTP on an HTTPS page. Browsers block or warn.",
      selector: mixed.join("; "),
      recommendation: "Update all subresource URLs to https:// (or use protocol-relative).",
    });
  }

  // Response headers (only if we captured the navigation response)
  if (mainResponse) {
    try {
      const headers = await mainResponse.allHeaders();
      result.metrics.securityHeaders = {};
      const checks = [
        [
          "strict-transport-security",
          "HSTS missing",
          "minor",
          "Add Strict-Transport-Security: max-age=31536000; includeSubDomains.",
        ],
        [
          "content-security-policy",
          "Content-Security-Policy missing",
          "minor",
          "Add a CSP header limiting script sources.",
        ],
        ["x-content-type-options", "X-Content-Type-Options missing", "minor", "Add X-Content-Type-Options: nosniff."],
        [
          "referrer-policy",
          "Referrer-Policy missing",
          "minor",
          "Add Referrer-Policy: strict-origin-when-cross-origin.",
        ],
        [
          "x-frame-options",
          "X-Frame-Options/CSP frame-ancestors missing",
          "minor",
          "Add X-Frame-Options: SAMEORIGIN or CSP frame-ancestors.",
        ],
      ];
      const cspFrameAncestors = (headers["content-security-policy"] || "").includes("frame-ancestors");
      for (const [hdr, title, severity, rec] of checks) {
        const present = !!headers[hdr];
        result.metrics.securityHeaders[hdr] = present;
        if (!present) {
          if (hdr === "x-frame-options" && cspFrameAncestors) continue;
          result.addIssue({
            category: "Security",
            severity,
            title,
            description: `Response header "${hdr}" not set on the main document.`,
            recommendation: rec,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Subresource Integrity on cross-origin scripts
  const sriMissing = await page.evaluate(() => {
    const out = [];
    const here = location.host;
    document.querySelectorAll("script[src]").forEach((s) => {
      const src = s.getAttribute("src") || "";
      try {
        const u = new URL(src, location.href);
        if (u.host !== here && !s.hasAttribute("integrity")) {
          out.push(u.href.slice(0, 60));
        }
      } catch {
        /* ignore */
      }
    });
    return out.slice(0, 5);
  });
  if (sriMissing.length) {
    result.addIssue({
      category: "Security",
      severity: "minor",
      title: `${sriMissing.length} cross-origin scripts without SRI`,
      description: "Cross-origin <script> tags have no integrity= hash — supply-chain compromise risk.",
      selector: sriMissing.join("; "),
      recommendation: 'Add integrity="sha384-..." and crossorigin="anonymous" attributes.',
    });
  }
}

// =============================================================================
// CORE WEB VITALS
// =============================================================================

async function installWebVitalsObserver(page) {
  await page.addInitScript(() => {
    window.__webVitals = { lcp: 0, cls: 0, fcp: 0, longTasks: 0, longTaskTotal: 0 };
    if (typeof PerformanceObserver === "undefined") return;
    const safeObserve = (type, cb) => {
      try {
        new PerformanceObserver(cb).observe({ type, buffered: true });
      } catch {
        /* ignore */
      }
    };
    safeObserve("largest-contentful-paint", (list) => {
      for (const e of list.getEntries()) {
        if (e.startTime > window.__webVitals.lcp) window.__webVitals.lcp = e.startTime;
      }
    });
    safeObserve("layout-shift", (list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) window.__webVitals.cls += e.value;
      }
    });
    safeObserve("paint", (list) => {
      for (const e of list.getEntries()) {
        if (e.name === "first-contentful-paint") window.__webVitals.fcp = e.startTime;
      }
    });
    safeObserve("longtask", (list) => {
      for (const e of list.getEntries()) {
        window.__webVitals.longTasks++;
        window.__webVitals.longTaskTotal += e.duration;
      }
    });
  });
}

async function collectWebVitals(page, result) {
  // Wait for load event then poll until LCP and CLS stop changing for 1s, capped at 8s total.
  await page.waitForLoadState("load").catch(() => {});
  let prev = { lcp: -1, cls: -1 };
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await page.waitForTimeout(1000);
    const cur = await page
      .evaluate(() => ({
        lcp: window.__webVitals?.lcp ?? 0,
        cls: window.__webVitals?.cls ?? 0,
      }))
      .catch(() => prev);
    if (cur.lcp === prev.lcp && cur.cls === prev.cls) break;
    prev = cur;
  }
  const cwv = await page.evaluate(() => window.__webVitals).catch(() => null);
  if (!cwv) return;
  result.metrics.cwv = cwv;

  // Thresholds: Google's "Good" cutoffs
  if (cwv.lcp > 2500) {
    result.addIssue({
      category: "Core Web Vitals",
      severity: cwv.lcp > 4000 ? "serious" : "moderate",
      title: `LCP ${Math.round(cwv.lcp)}ms (target ≤2500ms)`,
      description: "Largest Contentful Paint exceeds Google's 'Good' threshold.",
      recommendation: "Optimize the LCP element: priority hints, smaller images, preload, server-push.",
    });
  }
  if (cwv.cls > 0.1) {
    result.addIssue({
      category: "Core Web Vitals",
      severity: cwv.cls > 0.25 ? "serious" : "moderate",
      title: `CLS ${cwv.cls.toFixed(3)} (target ≤0.1)`,
      description: "Cumulative Layout Shift indicates content jumps during load.",
      recommendation: "Reserve space for images/embeds; avoid inserting content above existing content.",
    });
  }
  if (cwv.fcp > 1800) {
    result.addIssue({
      category: "Core Web Vitals",
      severity: cwv.fcp > 3000 ? "moderate" : "minor",
      title: `FCP ${Math.round(cwv.fcp)}ms (target ≤1800ms)`,
      description: "First Contentful Paint slower than Google's 'Good' threshold.",
      recommendation: "Reduce render-blocking resources, inline critical CSS, eliminate redirects.",
    });
  }
  if (cwv.longTaskTotal > 600) {
    result.addIssue({
      category: "Core Web Vitals",
      severity: cwv.longTaskTotal > 1200 ? "serious" : "moderate",
      title: `Total Blocking Time ~${Math.round(cwv.longTaskTotal)}ms`,
      description: `${cwv.longTasks} long tasks (>50ms) blocked the main thread during load.`,
      recommendation: "Break up long JS tasks, defer non-critical scripts, code-split bundles.",
    });
  }
}

// =============================================================================
// PERFORMANCE
// =============================================================================

async function collectPerformance(page, result) {
  const timing = await page.evaluate(() => {
    const perf = performance.getEntriesByType("navigation")[0];
    if (!perf) return null;
    return {
      dns: perf.domainLookupEnd - perf.domainLookupStart,
      tcp: perf.connectEnd - perf.connectStart,
      ttfb: perf.responseStart - perf.requestStart,
      domLoad: perf.domContentLoadedEventEnd - perf.startTime,
      fullLoad: perf.loadEventEnd - perf.startTime,
      transferSize: perf.transferSize,
    };
  });
  if (timing) {
    result.metrics.timing = timing;
    if ((timing.ttfb || 0) > 600) {
      result.addIssue({
        category: "Performance",
        severity: "moderate",
        title: `Slow Time to First Byte (${Math.round(timing.ttfb)}ms)`,
        description: "Server response time is higher than recommended 600ms.",
        recommendation: "Optimize server-side processing, consider caching.",
      });
    }
    if ((timing.domLoad || 0) > 3000) {
      result.addIssue({
        category: "Performance",
        severity: "serious",
        title: `Slow DOM Content Loaded (${Math.round(timing.domLoad)}ms)`,
        description: "Page takes too long to become interactive on mobile.",
        recommendation: "Reduce JavaScript, defer non-critical resources.",
      });
    }
  }

  const resources = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource");
    const nav = performance.getEntriesByType("navigation")[0];
    const docSize = (nav && nav.transferSize) || 0;
    const stats = { total: entries.length, js: 0, css: 0, img: 0, font: 0, other: 0 };
    let subSize = 0;
    let imgSize = 0;
    let jsSize = 0;
    entries.forEach((e) => {
      const sz = e.transferSize || 0;
      subSize += sz;
      if (e.initiatorType === "script") {
        stats.js++;
        jsSize += sz;
      } else if (e.initiatorType === "css" || e.name.includes(".css")) stats.css++;
      else if (e.initiatorType === "img") {
        stats.img++;
        imgSize += sz;
      } else if (e.name.includes("font") || e.name.includes("woff")) stats.font++;
      else stats.other++;
    });
    stats.docSizeKB = Math.round(docSize / 1024);
    stats.subSizeKB = Math.round(subSize / 1024);
    stats.totalSizeKB = Math.round((docSize + subSize) / 1024);
    stats.imgSizeKB = Math.round(imgSize / 1024);
    stats.jsSizeKB = Math.round(jsSize / 1024);
    return stats;
  });
  if (resources) {
    result.metrics.resources = resources;
    if (resources.total > 100) {
      result.addIssue({
        category: "Performance",
        severity: "moderate",
        title: `High resource count (${resources.total} requests)`,
        description: "Too many HTTP requests slow down mobile loading.",
        recommendation: "Bundle resources, use sprites, reduce third-party scripts.",
      });
    }
    if ((resources.totalSizeKB || 0) > 3000) {
      result.addIssue({
        category: "Performance",
        severity: "serious",
        title: `Large page weight (${resources.totalSizeKB}KB)`,
        description: "Page size exceeds 3MB, causing slow loads on mobile networks.",
        recommendation: "Compress images, minify code, remove unused resources.",
      });
    }
    if ((resources.jsSizeKB || 0) > 500) {
      result.addIssue({
        category: "Performance",
        severity: "moderate",
        title: `JavaScript bundle ${resources.jsSizeKB}KB`,
        description: "JS payload exceeds 500KB. Slows parse, compile, and execute on low-end devices.",
        recommendation: "Code-split, tree-shake, lazy-load below-the-fold logic.",
      });
    }
    if ((resources.imgSizeKB || 0) > 1500) {
      result.addIssue({
        category: "Performance",
        severity: "moderate",
        title: `Image payload ${resources.imgSizeKB}KB`,
        description: "Images dominate the page weight.",
        recommendation: "Use AVIF/WebP, responsive srcset, and lazy-loading.",
      });
    }
  }
}

async function checkRenderBlocking(page, result) {
  // Stylesheets and scripts in <head> without async/defer or media-query non-blocking are render-blocking.
  const blocking = await page.evaluate(() => {
    const head = document.head;
    let blockingCss = 0;
    let blockingJs = 0;
    head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
      const media = l.getAttribute("media") || "all";
      if (media === "all" || media === "screen" || media.includes("screen")) blockingCss++;
    });
    head.querySelectorAll("script[src]").forEach((s) => {
      if (!s.hasAttribute("async") && !s.hasAttribute("defer") && s.getAttribute("type") !== "module") blockingJs++;
    });
    return { blockingCss, blockingJs };
  });
  if (blocking.blockingJs > 2) {
    result.addIssue({
      category: "Performance",
      severity: "moderate",
      title: `${blocking.blockingJs} render-blocking <script> tags in <head>`,
      description: "Scripts without async/defer block parsing of the rest of the document.",
      recommendation: "Add async or defer attributes, or move scripts to end of <body>.",
    });
  }
  if (blocking.blockingCss > 4) {
    result.addIssue({
      category: "Performance",
      severity: "minor",
      title: `${blocking.blockingCss} render-blocking stylesheets`,
      description: "Many stylesheets in <head> delay first paint.",
      recommendation: "Inline critical CSS, async-load non-critical via media swap.",
    });
  }
}

async function checkResourceHints(page, result) {
  const hints = await page.evaluate(() => ({
    preconnect: document.querySelectorAll('link[rel="preconnect"]').length,
    preload: document.querySelectorAll('link[rel="preload"]').length,
    dnsPrefetch: document.querySelectorAll('link[rel="dns-prefetch"]').length,
    crossOriginScripts: [...document.querySelectorAll("script[src]")].filter((s) => {
      try {
        return new URL(s.src, location.href).host !== location.host;
      } catch {
        return false;
      }
    }).length,
  }));
  result.metrics.resourceHints = hints;
  if (hints.crossOriginScripts > 3 && hints.preconnect === 0 && hints.dnsPrefetch === 0) {
    result.addIssue({
      category: "Performance",
      severity: "minor",
      title: "No preconnect/dns-prefetch despite 3+ cross-origin scripts",
      description: "Browsers waste round-trips on DNS+TCP+TLS for each unknown origin.",
      recommendation: 'Add <link rel="preconnect" href="https://...">  for top third-party origins.',
    });
  }
}

// =============================================================================
// AXE
// =============================================================================

async function runAxe(page, result) {
  try {
    const axe = await new AxeBuilder({ page }).analyze();
    for (const v of axe.violations || []) {
      result.addIssue({
        category: "Accessibility",
        severity: v.impact || "moderate",
        title: v.help || "Unknown issue",
        description: v.description || "",
        selector: v.nodes?.[0]?.target?.[0] || "",
        recommendation: v.helpUrl || "",
        wcag: (v.tags || []).slice(0, 3).join(", "),
      });
    }
    result.metrics.axePassCount = (axe.passes || []).length;
    result.metrics.axeViolationCount = (axe.violations || []).length;
  } catch (err) {
    log(`⚠️  Axe error: ${err.message}`);
  }
}

// =============================================================================
// REPORTS
// =============================================================================

export function toJSON(result) {
  const [grade] = getGrade(result.score);
  return JSON.stringify(
    {
      url: result.url,
      device: result.device,
      timestamp: result.timestamp,
      viewport: result.viewport,
      score: result.score,
      grade,
      issues: result.issues,
      metrics: result.metrics,
    },
    null,
    2,
  );
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toHTML(result) {
  const [grade, gradeEmoji] = getGrade(result.score);
  const colorMap = {
    critical: "#dc3545",
    serious: "#fd7e14",
    moderate: "#ffc107",
    minor: "#17a2b8",
  };
  const cats = {};
  for (const i of result.issues) (cats[i.category] ??= []).push(i);
  const catHtml = Object.keys(cats)
    .sort()
    .map((cat) => {
      const items = cats[cat]
        .map((i) => {
          const c = colorMap[i.severity] || "#6c757d";
          return `
        <div style="border-left: 4px solid ${c}; padding: 10px; margin: 10px 0; background: #f8f9fa;">
          <strong style="color: ${c};">[${i.severity.toUpperCase()}]</strong> ${escapeHtml(i.title)}<br>
          <small>${escapeHtml(i.description)}</small>
          ${i.selector ? `<br><code style="font-size: 12px;">${escapeHtml(i.selector)}</code>` : ""}
          ${i.recommendation ? `<br><em>💡 ${escapeHtml(i.recommendation)}</em>` : ""}
          ${i.wcag ? `<br><small>📖 ${escapeHtml(i.wcag)}</small>` : ""}
        </div>`;
        })
        .join("");
      return `<h3>${escapeHtml(cat)} (${cats[cat].length})</h3>${items}`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mobile Audit Report - ${escapeHtml(result.url)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 880px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 10px; }
    .score { font-size: 56px; font-weight: bold; margin: 8px 0; }
    .grade { font-size: 24px; }
    code { background: #eee; padding: 1px 4px; border-radius: 3px; }
    h3 { margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 20px 0; padding: 16px; background: #f6f6f9; border-radius: 8px; }
    .meta-grid div { font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📱 Mobile Audit Report</h1>
    <p>${escapeHtml(result.url)}</p>
    <p class="score">${result.score}/100</p>
    <p class="grade">${gradeEmoji} Grade: ${grade}</p>
  </div>
  <div class="meta-grid">
    <div><strong>Device:</strong> ${escapeHtml(result.device)}</div>
    <div><strong>Viewport:</strong> ${result.viewport.width}x${result.viewport.height}</div>
    <div><strong>Timestamp:</strong> ${escapeHtml(result.timestamp)}</div>
    <div><strong>Issues:</strong> ${result.issues.length}</div>
  </div>
  ${catHtml || "<p>✅ No issues found!</p>"}
</body>
</html>`;
}

export function toMarkdown(result) {
  const [grade, gradeEmoji] = getGrade(result.score);
  const lines = [];
  lines.push(`# 📱 Mobile Audit Report`);
  lines.push("");
  lines.push(`- **URL**: ${result.url}`);
  lines.push(`- **Device**: ${result.device} (${result.viewport.width}x${result.viewport.height})`);
  lines.push(`- **Score**: **${result.score}/100** ${gradeEmoji} **${grade}**`);
  lines.push(`- **Issues**: ${result.issues.length}`);
  lines.push(`- **Timestamp**: ${result.timestamp}`);
  lines.push("");

  const cats = {};
  for (const i of result.issues) (cats[i.category] ??= []).push(i);
  if (!result.issues.length) {
    lines.push("✅ No issues found.");
  } else {
    for (const cat of Object.keys(cats).sort()) {
      lines.push(`## ${cat} (${cats[cat].length})`);
      lines.push("");
      for (const i of cats[cat]) {
        lines.push(`### ${SEVERITY_EMOJI[i.severity] || "⚪"} [${i.severity}] ${i.title}`);
        if (i.description) lines.push(i.description);
        if (i.selector) lines.push(`\n\`\`\`\n${i.selector}\n\`\`\``);
        if (i.recommendation) lines.push(`\n💡 ${i.recommendation}`);
        if (i.wcag) lines.push(`\n📖 ${i.wcag}`);
        lines.push("");
      }
    }
  }

  if (result.metrics.cwv) {
    const c = result.metrics.cwv;
    lines.push("## Core Web Vitals");
    lines.push("");
    lines.push(`- **LCP**: ${Math.round(c.lcp)}ms`);
    lines.push(`- **CLS**: ${c.cls.toFixed(3)}`);
    lines.push(`- **FCP**: ${Math.round(c.fcp)}ms`);
    lines.push(`- **Long-task TBT**: ${Math.round(c.longTaskTotal)}ms across ${c.longTasks} task(s)`);
    lines.push("");
  }
  if (result.metrics.timing) {
    const t = result.metrics.timing;
    lines.push("## Performance");
    lines.push("");
    lines.push(`- **TTFB**: ${Math.round(t.ttfb)}ms`);
    lines.push(`- **DOM Loaded**: ${Math.round(t.domLoad)}ms`);
    lines.push(`- **Full Load**: ${Math.round(t.fullLoad)}ms`);
    lines.push("");
  }
  if (result.metrics.resources) {
    const r = result.metrics.resources;
    lines.push(`## Resources`);
    lines.push("");
    lines.push(`- **Total**: ${r.total} requests / ${r.totalSizeKB || 0}KB`);
    lines.push(`- **JS**: ${r.js} (${r.jsSizeKB || 0}KB)`);
    lines.push(`- **Images**: ${r.img} (${r.imgSizeKB || 0}KB)`);
    lines.push(`- **CSS**: ${r.css} | **Fonts**: ${r.font} | **Other**: ${r.other}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function printConsoleReport(result) {
  const [grade, emoji] = getGrade(result.score);
  console.log("\n" + "=".repeat(60));
  console.log("📱 MOBILE AUDIT REPORT");
  console.log("=".repeat(60));
  console.log(`URL: ${result.url}`);
  console.log(`Device: ${result.device}`);
  console.log(`Viewport: ${result.viewport.width}x${result.viewport.height}`);
  console.log(`Timestamp: ${result.timestamp}`);
  console.log();
  console.log(`SCORE: ${result.score}/100  ${emoji} Grade: ${grade}`);
  console.log("-".repeat(60));

  if (!result.issues.length) {
    console.log("\n✅ No issues found! Page appears mobile-friendly.");
  } else {
    const cats = {};
    for (const i of result.issues) (cats[i.category] ??= []).push(i);
    console.log(`\n📋 Found ${result.issues.length} issues in ${Object.keys(cats).length} categories:\n`);
    for (const cat of Object.keys(cats).sort()) {
      console.log(`\n▸ ${cat.toUpperCase()} (${cats[cat].length} issues)`);
      for (const i of cats[cat]) {
        console.log(`  ${SEVERITY_EMOJI[i.severity] || "⚪"} [${i.severity.toUpperCase()}] ${i.title}`);
        if (i.description) console.log(`     ${i.description}`);
        if (i.selector) console.log(`     📍 ${i.selector.slice(0, 80)}`);
        if (i.recommendation) console.log(`     💡 ${i.recommendation}`);
        if (i.wcag) console.log(`     📖 ${i.wcag}`);
      }
    }
  }

  if (result.metrics.cwv) {
    const c = result.metrics.cwv;
    console.log("\n" + "-".repeat(60));
    console.log("🎯 CORE WEB VITALS");
    console.log(`   LCP: ${Math.round(c.lcp)}ms (${c.lcp <= 2500 ? "✅ good" : c.lcp <= 4000 ? "⚠️ ni" : "❌ poor"})`);
    console.log(`   CLS: ${c.cls.toFixed(3)} (${c.cls <= 0.1 ? "✅ good" : c.cls <= 0.25 ? "⚠️ ni" : "❌ poor"})`);
    console.log(`   FCP: ${Math.round(c.fcp)}ms`);
    console.log(`   TBT (long-task): ${Math.round(c.longTaskTotal)}ms across ${c.longTasks} task(s)`);
  }
  if (result.metrics.timing) {
    const t = result.metrics.timing;
    console.log("\n⚡ PERFORMANCE");
    console.log(`   TTFB: ${Math.round(t.ttfb || 0)}ms`);
    console.log(`   DOM Loaded: ${Math.round(t.domLoad || 0)}ms`);
    console.log(`   Full Load: ${Math.round(t.fullLoad || 0)}ms`);
  }
  if (result.metrics.resources) {
    const r = result.metrics.resources;
    console.log(
      `\n📦 RESOURCES: ${r.total + 1} requests (${r.totalSizeKB || 0}KB total — doc ${r.docSizeKB || 0}KB + ${r.subSizeKB || 0}KB subresources)`,
    );
    console.log(
      `   JS: ${r.js} (${r.jsSizeKB || 0}KB) | CSS: ${r.css} | Images: ${r.img} (${r.imgSizeKB || 0}KB) | Fonts: ${r.font}`,
    );
  }
  console.log("\n" + "=".repeat(60));
  return result.score;
}

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export async function audit(
  url,
  {
    device = "iphone_13",
    headless = true,
    timeout = 30000,
    headers = {},
    cookies = [],
    userAgent,
    screenshot,
    enable = {
      axe: true,
      mobile: true,
      ios: true,
      layout: true,
      seo: true,
      pwa: true,
      a11y2: true,
      security: true,
      perf: true,
      cwv: true,
    },
    throttle = null,
  } = {},
) {
  const deviceName = DEVICE_PROFILES[device] || device;
  const deviceConfig = devices[deviceName];
  if (!deviceConfig) throw new Error(`Unknown Playwright device: ${deviceName}`);

  const browser = await launchMobileAuditBrowser({ headless });
  const contextOpts = { ...deviceConfig };
  if (userAgent) contextOpts.userAgent = userAgent;
  if (Object.keys(headers).length) contextOpts.extraHTTPHeaders = headers;
  const context = await browser.newContext(contextOpts);
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();

  if (throttle) {
    // CDP-based network throttling. Profiles match Lighthouse's standard
    // presets so numbers are comparable to Lighthouse runs.
    const profiles = {
      "3g-slow": { downloadKbps: 400, uploadKbps: 400, latencyMs: 400 },
      "3g": { downloadKbps: 1600, uploadKbps: 750, latencyMs: 150 },
      "4g": { downloadKbps: 9000, uploadKbps: 9000, latencyMs: 170 },
      wifi: { downloadKbps: 30000, uploadKbps: 15000, latencyMs: 2 },
    };
    const profile = profiles[throttle] ?? profiles["3g"];
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: (profile.downloadKbps * 1024) / 8,
      uploadThroughput: (profile.uploadKbps * 1024) / 8,
    });
  }

  const result = createResult({
    url,
    device: deviceName,
    viewport: { width: deviceConfig.viewport.width, height: deviceConfig.viewport.height },
  });

  log(`📱 Auditing ${url}`);
  log(`   Device: ${deviceName}`);
  log(`   Viewport: ${result.viewport.width}x${result.viewport.height}\n`);

  let mainResponse = null;
  page.on("response", (resp) => {
    if (!mainResponse && resp.url() === url) mainResponse = resp;
  });

  try {
    if (enable.cwv) await installWebVitalsObserver(page);

    let response;
    try {
      response = await page.goto(url, { waitUntil: "networkidle", timeout });
    } catch (err) {
      log(`⚠️  Page load warning: ${err.message}`);
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 15000) });
      } catch (err2) {
        result.addIssue({
          category: "Connectivity",
          severity: "critical",
          title: "Page failed to load",
          description: err2.message,
        });
        result.score = computeScore(result.issues);
        return result;
      }
    }
    if (!mainResponse && response) mainResponse = response;

    if (mainResponse) {
      const status = mainResponse.status();
      result.metrics.httpStatus = status;
      if (status >= 400) {
        result.addIssue({
          category: "Connectivity",
          severity: status >= 500 ? "critical" : "serious",
          title: `HTTP ${status} response`,
          description: `Page returned ${status} ${mainResponse.statusText()}.`,
          recommendation: "Verify URL and server health.",
        });
      }
    }

    if (enable.axe) {
      log("🔍 Running accessibility audit (Axe)...");
      await safe("axe", () => runAxe(page, result));
    }
    if (enable.mobile) {
      log("📲 Mobile UX heuristics...");
      await safe("viewport", () => checkViewportMeta(page, result));
      await safe("touch-targets", () => checkTouchTargets(page, result));
      await safe("tap-spacing", () => checkTapSpacing(page, result));
      await safe("target-offset", () => checkTargetOffset(page, result));
      await safe("horizontal-scroll", () => checkHorizontalScroll(page, result));
      await safe("interstitials", () => checkIntrusiveInterstitials(page, result));
      await safe("hover", () => checkHoverDependency(page, result));
      await safe("text-clipping", () => checkTextClipping(page, result));
      await safe("line-height", () => checkLineHeight(page, result));
      await safe("visual-overlap", () => checkVisualOverlap(page, result));
      await safe("font-sizes", () => checkFontSizes(page, result));
      await safe("form-inputs", () => checkFormInputs(page, result));
      await safe("images", () => checkImages(page, result));
      await safe("orientation", () => checkOrientation(page, result));
      await safe("fixed-elements", () => checkFixedElements(page, result));
      await safe("text-contrast", () => checkTextContrast(page, result));
    }
    if (enable.ios) {
      log("🍎 iOS-specific checks...");
      await safe("ios-input-zoom", () => checkInputAutoZoom(page, result));
      await safe("ios-safe-area", () => checkSafeAreaInsets(page, result));
      await safe("ios-meta", () => checkAppleMetaTags(page, result));
      await safe("ios-tap-highlight", () => checkTapHighlight(page, result));
    }
    // CWV must run before layout-shift checks — they cross-reference observed CLS.
    if (enable.cwv) {
      log("🎯 Core Web Vitals...");
      await safe("cwv", () => collectWebVitals(page, result));
    }
    if (enable.layout) {
      log("📐 Layout / CLS source checks...");
      await safe("img-dims", () => checkImageDimensions(page, result));
      await safe("iframe-dims", () => checkIframeDimensions(page, result));
      await safe("font-display", () => checkFontDisplay(page, result));
    }
    if (enable.seo) {
      log("🔎 SEO / meta checks...");
      await safe("seo", () => checkSEO(page, result));
    }
    if (enable.pwa) {
      log("📲 PWA checks...");
      await safe("pwa", () => checkPWA(page, result, mainResponse));
    }
    if (enable.a11y2) {
      log("♿ A11y supplementary...");
      await safe("headings", () => checkHeadings(page, result));
      await safe("skip-link", () => checkSkipLink(page, result));
      await safe("form-labels", () => checkFormLabels(page, result));
      await safe("focus-visible", () => checkFocusVisible(page, result));
      await safe("reduced-motion", () => checkReducedMotion(page, result));
      await safe("landmarks", () => checkLandmarks(page, result));
    }
    if (enable.security) {
      log("🔒 Security checks...");
      await safe("security", () => checkSecurity(page, result, mainResponse));
    }
    if (enable.perf) {
      log("⚡ Performance metrics...");
      await safe("perf", () => collectPerformance(page, result));
      await safe("render-blocking", () => checkRenderBlocking(page, result));
      await safe("resource-hints", () => checkResourceHints(page, result));
    }

    if (screenshot) {
      try {
        await page.screenshot({ path: screenshot, fullPage: true });
        log(`📸 Screenshot saved to ${screenshot}`);
      } catch (err) {
        log(`⚠️  Screenshot failed: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Heuristic: many big sites serve a stub page to headless browsers.
  // If the rendered page is implausibly thin, surface a warning so the user
  // doesn't trust the score blindly.
  const r = result.metrics.resources;
  if (r && (r.totalSizeKB || 0) < 50 && r.total < 10) {
    result.metrics.botDetectionSuspected = true;
    result.addIssue({
      category: "Audit Confidence",
      severity: "minor",
      title: "Page response suspiciously small — possible bot-detection shell",
      description: `Document + subresources totaled ${r.totalSizeKB || 0}KB across ${r.total + 1} requests. The site may have served a degraded page to the headless browser. Audit findings may not reflect the real user experience.`,
      recommendation: "Try with --ua to spoof a normal user agent, or run from a non-datacenter IP.",
    });
  }

  result.score = computeScore(result.issues);
  return result;
}

export async function auditMultiple(urls, options = {}) {
  const out = [];
  for (const url of urls) {
    log(`\n${"=".repeat(60)}`);
    out.push(await audit(url, options));
  }
  return out;
}

export async function runAudit({
  urls,
  devices: deviceList = ["iphone_13"],
  format = "console",
  outputFile,
  runs = 1,
  ...rest
} = {}) {
  const results = [];
  for (const device of deviceList) {
    for (const url of urls) {
      if (runs > 1) {
        const runResults = [];
        for (let runIndex = 0; runIndex < runs; runIndex += 1) {
          log(`\n— Run ${runIndex + 1}/${runs} —`);
          runResults.push(await audit(url, { ...rest, device }));
        }
        results.push(aggregateRuns(runResults));
      } else {
        results.push(await audit(url, { ...rest, device }));
      }
    }
  }

  const emit = (text, suffix = "") => {
    if (outputFile && outputFile !== "-") {
      const path =
        deviceList.length > 1 || urls.length > 1 ? outputFile.replace(/(\.[^.]+)?$/, `${suffix}$1`) : outputFile;
      writeFileSync(path, text);
      log(`📄 Saved ${path}`);
    } else if (outputFile === "-") {
      process.stdout.write(text + "\n");
    } else {
      process.stdout.write(text + "\n");
    }
  };

  if (format === "json") {
    if (results.length === 1) emit(toJSON(results[0]));
    else
      emit(
        JSON.stringify(
          results.map((r) => JSON.parse(toJSON(r))),
          null,
          2,
        ),
      );
  } else if (format === "html") {
    for (const r of results) emit(toHTML(r), `-${slug(r.url)}-${slug(r.device)}`);
  } else if (format === "markdown" || format === "md") {
    for (const r of results) emit(toMarkdown(r), `-${slug(r.url)}-${slug(r.device)}`);
  } else {
    for (const r of results) printConsoleReport(r);
  }

  const minScore = results.reduce((m, r) => Math.min(m, r.score), 100);
  return { results, minScore };
}

export async function runMobileAudit({
  urls,
  devices: deviceList = ["iphone_13"],
  reportFormat = "markdown",
  runs = 1,
  quiet = false,
  ...rest
} = {}) {
  if (shouldRunBrowserAuditInNode()) {
    return runMobileAuditInNode({
      urls,
      devices: deviceList,
      reportFormat,
      runs,
      quiet,
      ...rest,
    });
  }

  QUIET = quiet;
  const results = [];
  for (const device of deviceList) {
    for (const url of urls) {
      if (runs > 1) {
        const runResults = [];
        for (let runIndex = 0; runIndex < runs; runIndex += 1) {
          log(`\n— Run ${runIndex + 1}/${runs} —`);
          runResults.push(await audit(url, { ...rest, device }));
        }
        results.push(aggregateRuns(runResults));
      } else {
        results.push(await audit(url, { ...rest, device }));
      }
    }
  }

  const minScore = results.reduce((minimum, result) => Math.min(minimum, result.score), 100);
  return {
    failed: minScore < 60,
    jsonPayload: { minScore, results },
    minScore,
    results,
    report: renderMobileReport(results, reportFormat),
  };
}

function renderMobileReport(results, format) {
  if (format === "json") {
    return `${JSON.stringify(results, null, 2)}\n`;
  }

  if (format === "html") {
    return results.map((result) => toHTML(result)).join("\n");
  }

  if (format === "markdown" || format === "md") {
    return `${results.map((result) => toMarkdown(result)).join("\n\n")}\n`;
  }

  return `${JSON.stringify(results, null, 2)}\n`;
}

// Aggregate N runs of audit() into a single result whose Core Web Vitals
// and timing metrics are reported as p50 / p90 / p95 across runs. Issues are
// taken from the median (p50) run since they're rule outputs, not measurements.
function aggregateRuns(runResults) {
  const median = runResults[Math.floor(runResults.length / 2)];
  const aggregated = { ...median, runs: runResults.length };

  const cwvSamples = runResults.map((r) => r.metrics.cwv).filter(Boolean);
  if (cwvSamples.length) {
    aggregated.metrics = { ...median.metrics };
    aggregated.metrics.cwv = {
      lcp: percentiles(cwvSamples.map((s) => s.lcp ?? 0)),
      fcp: percentiles(cwvSamples.map((s) => s.fcp ?? 0)),
      cls: percentiles(cwvSamples.map((s) => s.cls ?? 0)),
      ttfb: percentiles(cwvSamples.map((s) => s.ttfb ?? 0)),
    };
  }

  const timingSamples = runResults.map((r) => r.metrics.timing).filter(Boolean);
  if (timingSamples.length && aggregated.metrics) {
    aggregated.metrics.timing = {
      ttfb: percentiles(timingSamples.map((s) => s.ttfb ?? 0)),
      fcp: percentiles(timingSamples.map((s) => s.fcp ?? 0)),
      domInteractive: percentiles(timingSamples.map((s) => s.domInteractive ?? 0)),
      domComplete: percentiles(timingSamples.map((s) => s.domComplete ?? 0)),
    };
  }

  // Score: take the p50 score across runs.
  const scores = [...runResults.map((r) => r.score)].sort((a, b) => a - b);
  aggregated.score = scores[Math.floor(scores.length / 2)];
  return aggregated;
}

function percentiles(values) {
  if (!values.length) return { p50: 0, p90: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: pick(50), p90: pick(90), p95: pick(95) };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// =============================================================================
// CLI
// =============================================================================

export function parseMobileAuditArgs(argv) {
  const args = {
    urls: [],
    devices: null,
    device: "iphone_13",
    format: "console",
    outputFile: null,
    screenshot: null,
    timeout: 30000,
    headers: {},
    cookies: [],
    userAgent: null,
    quiet: false,
    enable: {
      axe: true,
      mobile: true,
      ios: true,
      layout: true,
      seo: true,
      pwa: true,
      a11y2: true,
      security: true,
      perf: true,
      cwv: true,
    },
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format" || a === "-f") args.format = argv[++i];
    else if (a === "--output" || a === "-o") args.outputFile = argv[++i];
    else if (a === "--device" || a === "-d") args.device = argv[++i];
    else if (a === "--devices") args.devices = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--screenshot") args.screenshot = argv[++i];
    else if (a === "--timeout") args.timeout = parseInt(argv[++i]);
    else if (a === "--ua") args.userAgent = argv[++i];
    else if (a === "--header") {
      const h = argv[++i];
      const idx = h.indexOf(":");
      if (idx > 0) args.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else if (a === "--cookie") {
      const c = argv[++i];
      const idx = c.indexOf("=");
      if (idx > 0) args.cookies.push({ name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim() });
    } else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--throttle") args.throttle = argv[++i];
    else if (a === "--runs") args.runs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a.startsWith("--no-")) {
      const family = a.slice(5);
      if (family in args.enable) args.enable[family] = false;
    } else if (!a.startsWith("-")) {
      args.urls.push(a);
    }
  }

  // Positional fallback: any positional that matches a device key is the device.
  const realUrls = [];
  for (const u of args.urls) {
    if (DEVICE_PROFILES[u] && !args.devices) {
      args.device = u;
    } else {
      realUrls.push(u);
    }
  }
  args.urls = realUrls;

  if (args.cookies.length) {
    for (const u of args.urls) {
      try {
        const url = new URL(u);
        args.cookies = args.cookies.map((c) => ({ ...c, domain: c.domain || url.hostname, path: c.path || "/" }));
        break;
      } catch {
        /* ignore */
      }
    }
  }
  if (!args.devices) args.devices = [args.device];
  return args;
}

function printHelp() {
  console.log(`audit-mobile — Comprehensive Mobile UX, A11y, SEO, PWA, Perf & Security Auditor

Usage:
  bun packages/connections-arkitect/src/engines/mobile-audit-engine.mjs <url> [url2 ...] [options]

Options:
  -d, --device <name>          Device profile (default: iphone_13)
      --devices a,b,c          Multiple devices in one run
  -f, --format <fmt>           console | json | html | markdown
  -o, --output <file>          Write report to file (- for stdout)
      --screenshot <path>      Save full-page screenshot
      --timeout <ms>           Navigation timeout (default 30000)
      --header "Key: Value"    Extra HTTP header (repeatable)
      --cookie "name=value"    Cookie (repeatable)
      --ua <string>            Override User-Agent
  -q, --quiet                  Suppress progress logs
      --no-<family>            Skip a check family. Families:
                               axe, mobile, ios, layout, seo, pwa,
                               a11y2, security, perf, cwv
      --throttle <profile>     Network throttling. Profiles: 3g-slow, 3g, 4g, wifi
      --runs <N>               Run N times and aggregate Core Web Vitals as p50/p90/p95
  -h, --help                   Show help

Devices: ${Object.keys(DEVICE_PROFILES).join(", ")}

Examples:
  bun run audit:mobile -- https://example.com
  bun run audit:mobile -- https://example.com pixel_7
  bun run audit:mobile -- https://example.com --format json -o tmp/reports/audit-mobile/report.json
  bun run audit:mobile -- https://a.com https://b.com --devices iphone_se,ipad_pro -f html -o tmp/reports/audit-mobile/report.html
  bun run audit:mobile -- https://example.com --no-axe --no-pwa
`);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseMobileAuditArgs(process.argv.slice(2));
  QUIET = args.quiet;
  if (args.help || !args.urls.length) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  runAudit({
    urls: args.urls,
    devices: args.devices,
    format: args.format,
    outputFile: args.outputFile,
    screenshot: args.screenshot,
    timeout: args.timeout,
    headers: args.headers,
    cookies: args.cookies,
    userAgent: args.userAgent,
    enable: args.enable,
    throttle: args.throttle,
    runs: args.runs,
  })
    .then(({ minScore }) => {
      process.exit(minScore >= 60 ? 0 : 1);
    })
    .catch((err) => {
      console.error(`❌ Audit failed: ${err.message}`);
      console.error(err.stack);
      process.exit(2);
    });
}
