import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "@saydeploy/architect/core/files";

const RULES = {
  "deleted-wrapper-reference": {
    severity: "error",
    description: "Collapsed wrapper components must not be reintroduced or imported.",
  },
  "rename-only-view-model-builder": {
    severity: "error",
    description: "View-model builders that only rename composable state must stay deleted.",
  },
  "large-vue-prop-surface": {
    severity: "warning",
    description:
      "Vue components should keep props near the configured prop limit; split concerns instead of forwarding props.",
  },
  // NOTE: `workspace-root-state-import` is owned by the `ui-drift` audit at error severity
  // (see packages/connections-arkitect/src/checks/ui-drift.mjs). Keep the canonical rule there to avoid
  // duplicate, conflicting severities and double-counted findings.
  "direct-browser-storage": {
    severity: "warning",
    description: "Direct browser storage should live at explicit feature persistence boundaries.",
  },
  "bare-fetch": {
    severity: "warning",
    description:
      "Direct `fetch(...)` calls bypass the canonical fetchWithDeadline + retry + AbortSignal helpers. Use the wrappers in src/lib/http/ or infra/lambda/src/_shared/.",
  },
  "external-link-without-rel": {
    severity: "warning",
    description:
      '`target="_blank"` without `rel="noopener noreferrer"` is a reverse-tabnabbing vector. Add the rel attribute.',
  },
  "get-api-client-outside-vault-api": {
    severity: "warning",
    description:
      "`getApiClient()` is the low-level data-layer entrypoint. Wrap usage in a typed `src/lib/vault-api/*` function rather than calling it from components/composables directly.",
  },
  "private-normalize-helper": {
    severity: "warning",
    description:
      "Private `normalize(Email|Phone|Handle)` helpers drift from canonical text-utils versions and break identity-resolution exact-match. Import from a canonical text utility module.",
  },
  "inline-arbitrary-z-index": {
    severity: "warning",
    description: "Inline Tailwind `z-[N]` utilities bypass the documented --gc-z-* stacking registry.",
  },
  "app-button-on-detail-row": {
    severity: "warning",
    description:
      "Detail-row actions should use compact icon/actions primitives instead of full AppButton text buttons.",
  },
  "internal-anchor-route": {
    severity: "warning",
    description: 'Internal app paths should use `<RouterLink>` instead of raw `<a href="/...">` reloads.',
  },
  "literal-template-content-with-translate": {
    severity: "info",
    description: "Vue files that import `translate`/`tr` helpers — tracks i18n migration progress, not a bug.",
  },
  "public-workspace-direct-import": {
    severity: "warning",
    description: "Public UI must not import workspace-only components or composables directly.",
  },
  "workspace-public-direct-import": {
    severity: "warning",
    description: "Workspace UI must not import public UI directly; move shared pieces to a shared layer.",
  },
  "ui-package-root-import": {
    severity: "warning",
    description: "`packages/connections-ui` must not import from the app root alias `@/`.",
  },
  "app-table-load-more-adjacent": {
    severity: "warning",
    description: "AppTable callsites should not bolt on ad-hoc load-more controls beside the table.",
  },
  "ad-hoc-set-interval": {
    severity: "info",
    description: "Will use shared clock/scheduler composable (useNow) once built; currently aspirational.",
  },
};

