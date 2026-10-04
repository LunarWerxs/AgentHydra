/**
 * Dead Component Events — connections-arkitect check
 * ====================================================
 * Detects Vue component event handlers (@mouseenter, @focus, @mouseleave)
 * wired to child components that do not emit those events.
 *
 * This was a real bug where `WorkspaceShellSidebarContent` had hover/focus
 * prefetch handlers on `<AppNavItem>` but the component only emitted
 * `activate` — the prefetch was dead code for months.
 *
 * Rules:
 *   1. dead-component-event
 *      A parent component listens for a DOM event on a child component
 *      that does not declare that event in its `defineEmits`. The handler
 *      will never fire.
 *
 * Scope: src/** and packages/** .vue files. Skips node_modules, dist, .git.
 *
 *   bun packages/connections-arkitect/bin/audit.mjs --check dead-component-events
 */

import fs from "node:fs";
import path from "node:path";

const NATIVE_EVENTS_TO_CHECK = ["mouseenter", "focus", "mouseleave"];

const HTML_TAGS = new Set([
  "div",
  "span",
  "p",
  "a",
  "button",
  "input",
  "img",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "article",
  "table",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "form",
  "label",
  "select",
  "option",
  "template",
  "slot",
  "svg",
  "path",
  "circle",
  "rect",
  "g",
  "defs",
  "clipPath",
  "mask",
  "use",
  "symbol",
  "view",
  "text",
  "tspan",
  "br",
  "hr",
  "pre",
  "code",
  "em",
  "strong",
  "small",
  "dialog",
  "transition",
  "keep-alive",
  "suspense",
  "teleport",
  "component",
]);

const RULES = {
  "dead-component-event": {
    severity: "warning",
    description:
      "Parent component listens for a DOM event on a child component that does not emit it in defineEmits. The handler will never fire.",
  },
};

// ── Parsers ─────────────────────────────────────────────────────────

function parseEmits(source) {
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) return null;

  const script = scriptMatch[1];

  // defineEmits<{ event: [...] }>()
  const emitsTypeMatch = script.match(/defineEmits\s*<\s*\{([^}]*)\}\s*>/);
  if (emitsTypeMatch) {
    const events = new Set();
    const body = emitsTypeMatch[1];
    for (const m of body.matchAll(/['"]?(\w+)['"]?\s*:/g)) {
      events.add(m[1]);
    }
    return events;
  }

  // defineEmits(['event', 'event2'])
  const emitsArrayMatch = script.match(/defineEmits\s*\(\s*\[([^\]]*)\]\s*\)/);
  if (emitsArrayMatch) {
    const events = new Set();
    for (const m of emitsArrayMatch[1].matchAll(/['"](\w+)['"]/g)) {
      events.add(m[1]);
    }
    return events;
  }

  return null;
}

function findComponentEventHandlers(source) {
  const handlers = new Map();
  const templateMatch = source.match(/<template[^>]*>([\s\S]*?)<\/template>/);
  if (!templateMatch) return handlers;

  const template = templateMatch[1];
  const cleaned = template.replace(/<!--[\s\S]*?-->/g, "");

  const tagRegex = /<([A-Z][a-zA-Z]*(?:-[a-zA-Z]+)*)\b([^>]*)>/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(cleaned)) !== null) {
    const componentName = tagMatch[1];
    const attrs = tagMatch[2];

    if (HTML_TAGS.has(componentName)) continue;
    if (!componentName.includes("-") && !/^[A-Z][a-z]/.test(componentName)) continue;

    for (const eventName of NATIVE_EVENTS_TO_CHECK) {
      if (new RegExp(`@${eventName}\\b`).test(attrs)) {
        if (!handlers.has(componentName)) {
          handlers.set(componentName, new Set());
        }
        handlers.get(componentName).add(eventName);
      }
    }
  }

  return handlers;
}

function resolveComponentPath(componentName, fromDir) {
  const kebab = componentName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const patterns = [path.join(fromDir, `${kebab}.vue`), path.join(fromDir, `${kebab}/index.vue`)];

  const componentsDir = path.resolve(fromDir, "../../../");
  patterns.push(path.join(componentsDir, "**", `${kebab}.vue`), path.join(componentsDir, "**", componentName, "*.vue"));

  for (const pattern of patterns) {
    if (pattern.includes("**")) {
      const dir = path.dirname(pattern.replace("**", ""));
      if (fs.existsSync(dir)) {
        const fileName = path.basename(pattern);
        const found = findFile(dir, fileName);
        if (found) return found;
      }
    } else if (fs.existsSync(pattern)) {
      return pattern;
    }
  }

  return null;
}

function findFile(dir, fileName, maxDepth = 4) {
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) return fullPath;
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        const found = findFile(fullPath, fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Permission error, ignore
  }
  return null;
}

// ── File collection ─────────────────────────────────────────────────

function collectVueFiles(dir, files, depth = 0) {
  if (depth > 10) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist" && entry.name !== ".git") {
          collectVueFiles(fullPath, files, depth + 1);
        }
      } else if (entry.name.endsWith(".vue")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Permission error
  }
}

// ── Audit ───────────────────────────────────────────────────────────

export const audit = {
  id: "dead-component-events",
  title: "Dead Component Events",
  category: "architecture",
  defaultConfig: {
    includeInAll: true,
    roots: ["src", "packages"],
    outputPath: "tmp/audits/DEAD_COMPONENT_EVENTS_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;
    const roots = cfg.roots || ["src", "packages"];

    const vueFiles = [];
    for (const r of roots) {
      const dir = path.resolve(root, r);
      if (fs.existsSync(dir)) {
        collectVueFiles(dir, vueFiles);
      }
    }

    // Build emit index: componentName → Set<eventName>
    const emitIndex = new Map();
    for (const filePath of vueFiles) {
      try {
        const source = fs.readFileSync(filePath, "utf8");
        const emits = parseEmits(source);
        if (emits !== null) {
          const componentName = path.basename(filePath, ".vue");
          emitIndex.set(componentName, emits);
          emitIndex.set(filePath, emits);
        }
      } catch {
        // Skip unreadable
      }
    }

    const findings = [];

    for (const filePath of vueFiles) {
      try {
        const source = fs.readFileSync(filePath, "utf8");
        const handlers = findComponentEventHandlers(source);
        if (handlers.size === 0) continue;

        for (const [componentName, eventNames] of handlers) {
          const parentDir = path.dirname(filePath);
          const kebab = componentName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
          let childEmits = emitIndex.get(kebab) || emitIndex.get(componentName);

          if (!childEmits) {
            const resolved = resolveComponentPath(componentName, parentDir);
            if (resolved) childEmits = emitIndex.get(resolved);
          }

          if (!childEmits) {
            for (const [key, emits] of emitIndex) {
              if (typeof key === "string" && key.endsWith(`/${kebab}.vue`)) {
                childEmits = emits;
                break;
              }
            }
          }

          if (!childEmits) continue;

          for (const eventName of eventNames) {
            if (!childEmits.has(eventName)) {
              findings.push({
                ruleId: "dead-component-event",
                severity: RULES["dead-component-event"].severity,
                message: `${componentName} has @${eventName} but does not emit "${eventName}" in defineEmits`,
                filePath: path.relative(root, filePath),
                line: 0,
              });
            }
          }
        }
      } catch {
        // Skip unreadable
      }
    }

    return {
      findings,
      filesScanned: vueFiles.length,
      metadata: {
        componentsIndexed: emitIndex.size,
      },
    };
  },
};

export const metadata = {
  rules: RULES,
};
