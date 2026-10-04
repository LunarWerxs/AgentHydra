import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = Object.freeze([
  "src/components",
  "packages/connections-ui/src/components",
  "src/styles/core/transitions.css",
]);

let ROOT = process.cwd();
let SCAN_ROOTS = [...DEFAULT_SCAN_ROOTS];
const SOURCE_EXTENSIONS = new Set([".vue", ".css"]);
const SKIP_SEGMENTS = new Set([".git", "coverage", "dist", "node_modules", "tmp"]);

const REQUIRED_PRIMITIVES = [
  "packages/connections-ui/src/components/motion/AppMaterialContentTransition.vue",
  "packages/connections-ui/src/components/motion/AppMaterialListMorph.vue",
  "packages/connections-ui/src/components/motion/AppMaterialProgressMotion.vue",
  "packages/connections-ui/src/components/motion/AppMaterialFocusPulse.vue",
];

const REQUIRED_PRIMITIVE_CONSUMERS = [
  {
    filePath: "src/components/shared/table/AppTable.vue",
    snippets: ["AppMaterialContentTransition", "AppMaterialListMorph", "rowMotion", "stateMotion"],
    message: "AppTable should keep opt-in row and state motion on shared Material primitives.",
  },
  {
    filePath: "src/components/shared/table/AppTableDetailDock.vue",
    snippets: ["AppMaterialContentTransition", "contentKey", 'preset: "detail"'],
    message: "AppTableDetailDock should keep keyed detail body changes on the shared Material content primitive.",
  },
  {
    filePath: "src/components/workspace/views/host/WorkspaceHostConsoleEditorShellV2.vue",
    snippets: ["AppMaterialContentTransition", "activeTab", "gc-editor-plain-content-surface"],
    message:
      "WorkspaceHostConsoleEditorShellV2 should keep tab panel changes on the shared Material content primitive.",
  },
  {
    filePath: "src/components/workspace/views/host/WorkspaceHostConsoleCheckInTab.vue",
    snippets: ["AppMaterialContentTransition", "badgeTemplateMotionKey", "saveSuccess"],
    message: "WorkspaceHostConsoleCheckInTab should keep badge editor and save feedback motion on shared primitives.",
  },
  {
    filePath: "src/components/workspace/views/forms/WorkspaceFormsView.vue",
    snippets: [
      "AppMaterialContentTransition",
      "AppMaterialFocusPulse",
      "AppAnimatedSwapText",
      "selectedSubmissionMotionKey",
    ],
    message: "WorkspaceFormsView should keep form detail micro-feedback on shared Material primitives.",
  },
  {
    filePath: "src/components/workspace/shell/DesktopSearchSurface.vue",
    snippets: ["AppMaterialContentTransition", "desktopSearchPanelMode"],
    message: "DesktopSearchSurface should keep search panel body states on the shared Material content primitive.",
  },
  {
    filePath: "src/components/workspace/shell/WorkspaceMobileAssistantSurface.vue",
    snippets: ["AppMaterialContentTransition", "mobile-search-paywall", "mobile-search-feed"],
    message:
      "WorkspaceMobileAssistantSurface should keep mobile search assistant states on shared Material primitives.",
  },
  {
    filePath: "src/components/workspace/shell/WorkspaceSearchResultList.vue",
    snippets: ["AppMaterialListMorph", "resultTestIdPrefix"],
    message: "WorkspaceSearchResultList should keep result row changes on the shared Material list morph primitive.",
  },
  {
    filePath: "src/components/public/hosted-event-public/HostedEventPublicRegistrationPanel.vue",
    snippets: ["AppMaterialProgressMotion", "AppMaterialFocusPulse", "registrationProgressValue"],
    message:
      "HostedEventPublicRegistrationPanel should keep registration progress and requirement emphasis on shared primitives.",
  },
  {
    filePath: "src/components/public/hosted-event-public/shared/HostedEventTicketTierPicker.vue",
    snippets: ["AppMaterialContentTransition", "selectedTicketTierMotionKey"],
    message: "HostedEventTicketTierPicker should keep selected tier handoffs on the shared Material content primitive.",
  },
  {
    filePath: "src/components/public/explore/ExploreMapView.vue",
    snippets: ["AppMaterialFocusPulse", "highlightedEventId"],
    message: "ExploreMapView should keep map/list focus feedback on the shared Material pulse primitive.",
  },
  {
    filePath: "src/components/workspace/views/calendar/WorkspaceSharedCalendarView.vue",
    snippets: ["AppMaterialContentTransition", "rowMotion", "stateMotion"],
    message: "WorkspaceSharedCalendarView should keep row and selected event continuity on shared Material primitives.",
  },
  {
    filePath: "src/components/workspace/views/calendar/WorkspaceCalendarBookingTab.vue",
    snippets: ["AppMaterialContentTransition", "AppMaterialProgressMotion", "rowMotion", "stateMotion"],
    message:
      "WorkspaceCalendarBookingTab should keep booking row/detail/availability motion on shared Material primitives.",
  },
  {
    filePath: "src/components/public/MyConnectPublicPage.vue",
    snippets: ["AppMaterialContentTransition", "AppMaterialFocusPulse", "publicCardMotionKey"],
    message: "MyConnectPublicPage should keep public preview swaps and share feedback on shared Material primitives.",
  },
];

