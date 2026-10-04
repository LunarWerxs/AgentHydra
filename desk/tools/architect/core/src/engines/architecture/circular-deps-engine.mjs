/**
 * Circular dependency detection (madge-style).
 *
 * Algorithm: iterative DFS over the import graph with a recursion stack.
 * Every back-edge produces a cycle (rotated to canonical form so duplicate
 * cycles collapse). Output: an array of cycles, each cycle a string[] of
 * file paths in traversal order.
 *
 * Policy:
 *   {
 *     "roots": ["src"],
 *     "extensions": [".ts", ".tsx", ".vue"],
 *     "aliases": { "@/": "src/" },
 *     "ignorePatterns": ["\\.spec\\.", "__tests__/"]
 *   }
 */
import { createFinding } from "@saydeploy/architect/core/finding";
import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

export const CIRCULAR_DEPS_DEFAULTS = {
  roots: ["src"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"],
  aliases: {},
  ignorePatterns: [],
  // `import type {…}` edges are erased by the compiler, so a cycle that only
  // closes through a type-only import is not a real runtime cycle. Exclude them
  // by default; set true to count them (e.g. for `isolatedModules` strictness).
  includeTypeOnlyEdges: false,
  // A dynamic `import()` is deferred (lazy/code-split), so a cycle that only
  // closes through one is not a load-time cycle — it's the lazy-loading pattern
  // that deliberately BREAKS a static cycle (lazy route components, view-chunk
  // loaders). Exclude by default; set true to also flag deferred cycles.
  includeDynamicEdges: false,
};

function canonicalize(cycle) {
  let pivot = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if (cycle[index] < cycle[pivot]) pivot = index;
  }
  return [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
}

function findCycles(adjacency) {
  const cycles = [];
  const seenCycleKeys = new Set();
  const onStack = new Map();
  const stackOrder = [];
  const visited = new Set();

  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const work = [{ node: start, neighborIndex: 0 }];
    onStack.set(start, 0);
    stackOrder.push(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.neighborIndex >= neighbors.length) {
        visited.add(frame.node);
        onStack.delete(frame.node);
        stackOrder.pop();
        work.pop();
        continue;
      }

      const neighbor = neighbors[frame.neighborIndex];
      frame.neighborIndex += 1;

      if (onStack.has(neighbor)) {
        const startIndex = onStack.get(neighbor);
        const rawCycle = stackOrder.slice(startIndex);
        const canonical = canonicalize(rawCycle);
        const key = canonical.join("");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(canonical);
        }
        continue;
      }

      if (visited.has(neighbor)) continue;
      if (!adjacency.has(neighbor)) continue;

      onStack.set(neighbor, stackOrder.length);
      stackOrder.push(neighbor);
      work.push({ node: neighbor, neighborIndex: 0 });
    }
  }

  return cycles;
}

function renderReport({ cycles, fileCount }) {
  const lines = ["# Circular Dependencies", "", `Scanned ${fileCount} files.`, `Cycles: ${cycles.length}`, ""];
  if (cycles.length === 0) {
    lines.push("No circular dependencies.", "");
    return lines.join("\n");
  }
  for (let index = 0; index < cycles.length; index += 1) {
    const cycle = cycles[index];
    lines.push(`## Cycle ${index + 1} (${cycle.length} files)`, "");
    for (let step = 0; step < cycle.length; step += 1) {
      const next = cycle[(step + 1) % cycle.length];
      lines.push(`- \`${cycle[step]}\` → \`${next}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runCircularDepsAudit({ root, checkConfig = {} } = {}) {
  const config = { ...CIRCULAR_DEPS_DEFAULTS, ...checkConfig };
  const ignoreMatchers = (config.ignorePatterns ?? []).map((pattern) => new RegExp(pattern));

  const graph = await buildImportGraph({
    root,
    roots: config.roots,
    extensions: config.extensions,
    aliases: config.aliases,
  });

  function isIgnored(filePath) {
    return ignoreMatchers.some((matcher) => matcher.test(filePath));
  }

  const adjacency = new Map();
  for (const [filePath, node] of graph.nodes) {
    if (isIgnored(filePath)) continue;
    const neighbors = new Set();
    for (const edge of node.imports) {
      if (!edge.resolved) continue;
      if (!config.includeTypeOnlyEdges && edge.importKind === "type") continue;
      if (!config.includeDynamicEdges && edge.importKind === "dynamic") continue;
      if (isIgnored(edge.resolved)) continue;
      if (!graph.nodes.has(edge.resolved)) continue;
      if (edge.resolved === filePath) continue;
      neighbors.add(edge.resolved);
    }
    adjacency.set(filePath, [...neighbors].sort());
  }

  const cycles = findCycles(adjacency);

  const findings = cycles.map((cycle) =>
    createFinding({
      ruleId: "circular-dep",
      severity: "warn",
      filePath: cycle[0],
      line: 0,
      message: `Cycle of ${cycle.length} files: ${cycle.join(" → ")} → ${cycle[0]}`,
      metadata: { cycle },
    }),
  );

  return {
    failed: cycles.length > 0,
    findings,
    jsonPayload: { fileCount: graph.files.length, cycleCount: cycles.length, cycles },
    report: renderReport({ cycles, fileCount: graph.files.length }),
  };
}
