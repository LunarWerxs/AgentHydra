# Connections Arkitect

Audit and contract-check tooling for the Connections codebase.

> **📖 Full instruction manual:** [`docs/INSTRUCTION_MANUAL.md`](./docs/INSTRUCTION_MANUAL.md) — all check IDs, groups, CLI flags, architecture, and AI agent quick reference.

## Quick Start

```bash
# Run all checks
bun packages/connections-arkitect/bin/audit.mjs --all

# List all checks
bun packages/connections-arkitect/bin/audit.mjs list

# Run a single check
bun packages/connections-arkitect/bin/audit.mjs --check <check-id>

# Run with npm scripts
bun run audit:all
bun run audit:strict
```

## Architecture

- **`bin/`** — CLI entry points (`audit.mjs`, `audit-test.mjs`, `arkitect-canary.mjs`, `audit-screenshot.mjs`)
- **`src/cli/`** — Args parser, check registry, audit runner
- **`src/core/`** — Primitives: finding, scoring, envelope, SARIF, config
- **`src/checks/`** — Organized by domain (architecture, contracts, css, design-system, i18n, mobile, performance, code-quality, surface, meta, agnostic)
- **`src/engines/`** — Reusable engine logic, mirrors checks/ structure
- **`arkitect-core/`** — Codebase-agnostic layer (ui-antipatterns, design vocabulary, engineering rules, auditor skills)
- **`policies/connections/`** — Connections-specific policy JSON, allowlists, baselines

### Import Convention

All internal imports use stable package self-references:

```js
import { createFinding } from "@connections/arkitect/core/finding";
import { walkFiles } from "@connections/arkitect/core/files";
```

The `package.json` exports map is the single source of truth. No brittle `../../` relative paths.

## Codebase-agnostic checks

The `intelligence` and `codeRisk` groups are codebase-agnostic: every path,
threshold, and rule comes from JSON policy (or per-check config), with no
hard-coded Connections-specific assumptions in the engine. They're inspired by
the fallow / knip / dependency-cruiser / madge / jscpd / unimported / oxlint /
CodeScene family of tools.

`intelligence` (graph-based):

- `dep-rules` — dependency-cruiser-style forbidden/allowed edges. Policy uses
  `from.path` / `from.pathNot` / `to.path` / `to.pathNot` regex pairs plus
  `dependencyTypes: ["local" | "external"]`.
- `circular-deps` — madge-style import-cycle detection (iterative DFS,
  canonical-rotation deduping).
- `clone-blocks` — jscpd-style Rabin-Karp duplicate-block detection across
  TS/JS/Vue/CSS with `minTokens` + `minLines` thresholds.
- `unused-exports` — knip / ts-prune-style. Marks every export not imported
  elsewhere, with `entryPatterns` (regex of always-used files) and
  `ignoreNames`.
- `orphan-files` — unimported-style. BFS reachability from `entryPatterns`;
  flags files no entry can reach.

`codeRisk` (per-function metrics — direct ports of canonical upstream tools):

