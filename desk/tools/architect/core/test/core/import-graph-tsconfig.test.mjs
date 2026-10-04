import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSpecifierResolver, loadTsconfigAliases } from "@saydeploy/architect/core/import-graph";

async function scratch() {
  return mkdtemp(path.join(tmpdir(), "arkitect-tsconfig-"));
}

test("loadTsconfigAliases converts glob paths to slash-terminated prefixes", async () => {
  const root = await scratch();
  try {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
            "@ui/*": ["./packages/ui/src/*"],
            "bun:test": ["./src/types/bun-test"],
          },
        },
      }),
    );
    const aliases = await loadTsconfigAliases(root);
    // Glob prefixes keep their trailing slash; `path.resolve` strips it, so the
    // loader must re-add it or `@/foo` would resolve to `srcfoo`.
    assert.equal(aliases["@/"], "src/");
    assert.equal(aliases["@ui/"], "packages/ui/src/");
    // Exact (non-glob) mapping: no trailing slash on prefix or target.
    assert.equal(aliases["bun:test"], "src/types/bun-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aliases resolve real files end-to-end", async () => {
  const root = await scratch();
  try {
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(path.join(root, "src", "lib", "x.ts"), "export const x = 1;");
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    const resolve = createSpecifierResolver({ root, aliases: await loadTsconfigAliases(root) });
    const resolved = await resolve("@/lib/x", path.join(root, "src", "main.ts"));
    assert.equal(resolved, path.join(root, "src", "lib", "x.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("longest matching alias prefix wins over a shorter overlapping one", async () => {
  const root = await scratch();
  try {
    await mkdir(path.join(root, "generic"), { recursive: true });
    await mkdir(path.join(root, "specific"), { recursive: true });
    await writeFile(path.join(root, "specific", "hit.ts"), "export const hit = 1;");
    const resolve = createSpecifierResolver({
      root,
      // Insertion order deliberately puts the shorter prefix first.
      aliases: { "@a/": "generic/", "@a/b/": "specific/" },
    });
    const resolved = await resolve("@a/b/hit", path.join(root, "x.ts"));
    assert.equal(resolved, path.join(root, "specific", "hit.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerates JSONC comments and trailing commas", async () => {
  const root = await scratch();
  try {
    await writeFile(
      path.join(root, "tsconfig.json"),
      `{
        // line comment
        "compilerOptions": {
          /* block comment */
          "paths": {
            "@/*": ["./src/*"],
          },
        },
      }`,
    );
    const aliases = await loadTsconfigAliases(root);
    assert.equal(aliases["@/"], "src/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges a relative extends chain, child overrides parent", async () => {
  const root = await scratch();
  try {
    await writeFile(
      path.join(root, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./base/*"], "@shared/*": ["./shared/*"] } } }),
    );
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
    );
    const aliases = await loadTsconfigAliases(root);
    assert.equal(aliases["@/"], "src/"); // child wins
    assert.equal(aliases["@shared/"], "shared/"); // inherited
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing tsconfig is a no-op (JS-only project), malformed throws", async () => {
  const root = await scratch();
  try {
    assert.deepEqual(await loadTsconfigAliases(root, "does-not-exist.json"), {});
    await writeFile(path.join(root, "broken.json"), "{ this is not json");
    await assert.rejects(() => loadTsconfigAliases(root, "broken.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