const REQUIRED_TRANSITION_NAMES = [
  "gc-material-content-standard",
  "gc-material-content-fast",
  "gc-material-content-slow",
  "gc-material-content-detail",
];

const RULES = {
  "missing-material-motion-primitive": {
    severity: "error",
    description: "Material motion patterns must be owned by shared primitives before product surfaces consume them.",
  },
  "missing-material-motion-consumer": {
    severity: "error",
    description: "High-leverage product surfaces must consume shared Material motion primitives instead of drifting.",
  },
  "missing-material-content-transition-css": {
    severity: "error",
    description:
      "Shared Material content transition primitives require matching transition classes in transitions.css.",
  },
  "direct-material-content-transition-name": {
    severity: "error",
    description:
      "Product surfaces should consume AppMaterialContentTransition instead of binding gc-material-content-* names directly.",
  },
  "direct-list-row-morph-transition-group": {
    severity: "warning",
    description:
      'Product surfaces should consume AppMaterialListMorph instead of binding TransitionGroup name="gc-list-row-morph" directly.',
  },
};

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function relativePath(filePath) {
  return normalizePath(path.relative(ROOT, filePath));
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

async function walkPath(fullPath) {
  if (!existsSync(fullPath)) {
    return [];
  }

  const info = await stat(fullPath);
  if (info.isFile()) {
    return SOURCE_EXTENSIONS.has(path.extname(fullPath)) ? [fullPath] : [];
  }

  const entries = await readdir(fullPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) {
      continue;
    }

    const childPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkPath(childPath)));
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(childPath);
    }
  }

  return files;
}

async function collectFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    files.push(...(await walkPath(path.join(ROOT, root))));
  }

  return Array.from(new Set(files)).sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
}

function isAllowedDirectListMorphPath(rel) {
  return (
    rel.startsWith("packages/connections-ui/src/components/") ||
    rel.startsWith("src/components/shared/")
  );
}

function auditRequiredPrimitives(findings) {
  for (const primitivePath of REQUIRED_PRIMITIVES) {
    if (existsSync(path.join(ROOT, primitivePath))) {
      continue;
    }

    addFinding(
      findings,
      "missing-material-motion-primitive",
      primitivePath,
      1,
      `Missing shared Material motion primitive: ${path.basename(primitivePath)}.`,
      primitivePath,
    );
  }
}

function auditRequiredPrimitiveConsumers(findings, files) {
  for (const consumer of REQUIRED_PRIMITIVE_CONSUMERS) {
    const file = files.find((candidate) => candidate.rel === consumer.filePath);
    if (!file) {
      addFinding(
        findings,
        "missing-material-motion-consumer",
        consumer.filePath,
        1,
        consumer.message,
        consumer.filePath,
      );
      continue;
    }

    for (const snippet of consumer.snippets) {
      if (file.source.includes(snippet)) {
        continue;
      }

      addFinding(
        findings,
        "missing-material-motion-consumer",
        consumer.filePath,
        1,
        `${consumer.message} Missing ${snippet}.`,
        snippet,
      );
    }
  }
}