| Check                   | Ported from                                                                         | What it measures                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `crap-score`            | [cargo-crap](https://github.com/minikin/cargo-crap) / CRAP4J                        | `CC² · (1 − cov/100)³ + CC` per function. Reads any LCOV file (cargo llvm-cov, c8, nyc, istanbul, vitest). |
| `cyclomatic-complexity` | [lizard](https://github.com/terryyin/lizard)                                        | McCabe CC per function via heuristic token counting (no AST).                                              |
| `cognitive-complexity`  | [SonarSource white paper](https://www.sonarsource.com/docs/CognitiveComplexity.pdf) | Nesting-aware complexity (B1/B2/B3 rules).                                                                 |
| `maintainability-index` | [radon](https://github.com/rubik/radon)                                             | SEI MI: `100 · (171 − 5.2 ln V − 0.23 G − 16.2 ln L + 50 sin(√2.4 C)) / 171`.                              |
| `churn-hotspots`        | [code-maat](https://github.com/adamtornhill/code-maat) / CodeScene                  | `revisions × complexity` from `git log` — files complex AND frequently changed.                            |
| `code-duplication`      | [jscpd](https://github.com/kucherenko/jscpd)                                        | Token-based clone detection via Rabin-Karp rolling hash.                                                   |

Shared `codeRisk` engines in `src/engines/`:

- `code-metrics-engine.mjs` — `extractFunctions()`, `cyclomaticComplexity()`,
  `cognitiveComplexity()`, `halstead()`, `fileMaintainabilityIndex()`. Brace
  languages plus a Python indent fallback.
- `lcov-engine.mjs` — `parseLcov()`, `findLcovFile()`, `functionCoverage()`.
- `crap-engine.mjs` — `crapScore()`, `scoreFunctions()`, `regressions()`.
- `git-churn-engine.mjs` — `gitChurn()` (shells out to `git log`),
  `computeHotspots()`.
- `clone-detection-engine.mjs` — `detectClones()` (true Rabin-Karp rolling hash
  over a generic token stream).

All checks support `// arkitect-ignore-next-line <rule-id>` and
`// arkitect-ignore-file <rule-id>` inline directives (fallow-style).

`qualityAgnostic` (backed by `arkitect-core/`):

- `ui-antipatterns` — regex source scan against
  [impeccable](https://github.com/pbakaus/impeccable)'s 29-rule UI anti-pattern
  catalog (Apache-2.0). Catches AI-generated UI tells (side-tab borders,
  overused fonts, gradient text, AI palettes, nested cards, bounce easing,
  dark-glow accents, icon-tile stacks, …) plus WCAG-class quality issues
  (low contrast, line length, cramped padding, tight leading, skipped headings,
  tiny body text, all-caps body, wide tracking, …). Set
  `failOnCategories: ["slop"]` in policy config to wire it into CI; defaults to
  warn-only.
- `rules-docs` — indexes the cross-cutting engineering rule decks bundled in
  `arkitect-core/rules-docs/` (15 codebase-agnostic decks: accessibility,
  api-design, code-review, coding-style, database, dependency-management,
  documentation, error-handling, git-workflow, monitoring, naming, performance,
  security, testing, agents).

Both checks are opt-out (`includeInAll: false`) — drop arkitect into a new
repo and they sit dormant until invoked via `--check ui-antipatterns` /
`--check rules-docs`.

## `arkitect-core/` — codebase-agnostic harvest layer

`arkitect-core/` is the framework-side of the package: zero Connections
references, drop into any repo and the rules / references / auditors still
make sense. See `arkitect-core/README.md` and `arkitect-core/NOTICES.md` for
the full source-of-truth attribution.

- `arkitect-core/rules/ui-antipatterns/` — impeccable rule registry + regex
  detector + color / font / WCAG utilities. Public entry is `index.mjs`.
- `arkitect-core/references/` — 16 design-vocabulary reference files
  (typography, color-and-contrast, layout, motion-design, interaction-design,
  responsive-design, spatial-design, cognitive-load, heuristics-scoring, audit,
  polish, critique, harden, brand, product, ux-writing).
- `arkitect-core/rules-docs/` — 15 cross-cutting engineering rule decks
  harvested from
  [awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit).
- `arkitect-core/auditors/` — 20 codebase-agnostic auditor SKILL.md cards
  harvested from
  [levnikolaevich/claude-code-skills](https://github.com/levnikolaevich/claude-code-skills)
  (security-boundary, build-delivery-gate, duplication-overabstraction,
  maintainability-hotspot, dependency-reuse, dead-code-pruning, diagnosability,
  concurrency-correctness, runtime-lifecycle, layer-ownership, api-contract,
  dependency-topology, project-structure, configuration-boundary,
  persistence-performance, query-efficiency, transaction-correctness,
  runtime-performance, resource-lifecycle, codebase-auditor coordinator).

## Codebase-agnostic policy resolution

Config discovery is no longer hardcoded to Connections. The loader tries (in
order):

1. `--config <path>` argument.
2. `--policy-dir <dir>` argument.
3. `ARKITECT_POLICY_DIR` env var.
4. `<repo>/.arkitect/<policy>/<policy>.audit.config.json`
5. `<repo>/.arkitect/arkitect.audit.config.json`
6. `<repo>/arkitect.config.json`
7. Legacy Connections fallback:
   `packages/connections-arkitect/policies/<policy>/<policy>.audit.config.json`

The Connections-specific UI-package-root injection that used to live in
`src/core/config.mjs` is now an `augments` entry in
`policies/connections/connections.audit.config.json` pointing at
`policies/connections/augment.mjs`. Any policy can ship its own augment(s) the
same way — each augment is an ESM module whose default export is
`(config, { configDir, root, configPath }) => config`.

Similarly, the previous hardcoded list of "actionable" report keys was a
Connections-shaped allowlist (`fileBugs`, `splitFailures`,
`vendorPrefixFamilies`, `msIconSizeTokenViolations`, …). The runner now
declares a small universal set (`findings`, `regressions`, `issues`,
`actionable`, `errors`, `warnings`, `totalFindings`, …) and lets policies
extend it via top-level `actionableArrayKeys` / `actionableCountKeys` arrays —
see `connections.audit.config.json` for the Connections additions.

Shared building blocks for these checks:

- `src/core/import-graph.mjs` — regex-based import/export scanner +
  alias-aware specifier resolver. Used by every `intelligence` check.
- `src/core/suppressions.mjs` — inline ignore-directive parser.

To use any of these on a different repo, point `--config` at a JSON file with
the desired `roots`, `extensions`, `aliases`, and check-specific options. The
full walkthrough — including the minimal `.arkitect/` "hello world" pack and
a catalog of which checks are generic / which need a framework / which are
Connections-specific — is in
[docs/codebase-agnostic-guide.md](docs/codebase-agnostic-guide.md).

## Core primitives for check authors

The following runtime modules are codebase-agnostic and are re-exported from
the package. New checks should reach for these instead of rolling their own
math / IO / output shape.

| Module                   | Adapted from                                                                          | What it gives you                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `./core/scoring`         | levnikolaevich/claude-code-skills, itsmesherry/claude-audit                           | 0–10 / 0–100 / A–F severity-weighted scoring + blast-radius modifier                            |
| `./core/envelope`        | levnikolaevich/claude-code-skills `audit_summary_contract.md`                         | Versioned JSON envelope wrapping findings + scoring + project                                   |
| `./core/sarif`           | gadievron/raptor `core/sarif/`                                                        | SARIF 2.1.0 writer for GitHub Code Scanning / VS Code                                           |
| `./core/source-anchor`   | omp/oh-my-pi hash-anchored edit harness pattern                                       | Adds stable `sourceAnchor` content hashes to findings so file:line reports survive nearby edits |
| `./core/confidence`      | anthropics/claude-code `pr-review-toolkit`, gadievron/raptor `hypothesis_validation/` | 0–100 confidence rubric (cutoff 80) + three-valued verdict lattice + Beta-Bernoulli aggregation |
| `./core/findings-filter` | anthropics/claude-code-security-review `findings_filter.py`                           | Two-stage suppression (regex hard rules → semantic predicate)                                   |
| `./core/project-detect`  | itsmesherry/claude-audit `scanner.ts`                                                 | Language / framework / ecosystem detection + per-check `requires` gating                        |
| `./core/checklist`       | avalonreset/claude-github `audit_repo.py`                                             | Weighted-checklist scoring primitive + category aggregation                                     |

Full per-module contracts live in
[`arkitect-core/references/`](arkitect-core/references/) — see
`severity-scoring.md`, `output-envelope.md`, `sarif.md`, and
`verdict-and-confidence.md`. Upstream license attribution is in
[`arkitect-core/NOTICES.md`](arkitect-core/NOTICES.md). Core regression tests
live under `test/core/`; the root Arkitect fixture gate remains the current
operating interface.

Root commands remain the operating interface:

```sh
bun run audit:test
bun run audit:arkitect:report
bun run audit:arkitect:canary
bun run audit:arkitect
```

`bun run audit:all` runs the default static/local Arkitect suite. `oversized-files` is intentionally
opt-in. `mobile-audit` participates in the default suite as a no-browser static mobile contract; when
a human asks an agent to explicitly "run the mobile audit", use `bun run audit:mobile` so the full
browser/device pass runs.
