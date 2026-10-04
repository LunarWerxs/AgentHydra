import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runWorkspaceSurfaceVisibilityAudit } from "@saydeploy/architect/engines/design-system/workspace-surface-visibility-engine";

async function withFixture(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-surface-visibility-"));
  try {
    for (const [relPath, source] of Object.entries(files)) {
      const fullPath = path.join(root, relPath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, source, "utf8");
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const GOOD_TOKENS = `
:root {
  --gc-desktop-search-surface-outline: color-mix(in srgb, var(--md-sys-color-outline-variant) 52%, transparent);
}
:root[data-resolved-theme="dark"] {
  --gc-desktop-search-surface-outline: var(--gc-dark-sidebar-stroke);
}
`;

const GOOD_DESKTOP_SEARCH = `
.desktop-search-surface__chrome {
  background: var(--gc-desktop-search-surface-bg);
}
.desktop-search-surface:hover .desktop-search-surface__chrome {
  background: var(--gc-desktop-search-surface-hover-bg);
}
.desktop-search-surface:focus-within .desktop-search-surface__chrome,
.desktop-search-surface__chrome--open {
  background: var(--gc-desktop-search-surface-focus-bg);
}
`;

test("workspace surface visibility passes with visible desktop search chrome", async () => {
  await withFixture(
    {
      "src/styles/core/tokens.css": GOOD_TOKENS,
      "packages/connections-ui/src/styles/primitives/desktop-search.css": GOOD_DESKTOP_SEARCH,
    },
    (root) => {
      const result = runWorkspaceSurfaceVisibilityAudit({ root });
      assert.equal(result.findings.length, 0);
    },
  );
});

test("workspace surface visibility catches transparent search outline and chrome backgrounds", async () => {
  await withFixture(
    {
      "src/styles/core/tokens.css": `
:root {
  --gc-desktop-search-surface-outline: transparent;
}
`,
      "packages/connections-ui/src/styles/primitives/desktop-search.css": GOOD_DESKTOP_SEARCH.replaceAll(
        /background: var\(--gc-desktop-search-surface-[^)]+\);/g,
        "background: transparent;",
      ),
    },
    (root) => {
      const result = runWorkspaceSurfaceVisibilityAudit({ root });
      assert.equal(result.findings.length, 5);
      assert(result.findings.some((finding) => finding.ruleId === "desktop-search-idle-outline-visible"));
      assert(result.findings.some((finding) => finding.ruleId === "desktop-search-chrome-background-token"));
    },
  );
});
