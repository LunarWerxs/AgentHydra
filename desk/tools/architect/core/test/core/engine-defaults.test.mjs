import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runTransitionFadeSnapAudit } from "@saydeploy/architect/engines/design-system/transition-fade-snap-engine";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const engineDir = path.resolve(__dirname, "../../src/engines");

async function listEngineFiles() {
  const entries = await readdir(engineDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(engineDir, entry.name));
}

test("engine option overrides do not become sticky defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkitect-engine-defaults-"));
  await mkdir(path.join(root, "src", "styles", "core"), { recursive: true });
  await mkdir(path.join(root, "other"), { recursive: true });

  await writeFile(
    path.join(root, "src", "styles", "core", "transitions.css"),
    [".fade-leave-to { opacity: 1; }", ".fade-enter-from { opacity: 1; }"].join("\n"),
  );
  const vueSource = [
    "<template>",
    '  <Transition name="fade">',
    '    <div v-if="show">Snap risk</div>',
    "  </Transition>",
    "</template>",
  ].join("\n");
  await writeFile(path.join(root, "src", "Bad.vue"), vueSource);
  await writeFile(path.join(root, "other", "Bad.vue"), vueSource);

  try {
    const scoped = await runTransitionFadeSnapAudit({ root, roots: ["other"] });
    assert.deepEqual(
      scoped.findings.map((finding) => finding.file),
      ["other/Bad.vue"],
      "the explicit roots option should scope this run",
    );

    const defaulted = await runTransitionFadeSnapAudit({ root });
    assert.deepEqual(
      defaulted.findings.map((finding) => finding.file),
      ["src/Bad.vue"],
      "a later run without roots should reset to the engine default roots",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engine files avoid self-referential mutable default fallbacks", async () => {
  const stickyPatterns = [
    /SCAN_ROOTS\s*=\s*options\.roots\?\.length\s*\?\s*options\.roots\s*:\s*SCAN_ROOTS/,
    /FIXED_ICON_TARGETS\s*=\s*options\.targets\?\.length\s*\?\s*options\.targets\s*:\s*FIXED_ICON_TARGETS/,
    /\b(SCAN_ROOTS|SCAN_EXTENSIONS|SKIP_SEGMENTS|SOURCE_EXTENSIONS|TOKEN_FILE|TRANSITION_CSS|CODEPOINTS_URL|DEFAULT_URL|DEFAULT_MAX_PER_RULE|INLINE_FONT_SIZE_FILE_ALLOWLIST|FIXED_ICON_TARGETS)\s*=\s*[^;\n]*options\.[A-Za-z0-9_]+[^;\n]*\?\?\s*(?:\[\.\.\.)?\1\b/,
  ];

  const failures = [];
  for (const filePath of await listEngineFiles()) {
    const relativePath = path.relative(path.resolve(__dirname, "../../.."), filePath).replaceAll(path.sep, "/");
    const source = await readFile(filePath, "utf8");
    for (const pattern of stickyPatterns) {
      if (pattern.test(source)) {
        failures.push(`${relativePath} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