function auditTransitionCss(findings, files) {
  const transitionCss = files.find((file) => file.rel === "src/styles/core/transitions.css");
  if (!transitionCss) {
    addFinding(
      findings,
      "missing-material-content-transition-css",
      "src/styles/core/transitions.css",
      1,
      "Missing transitions.css from material motion primitive audit roots.",
    );
    return;
  }

  for (const transitionName of REQUIRED_TRANSITION_NAMES) {
    if (transitionCss.source.includes(`.${transitionName}-enter-active`)) {
      continue;
    }

    addFinding(
      findings,
      "missing-material-content-transition-css",
      transitionCss.rel,
      1,
      `Missing shared Material content transition class for ${transitionName}.`,
      transitionName,
    );
  }
}

function auditDirectPrimitiveBypass(findings, files) {
  const directContentTransitionPattern = /<\s*Transition\b[^>]*\bname\s*=\s*"gc-material-content-[^"]+"/g;
  const directListMorphPattern = /<\s*TransitionGroup\b[^>]*\bname\s*=\s*"gc-list-row-morph"/g;

  for (const { rel, source } of files) {
    if (!rel.endsWith(".vue")) {
      continue;
    }

    directContentTransitionPattern.lastIndex = 0;
    for (const match of source.matchAll(directContentTransitionPattern)) {
      addFinding(
        findings,
        "direct-material-content-transition-name",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Use AppMaterialContentTransition so product content swaps stay on the shared Material primitive path.",
        match[0],
      );
    }

    if (isAllowedDirectListMorphPath(rel)) {
      continue;
    }

    directListMorphPattern.lastIndex = 0;
    for (const match of source.matchAll(directListMorphPattern)) {
      addFinding(
        findings,
        "direct-list-row-morph-transition-group",
        rel,
        lineNumberAt(source, match.index ?? 0),
        "Use AppMaterialListMorph so list morphs stay on the shared Material primitive path.",
        match[0],
      );
    }
  }
}

function renderMarkdown(findings) {
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [];
  lines.push("# Material Motion Primitive Audit");
  lines.push("");
  lines.push(`- Total findings: ${findings.length}`);
  lines.push(`- Errors: ${counts.error ?? 0}`);
  lines.push(`- Warnings: ${counts.warning ?? 0}`);
  lines.push("");

  if (!findings.length) {
    lines.push("No Material motion primitive drift found.");
    return `${lines.join("\n")}\n`;
  }

  for (const finding of findings) {
    const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
    lines.push(`- ${finding.severity.toUpperCase()}: \`${finding.ruleId}\` - ${location} - ${finding.message}`);
    if (finding.snippet) {
      lines.push(`  - ${finding.snippet}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runMaterialMotionPrimitiveAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  SCAN_ROOTS = options.roots?.length ? [...options.roots] : [...DEFAULT_SCAN_ROOTS];

  const filePaths = await collectFiles();
  const files = [];
  for (const filePath of filePaths) {
    files.push({
      rel: relativePath(filePath),
      source: await readFile(filePath, "utf8"),
    });
  }

  const findings = [];

  auditRequiredPrimitives(findings);
  auditRequiredPrimitiveConsumers(findings, files);
  auditTransitionCss(findings, files);
  auditDirectPrimitiveBypass(findings, files);

  findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.filePath.localeCompare(b.filePath) || a.line - b.line);

  return {
    failed: findings.some((finding) => finding.severity === "error"),
    findings,
    rules: RULES,
    jsonPayload: { findings, rules: RULES },
    report: renderMarkdown(findings),
  };
}

async function main() {
  const result = await runMaterialMotionPrimitiveAudit();
  if (hasFlag("--json")) {
    console.log(JSON.stringify(result.jsonPayload, null, 2));
  } else if (!hasFlag("--quiet") || result.findings.length > 0) {
    console.log(result.report.trimEnd());
  }

  if (hasFlag("--fail-on-drift") && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[material-motion-primitive-engine] failed:", error);
    process.exitCode = 1;
  });
}
