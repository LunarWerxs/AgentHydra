import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MOBILE_BREAKPOINT = "56rem";
const MOBILE_MAX_BREAKPOINT = "55.9375rem";
const TOPBAR_BREAKPOINT = "64rem";
const TOPBAR_MAX_BREAKPOINT = "63.9375rem";

export const HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS = {
  bodyFiles: [
    {
      path: "src/components/public/HostedEventPublicPage.vue",
      requiredMarkers: [
        "max-w-[30rem]",
        "min-[56rem]:max-w-5xl",
        "min-[56rem]:grid-cols-[minmax(0,1fr)_20rem]",
        "max-[55.9375rem]:hidden",
      ],
    },
    {
      path: "src/components/public/shared/PublicHostedContentGrid.vue",
      requiredMarkers: [
        "min-[56rem]:grid-cols-[minmax(0,1fr)_20rem]",
        "min-[56rem]:col-start-2",
      ],
    },
    {
      path: "src/components/public/shared/PublicHostedPageFrame.vue",
      requiredMarkers: [
        "max-w-[30rem]",
        "min-[56rem]:max-w-5xl",
        "min-[56rem]:grid-cols-[minmax(0,1fr)_20rem]",
      ],
    },
    {
      path: "src/components/public/hosted-event-public/HostedEventPublicContentSections.vue",
      requiredMarkers: ["min-[56rem]:block"],
    },
    {
      path: "src/components/public/hosted-event-public/HostedEventPublicHeaderSection.vue",
      requiredMarkers: ["max-[55.9375rem]:px-5"],
    },
  ],
  routeCssFiles: [
    {
      path: "src/styles/routes/public/hosted-event/hosted-event-page.css",
      requiredMarkers: [`@media (min-width: ${MOBILE_BREAKPOINT})`, `@media (max-width: ${MOBILE_MAX_BREAKPOINT})`],
    },
    {
      path: "src/styles/routes/public/hosted-event/hosted-event-content.css",
      requiredMarkers: [`@media (min-width: ${MOBILE_BREAKPOINT})`],
    },
  ],
  topbarFile: "src/styles/routes/public/hosted-event/hosted-event-topbar.css",
};

const RULES = {
  "hosted-event-body-two-compositions": {
    severity: "error",
    description:
      "The hosted-event page body must have only two compositions: a capped mobile column below 56rem and the desktop grid at 56rem+.",
  },
  "hosted-event-topbar-compact-breakpoint": {
    severity: "error",
    description:
      "The hosted-event topbar keeps its own compact layout until 64rem so it does not crowd the event content at wide-mobile widths.",
  },
  "hosted-event-legacy-tablet-breakpoint": {
    severity: "error",
    description:
      "Hosted-event body/frame files must not reintroduce legacy tablet breakpoints or Tailwind lg: layout switches.",
  },
};

const LEGACY_BODY_PATTERNS = [
  {
    regex: /\blg:/g,
    label: "Tailwind lg: variant",
  },
  {
    regex: /min-\[64rem\]|max-\[63\.9375rem\]/g,
    label: "64rem topbar breakpoint in body layout",
  },
  {
    regex: /min-\[1100px\]|max-\[1099px\]|68\.75rem|68\.6875rem/g,
    label: "legacy 1100px tablet breakpoint",
  },
];

const LEGACY_ROUTE_CSS_PATTERNS = [
  {
    regex: /1100px|1099px|68\.75rem|68\.6875rem/g,
    label: "legacy 1100px tablet breakpoint",
  },
];

function normalizePath(filePath) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

function readSource(root, relPath, findings) {
  const normalizedPath = normalizePath(relPath);
  const absolutePath = path.resolve(root, normalizedPath);
  if (!existsSync(absolutePath)) {
    findings.push({
      ruleId: "hosted-event-body-two-compositions",
      severity: "error",
      filePath: normalizedPath,
      line: 1,
      message: `Missing required hosted-event responsive contract file: ${normalizedPath}`,
      snippet: "",
    });
    return null;
  }
  return readFileSync(absolutePath, "utf8");
}

