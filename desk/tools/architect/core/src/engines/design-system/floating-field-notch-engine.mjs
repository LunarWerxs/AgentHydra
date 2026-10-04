import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";

/**
 * Floating-field notch-mask engine.
 *
 * The "notched outline" on a public floating-label field is produced by painting
 * the label's background over the control's top border. That mask only works if
 * it is OPAQUE. The original bug: the mask used `--gc-floating-field-surface`
 * (= `--public-input-bg`), which on a themed card resolves to a ~7%-alpha tint —
 * so it never covered the stroke and the label floated over a closed outline.
 *
 * Invariant guarded here (against `app-text-field.css`):
 *   1. A `--gc-floating-field-notch-surface` is defined (the opaque source).
 *   2. It resolves to an opaque CARD surface token, never the translucent
 *      input-surface tokens.
 *   3. A floating-label `background` actually references that notch surface, so
 *      the mask is applied.
 *
 * This is a source contract (à la workspace-surface-visibility): it catches a
 * revert/weakening of the fix. The rendered-pixel guarantee belongs to a
 * computed-style render test; this is the cheap, CI-friendly first line.
 */

const RULES = {
  "floating-field-notch-opaque-mask": {
    severity: "error",
    description:
      "The public floating-label notch mask must paint an OPAQUE card surface so it covers the field outline. " +
      "A translucent mask (e.g. --public-input-bg / --gc-floating-field-surface, ~7% on themed cards) leaves the " +
      "label floating over a closed stroke instead of notching it.",
  },
};

const NOTCH_SURFACE_VAR = "--gc-floating-field-notch-surface";
const OPAQUE_CARD_SURFACE_TOKENS = [
  "--gc-app-card-filled-container",
  "--gc-app-card-outlined-container",
  "--gc-app-card-elevated-container",
];
const TRANSLUCENT_SURFACE_TOKENS = ["--public-input-bg", "--gc-floating-field-surface"];

function normalizePath(filePath) {
  return String(filePath ?? "").replace(/\\/g, "/");
}

function firstReferencedVar(value) {
  const match = String(value ?? "").match(/var\(\s*(--[a-z0-9-]+)/i);
  return match ? match[1] : "";
}

function readCss(root, relPath, findings) {
  const absolutePath = path.resolve(root, relPath);
  if (!existsSync(absolutePath)) {
    findings.push({
      ruleId: "floating-field-notch-opaque-mask",
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

export function runFloatingFieldNotchAudit({
  root,
  cssFile = "packages/connections-ui/src/styles/primitives/app-text-field.css",
} = {}) {
  const findings = [];
  const filesScanned = [];
  const relPath = normalizePath(cssFile);

  const css = readCss(root, relPath, findings);
  if (!css) {
    return { findings, filesScanned, rules: RULES };
  }
  filesScanned.push(relPath);

  const notchDecls = [];
  let labelBackgroundUsesNotchVar = false;

  css.root.walkDecls((decl) => {
    if (decl.prop === NOTCH_SURFACE_VAR) {
      notchDecls.push(decl);
    }
    if (decl.prop === "background" && String(decl.value).includes(`var(${NOTCH_SURFACE_VAR}`)) {
      labelBackgroundUsesNotchVar = true;
    }
  });

  if (notchDecls.length === 0) {
    findings.push({
      ruleId: "floating-field-notch-opaque-mask",
      severity: "error",
      filePath: relPath,
      line: 1,
      message:
        `No \`${NOTCH_SURFACE_VAR}\` declaration found. The public floating-label notch mask must define an ` +
        `opaque card surface (one of ${OPAQUE_CARD_SURFACE_TOKENS.join(", ")}) — otherwise the label floats over ` +
        `a closed outline (the 7%-alpha mask regression).`,
      snippet: "",
    });
  }

  for (const decl of notchDecls) {
    const value = String(decl.value);
    const usesOpaqueCardToken = OPAQUE_CARD_SURFACE_TOKENS.some((token) => value.includes(token));
    const startsWithTranslucentToken = TRANSLUCENT_SURFACE_TOKENS.includes(firstReferencedVar(value));

    if (!usesOpaqueCardToken || startsWithTranslucentToken) {
      findings.push({
        ruleId: "floating-field-notch-opaque-mask",
        severity: "error",
        filePath: relPath,
        line: decl.source?.start?.line ?? 1,
        message:
          `\`${NOTCH_SURFACE_VAR}\` must resolve to an opaque card surface ` +
          `(${OPAQUE_CARD_SURFACE_TOKENS.join(", ")}), never a translucent input surface ` +
          `(${TRANSLUCENT_SURFACE_TOKENS.join(", ")}). Found \`${value}\`.`,
        snippet: `${decl.prop}: ${decl.value};`,
      });
    }
  }

  if (notchDecls.length > 0 && !labelBackgroundUsesNotchVar) {
    findings.push({
      ruleId: "floating-field-notch-opaque-mask",
      severity: "error",
      filePath: relPath,
      line: notchDecls[0].source?.start?.line ?? 1,
      message:
        `\`${NOTCH_SURFACE_VAR}\` is defined but no floating-label \`background\` references it — the notch ` +
        `mask is not applied, so the outline will not be cut around the label.`,
      snippet: "",
    });
  }

  return { findings, filesScanned, rules: RULES };
}

export function renderReport({ findings, filesScanned }) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const lines = [
    "# Floating Field Notch Mask Audit",
    "",
    `- Files scanned: **${filesScanned.length}**`,
    `- Errors: **${errors.length}**`,
    `- Findings: **${findings.length}**`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("Public floating-label notch mask paints an opaque card surface. No regression detected.", "");
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
