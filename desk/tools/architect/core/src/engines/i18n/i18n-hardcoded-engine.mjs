import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const defaultI18nHardcodedTargets = [];

const visibleAttributePattern =
  /\s(?:aria-label|error-title|empty-query-text|label|loading-label|no-results-text|placeholder|retry-label|title|tooltip)="([^"{][^"]*[A-Za-z][^"]*)"/g;
const textNodePattern = />\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*)\s*</g;
// Template literals used in user-visible contexts. The host name appears
// directly before the backtick on the same line; we anchor to known toast /
// snackbar / dialog / error / aria-label hosts so general-purpose URL or path
// template literals (`${prefix}/${id}`) aren't dragged in.
const VISIBLE_TEMPLATE_LITERAL_HOSTS_RE =
  "showSnackbar|showToast|showError|showInfoSnackbar|showSuccessSnackbar|showErrorSnackbar|openConfirmDialog|openErrorDialog|errorMessage|errorTitle|message|placeholder|ariaLabel|aria-label|label";
const visibleTemplateLiteralPattern = new RegExp(
  String.raw`\b(?:` +
    VISIBLE_TEMPLATE_LITERAL_HOSTS_RE +
    String.raw`)\s*[:(=]\s*` +
    "`" +
    String.raw`([^` +
    "`" +
    String.raw`]*[A-Za-z][^` +
    "`" +
    String.raw`]*)` +
    "`",
  "g",
);
const thrownErrorTemplateLiteralPattern = /throw\s+new\s+(?:Error|TypeError|RangeError)\s*\(\s*`([^`]*[A-Za-z][^`]*)`/g;
// Non-ASCII letter character (any script) — flags "Iniciar sesión" / "登录" etc.
// in code that should be using i18n keys regardless of source language.
// Catches any non-ASCII letter (Latin-extended, Cyrillic, CJK, Hangul,
// Hebrew, Arabic, etc.). isIgnoredLine filters comments and imports, so this
// fires only on string literals that intentionally contain non-English text.
// Letter ranges only: excludes math/punctuation glyphs (\u00D7 \u00F7 \u2014 etc.) that are
// legitimate UI characters and don't need i18n.
const nonAsciiLetterPattern =
  /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/u;

function collectFiles(root, target) {
  const absoluteTarget = join(root, target);
  const stat = statSync(absoluteTarget);
  if (stat.isFile()) {
    return [absoluteTarget];
  }

  return readdirSync(absoluteTarget).flatMap((entry) => collectFiles(root, join(target, entry)));
}

function shouldScan(file) {
  return [".vue", ".ts"].includes(extname(file)) && !file.endsWith(".spec.ts");
}

function isIgnoredLine(line) {
  return (
    /^\s*(\/\/|\/\*|<!--|\*|-{2,})/.test(line) ||
    line.includes(" tr(") ||
    line.includes("translate(") ||
    line.includes("data-testid") ||
    line.includes("class=") ||
    line.includes("console.") ||
    line.includes("import ") ||
    line.includes(" from ") ||
    line.includes("https://...") ||
    /^\s*(type|interface)\s/.test(line) ||
    /^\s*(export\s+)?(async\s+)?function\s+.*\b(Record|Map|Array|Promise)\b/.test(line) ||
    /^\s*[A-Za-z_$][\w$?]*\s*[):][^;]*\b(Record|Map|Array|Promise)\b/.test(line) ||
    /^\s*[),][^;]*\b(Record|Map|Array|Promise)\b/.test(line) ||
    /^\s*>?\([^;]*\b(Record|Map|Array|Promise)\b/.test(line) ||
    /^\s*\([^;]*\b(Record|Map|Array|Promise)\b/.test(line) ||
    /^\s*\|\s*(Array|Record|Map|Promise)\b/.test(line) ||
    /^\s*export function \w+\([^)]*\{.*\bRef\b/.test(line) ||
    /^\s*&\s*(Partial|Pick|Omit|Readonly|Record)\b/.test(line) ||
    />\s*&\s*(Partial|Pick|Omit|Readonly|Record)</.test(line) ||
    /^\s*function\s+\w+<[^>]+>/.test(line) ||
    /^\s*async function\s+\w+<[^>]+>/.test(line) ||
    /^\s*async function\s+\w+\([^)]*handler:\s*\(\) =>/.test(line) ||
    /^\s*function\s+\w+\([^)]*handler:\s*\(\) =>/.test(line) ||
    /^\s*\w+\??:\s*\([^)]*\) =>/.test(line) ||
    /=>/.test(line) ||
    /^\s*function\s+\w+\([^)]*:\s*(Readonly)?Set/.test(line) ||
    /^\s*if \(.*(===|!==|>=|<=|>|<).*$/.test(line) ||
    /^\s*if \([^)]*$/.test(line) ||
    /^\s*return\s+.*(===|!==|>=|<=|>|<).*$/.test(line) ||
    /^\s*(const|let|var)\s+\w+\s*=\s*.*(===|!==|>=|<=|>|<).*$/.test(line) ||
    /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*(===|!==|>=|<=|>|<).*$/.test(line) ||
    /^\s*(const|let|var)\s+\w+\s*=\s*\/.*\/[a-z]*;?\s*$/.test(line) ||
    /^\s*\.replace\(\/.*\/[a-z]*,/.test(line)
  );
}

export function runI18nHardcodedAudit(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const targets = options.targets?.length ? options.targets : defaultI18nHardcodedTargets;
  const findings = [];
  const missingTargets = [];

  for (const target of targets) {
    let files;
    try {
      files = collectFiles(root, target).filter(shouldScan);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missingTargets.push(target);
        continue;
      }
      throw error;
    }

    for (const file of files) {
      const relativeFile = relative(root, file).replace(/\\/g, "/");
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (isIgnoredLine(line)) {
          return;
        }

        for (const match of line.matchAll(visibleAttributePattern)) {
          findings.push({ file: relativeFile, line: index + 1, text: match[1].trim() });
        }

        for (const match of line.matchAll(textNodePattern)) {
          const text = match[1].trim();
          if (
            text &&
            text !== "&nbsp;" &&
            !text.includes("`") &&
            !text.startsWith("/") &&
            !/^[a-z0-9_-]+$/i.test(text)
          ) {
            findings.push({ file: relativeFile, line: index + 1, text });
          }
        }

        for (const match of line.matchAll(visibleTemplateLiteralPattern)) {
          const text = match[1].trim();
          if (text) {
            findings.push({ file: relativeFile, line: index + 1, text: `\`${text}\` (template literal)` });
          }
        }

        for (const match of line.matchAll(thrownErrorTemplateLiteralPattern)) {
          const text = match[1].trim();
          if (text) {
            findings.push({ file: relativeFile, line: index + 1, text: `Error(\`${text}\`)` });
          }
        }

        if (nonAsciiLetterPattern.test(line)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("<!--")) {
            findings.push({
              file: relativeFile,
              line: index + 1,
              text: `non-ASCII text on this line (move to i18n): ${trimmed.slice(0, 100)}`,
            });
          }
        }
      });
    }
  }

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      targets,
      missingTargets,
      findingCount: findings.length,
      findings,
    },
    report: renderReport({ findings, missingTargets, targets }),
  };
}

function renderReport({ findings, missingTargets, targets }) {
  const lines = [];
  lines.push("# I18n Hardcoded Strings Audit");
  lines.push("");
  lines.push(`- Targets audited: ${targets.length}`);
  lines.push(`- Missing targets: ${missingTargets.length}`);
  lines.push(`- Findings: ${findings.length}`);
  lines.push("");

  if (missingTargets.length > 0) {
    lines.push("## Missing Targets", "");
    for (const target of missingTargets) lines.push(`- \`${target}\``);
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("## No Findings", "");
    lines.push("No hardcoded user-facing strings found in audited targets.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Findings", "");
  lines.push("| File | Line | Text |");
  lines.push("| --- | ---: | --- |");
  for (const finding of findings) {
    lines.push(`| \`${finding.file}\` | ${finding.line} | \`${escapeTableText(finding.text)}\` |`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeTableText(text) {
  return text.replaceAll("|", "\\|").replaceAll("`", "'");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const result = runI18nHardcodedAudit({ root: defaultRoot, targets: targetArgs });
  console.log(JSON.stringify(result.jsonPayload, null, 2));
  if (process.argv.includes("--fail-on-drift") && result.failed) process.exitCode = 1;
}
