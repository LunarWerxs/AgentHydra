import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runFloatingFieldNotchAudit } from "@saydeploy/architect/engines/design-system/floating-field-notch-engine";

const CSS_FILE = "packages/connections-ui/src/styles/primitives/app-text-field.css";

async function withFixture(source, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floating-field-notch-"));
  try {
    const fullPath = path.join(root, CSS_FILE);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, source, "utf8");
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const GOOD = `
.gc-app-card .gc-floating-field--variant-public.gc-floating-field--label-floating.is-filled .gc-floating-field__label {
  --gc-floating-field-notch-surface: var(--gc-app-card-filled-container, var(--gc-floating-field-surface));
  background:
    var(--public-input-floating-label-bg),
    linear-gradient(to bottom, transparent 0, var(--gc-floating-field-notch-surface) 100%);
}
`;

test("floating-field notch passes when the mask uses the opaque card surface", async () => {
  await withFixture(GOOD, (root) => {
    const result = runFloatingFieldNotchAudit({ root });
    assert.equal(result.findings.length, 0);
  });
});

test("floating-field notch fails when the mask reverts to the translucent input surface", async () => {
  const bad = GOOD.replace(
    "--gc-floating-field-notch-surface: var(--gc-app-card-filled-container, var(--gc-floating-field-surface));",
    "--gc-floating-field-notch-surface: var(--gc-floating-field-surface);",
  );
  await withFixture(bad, (root) => {
    const result = runFloatingFieldNotchAudit({ root });
    assert(result.findings.length >= 1);
    assert(result.findings.some((finding) => finding.ruleId === "floating-field-notch-opaque-mask"));
  });
});

test("floating-field notch fails when the notch surface is removed entirely", async () => {
  const bad = `
.gc-app-card .gc-floating-field--variant-public.gc-floating-field--label-floating.is-filled .gc-floating-field__label {
  background: var(--public-input-floating-label-bg);
}
`;
  await withFixture(bad, (root) => {
    const result = runFloatingFieldNotchAudit({ root });
    assert(result.findings.some((finding) => finding.ruleId === "floating-field-notch-opaque-mask"));
  });
});
