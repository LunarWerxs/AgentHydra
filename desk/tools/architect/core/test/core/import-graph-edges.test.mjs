import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildImportGraph } from "@saydeploy/architect/core/import-graph";

async function scratch() {
  return mkdtemp(path.join(tmpdir(), "arkitect-edges-"));
}

function edgeTo(node, resolvedRel) {
  return node.imports.find((e) => e.resolved === resolvedRel);
}

test("import type / export type edges are tagged importKind=type; value imports stay value", async () => {
  const root = await scratch();
  try {
    await writeFile(path.join(root, "b.ts"), "export type T = number; export const v = 1;");
    await writeFile(path.join(root, "c.ts"), "export const y = 2;");
    await writeFile(path.join(root, "d.ts"), "export const z = 3;");
    await writeFile(
      path.join(root, "a.ts"),
      [
        'import type { T } from "./b";', // type-only
        'import { y } from "./c";', // value
        'import { type Z, w } from "./d";', // inline-mixed → value (w is real)
        "export type U = T; export const used = y + w;",
      ].join("\n"),
    );
    const graph = await buildImportGraph({ root, roots: ["."], tsconfigPath: null });
    const a = graph.nodes.get("a.ts");
    assert.equal(edgeTo(a, "b.ts").importKind, "type");
    assert.equal(edgeTo(a, "c.ts").importKind, "value");
    // Inline `{ type Z, w }` carries a real value (w) → the edge is a value edge.
    assert.equal(edgeTo(a, "d.ts").importKind, "value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic import() and function-scoped require() are deferred; only a top-level require() is a load-time edge", async () => {
  const root = await scratch();
  try {
    await writeFile(path.join(root, "e.ts"), "export const e = 1;");
    await writeFile(path.join(root, "f.ts"), "export const f = 2;");
    await writeFile(path.join(root, "g.ts"), "export const g = 3;");
    await writeFile(
      path.join(root, "a.ts"),
      [
        'const g = require("./g");', // top-level CJS → load-time
        'export async function loadE() { return import("./e"); }', // deferred → dynamic
        'export function loadF() { return require("./f"); }', // function-scoped require → deferred (cycle-breaker)
        "export const all = g;",
      ].join("\n"),
    );
    const graph = await buildImportGraph({ root, roots: ["."], tsconfigPath: null });
    const a = graph.nodes.get("a.ts");
    // A cycle that only closes through a dynamic import is NOT a load-time
    // cycle — circular-deps excludes "dynamic" edges by default (like "type").
    assert.equal(edgeTo(a, "e.ts").importKind, "dynamic");
    // A require() inside a function body is deferred — the deliberate lazy-require
    // cycle-breaker — so it is "dynamic" too, not a load-time edge.
    assert.equal(edgeTo(a, "f.ts").importKind, "dynamic");
    // Only a top-level require() runs at module-eval → a real load-time edge.
    assert.equal(edgeTo(a, "g.ts").importKind, "value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