export const audit = {
  id: "vue-layering",
  title: "Vue Layering",
  category: "architecture",
  requires: { projectNames: ["connections"], frameworks: ["vue", "vue3"] },
  defaultConfig: {
    roots: ["src", "packages/connections-ui/src"],
    extensions: [".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts"],
    outputPath: "tmp/audits/VUE_LAYERING_REPORT.md",
    ignoredPathPattern:
      "(?:^|/)(?:__tests__|test|tests|fixtures|mocks|shared-primitives-live)(?:/|$)|\\.(?:spec|test|spec-helpers|test-harness)\\.[cm]?[tj]sx?$|^src/lib/persistence/|^src/lib/auth/legacy-storage-purge\\.ts$|^src/lib/auth/tab-account-pin\\.ts$|^src/components/cookie-consent/",
    maxFindingsPerRule: 80,
    propLimit: 15,
    deletedWrappers: [],
  },
  async run(context) {
    const checkConfig = context.checkConfig;
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
    const findings = collectFindings(files, checkConfig);
    const summary = summarize(findings);
    const baselineDrift = context.baseline?.rules ? compareToBaseline(findings, context.baseline) : [];
    if (context.baseline?.rules) {
      summary.baseline = {
        path: "legacy snapshot",
        drift: baselineDrift.reduce((total, item) => total + item.delta, 0),
        driftDetails: baselineDrift,
      };
    }

    const payload = { files: files.map((file) => file.rel), findings, summary };
    const report = renderReportForFormat(payload, context.options.format || "text", checkConfig);
    const failOnWarnings = context.checkArgs.includes("--fail-on-warnings");

    return {
      baselineDocument: buildBaseline(findings),
      failed: summary.error > 0 || (summary.baseline?.drift ?? 0) > 0 || (failOnWarnings && summary.warning > 0),
      jsonPayload: payload,
      outputPath: checkConfig.outputPath,
      report,
    };
  },
};

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function stripCommentsPreservingLines(source) {
  return source.replace(/\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n\r]/g, " "));
}

function cleanSnippet(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function addFinding(findings, ruleId, filePath, line, snippet, note) {
  findings.push({
    ruleId,
    severity: RULES[ruleId].severity,
    filePath,
    line,
    snippet: cleanSnippet(snippet),
    note,
  });
}

function isIgnoredPath(filePath, checkConfig) {
  return new RegExp(checkConfig.ignoredPathPattern).test(filePath);
}

function scanDeletedWrapperReferences(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) {
    return;
  }

  for (const label of checkConfig.deletedWrappers ?? []) {
    const pattern = new RegExp(`\\b${escapeRegExp(label)}\\b`, "g");
    for (const match of source.matchAll(pattern)) {
      addFinding(
        findings,
        "deleted-wrapper-reference",
        filePath,
        lineNumberAt(source, match.index),
        label,
        `${label} was removed by the Vue layering cleanup.`,
      );
    }
  }
}

function scanViewModelBuilders(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) {
    return;
  }

  const basename = path.posix.basename(filePath);
  if (/^build[A-Z][A-Za-z0-9]*ViewModels\.[cm]?tsx?$/.test(basename)) {
    addFinding(
      findings,
      "rename-only-view-model-builder",
      filePath,
      1,
      basename,
      "New build*ViewModels files need an explicit business-rule justification.",
    );
  }

  const declarationPattern = /\b(?:export\s+)?(?:function|const)\s+(build[A-Z][A-Za-z0-9]*ViewModels)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    addFinding(
      findings,
      "rename-only-view-model-builder",
      filePath,
      lineNumberAt(source, match.index),
      match[1],
      "Prefer template-shaped composable returns plus a narrow composer for real joins.",
    );
  }
}

function scanDirectBrowserStorage(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) {
    return;
  }

  const searchableSource = stripCommentsPreservingLines(source);
  const storagePattern = /\b(?:window\.)?(?:localStorage|sessionStorage)\b/g;
  for (const match of searchableSource.matchAll(storagePattern)) {
    addFinding(
      findings,
      "direct-browser-storage",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Move storage access behind a feature persistence boundary when this area is migrated.",
    );
  }
}

// Allow-list of files that legitimately call `fetch(...)` directly because
// they ARE the canonical http wrapper or a primitive layer that the wrapper
// builds on top of. Everything else should go through fetchWithDeadline.
const BARE_FETCH_ALLOWED_PATHS = [
  "src/lib/http/fetch-with-deadline.ts",
  "src/lib/aws-client.ts",
  "src/lib/auth/cognito-auth.ts",
  "src/lib/auth/account-security-api.ts",
  "src/lib/auth/oauth-api.ts",
  "src/lib/services-api.ts",
  "src/lib/runnyknows/client.ts",
  "src/lib/analytics/paramount-pixel.ts",
];

