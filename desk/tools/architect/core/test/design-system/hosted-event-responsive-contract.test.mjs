import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS,
  runHostedEventResponsiveContractAudit,
} from "@saydeploy/architect/engines/design-system/hosted-event-responsive-contract-engine";

async function writeFixtureFile(root, relPath, source) {
  const fullPath = path.join(root, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source, "utf8");
}

async function withFixture(overrides, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosted-event-responsive-contract-"));
  try {
    for (const entry of HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.bodyFiles) {
      await writeFixtureFile(root, entry.path, `<template><div class="${entry.requiredMarkers.join(" ")}"></div></template>`);
    }
    for (const entry of HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.routeCssFiles) {
      await writeFixtureFile(root, entry.path, entry.requiredMarkers.join("\n"));
    }
    await writeFixtureFile(
      root,
      HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.topbarFile,
      "@media (min-width: 64rem) {}\n@media (max-width: 63.9375rem) {}",
    );

    for (const [relPath, source] of Object.entries(overrides ?? {})) {
      await writeFixtureFile(root, relPath, source);
    }

    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("hosted-event responsive contract passes for the two-composition layout", async () => {
  await withFixture({}, (root) => {
    const result = runHostedEventResponsiveContractAudit({ root });
    assert.equal(result.findings.length, 0);
  });
});

test("hosted-event responsive contract fails when topbar reuses the body breakpoint", async () => {
  await withFixture(
    {
      [HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.topbarFile]:
        "@media (min-width: 56rem) {}\n@media (max-width: 55.9375rem) {}",
    },
    (root) => {
      const result = runHostedEventResponsiveContractAudit({ root });
      assert(result.findings.some((finding) => finding.ruleId === "hosted-event-topbar-compact-breakpoint"));
    },
  );
});

test("hosted-event responsive contract fails when body files reintroduce lg tablet variants", async () => {
  const pageEntry = HOSTED_EVENT_RESPONSIVE_CONTRACT_DEFAULTS.bodyFiles[0];
  await withFixture(
    {
      [pageEntry.path]: `<template><div class="${pageEntry.requiredMarkers.join(" ")} lg:grid"></div></template>`,
    },
    (root) => {
      const result = runHostedEventResponsiveContractAudit({ root });
      assert(result.findings.some((finding) => finding.ruleId === "hosted-event-legacy-tablet-breakpoint"));
    },
  );
});
