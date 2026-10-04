/**
 * Project-shape detection: languages, frameworks, package managers, test
 * frameworks, build outputs.
 *
 * Adapted from itsmesherry/claude-audit (src/core/scanner.ts: LANGUAGE_MAP,
 * FRAMEWORK_PATTERNS, TEST_PATTERNS) and alirezarezvani/claude-skills
 * (engineering/skills/dependency-auditor).
 *
 * Why it lives in core: a codebase-agnostic check needs to know "this is a
 * Vue project" vs "this is a Django project" so it can either skip itself,
 * pick the right rule set, or scope its file walk. The arkitect previously
 * baked Vue into 30+ checks; with this module a check can declare
 * `frameworks: ["vue"]` and the runner will skip it on a non-Vue project.
 *
 * Detection is filesystem-only — read package.json / pyproject.toml / etc.
 * and a sample of file extensions. No network.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./files.mjs";

/** ext → canonical language id. Order doesn't matter; both ext and lang are flat. */
export const LANGUAGE_MAP = Object.freeze({
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".m": "objective-c",
  ".mm": "objective-c",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".vb": "vbnet",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".php": "php",
  ".scala": "scala",
  ".clj": "clojure",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".lua": "lua",
  ".dart": "dart",
  ".elm": "elm",
  ".hs": "haskell",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
});

/** Detector: presence of `dependency` in `package.json` → framework. */
export const NPM_FRAMEWORK_PATTERNS = Object.freeze({
  vue: ["vue", "nuxt", "@vue/cli"],
  react: ["react", "react-dom", "next", "remix", "@remix-run/react"],
  angular: ["@angular/core"],
  svelte: ["svelte", "@sveltejs/kit"],
  solid: ["solid-js"],
  astro: ["astro"],
  express: ["express"],
  fastify: ["fastify"],
  koa: ["koa"],
  nest: ["@nestjs/core"],
  hapi: ["@hapi/hapi"],
  tailwind: ["tailwindcss"],
  bootstrap: ["bootstrap"],
  mui: ["@mui/material"],
  vite: ["vite"],
  webpack: ["webpack"],
  rollup: ["rollup"],
  esbuild: ["esbuild"],
  jest: ["jest"],
  vitest: ["vitest"],
  mocha: ["mocha"],
  cypress: ["cypress"],
  playwright: ["@playwright/test", "playwright"],
});

/** Detector: presence of a manifest file in the repo root → ecosystem. */
export const ECOSYSTEM_MANIFESTS = Object.freeze([
  { manifest: "package.json", ecosystem: "npm" },
  { manifest: "pyproject.toml", ecosystem: "python" },
  { manifest: "requirements.txt", ecosystem: "python" },
  { manifest: "Pipfile", ecosystem: "python" },
  { manifest: "Cargo.toml", ecosystem: "rust" },
  { manifest: "go.mod", ecosystem: "go" },
  { manifest: "Gemfile", ecosystem: "ruby" },
  { manifest: "composer.json", ecosystem: "php" },
  { manifest: "pom.xml", ecosystem: "maven" },
  { manifest: "build.gradle", ecosystem: "gradle" },
  { manifest: "build.gradle.kts", ecosystem: "gradle" },
  { manifest: ".csproj", ecosystem: "nuget", glob: true },
  { manifest: "mix.exs", ecosystem: "hex" },
  { manifest: "Package.swift", ecosystem: "swift-pm" },
  { manifest: "pubspec.yaml", ecosystem: "pub" },
]);

/**
 * Walk a sample of files under `root` (capped at `sampleLimit`) and count
 * extensions. Returns the canonical languages observed, sorted by frequency.
 */
export async function detectLanguages(root, { sampleLimit = 500, roots = ["."] } = {}) {
  const counts = new Map();
  const extensions = Object.keys(LANGUAGE_MAP);
  const files = await walkFiles({ root, roots, extensions });
  const sample = files.slice(0, sampleLimit);

  for (const filePath of sample) {
    const ext = path.extname(filePath).toLowerCase();
    const lang = LANGUAGE_MAP[ext];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    primary: entries[0]?.[0] ?? null,
    languages: entries.map(([name, count]) => ({ name, count })),
    sampleSize: sample.length,
  };
}

/** Read package.json (if present) and return framework ids whose deps appear. */
export async function detectNpmFrameworks(root) {
  const pkgPath = path.join(root, "package.json");
  const raw = await fs.readFile(pkgPath, "utf8").catch(() => null);
  if (!raw) return [];
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const out = [];
  for (const [framework, deps] of Object.entries(NPM_FRAMEWORK_PATTERNS)) {
    if (deps.some((dep) => dep in allDeps)) out.push(framework);
  }
  return out;
}

/** Walk root for manifests; return ecosystems present. */
export async function detectEcosystems(root) {
  const out = new Set();
  for (const { manifest, ecosystem, glob } of ECOSYSTEM_MANIFESTS) {
    if (glob) {
      // Cheap shallow glob — only repo-root level. csproj files etc.
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith(manifest))) {
        out.add(ecosystem);
      }
      continue;
    }
    const exists = await fs.stat(path.join(root, manifest)).catch(() => null);
    if (exists?.isFile()) out.add(ecosystem);
  }
  return [...out];
}

/** Top-level: produce a `project` block suitable for the envelope. */
export async function detectProject(root, { sampleLimit = 500, roots = ["."] } = {}) {
  const [langs, npmFrameworks, ecosystems] = await Promise.all([
    detectLanguages(root, { sampleLimit, roots }),
    detectNpmFrameworks(root),
    detectEcosystems(root),
  ]);
  return {
    root,
    languages: langs.languages.map((entry) => entry.name),
    primary_language: langs.primary,
    frameworks: npmFrameworks,
    ecosystems,
  };
}

/**
 * Decide whether a check should run on this project given its declared
 * `requires.languages` / `requires.frameworks` / `requires.ecosystems` /
 * `requires.projectNames`. If the check declares none, it always runs.
 * If it declares any dimension, that dimension must match.
 */
export function checkAppliesToProject(check, project) {
  const requires = check?.requires;
  if (!requires) return true;
  if (Array.isArray(requires.projectNames) && requires.projectNames.length > 0) {
    if (!requires.projectNames.includes(project?.name)) return false;
  }
  if (Array.isArray(requires.languages) && requires.languages.length > 0) {
    const langs = new Set(project?.languages ?? []);
    if (!requires.languages.some((lang) => langs.has(lang))) return false;
  }
  if (Array.isArray(requires.frameworks) && requires.frameworks.length > 0) {
    const fws = new Set(project?.frameworks ?? []);
    if (!requires.frameworks.some((fw) => fws.has(fw))) return false;
  }
  if (Array.isArray(requires.ecosystems) && requires.ecosystems.length > 0) {
    const ecos = new Set(project?.ecosystems ?? []);
    if (!requires.ecosystems.some((eco) => ecos.has(eco))) return false;
  }
  return true;
}