function scanBareFetch(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  if (BARE_FETCH_ALLOWED_PATHS.includes(filePath.replaceAll("\\", "/"))) return;

  const searchableSource = stripCommentsPreservingLines(source);
  // Match `fetch(` with a word boundary AND make sure it isn't preceded by
  // `.` (so `instance.fetch(...)` and `await this.fetch(...)` don't trip)
  // or by `etch` already (avoid `prefetch`, `dispatch`).
  const fetchPattern = /(?<![.\w])fetch\s*\(/g;
  for (const match of searchableSource.matchAll(fetchPattern)) {
    addFinding(
      findings,
      "bare-fetch",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Use fetchWithDeadline (src/lib/http/ or infra/lambda/src/_shared/) so the call honors timeouts and abort signals.",
    );
  }
}

// Files allowed to import getApiClient directly: the data-layer wrappers, the
// api-client construction itself, and a small explicit allow-list of legacy
// surfaces that haven't been migrated yet.
// Components with naturally large config surfaces — UI primitives, complex
// dialogs, sign-in panels. Their prop count is by-design, not a violation.
const LARGE_PROP_ALLOWLIST = new Set([
  "packages/connections-ui/src/components/dialogs/AppImageAdjusterDialog.vue",
  "packages/connections-ui/src/components/fields/AppAdditionalInfoFieldTray.vue",
  "packages/connections-ui/src/components/fields/AppFieldTray.vue",
  "packages/connections-ui/src/components/fields/AppSearchField.vue",
  "packages/connections-ui/src/components/pickers/AppDatePickerDialog.vue",
  "packages/connections-ui/src/components/selection/AppChip.vue",
  "src/components/public/shared/PublicIconButton.vue",
  "src/components/public/network-demo/NetworkDemoAttendeeCarousel.vue",
  "src/components/sign-in/SignInPrimaryFlowPanel.vue",
  "src/components/workspace/views/host/WorkspaceHostAnalyticsPanelBeta.vue",
  "src/components/workspace/views/host/WorkspaceRegistrationFieldsEditor.vue",
  // Core primitives with naturally large config surfaces.
  "src/components/shared/table/AppTable.vue",
]);

const GET_API_CLIENT_ALLOWED_PREFIXES = [
  "src/lib/vault-api/",
  "src/lib/auth/",
  "src/lib/http/",
  "src/lib/runtime/",
  "src/lib/aws-client.ts",
  "src/lib/api-client.ts",
  "src/lib/services-api.ts",
];

function scanGetApiClientOutsideVaultApi(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  const normalized = filePath.replaceAll("\\", "/");
  if (GET_API_CLIENT_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized === prefix)) {
    return;
  }

  const searchableSource = stripCommentsPreservingLines(source);
  // Match `getApiClient` as a bare identifier (import or call). The arkitect
  // already strips comments, so this won't trip on doc references.
  const pattern = /\bgetApiClient\b/g;
  for (const match of searchableSource.matchAll(pattern)) {
    addFinding(
      findings,
      "get-api-client-outside-vault-api",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Wrap usage in a typed src/lib/vault-api/* function so component tests can mock the wire.",
    );
  }
}

// Files allowed to declare local `normalizeEmail` / `normalizePhone` / `normalizeHandle`:
// the canonical text-utils modules themselves, and any node_modules-style helper.
const NORMALIZE_HELPER_ALLOWED_PATHS = [
  "packages/connections-ui/src/lib/text/text-utils.ts",
  "src/lib/text/text-utils.ts",
  "src/lib/text/phone.ts",
  "src/lib/text/handle.ts",
];

const IMPORT_SOURCE_RE = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const INLINE_ARBITRARY_Z_RE = /\bz-\[\s*-?\d+\s*\]/g;
const SET_INTERVAL_RE = /\bsetInterval\s*\(/g;
const USE_NOW_ALLOWED_PATHS = ["packages/connections-ui/src/composables/useNow.ts"];
const TEMPLATE_TEXT_ALLOWLIST = new Set(["|", "/", "•", "·", "…", "→", "×", "+", "-", "—", "–"]);

function hasTranslateImport(source) {
  return /import\s+\{[^}]*\b(?:translate|translatePlural)\b[^}]*\}\s+from\s+["']@\/lib\/i18n["']/.test(source);
}

function extractVueTemplate(source) {
  const match = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
  return match?.[1] ?? "";
}

function findOpeningTags(source, tagName) {
  const tags = [];
  const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?>`, "gi");
  for (const match of source.matchAll(pattern)) {
    tags.push({ index: match.index ?? 0, text: match[0] });
  }
  return tags;
}

function isInternalHref(value) {
  return value.startsWith("/") && !value.startsWith("//");
}

function resolveImportSpec(filePath, spec) {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec));
  }
  return spec;
}

function importRuleFor(filePath, spec) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedTarget = resolveImportSpec(normalizedPath, spec).replaceAll("\\", "/");

  if (normalizedPath.startsWith("packages/connections-ui/src/") && spec.startsWith("@/")) {
    return "ui-package-root-import";
  }

  const isPublicSource =
    normalizedPath.startsWith("src/components/public/") ||
    normalizedPath.startsWith("src/components/myconnect/") ||
    normalizedPath.startsWith("src/composables/public/");
  const isWorkspaceSource =
    normalizedPath.startsWith("src/components/workspace/") || normalizedPath.startsWith("src/composables/workspace/");
  const isWorkspaceTarget =
    normalizedTarget.startsWith("src/components/workspace/") ||
    normalizedTarget.startsWith("src/composables/workspace/");
  const isPublicTarget =
    normalizedTarget.startsWith("src/components/public/") ||
    normalizedTarget.startsWith("src/components/myconnect/") ||
    normalizedTarget.startsWith("src/composables/public/");

  if (isPublicSource && isWorkspaceTarget) return "public-workspace-direct-import";
  if (isWorkspaceSource && isPublicTarget) {
    // public/shared/ and myconnect/shared/ components are intended to be
    // shared across layers, not public-only.
    if (normalizedTarget.startsWith("src/components/public/shared/")) return null;
    if (normalizedTarget.startsWith("src/components/myconnect/shared/")) return null;
    // welcome-state is intentionally imported by the workspace settings panel.
    if (normalizedTarget === "src/components/public/welcome/welcome-state") return null;
    return "workspace-public-direct-import";
  }
  return null;
}

function scanPrivateNormalizeHelper(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  const normalized = filePath.replaceAll("\\", "/");
  if (NORMALIZE_HELPER_ALLOWED_PATHS.includes(normalized)) return;

  const searchableSource = stripCommentsPreservingLines(source);
  // Match local function or const declarations of normalizeEmail/Phone/Handle.
  const pattern = /\b(?:function|const|let)\s+(normalize(?:Email|Phone|Handle))\b/g;
  for (const match of searchableSource.matchAll(pattern)) {
    addFinding(
      findings,
      "private-normalize-helper",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      `Delete this local helper and import ${match[1]} from a canonical text utility module. Identity-resolution exact-match depends on consistent normalization.`,
    );
  }
}

function scanInlineArbitraryZIndex(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  const searchableSource = stripCommentsPreservingLines(source);
  INLINE_ARBITRARY_Z_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_ARBITRARY_Z_RE.exec(searchableSource))) {
    addFinding(
      findings,
      "inline-arbitrary-z-index",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Use a documented z-index token from docs/architecture/Z_INDEX_LAYERS.md, e.g. z-(--gc-z-modal).",
    );
  }
}

function scanAppButtonOnDetailRow(source, filePath, findings, checkConfig) {
  if (!filePath.endsWith(".vue") || isIgnoredPath(filePath, checkConfig)) return;
  const searchableSource = stripCommentsPreservingLines(source);
  const directPattern = /<AppButton\b[\s\S]*?class\s*=\s*["'][^"']*\b(?:gc-)?detail-row\b[^"']*["'][\s\S]*?>/g;
  for (const match of searchableSource.matchAll(directPattern)) {
    addFinding(
      findings,
      "app-button-on-detail-row",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Detail-row buttons should use AppIconButton/AppKebabMenu or a reviewed compact action treatment.",
    );
  }

  const rowBlockPattern = /<[^>]+\bclass\s*=\s*["'][^"']*\b(?:gc-)?detail-row\b[^"']*["'][^>]*>[\s\S]*?<AppButton\b/g;
  for (const match of searchableSource.matchAll(rowBlockPattern)) {
    addFinding(
      findings,
      "app-button-on-detail-row",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Detail-row buttons should use AppIconButton/AppKebabMenu or a reviewed compact action treatment.",
    );
  }
}

function scanAnchorTags(source, filePath, findings, checkConfig) {
  if (!filePath.endsWith(".vue") || isIgnoredPath(filePath, checkConfig)) return;
  const searchableSource = stripCommentsPreservingLines(source);
  for (const tag of findOpeningTags(searchableSource, "a")) {
    const targetBlank = /\btarget\s*=\s*["']_blank["']/.test(tag.text);
    if (targetBlank && !/\brel\s*=/.test(tag.text)) {
      addFinding(
        findings,
        "external-link-without-rel",
        filePath,
        lineNumberAt(source, tag.index),
        tag.text,
        'Add rel="noopener noreferrer" to prevent reverse-tabnabbing.',
      );
    }

    const hrefMatch = tag.text.match(/\bhref\s*=\s*["']([^"']+)["']/);
    if (hrefMatch && isInternalHref(hrefMatch[1])) {
      // Skip if the tag already has Vue event handling (@click, @click.prevent)
      // — these are using JS navigation, the <a> is just a trigger element.
      if (/@click\b/.test(tag.text)) continue;

      // Skip if opening in a new tab — these are intentional external-style opens.
      if (/\btarget\s*=\s*["']_blank["']/.test(tag.text)) continue;

      // Skip static file references (.html, .md) — not SPA routes.
      if (/\.(?:html|md)["']\s*$/.test(hrefMatch[1])) continue;

      // Sign-in pages are rendered outside the main app router — they
      // legitimately use <a> tags for legal page links.
      if (filePath.includes("src/components/sign-in/")) continue;

      addFinding(
        findings,
        "internal-anchor-route",
        filePath,
        lineNumberAt(source, tag.index),
        tag.text,
        "Use RouterLink/custom navigation for in-app routes so navigation stays SPA-local.",
      );
    }
  }
}

function scanLiteralTemplateContentWithTranslate(source, filePath, findings, checkConfig) {
  if (!filePath.endsWith(".vue") || isIgnoredPath(filePath, checkConfig) || !hasTranslateImport(source)) return;
  const template = extractVueTemplate(source);
  if (!template) return;

  const textPattern = />([^<>{}]+)</g;
  const templateOffset = source.indexOf(template);
  for (const match of template.matchAll(textPattern)) {
    const literal = match[1].replace(/\s+/g, " ").trim();
    if (!literal || TEMPLATE_TEXT_ALLOWLIST.has(literal) || !/[A-Za-z0-9]/.test(literal)) continue;
    if (/^&(?:nbsp|middot|hellip|rarr|times);$/i.test(literal)) continue;
    addFinding(
      findings,
      "literal-template-content-with-translate",
      filePath,
      lineNumberAt(source, templateOffset + (match.index ?? 0)),
      literal,
      "Route user-visible text through the local translate helper instead of raw template text.",
    );
  }
}

function scanImportBoundaries(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  const searchableSource = stripCommentsPreservingLines(source);
  IMPORT_SOURCE_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_SOURCE_RE.exec(searchableSource))) {
    const spec = match[1] ?? match[2] ?? "";
    const ruleId = importRuleFor(filePath, spec);
    if (!ruleId) continue;
    addFinding(
      findings,
      ruleId,
      filePath,
      lineNumberAt(source, match.index),
      spec,
      ruleId === "ui-package-root-import"
        ? "Move the dependency into @lunawerx/ui or pass it from the app shell instead of importing app internals."
        : "Move the shared dependency to src/components/shared, src/lib, or the UI package.",
    );
  }
}

function scanAppTableLoadMore(source, filePath, findings, checkConfig) {
  if (!filePath.endsWith(".vue") || isIgnoredPath(filePath, checkConfig)) return;
  if (!source.includes("<AppTable")) return;
  const searchableSource = stripCommentsPreservingLines(source);
  const pattern =
    /<AppTable\b[\s\S]*?<\/AppTable>\s*(?:<[^>]+>\s*){0,4}[\s\S]{0,800}?\b(?:loadMore|load-more|Load more|hasMore)\b/g;
  for (const match of searchableSource.matchAll(pattern)) {
    addFinding(
      findings,
      "app-table-load-more-adjacent",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Avoid per-page load-more glue next to AppTable; add a reviewed primitive/table affordance first.",
    );
  }
}

function scanAdHocSetInterval(source, filePath, findings, checkConfig) {
  if (isIgnoredPath(filePath, checkConfig)) return;
  const normalized = filePath.replaceAll("\\", "/");
  if (USE_NOW_ALLOWED_PATHS.includes(normalized)) return;
  const searchableSource = stripCommentsPreservingLines(source);
  SET_INTERVAL_RE.lastIndex = 0;
  let match;
  while ((match = SET_INTERVAL_RE.exec(searchableSource))) {
    addFinding(
      findings,
      "ad-hoc-set-interval",
      filePath,
      lineNumberAt(source, match.index),
      match[0],
      "Use a shared scheduler or useNow() so timers coalesce and clean up consistently.",
    );
  }
}

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripTypeBlockNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/=>\s*[^;\n,]+/g, "=> unknown");
}

function countPropsInTypeLiteral(typeBlock) {
  const cleaned = stripTypeBlockNoise(typeBlock);
  const matches = cleaned.matchAll(/(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/g);
  return [...matches].filter((match) => nestingDepthAt(cleaned, match.index) === 0).map((match) => match[1]);
}

function nestingDepthAt(source, targetIndex) {
  let depth = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    const char = source[index];
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function scanLargeVuePropSurface(source, filePath, findings, checkConfig) {
  if (!filePath.endsWith(".vue") || isIgnoredPath(filePath, checkConfig)) {
    return;
  }

  const definePropsPattern = /\bdefineProps\s*<\s*\{/g;
  for (const match of source.matchAll(definePropsPattern)) {
    const openBraceIndex = source.indexOf("{", match.index);
    if (openBraceIndex === -1) continue;
    const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
    if (closeBraceIndex === -1) continue;

    const typeBlock = source.slice(openBraceIndex + 1, closeBraceIndex);
    const propNames = countPropsInTypeLiteral(typeBlock);
    if (propNames.length <= checkConfig.propLimit) {
      continue;
    }

    // Components with naturally large config surfaces (UI primitives,
    // complex dialogs, sign-in panels). These are by-design, not violations.
    if (LARGE_PROP_ALLOWLIST.has(filePath)) continue;

    addFinding(
      findings,
      "large-vue-prop-surface",
      filePath,
      lineNumberAt(source, match.index),
      `defineProps with ${propNames.length} props`,
      `${propNames.length} props: ${propNames.slice(0, 18).join(", ")}${propNames.length > 18 ? ", ..." : ""}`,
    );
  }
}

function collectFindings(files, checkConfig) {
  const findings = [];

  for (const { rel, source } of files) {
    scanDeletedWrapperReferences(source, rel, findings, checkConfig);
    scanViewModelBuilders(source, rel, findings, checkConfig);
    scanLargeVuePropSurface(source, rel, findings, checkConfig);
    scanDirectBrowserStorage(source, rel, findings, checkConfig);
    scanBareFetch(source, rel, findings, checkConfig);
    scanGetApiClientOutsideVaultApi(source, rel, findings, checkConfig);
    scanPrivateNormalizeHelper(source, rel, findings, checkConfig);
    scanInlineArbitraryZIndex(source, rel, findings, checkConfig);
    scanAppButtonOnDetailRow(source, rel, findings, checkConfig);
    scanAnchorTags(source, rel, findings, checkConfig);
    scanLiteralTemplateContentWithTranslate(source, rel, findings, checkConfig);
    scanImportBoundaries(source, rel, findings, checkConfig);
    scanAppTableLoadMore(source, rel, findings, checkConfig);
    scanAdHocSetInterval(source, rel, findings, checkConfig);
  }

  return findings.sort((a, b) => {
    const ruleSort = a.ruleId.localeCompare(b.ruleId);
    if (ruleSort !== 0) return ruleSort;
    const fileSort = a.filePath.localeCompare(b.filePath);
    if (fileSort !== 0) return fileSort;
    return a.line - b.line;
  });
}

function summarize(findings) {
  const summary = { total: findings.length, error: 0, warning: 0, byRule: {} };

  for (const finding of findings) {
    summary[finding.severity] += 1;
    summary.byRule[finding.ruleId] ??= { severity: finding.severity, count: 0, files: new Set() };
    summary.byRule[finding.ruleId].count += 1;
    summary.byRule[finding.ruleId].files.add(finding.filePath);
  }

  return {
    ...summary,
    byRule: Object.fromEntries(
      Object.entries(summary.byRule).map(([ruleId, value]) => [
        ruleId,
        { severity: value.severity, count: value.count, files: value.files.size },
      ]),
    ),
  };
}

function buildCountsByRuleAndFile(findings, severity) {
  const counts = {};
  for (const finding of findings) {
    if (severity && finding.severity !== severity) continue;
    counts[finding.ruleId] ??= {};
    counts[finding.ruleId][finding.filePath] = (counts[finding.ruleId][finding.filePath] ?? 0) + 1;
  }
  return sortNestedCounts(counts);
}

function sortNestedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ruleId, fileCounts]) => [
        ruleId,
        Object.fromEntries(Object.entries(fileCounts).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

function buildBaseline(findings) {
  return { version: 1, rules: buildCountsByRuleAndFile(findings, "warning") };
}

function compareToBaseline(findings, baseline) {
  const current = buildCountsByRuleAndFile(findings, "warning");
  const drift = [];
  for (const [ruleId, fileCounts] of Object.entries(current)) {
    const baselineRule = baseline.rules?.[ruleId] ?? {};
    for (const [filePath, count] of Object.entries(fileCounts)) {
      const baselineCount = baselineRule[filePath] ?? 0;
      if (count > baselineCount) {
        drift.push({ ruleId, filePath, count, baselineCount, delta: count - baselineCount });
      }
    }
  }
  return drift.sort((a, b) => {
    const ruleSort = a.ruleId.localeCompare(b.ruleId);
    if (ruleSort !== 0) return ruleSort;
    return a.filePath.localeCompare(b.filePath);
  });
}

function renderTextReport({ files, findings, summary }, checkConfig) {
  const lines = [];
  lines.push("Vue layering audit");
  lines.push(`Scanned ${files.length} source files.`);
  lines.push(`- Errors: ${summary.error}`);
  lines.push(`- Warnings: ${summary.warning}`);
  if (summary.baseline) {
    lines.push(`Baseline: ${summary.baseline.path}. Warning drift: ${summary.baseline.drift}.`);
  }
  lines.push("");

  if (findings.length === 0) {
    lines.push("No layering drift detected.");
    return lines.join("\n");
  }

  for (const [ruleId, rule] of Object.entries(RULES)) {
    const ruleFindings = findings.filter((finding) => finding.ruleId === ruleId);
    if (ruleFindings.length === 0) continue;
    lines.push(`[${rule.severity}] ${ruleId}: ${ruleFindings.length}`);
    lines.push(`  ${rule.description}`);
    for (const finding of ruleFindings.slice(0, checkConfig.maxFindingsPerRule)) {
      const note = finding.note ? ` - ${finding.note}` : "";
      lines.push(`  - ${finding.filePath}:${finding.line} ${finding.snippet}${note}`);
    }
    if (ruleFindings.length > checkConfig.maxFindingsPerRule) {
      lines.push(`  - ... ${ruleFindings.length - checkConfig.maxFindingsPerRule} more`);
    }
    lines.push("");
  }

  if (summary.baseline?.driftDetails?.length) {
    lines.push("[error] baseline-warning-drift");
    lines.push(`  Warning debt grew above ${summary.baseline.path}.`);
    for (const item of summary.baseline.driftDetails.slice(0, checkConfig.maxFindingsPerRule)) {
      lines.push(
        `  - ${item.filePath} ${item.ruleId}: ${item.count} current, ${item.baselineCount} baseline (+${item.delta})`,
      );
    }
  }
  return lines.join("\n").trimEnd();
}

function renderMarkdownReport({ files, findings, summary }, checkConfig) {
  const lines = [
    "# Vue Layering Audit",
    "",
    `- **Scanned:** ${files.length} source files`,
    `- **Errors:** ${summary.error}`,
    `- **Warnings:** ${summary.warning}`,
  ];
  if (summary.baseline) {
    lines.push(`- **Baseline:** \`${summary.baseline.path}\``);
    lines.push(`- **Warning drift:** ${summary.baseline.drift}`);
  }
  lines.push("");
  lines.push(
    "This audit turns the Vue layering cleanup plan into a repeatable guardrail. Completed cleanup regressions are hard errors; remaining large layering surfaces are warnings so they can be paid down phase by phase.",
  );
  lines.push("");

  if (findings.length === 0) {
    lines.push("## No Drift", "", "No layering drift detected.", "");
    return lines.join("\n");
  }

  for (const [ruleId, rule] of Object.entries(RULES)) {
    const ruleFindings = findings.filter((finding) => finding.ruleId === ruleId);
    if (ruleFindings.length === 0) continue;
    lines.push(
      `## ${ruleId}`,
      "",
      `- **Severity:** ${rule.severity}`,
      `- **Findings:** ${ruleFindings.length}`,
      `- **Rule:** ${rule.description}`,
      "",
    );
    lines.push("| File | Line | Finding | Note |", "| --- | ---: | --- | --- |");
    for (const finding of ruleFindings.slice(0, checkConfig.maxFindingsPerRule)) {
      lines.push(
        `| \`${finding.filePath}\` | ${finding.line} | \`${escapeMarkdownTable(finding.snippet)}\` | ${escapeMarkdownTable(finding.note ?? "")} |`,
      );
    }
    lines.push("");
  }

  if (summary.baseline?.driftDetails?.length) {
    lines.push(
      "## Baseline Warning Drift",
      "",
      "| Rule | File | Baseline | Current | Delta |",
      "| --- | --- | ---: | ---: | ---: |",
    );
    for (const item of summary.baseline.driftDetails.slice(0, checkConfig.maxFindingsPerRule)) {
      lines.push(
        `| \`${item.ruleId}\` | \`${item.filePath}\` | ${item.baselineCount} | ${item.count} | +${item.delta} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderReportForFormat(payload, format, checkConfig) {
  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === "markdown") return renderMarkdownReport(payload, checkConfig);
  return `${renderTextReport(payload, checkConfig)}\n`;
}

function escapeMarkdownTable(value) {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
