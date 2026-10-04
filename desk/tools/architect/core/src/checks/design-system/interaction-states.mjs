import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "@saydeploy/architect/core/files";
import { SHARED_PRIMITIVE_PATH_PREFIXES } from "@saydeploy/architect/core/primitive-locations";

const RULES = {
  "state-token-missing": {
    severity: "error",
    description: "Required state-layer, disabled, shape, and motion tokens must exist in the central token file.",
  },
  "m3-state-token-value": {
    severity: "error",
    description: "Core M3 state-layer opacity tokens must match the native Material Web token values.",
  },
  "m3-motion-token-value": {
    severity: "error",
    description: "Core M3 motion easing and duration tokens must match the native Material Web token values.",
  },
  "interactive-template-missing-state-layer": {
    severity: "warn",
    description:
      "Shared interactive primitives should expose a dedicated state-layer element or delegate to a primitive that does.",
  },
  "raw-hover-color-without-state-layer": {
    severity: "warn",
    description: "Hover state mutates color/background directly without a state-layer opacity token in the same rule.",
  },
  "focus-visible-missing": {
    severity: "warn",
    description: "Interactive styling exists but no explicit :focus-visible state is defined in the file.",
  },
  "pressed-state-missing": {
    severity: "warn",
    description: "Hover styling exists but no explicit :active/pressed state is defined in the file.",
  },
  "disabled-opacity-fallback": {
    severity: "warn",
    description: "Disabled state uses bare opacity instead of disabled opacity tokens.",
  },
  "focus-ring-token-bypass": {
    severity: "warn",
    description: "Focus-visible state draws a ring without the canonical focus-ring token.",
  },
  "state-motion-transition-all": {
    severity: "warn",
    description: "Interactive state motion uses transition-all/all instead of scoped tokenized transition properties.",
  },
  "state-important-override": {
    severity: "error",
    description: "Interaction-state rules must not use !important; fix cascade ownership instead.",
  },
  "state-hardcoded-duration": {
    severity: "warn",
    description:
      "Interaction-state transition/animation durations should use motion tokens, not hardcoded time literals.",
  },
  "state-layer-focus-uses-hover-opacity": {
    severity: "error",
    description: "Focus-visible state-layer rules must use the M3 focus opacity token, not the hover opacity token.",
  },
  "touch-sticky-hover-state": {
    severity: "error",
    description:
      "Shared action/table hover states must be scoped to hover-capable pointers so touch UIs do not keep sticky hover affordances.",
  },
  "icon-button-visible-density-contract": {
    severity: "error",
    description: "AppIconButton keeps compact visible density separate from the M3 48dp tap target.",
  },
  "app-table-header-action-size-contract": {
    severity: "error",
    description: "AppTable owns one shared header-action size for table settings and slotted header actions.",
  },
  "app-button-anchor-disabled-contract": {
    severity: "error",
    description: "AppButton anchor mode must soft-disable links by removing href and exposing aria-disabled/tabindex.",
  },
};

