import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const HASH_PREFIX = "sha256";
const LINE_HASH_LENGTH = 12;
const CONTEXT_HASH_LENGTH = 12;
const CONTEXT_RADIUS = 2;

export function hashSourceText(text, length = LINE_HASH_LENGTH) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, length);
}

export function buildSourceAnchor({ filePath, line, root = process.cwd(), readFile = defaultReadFile } = {}) {
  const normalizedLine = Number(line) || 0;
  if (!filePath || normalizedLine <= 0) return null;

  const absolutePath = resolveSafePath(root, filePath);
  if (!absolutePath) return null;

  let text;
  try {
    text = readFile(absolutePath);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;

  const lines = text.split(/\r?\n/);
  const index = normalizedLine - 1;
  if (index < 0 || index >= lines.length) return null;

  const contextStartLine = Math.max(1, normalizedLine - CONTEXT_RADIUS);
  const contextEndLine = Math.min(lines.length, normalizedLine + CONTEXT_RADIUS);
  const contextText = lines.slice(contextStartLine - 1, contextEndLine).join("\n");
  const lineHash = hashSourceText(lines[index], LINE_HASH_LENGTH);
  const contextHash = hashSourceText(contextText, CONTEXT_HASH_LENGTH);

  return {
    version: 1,
    kind: "content-hash",
    filePath: toPosixPath(path.relative(path.resolve(root), absolutePath)),
    line: normalizedLine,
    anchor: `L${normalizedLine}:${HASH_PREFIX}-${lineHash}`,
    lineHash: `${HASH_PREFIX}-${lineHash}`,
    contextStartLine,
    contextEndLine,
    contextHash: `${HASH_PREFIX}-${contextHash}`,
  };
}

export function enrichFindingWithSourceAnchor(finding, options = {}) {
  if (!finding || typeof finding !== "object") return finding;
  if (finding.sourceAnchor) return finding;

  const filePath = finding.filePath ?? finding.location?.file ?? "";
  const line = finding.line ?? finding.location?.line ?? 0;
  const sourceAnchor = buildSourceAnchor({ ...options, filePath, line });
  if (!sourceAnchor) return finding;
  return { ...finding, sourceAnchor };
}

export function enrichFindingsWithSourceAnchors(findings, options = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return findings ?? [];

  const fileCache = new Map();
  const readFile = options.readFile ?? ((absolutePath) => {
    if (fileCache.has(absolutePath)) return fileCache.get(absolutePath);
    const text = defaultReadFile(absolutePath);
    fileCache.set(absolutePath, text);
    return text;
  });

  return findings.map((finding) => enrichFindingWithSourceAnchor(finding, { ...options, readFile }));
}

function resolveSafePath(root, filePath) {
  const rootAbs = path.resolve(root);
  const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(rootAbs, filePath);
  const relative = path.relative(rootAbs, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!existsSync(candidate)) return null;
  return candidate;
}

function defaultReadFile(absolutePath) {
  return readFileSync(absolutePath, "utf8");
}

function toPosixPath(value) {
  return String(value ?? "").split(path.sep).join("/");
}
