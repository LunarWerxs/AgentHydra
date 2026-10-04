import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildSourceAnchor,
  enrichFindingsWithSourceAnchors,
  hashSourceText,
} from "@saydeploy/architect/core/source-anchor";

test("hashSourceText returns stable short sha256 digests", () => {
  assert.equal(hashSourceText("const ok = true;", 8), hashSourceText("const ok = true;", 8));
  assert.notEqual(hashSourceText("const ok = true;", 8), hashSourceText("const ok = false;", 8));
});

test("buildSourceAnchor creates a durable line and context hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-source-anchor-"));
  try {
    await writeFile(path.join(root, "example.ts"), ["one", "two", "three", "four", "five"].join("\n"), "utf8");

    const anchor = buildSourceAnchor({ root, filePath: "example.ts", line: 3 });

    assert.equal(anchor.filePath, "example.ts");
    assert.equal(anchor.line, 3);
    assert.match(anchor.anchor, /^L3:sha256-[0-9a-f]{12}$/);
    assert.match(anchor.lineHash, /^sha256-[0-9a-f]{12}$/);
    assert.equal(anchor.contextStartLine, 1);
    assert.equal(anchor.contextEndLine, 5);
    assert.match(anchor.contextHash, /^sha256-[0-9a-f]{12}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enrichFindingsWithSourceAnchors preserves findings without readable source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkitect-source-anchor-"));
  try {
    const findings = [
      { ruleId: "demo", filePath: "missing.ts", line: 1, message: "missing" },
      { ruleId: "demo", filePath: "../outside.ts", line: 1, message: "outside" },
    ];

    assert.deepEqual(enrichFindingsWithSourceAnchors(findings, { root }), findings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