export const audit = {
  id: "interaction-states",
  title: "Interaction States",
  category: "design-system",
  defaultConfig: {
    title: "Interaction States Audit",
    roots: ["src"],
    extensions: [".css", ".vue", ".ts", ".tsx"],
    tokenFile: "",
    requiredTokens: [],
    canonicalStyleFiles: [],
  },
  async run(context) {
    const checkConfig = context.checkConfig;
    const canonicalStyleFiles = new Set(checkConfig.canonicalStyleFiles ?? []);
    const files = await Promise.all(
      (
        await walkFiles({
          root: context.root,
          roots: checkConfig.roots,
          extensions: checkConfig.extensions,
          skipSegments: checkConfig.skipSegments,
        })
      ).map(async (filePath) => ({
        rel: filePath,
        source: await fs.readFile(path.resolve(context.root, filePath), "utf8"),
      })),
    );
    const tokenSource = checkConfig.tokenFile
      ? await readOptionalFile(path.resolve(context.root, checkConfig.tokenFile))
      : "";
    const findings = [];

    auditRequiredTokens(findings, checkConfig, tokenSource);
    auditCanonicalM3TokenValues(findings, checkConfig, tokenSource);
    auditInteractiveTemplateStateLayers(findings, checkConfig, files);
    auditCssStateRules(findings, checkConfig, canonicalStyleFiles, files);
    auditActionSizingContracts(findings, files);

    findings.sort(
      (a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line,
    );
    const counts = countFindingsByRuleAndFile(findings);
    const regressions = findRegressions(counts, context.baseline);
    const report = renderReport({
      findings,
      counts,
      regressions,
      format: context.options.format,
      title: checkConfig.title,
    });

    return {
      baselineDocument: buildBaselineDocument(counts),
      failed: regressions.length > 0,
      jsonPayload: { findings, rules: RULES, regressions },
      outputPath: checkConfig.outputPath,
      report,
    };
  },
};

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
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
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
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

function isSharedPrimitive(relPath) {
  return SHARED_PRIMITIVE_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function hasInteractiveTemplate(source) {
  return /<button\b|<a\b[^>]*(?:@click|role=["']button)|role=["'](?:button|tab|switch|checkbox|radio|menuitem)/.test(
    source,
  );
}

function delegatesToStatefulPrimitive(source) {
  return /<App(?:Button|IconButton|FAB|Chip|SegmentedToggle|Switch|Checkbox|Radio|RadioRow|MenuList|ListRow|PresenceRow)\b/.test(
    source,
  );
}

function hasStateLayer(source) {
  return /__state-layer\b|state-layer/.test(source);
}

function isStateSelector(selector) {
  return /:(?:hover|focus-visible|focus|active|disabled)\b|\[aria-(?:disabled|pressed|selected|expanded|current)=|\.is-disabled\b|--disabled\b/.test(
    selector,
  );
}

function isDisabledSelector(selector) {
  return /:disabled\b|\[aria-disabled|\.is-disabled\b|--disabled\b/.test(selector);
}

function iterCssRules(source) {
  return iterCssRulesInRange(source, 0, source.length, []);
}

function iterCssRulesInRange(source, start, end, mediaQueries) {
  const rules = [];
  let cursor = start;

  while (cursor < end) {
    const openIndex = source.indexOf("{", cursor);
    if (openIndex === -1 || openIndex >= end) {
      break;
    }

    const selector = source.slice(cursor, openIndex).trim();
    const closeIndex = findMatchingBrace(source, openIndex, end);
    if (closeIndex === -1) {
      break;
    }

    if (selector.startsWith("@media")) {
      rules.push(...iterCssRulesInRange(source, openIndex + 1, closeIndex, [...mediaQueries, selector]));
    } else if (selector.length > 0 && !source.slice(openIndex + 1, closeIndex).includes("{")) {
      rules.push({
        selector,
        body: source.slice(openIndex + 1, closeIndex).trim(),
        index: cursor,
        raw: source.slice(cursor, closeIndex + 1),
        mediaQueries,
      });
    }

    cursor = closeIndex + 1;
  }

  return rules;
}

function findMatchingBrace(source, openIndex, end) {
  let depth = 0;
  for (let index = openIndex; index < end; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function auditRequiredTokens(findings, checkConfig, tokenSource) {
  for (const token of checkConfig.requiredTokens ?? []) {
    if (tokenSource.includes(`${token}:`)) {
      continue;
    }

    addFinding(
      findings,
      "state-token-missing",
      checkConfig.tokenFile,
      1,
      `Required interaction-state token ${token} is missing from the central token file.`,
      token,
    );
  }
}

function parseCustomPropertyValues(source) {
  return new Map(
    [...source.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      cleanSnippet(match[2]),
    ]),
  );
}

function tokenValueMatches(value, expected) {
  if (!value) {
    return false;
  }

  if (isNumericCssValue(value) && isNumericCssValue(expected)) {
    return Number(value) === Number(expected);
  }

  return expected instanceof RegExp ? expected.test(value) : value === expected;
}

function isNumericCssValue(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value).trim());
}

function auditCanonicalM3TokenValues(findings, checkConfig, tokenSource) {
  const values = parseCustomPropertyValues(tokenSource);
  const expectedStateTokens = {
    "--md-sys-state-hover-state-layer-opacity": "0.08",
    "--md-sys-state-focus-state-layer-opacity": "0.10",
    "--md-sys-state-pressed-state-layer-opacity": "0.12",
    "--md-sys-state-dragged-state-layer-opacity": "0.16",
  };
  const expectedMotionTokens = {
    "--md-sys-motion-easing-standard": "cubic-bezier(0.2, 0, 0, 1)",
    "--md-sys-motion-easing-standard-accelerate": "cubic-bezier(0.3, 0, 1, 1)",
    "--md-sys-motion-easing-standard-decelerate": "cubic-bezier(0, 0, 0, 1)",
    "--md-sys-motion-easing-emphasized": "cubic-bezier(0.2, 0, 0, 1)",
    "--md-sys-motion-easing-emphasized-accelerate": "cubic-bezier(0.3, 0, 0.8, 0.15)",
    "--md-sys-motion-easing-emphasized-decelerate": "cubic-bezier(0.05, 0.7, 0.1, 1)",
    "--md-sys-motion-duration-medium-2": "var(--md-sys-motion-duration-medium2)",
  };

  for (const [token, expected] of Object.entries(expectedStateTokens)) {
    const value = values.get(token);
    if (tokenValueMatches(value, expected)) {
      continue;
    }

    addFinding(
      findings,
      "m3-state-token-value",
      checkConfig.tokenFile,
      lineNumberAt(tokenSource, Math.max(tokenSource.indexOf(token), 0)),
      `Expected ${token} to be ${expected}, matching the Material Web state token set.`,
      `${token}: ${value ?? "(missing)"}`,
    );
  }

  for (const [token, expected] of Object.entries(expectedMotionTokens)) {
    const value = values.get(token);
    if (tokenValueMatches(value, expected)) {
      continue;
    }

    addFinding(
      findings,
      "m3-motion-token-value",
      checkConfig.tokenFile,
      lineNumberAt(tokenSource, Math.max(tokenSource.indexOf(token), 0)),
      `Expected ${token} to be ${expected}, matching the Material Web motion token set.`,
      `${token}: ${value ?? "(missing)"}`,
    );
  }
}

function auditInteractiveTemplateStateLayers(findings, checkConfig, files) {
  for (const { rel, source } of files) {
    if (!rel.endsWith(".vue") || !isSharedPrimitive(rel)) {
      continue;
    }

    if (!hasInteractiveTemplate(source) || hasStateLayer(source) || delegatesToStatefulPrimitive(source)) {
      continue;
    }

    const index = source.search(/<button\b|role=["'](?:button|tab|switch|checkbox|radio|menuitem)/);
    addFinding(
      findings,
      "interactive-template-missing-state-layer",
      rel,
      lineNumberAt(source, Math.max(index, 0)),
      "Shared primitive has an interactive template but no visible state-layer hook or delegated stateful primitive.",
      index === -1 ? "interactive template" : source.slice(index, index + 160),
    );
  }
}

function auditCssStateRules(findings, checkConfig, canonicalStyleFiles, files) {
  for (const { rel, source } of files) {
    const rules = iterCssRules(source);
    const hasHoverRule = rules.some((rule) => /:hover\b/.test(rule.selector));
    const hasFocusVisibleRule = rules.some((rule) => /:focus-visible\b/.test(rule.selector));
    const hasPressedRule = rules.some((rule) => /:active\b|\[aria-pressed=["']true["']/.test(rule.selector));

    if (hasHoverRule && !hasFocusVisibleRule && !canonicalStyleFiles.has(rel)) {
      const hoverRule = rules.find((rule) => /:hover\b/.test(rule.selector));
      addFinding(
        findings,
        "focus-visible-missing",
        rel,
        lineNumberAt(source, hoverRule?.index ?? 0),
        "File defines hover state styling but no explicit :focus-visible state.",
        hoverRule?.selector ?? ":hover",
      );
    }

    if (hasHoverRule && !hasPressedRule && !canonicalStyleFiles.has(rel)) {
      const hoverRule = rules.find((rule) => /:hover\b/.test(rule.selector));
      addFinding(
        findings,
        "pressed-state-missing",
        rel,
        lineNumberAt(source, hoverRule?.index ?? 0),
        "File defines hover state styling but no explicit pressed (:active/aria-pressed) state.",
        hoverRule?.selector ?? ":hover",
      );
    }

    for (const rule of rules) {
      if (!isStateSelector(rule.selector)) {
        continue;
      }

      const line = lineNumberAt(source, rule.index);
      const mutatesDirectSurface = /(?:^|;)\s*(?:background(?:-color)?|color)\s*:/.test(rule.body);
      const usesStateLayer = /state-layer|--md-sys-state-|--md-comp-[\w-]+-state-layer-opacity/.test(
        rule.body + rule.selector,
      );
      const isDisabledRule = isDisabledSelector(rule.selector);

      if (isTouchStickyHoverCandidate(rule) && !isHoverCapableMediaGuarded(rule)) {
        addFinding(
          findings,
          "touch-sticky-hover-state",
          rel,
          line,
          "Shared action/table hover state is not scoped to a hover-capable pointer media query.",
          rule.raw,
        );
      }

      if (
        /:focus-visible\b/.test(rule.selector) &&
        /state-layer/.test(rule.selector + rule.body) &&
        /hover-state-layer-opacity/.test(rule.body) &&
        !/focus-state-layer-opacity/.test(rule.body)
      ) {
        addFinding(
          findings,
          "state-layer-focus-uses-hover-opacity",
          rel,
          line,
          "Focus-visible state layer uses a hover opacity token instead of the M3 focus opacity token.",
          rule.raw,
        );
      }

      if (mutatesDirectSurface && /:hover\b/.test(rule.selector) && !usesStateLayer && !canonicalStyleFiles.has(rel)) {
        addFinding(
          findings,
          "raw-hover-color-without-state-layer",
          rel,
          line,
          "Hover rule mutates background/color directly without a state-layer token or overlay hook.",
          rule.raw,
        );
      }

      if (
        isDisabledRule &&
        /opacity\s*:\s*(?:0?\.[3-7]|[3-7]0%)/.test(rule.body) &&
        !/--(?:gc-disabled|md-sys-state-disabled)/.test(rule.body)
      ) {
        addFinding(findings, "disabled-opacity-fallback", rel, line, "Disabled state uses bare opacity.", rule.raw);
      }

      if (
        /:focus-visible\b/.test(rule.selector) &&
        /box-shadow\s*:\s*(?:inset\s+)?0\s+0\s+0\s+/.test(rule.body) &&
        !/var\(--gc-focus-ring/.test(rule.body)
      ) {
        addFinding(
          findings,
          "focus-ring-token-bypass",
          rel,
          line,
          "Focus-visible rule draws a ring without the focus-ring token.",
          rule.raw,
        );
      }

      if (/!important\b/.test(rule.body)) {
        addFinding(
          findings,
          "state-important-override",
          rel,
          line,
          "Interaction-state rule uses !important.",
          rule.raw,
        );
      }

      if (/transition\s*:\s*all\b|\btransition-all\b/.test(rule.body + " " + rule.selector)) {
        addFinding(
          findings,
          "state-motion-transition-all",
          rel,
          line,
          "Interactive state uses transition-all/all.",
          rule.raw,
        );
      }

      if (
        /\b(?:transition|animation(?:-duration)?)\s*:[^;]*\b\d+(?:\.\d+)?m?s\b/.test(rule.body) &&
        !/var\(--(?:gc|md)-/.test(rule.body)
      ) {
        addFinding(
          findings,
          "state-hardcoded-duration",
          rel,
          line,
          "Interactive state rule uses a hardcoded motion duration.",
          rule.raw,
        );
      }
    }
  }
}

function isTouchStickyHoverCandidate(rule) {
  if (!mutatesStickyHoverState(rule.body)) {
    return false;
  }

  return splitSelectorList(rule.selector).some(
    (selector) =>
      /:hover\b/.test(selector) &&
      /\.(?:gc-app-(?:button|icon-button|fab|drag-handle|table-row|table-configuration-list)|app-fab-menu__item|gc-row-actions-fade)\b/.test(
        selector,
      ),
  );
}

function mutatesStickyHoverState(body) {
  return /(?:^|;)\s*(?:background(?:-color)?|color|opacity|box-shadow|filter|transform|scale|border-color)\s*:|--[\w-]*(?:state-layer-opacity|hover|selected|active)[\w-]*\s*:/.test(
    body,
  );
}

function isHoverCapableMediaGuarded(rule) {
  return rule.mediaQueries.some((query) => /\(hover:\s*hover\)|\(pointer:\s*fine\)/.test(query));
}

function splitSelectorList(selector) {
  return selector
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sourceByPath(files) {
  return new Map(files.map((entry) => [entry.rel, entry.source]));
}

function assertContract(findings, ruleId, filePath, source, predicate, message, snippet = "") {
  if (predicate(source)) {
    return;
  }

  addFinding(findings, ruleId, filePath, 1, message, snippet);
}

function auditActionSizingContracts(findings, files) {
  const sources = sourceByPath(files);
  const iconButtonPath = "packages/connections-ui/src/components/actions/AppIconButton.vue";
  const buttonPath = "packages/connections-ui/src/components/actions/AppButton.vue";
  const kebabMenuPath = "packages/connections-ui/src/components/actions/AppKebabMenu.vue";
  const iconButtonCssPath = "packages/connections-ui/src/styles/primitives/app-icon-button.css";
  const tablePath = "src/components/shared/table/AppTable.vue";
  const button = sources.get(buttonPath) ?? "";
  const iconButton = sources.get(iconButtonPath) ?? "";
  const kebabMenu = sources.get(kebabMenuPath) ?? "";
  const iconButtonCss = sources.get(iconButtonCssPath) ?? "";
  const table = sources.get(tablePath) ?? "";

  assertContract(
    findings,
    "app-button-anchor-disabled-contract",
    buttonPath,
    button,
    (source) =>
      source.includes('const isLinkDisabled = computed(() => props.as === "a" && isDisabled.value)') &&
      source.includes(":href=\"as === 'a' && !isLinkDisabled ? href : undefined\"") &&
      source.includes(":aria-disabled=\"isLinkDisabled ? 'true' : undefined\"") &&
      source.includes(':tabindex="isLinkDisabled ? -1 : undefined"'),
    "AppButton anchor mode must remove href and expose aria-disabled/tabindex when disabled or loading.",
    "isLinkDisabled",
  );
  assertContract(
    findings,
    "icon-button-visible-density-contract",
    iconButtonCssPath,
    iconButtonCss,
    (source) =>
      source.includes("--gc-app-icon-button-tap-target-size: var(--md-comp-icon-button-state-layer-size, 48px)") &&
      !source.includes("--gc-app-icon-button-container-size"),
    "AppIconButton must keep the 48dp M3 target as tap padding, not as the visible hover/container size.",
    "--gc-app-icon-button-tap-target-size",
  );
  assertContract(
    findings,
    "icon-button-visible-density-contract",
    iconButtonCssPath,
    iconButtonCss,
    (source) => !/(?:block-size|inline-size)\s*:\s*var\(--gc-app-icon-button-container-size\)/.test(source),
    "AppIconButton CSS must not inflate visible block/inline size through a container-size token.",
    "--gc-app-icon-button-container-size",
  );
  assertContract(
    findings,
    "icon-button-visible-density-contract",
    iconButtonPath,
    iconButton,
    (source) =>
      /return\s+"size-7"/.test(source) && /return\s+"size-8"/.test(source) && /return\s+"size-9"/.test(source),
    "AppIconButton visible density must preserve compact sm/md/lg size classes.",
    "size-7 / size-8 / size-9",
  );
  assertContract(
    findings,
    "icon-button-visible-density-contract",
    kebabMenuPath,
    kebabMenu,
    (source) =>
      source.includes('const triggerSize = computed(() => (props.size === "sm" ? "sm" : "md"))') &&
      !source.includes(":size=\"size === 'sm' ? 'md' : 'lg'\""),
    "AppKebabMenu trigger size must not inflate beyond the requested icon-button density.",
    "triggerSize",
  );
  assertContract(
    findings,
    "app-table-header-action-size-contract",
    tablePath,
    table,
    (source) =>
      source.includes('headerActionSize?: "sm" | "md"') &&
      source.includes('const headerActionSize = computed(() => actionsConfig.value.headerActionSize ?? "md")'),
    "AppTable actions config must own a shared headerActionSize contract with md as the default.",
    "headerActionSize",
  );
  assertContract(
    findings,
    "app-table-header-action-size-contract",
    tablePath,
    table,
    (source) =>
      source.includes(':size="headerActionSize"') && source.includes(':header-action-size="headerActionSize"'),
    "AppTable must apply headerActionSize to built-in header actions and expose it to header-action slots.",
    ':size="headerActionSize"',
  );
  assertContract(
    findings,
    "app-table-header-action-size-contract",
    tablePath,
    table,
    (source) => !/data-table-preferences-trigger[\s\S]{0,220}\bsize="sm"/.test(source),
    "AppTable table-settings trigger must not hard-code compact sizing; it must use headerActionSize.",
    "data-table-preferences-trigger",
  );
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
      if (currentCount <= baselineCount) {
        continue;
      }

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

function renderMarkdown({ findings, regressions, title }) {
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [
    `# ${title}`,
    "",
    `- Total findings: ${findings.length}`,
    `- Errors: ${counts.error ?? 0}`,
    `- Warnings: ${counts.warn ?? 0}`,
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
    lines.push("No interaction-state drift found.");
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

function renderReport({ findings, counts, regressions, format, title }) {
  if (format === "counts") {
    return renderCounts(counts);
  }
  return renderMarkdown({ findings, regressions, title });
}
