import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";

const RULES = {
  "desktop-search-idle-outline-visible": {
    severity: "error",
    description: "The light-theme desktop search idle outline must not be fully transparent.",
  },
  "desktop-search-chrome-background-token": {
    severity: "error",
    description: "The desktop search chrome must paint the matching surface background token in each state.",
  },
};

const DESKTOP_SEARCH_BACKGROUND_CONTRACTS = [
  {
    selector: ".desktop-search-surface__chrome",
    property: "background",
    expected: "var(--gc-desktop-search-surface-bg)",
    message: "Desktop search idle chrome must paint the search surface background token.",
  },
  {
    selector: ".desktop-search-surface:hover .desktop-search-surface__chrome",
    property: "background",
    expected: "var(--gc-desktop-search-surface-hover-bg)",
    message: "Desktop search hover chrome must paint the hover surface background token.",
  },
  {
    selector: ".desktop-search-surface:focus-within .desktop-search-surface__chrome",
    property: "background",
    expected: "var(--gc-desktop-search-surface-focus-bg)",
    message: "Desktop search focus chrome must paint the focus surface background token.",
  },
  {
    selector: ".desktop-search-surface__chrome--open",
    property: "background",
    expected: "var(--gc-desktop-search-surface-focus-bg)",
    message: "Desktop search open chrome must paint the focus surface background token.",
  },
];

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function normalizeCssValue(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isFullyTransparentValue(value) {
  const normalized = normalizeCssValue(value);
  return (
    normalized === "transparent" ||
    /^rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?\)$/.test(normalized) ||
    /^rgb\([^/]+\/\s*0(?:%|\.0+)?\)$/.test(normalized)
  );
}

function selectorsForRule(rule) {
  return rule.selectors ?? rule.selector.split(",").map((selector) => selector.trim());
}

function isDarkThemeContext(node) {
  for (let current = node; current; current = current.parent) {
    if (current.type !== "rule") continue;
    if (/\[data-resolved-theme=["']dark["']\]|(?:^|[\s,.]):?\.dark\b/.test(current.selector)) {
      return true;
    }
  }
  return false;
}

function readCss(root, relPath, findings) {
  const absolutePath = path.resolve(root, relPath);
  if (!existsSync(absolutePath)) {
    findings.push({
      ruleId: "desktop-search-chrome-background-token",
      severity: "error",
      filePath: relPath,
      line: 1,
      message: `Missing required CSS file: ${relPath}`,
      snippet: "",
    });
    return null;
  }

  const source = readFileSync(absolutePath, "utf8");
  return { source, root: postcss.parse(source, { from: absolutePath }) };
}

function findLightThemeCustomProperty(cssRoot, property) {
  let result = null;
  cssRoot.walkDecls(property, (decl) => {
    if (result || isDarkThemeContext(decl)) return;
    result = decl;
  });
  return result;
}

function findDeclarationForSelector(cssRoot, selector, property) {
  let result = null;
  cssRoot.walkRules((rule) => {
    if (result || isDarkThemeContext(rule)) return;
    if (!selectorsForRule(rule).includes(selector)) return;
    rule.walkDecls(property, (decl) => {
      if (!result) result = decl;
    });
  });
  return result;
}

function makeValueFinding({ ruleId, filePath, decl, message, expected }) {
  const actual = decl?.value ?? "(missing)";
  const expectedMessage = expected ? ` Expected \`${expected}\`; found \`${actual}\`.` : ` Found \`${actual}\`.`;
  return {
    ruleId,
    severity: RULES[ruleId]?.severity ?? "error",
    filePath,
    line: decl?.source?.start?.line ?? 1,
    message: `${message}${expectedMessage}`,
    snippet: decl ? `${decl.prop}: ${decl.value};` : "",
  };
}

export function runWorkspaceSurfaceVisibilityAudit({
  root,
  tokenFile = "src/styles/core/tokens.css",
  desktopSearchCssFile = "packages/connections-ui/src/styles/primitives/desktop-search.css",
} = {}) {
  const findings = [];
  const filesScanned = [];
  const normalizedTokenFile = normalizePath(tokenFile);
  const normalizedDesktopSearchCssFile = normalizePath(desktopSearchCssFile);

  const tokenCss = readCss(root, normalizedTokenFile, findings);
  if (tokenCss) {
    filesScanned.push(normalizedTokenFile);
    const outlineDecl = findLightThemeCustomProperty(tokenCss.root, "--gc-desktop-search-surface-outline");
    if (!outlineDecl) {
      findings.push({
        ruleId: "desktop-search-idle-outline-visible",
        severity: "error",
        filePath: normalizedTokenFile,
        line: 1,
        message: "Missing light-theme `--gc-desktop-search-surface-outline` token.",
        snippet: "",
      });
    } else if (isFullyTransparentValue(outlineDecl.value)) {
      findings.push(
        makeValueFinding({
          ruleId: "desktop-search-idle-outline-visible",
          filePath: normalizedTokenFile,
          decl: outlineDecl,
          message: "Desktop search idle outline cannot be fully transparent in light theme.",
        }),
      );
    }
  }

  const desktopSearchCss = readCss(root, normalizedDesktopSearchCssFile, findings);
  if (desktopSearchCss) {
    filesScanned.push(normalizedDesktopSearchCssFile);
    for (const contract of DESKTOP_SEARCH_BACKGROUND_CONTRACTS) {
      const decl = findDeclarationForSelector(desktopSearchCss.root, contract.selector, contract.property);
      if (!decl || normalizeCssValue(decl.value) !== normalizeCssValue(contract.expected)) {
        findings.push(
          makeValueFinding({
            ruleId: "desktop-search-chrome-background-token",
            filePath: normalizedDesktopSearchCssFile,
            decl,
            message: contract.message,
            expected: contract.expected,
          }),
        );
      }
    }
  }

  return { findings, filesScanned, rules: RULES };
}

export function renderReport({ findings, filesScanned }) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const lines = [
    "# Workspace Surface Visibility Audit",
    "",
    `- Files scanned: **${filesScanned.length}**`,
    `- Errors: **${errors.length}**`,
    `- Warnings: **0**`,
    `- Findings: **${findings.length}**`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No workspace surface visibility regressions detected.", "");
    return lines.join("\n");
  }

  lines.push("## Findings", "");
  for (const finding of findings) {
    lines.push(`- **${finding.filePath}:${finding.line}** — ${finding.ruleId}: ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  \`${finding.snippet}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}