function lineNumberForIndex(source, index) {
  return source.slice(0, Math.max(0, index)).split("\n").length;
}

function requireMarker({ filePath, source, marker, ruleId, findings }) {
  if (source.includes(marker)) return;
  findings.push({
    ruleId,
    severity: "error",
    filePath,
    line: 1,
    message: `Expected \`${marker}\` to preserve the hosted-event two-composition responsive contract.`,
    snippet: "",
  });
}

function forbidPattern({ filePath, source, pattern, ruleId, findings }) {
  for (const match of source.matchAll(pattern.regex)) {
    findings.push({
      ruleId,
      severity: "error",
      filePath,
      line: lineNumberForIndex(source, match.index ?? 0),
      message: `Do not use ${pattern.label} in this hosted-event responsive contract surface.`,
      snippet: match[0],
    });
  }
}

function assertRequiredMarkers({ root, entries, ruleId, findings, filesScanned }) {
  for (const entry of entries) {
    const filePath = normalizePath(entry.path);
    const source = readSource(root, filePath, findings);
    if (source == null) continue;
    filesScanned.push(filePath);
    for (const marker of entry.requiredMarkers ?? []) {
      requireMarker({ filePath, source, marker, ruleId, findings });
    }
  }
}

export function runHostedEventResponsiveContractAudit({
  root,
  bodyFiles = HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.bodyFiles,
  routeCssFiles = HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.routeCssFiles,
  topbarFile = HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.topbarFile,
} = {}) {
  const findings = [];
  const filesScanned = [];

  assertRequiredMarkers({
    root,
    entries: bodyFiles,
    ruleId: "hosted-event-body-two-compositions",
    findings,
    filesScanned,
  });
  assertRequiredMarkers({
    root,
    entries: routeCssFiles,
    ruleId: "hosted-event-body-two-compositions",
    findings,
    filesScanned,
  });

  for (const entry of [...bodyFiles, ...routeCssFiles]) {
    const filePath = normalizePath(entry.path);
    const source = readSource(root, filePath, findings);
    if (source == null) continue;
    const patterns = entry.path.endsWith(".css") ? LEGACY_ROUTE_CSS_PATTERNS : LEGACY_BODY_PATTERNS;
    for (const pattern of patterns) {
      forbidPattern({
        filePath,
        source,
        pattern,
        ruleId: "hosted-event-legacy-tablet-breakpoint",
        findings,
      });
    }
  }

  const normalizedTopbarPath = normalizePath(topbarFile);
  const topbarSource = readSource(root, normalizedTopbarPath, findings);
  if (topbarSource != null) {
    filesScanned.push(normalizedTopbarPath);
    for (const marker of [
      `@media (min-width: ${TOPBAR_BREAKPOINT})`,
      `@media (max-width: ${TOPBAR_MAX_BREAKPOINT})`,
    ]) {
      requireMarker({
        filePath: normalizedTopbarPath,
        source: topbarSource,
        marker,
        ruleId: "hosted-event-topbar-compact-breakpoint",
        findings,
      });
    }
    for (const pattern of [
      { regex: /@media \(min-width: 56rem\)/g, label: "56rem body breakpoint" },
      { regex: /@media \(max-width: 55\.9375rem\)/g, label: "55.9375rem body breakpoint" },
    ]) {
      forbidPattern({
        filePath: normalizedTopbarPath,
        source: topbarSource,
        pattern,
        ruleId: "hosted-event-topbar-compact-breakpoint",
        findings,
      });
    }
  }

  return {
    findings,
    filesScanned: [...new Set(filesScanned)],
    rules: RULES,
  };
}

export function renderReport({ findings, filesScanned }) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const lines = [
    "# Hosted Event Responsive Contract Audit",
    "",
    `- Files scanned: **${filesScanned.length}**`,
    `- Errors: **${errors.length}**`,
    `- Findings: **${findings.length}**`,
    "",
  ];

  if (findings.length === 0) {
    lines.push(
      "Hosted-event public pages keep the two intended compositions: capped mobile body, desktop body at 56rem+, and compact topbar until 64rem.",
      "",
    );
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
