/**
 * lcov-engine — minimal LCOV parser
 * =================================
 * Parses LCOV "tracefile" records (the format `cargo llvm-cov`, `c8`, `nyc`,
 * `istanbul`, `lcov.info` all emit) into per-file function coverage maps.
 * Used by crap-engine to wire coverage % into the CRAP formula.
 *
 * Record summary:
 *   TN:<test-name>
 *   SF:<source-file>            file start
 *   FN:<line>,<fn-name>         function declared at <line>
 *   FNDA:<hit-count>,<fn-name>  function hit count
 *   DA:<line>,<hits>            line hit count
 *   end_of_record               file end
 */
import fs from "node:fs/promises";
import path from "node:path";

export async function loadLcov(absPath) {
  let text;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return { files: new Map(), path: absPath, missing: true };
  }
  return parseLcov(text, { path: absPath });
}

export function parseLcov(text, { path: source = "" } = {}) {
  const files = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("SF:")) {
      current = {
        sourceFile: normalize(line.slice(3)),
        functions: new Map(),
        lines: new Map(),
      };
      files.set(current.sourceFile, current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("FN:")) {
      const [lineNo, ...nameParts] = line.slice(3).split(",");
      const name = nameParts.join(",");
      current.functions.set(name, {
        name,
        startLine: Number(lineNo) || 0,
        hits: current.functions.get(name)?.hits ?? 0,
      });
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...nameParts] = line.slice(5).split(",");
      const name = nameParts.join(",");
      const fn = current.functions.get(name) ?? { name, startLine: 0, hits: 0 };
      fn.hits = Math.max(fn.hits, Number(hits) || 0);
      current.functions.set(name, fn);
    } else if (line.startsWith("DA:")) {
      const [lineNo, hits] = line.slice(3).split(",");
      current.lines.set(Number(lineNo), Number(hits) || 0);
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return { files, path: source, missing: false };
}

function normalize(p) {
  return String(p ?? "").replaceAll("\\", "/");
}

/**
 * Resolve a function's coverage percentage as `covered_lines / total_lines * 100`
 * across the function span [startLine, endLine].
 * Returns null when no line hits are recorded for the span.
 */
export function functionCoverage(lcovFile, startLine, endLine) {
  if (!lcovFile) return null;
  let total = 0;
  let covered = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    const hits = lcovFile.lines.get(line);
    if (hits === undefined) continue;
    total += 1;
    if (hits > 0) covered += 1;
  }
  if (total === 0) return null;
  return (covered / total) * 100;
}

/**
 * Match an arkitect-relative file path against an LCOV file map.
 * LCOV often stores absolute paths; we try suffix matching as a fallback.
 */
export function findLcovFile(filesMap, relPath, root) {
  const norm = normalize(relPath);
  if (filesMap.has(norm)) return filesMap.get(norm);
  const abs = root ? normalize(path.resolve(root, relPath)) : null;
  if (abs && filesMap.has(abs)) return filesMap.get(abs);
  for (const [key, value] of filesMap) {
    if (key.endsWith(`/${norm}`) || (abs && key === abs)) return value;
  }
  return null;
}
