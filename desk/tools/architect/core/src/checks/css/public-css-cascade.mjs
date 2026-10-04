import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";

const DEFAULT_COMPONENT_ROOTS = ["src/components/public"];
const DEFAULT_ROUTE_CSS_FILES = [
  "src/styles/shared-declarations.css",
  "src/styles/routes/shared-declarations.css",
  "src/styles/routes/public/hosted-event-foundation.css",
  "src/styles/routes/public/hosted-event.css",
  "src/styles/routes/public/explore-browse.css",
  "src/styles/routes/public/explore-header.css",
  "src/styles/routes/public/myconnect.css",
  "src/styles/routes/public/auth.css",
  "src/styles/routes/public/explore.css",
];
const DEFAULT_VULNERABLE_PROPS = [
  "padding",
  "padding-inline",
  "padding-block",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
  "gap",
  "row-gap",
  "column-gap",
  "border-radius",
  "min-height",
  "height",
  "width",
  "min-width",
  "font-size",
  "line-height",
  "display",
  "align-items",
  "justify-content",
  "white-space",
];
const DEFAULT_UTILITY_CLASS_PREFIXES = [
  "flex",
  "grid",
  "inline-flex",
  "items-",
  "justify-",
  "gap-",
  "w-",
  "min-w-",
  "p-",
  "px-",
  "py-",
  "mt-",
  "mb-",
  "gc-",
  "text-",
  "bg-",
  "border-",
  "rounded-",
  "shadow",
  "opacity",
  "transition",
  "hover:",
  "focus:",
  "block",
  "hidden",
  "shrink-",
  "size-",
  "font-",
  "tracking",
  "uppercase",
  "whitespace",
];

export const audit = {
  id: "public-css-cascade",
  title: "Public CSS Cascade",
  category: "maintainability",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: {
    componentRoots: DEFAULT_COMPONENT_ROOTS,
    routeCssFiles: DEFAULT_ROUTE_CSS_FILES,
    vulnerableProps: DEFAULT_VULNERABLE_PROPS,
    utilityClassPrefixes: DEFAULT_UTILITY_CLASS_PREFIXES,
  },
  async run(context) {
    const findings = runPublicCssCascadeAudit({
      root: context.root,
      componentRoots: context.checkConfig.componentRoots,
      routeCssFiles: context.checkConfig.routeCssFiles,
      vulnerableProps: context.checkConfig.vulnerableProps,
      utilityClassPrefixes: context.checkConfig.utilityClassPrefixes,
    });

    return {
      failed: findings.length > 0,
      jsonPayload: { findings },
      report: renderReport(findings),
    };
  },
};

export function runPublicCssCascadeAudit({
  root,
  componentRoots = DEFAULT_COMPONENT_ROOTS,
  routeCssFiles = DEFAULT_ROUTE_CSS_FILES,
  vulnerableProps = DEFAULT_VULNERABLE_PROPS,
  utilityClassPrefixes = DEFAULT_UTILITY_CLASS_PREFIXES,
}) {
  const publicButtonClasses = collectPublicButtonClasses(root, componentRoots, utilityClassPrefixes);
  const vulnerablePropSet = new Set(vulnerableProps);
  const findings = [];

  for (const cssPath of routeCssFiles) {
    const fullPath = path.resolve(root, cssPath);
    if (!existsSync(fullPath)) continue;

    const cssRoot = postcss.parse(readFileSync(fullPath, "utf8"), { from: fullPath });
    cssRoot.walkRules((rule) => {
      const declarations = [];
      rule.walkDecls((decl) => {
        if (vulnerablePropSet.has(decl.prop) || decl.prop.startsWith("--public-button-")) {
          declarations.push(`${decl.prop}: ${decl.value}`);
        }
      });
      if (declarations.length === 0) return;

      for (const selector of rule.selectors ?? []) {
        const classNames = extractClassNames(selector);
        const publicButtonClass = classNames.find((className) => publicButtonClasses.has(className));
        if (!publicButtonClass) continue;
        if (classNames.includes("public-button")) continue;
        if (compareSpecificity(computeSpecificity(selector), [0, 1, 0]) > 0) continue;

        findings.push({
          filePath: cssPath,
          line: rule.source?.start?.line ?? 1,
          selector,
          publicButtonClass,
          declarations,
          componentUses: [...new Set(publicButtonClasses.get(publicButtonClass) ?? [])],
        });
      }
    });
  }

  return findings;
}

function collectPublicButtonClasses(root, componentRoots, utilityClassPrefixes) {
  const classes = new Map();
  for (const componentRoot of componentRoots) {
    const fullRoot = path.resolve(root, componentRoot);
    if (!existsSync(fullRoot)) continue;
    for (const filePath of walkFiles(fullRoot, ".vue")) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/<PublicButton\b[^>]*(?:\/>|>)/g)) {
        const classMatch = match[0].match(/\bclass\s*=\s*"([^"]+)"/);
        if (!classMatch) continue;
        for (const className of classMatch[1].split(/\s+/).filter(Boolean)) {
          if (!/^[A-Za-z_-][\w-]*$/.test(className)) continue;
          if (utilityClassPrefixes.some((prefix) => className.startsWith(prefix))) continue;
          const entries = classes.get(className) ?? [];
          entries.push(path.relative(root, filePath).replace(/\\/g, "/"));
          classes.set(className, entries);
        }
      }
    }
  }
  return classes;
}

function* walkFiles(directory, extension) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, extension);
    } else if (entry.isFile() && fullPath.endsWith(extension)) {
      yield fullPath;
    }
  }
}

function extractClassNames(selector) {
  return [...selector.matchAll(/\.([A-Za-z_-][\w-]*)/g)].map((match) => match[1]);
}

function computeSpecificity(selector) {
  const normalized = selector.replace(/:is\(([^)]*)\)/g, " $1 ").replace(/:where\(([^)]*)\)/g, " $1 ");
  return [
    (normalized.match(/#[\w-]+/g) ?? []).length,
    (normalized.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length,
    (normalized.match(/(^|[\s>+~])([a-z][\w-]*)/gi) ?? []).length,
  ];
}

function compareSpecificity(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function renderReport(findings) {
  const lines = [];
  lines.push("# Public CSS Cascade Audit");
  lines.push("");
  lines.push(`- Findings: **${findings.length}**`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No public button cascade risks found.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Route CSS selectors that style `PublicButton` custom classes must include `.public-button` or use `--public-button-*` tokens with enough specificity. Production CSS chunks can load public shared button rules after route CSS, so one-class route selectors lose ties.",
  );
  lines.push("");
  for (const finding of findings) {
    lines.push(`- ${finding.filePath}:${finding.line} \`${finding.selector}\``);
    lines.push(`  PublicButton class: \`${finding.publicButtonClass}\``);
    lines.push(`  Declarations: ${finding.declarations.map((decl) => `\`${decl}\``).join(", ")}`);
    lines.push(`  Uses: ${finding.componentUses.map((use) => `\`${use}\``).join(", ")}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
