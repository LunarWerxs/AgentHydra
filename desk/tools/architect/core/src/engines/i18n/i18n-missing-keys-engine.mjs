import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".vue"];
const DEFAULT_SKIP_SEGMENTS = [".git", "coverage", "dist", "node_modules", "tmp"];
const DEFAULT_SKIP_FILE_PATTERNS = [
  String.raw`\.spec\.[cm]?[tj]sx?$`,
  String.raw`\.test\.[cm]?[tj]sx?$`,
  String.raw`(?:^|/)__tests__/`,
  String.raw`(?:^|/)fixtures/`,
  String.raw`(?:^|/)mocks/`,
];

const TRANSLATE_CALL_PATTERN = /\btranslate(?:Plural)?\s*\(\s*(['"`])([^'"`$]+)\1/g;
const WRAPPER_CALL_PREFIX_PATTERN = String.raw`\b`;
const WRAPPER_DECLARATION_PATTERNS = [
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\bkey\b[^)]*\)\s*=>\s*(?:\{[\s\S]{0,500}?\breturn\s+)?translate(?:Plural)?\s*\(\s*`([^`$]*)\$\{\s*key\s*\}([^`]*)`/g,
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\bkey\b[^)]*\)\s*\{[\s\S]{0,500}?\breturn\s+translate(?:Plural)?\s*\(\s*`([^`$]*)\$\{\s*key\s*\}([^`]*)`/g,
];

export function runI18nMissingKeysAudit(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const roots = options.roots?.length ? options.roots : ["src"];
  const extensions = new Set(options.extensions?.length ? options.extensions : DEFAULT_EXTENSIONS);
  const skipSegments = options.skipSegments?.length ? options.skipSegments : DEFAULT_SKIP_SEGMENTS;
  const skipFilePatterns = (
    options.skipFilePatterns?.length ? options.skipFilePatterns : DEFAULT_SKIP_FILE_PATTERNS
  ).map((pattern) => new RegExp(pattern));
  const messagesPath = options.messagesPath ?? "src/lib/i18n/messages/en-US";
  const knownKeys = collectMessageKeys(resolve(root, messagesPath));
  const files = collectFiles({ root, roots, extensions, skipSegments, skipFilePatterns });
  const findings = [];

  for (const absoluteFile of files) {
    const source = readFileSync(absoluteFile, "utf8");
    const relativeFile = relative(root, absoluteFile).replace(/\\/g, "/");
    if (relativeFile.startsWith("src/lib/i18n/messages/")) continue;

    const references = collectTranslationReferences(source);
    for (const reference of references) {
      if (!knownKeys.has(reference.key)) {
        findings.push({
          file: relativeFile,
          line: lineNumberAt(source, reference.index),
          key: reference.key,
          call: reference.call,
        });
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.key.localeCompare(b.key));

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      roots,
      messagesPath,
      keyCount: knownKeys.size,
      scannedFileCount: files.length,
      findingCount: findings.length,
      findings,
    },
    report: renderReport({ findings, roots, messagesPath, keyCount: knownKeys.size, scannedFileCount: files.length }),
  };
}

export function collectMessageKeys(messagesPath) {
  const keys = new Set();

  if (statSync(messagesPath).isDirectory()) {
    const dirPath = messagesPath;
    // Walk all .ts files in the directory (excluding barrel index.ts)
    for (const entry of readdirSync(dirPath, { recursive: true })) {
      const fullPath = resolve(dirPath, entry);
      if (!statSync(fullPath).isFile()) continue;
      if (!fullPath.endsWith(".ts")) continue;
      // Skip barrel files
      const basename = fullPath.split(/[/\\]/).pop();
      if (basename === "index.ts") continue;

      // Compute key prefix from file path relative to messages directory
      // e.g. common.ts → "common."
      // e.g. workspace/shell.ts → "workspace."
      const relativePath = relative(dirPath, fullPath).replace(/\\/g, "/");
      const parts = relativePath.split("/");
      // If file is in a subdirectory, prefix is subdirectory name + "."
      // If file is at root, prefix is filename without .ts + "."
      let prefix;
      if (parts.length > 1) {
        prefix = parts[0] + ".";
      } else {
        prefix = basename.replace(/\.ts$/, "") + ".";
      }

      const sourceText = readFileSync(fullPath, "utf8");
      const sourceFile = ts.createSourceFile(fullPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      collectKeysFromSourceFile(sourceFile, keys, prefix);
    }
  } else {
    const sourceText = readFileSync(messagesPath, "utf8");
    const sourceFile = ts.createSourceFile(messagesPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    collectKeysFromSourceFile(sourceFile, keys, "");
  }

  return keys;
}

function collectKeysFromSourceFile(sourceFile, keys, prefix) {
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        const fileKeys = new Set();
        collectObjectKeys(initializer, [], fileKeys);
        for (const key of fileKeys) {
          keys.add(prefix + key);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function collectTranslationReferences(source) {
  const references = [];
  const wrapperPrefixes = collectWrapperPrefixes(source);

  for (const match of source.matchAll(TRANSLATE_CALL_PATTERN)) {
    references.push({ key: match[2], index: match.index ?? 0, call: "translate" });
  }

  for (const [name, prefix] of wrapperPrefixes) {
    const escapedName = escapeRegExp(name);
    const callPattern = new RegExp(
      `${WRAPPER_CALL_PREFIX_PATTERN}${escapedName}\\s*\\(\\s*(['"\`])([^'"\`$]+)\\1`,
      "g",
    );
    for (const match of source.matchAll(callPattern)) {
      references.push({ key: `${prefix}${match[2]}`, index: match.index ?? 0, call: name });
    }
  }

  return references;
}

function collectWrapperPrefixes(source) {
  const wrappers = new Map();
  for (const pattern of WRAPPER_DECLARATION_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const suffix = match[3] ?? "";
      if (suffix.includes("${")) continue;
      wrappers.set(match[1], `${match[2]}${suffix}`);
    }
  }
  return wrappers;
}

function collectObjectKeys(node, path, keys) {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameToString(property.name);
    if (!name) continue;

    const nextPath = [...path, name];
    if (ts.isObjectLiteralExpression(property.initializer)) {
      collectObjectKeys(property.initializer, nextPath, keys);
    } else {
      keys.add(nextPath.join("."));
    }
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameToString(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function collectFiles({ root, roots, extensions, skipSegments, skipFilePatterns }) {
  const files = [];
  for (const entry of roots) {
    walk(resolve(root, entry), root, files, extensions, skipSegments, skipFilePatterns);
  }
  return files;
}

function walk(absolutePath, root, files, extensions, skipSegments, skipFilePatterns) {
  const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
  const segments = relativePath.split("/");
  if (segments.some((segment) => skipSegments.includes(segment))) return;
  if (skipFilePatterns.some((pattern) => pattern.test(relativePath))) return;

  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolutePath)) {
      walk(join(absolutePath, entry), root, files, extensions, skipSegments, skipFilePatterns);
    }
    return;
  }

  if (stat.isFile() && extensions.has(extname(absolutePath))) {
    files.push(absolutePath);
  }
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function renderReport({ findings, roots, messagesPath, keyCount, scannedFileCount }) {
  const lines = [];
  lines.push("# I18n Missing Keys Audit");
  lines.push("");
  lines.push(`- Roots audited: ${roots.join(", ")}`);
  lines.push(`- Message catalog: \`${messagesPath}\``);
  lines.push(`- Known keys: ${keyCount}`);
  lines.push(`- Files scanned: ${scannedFileCount}`);
  lines.push(`- Findings: ${findings.length}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("## No Findings", "");
    lines.push("No statically resolvable missing translation keys found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Findings", "");
  lines.push("| File | Line | Key | Call |");
  lines.push("| --- | ---: | --- | --- |");
  for (const finding of findings) {
    lines.push(`| \`${finding.file}\` | ${finding.line} | \`${escapeTableText(finding.key)}\` | \`${finding.call}\` |`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeTableText(text) {
  return text.replaceAll("|", "\\|").replaceAll("`", "'");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runI18nMissingKeysAudit({ root: defaultRoot });
  console.log(JSON.stringify(result.jsonPayload, null, 2));
  if (process.argv.includes("--fail-on-drift") && result.failed) process.exitCode = 1;
}
