# Arkitect — Instruction Manual

The **Connections Arkitect** is a codebase audit and contract-check framework in `packages/connections-arkitect/`. It runs static checks, enforces architectural contracts, and surfaces regressions — all through a single CLI.

---

## Quick Start — How to Run

### The one command you need to know

```bash
bun packages/connections-arkitect/bin/audit.mjs --all
```

This runs every non-opt-in check. Use it after making changes to see what's broken.

### Running a single check

```bash
bun packages/connections-arkitect/bin/audit.mjs --check <check-id>
```

Example:

```bash
bun packages/connections-arkitect/bin/audit.mjs --check feature-boundaries
```

### Listing all available checks

```bash
bun packages/connections-arkitect/bin/audit.mjs list
```

### Strict mode (fail CI on drift)

```bash
bun packages/connections-arkitect/bin/audit.mjs --all --fail-on-drift --quiet
```

`--all` runs every static check, including the former opt-in groups
(`codeRisk`, `qualityAgnostic`, `dead-code`, `circular-deps`, `dep-rules`,
`no-deep-relative-imports`, `stale-todos`, …). The only thing excluded is
dynamic checks that need a dev server, browser, or live data cache.

### Reading the next-action manifest

Every `--all` run writes `tmp/audits/manifest.json`. The `pass.nextAction`
field tells AI agents (or humans) exactly what to do next:

| Value            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `"fix-errors"`   | Address listed error-severity findings, then re-run.          |
| `"fix-warnings"` | Address listed warning-severity findings, then re-run.        |
| `"run-all"`      | A single check ran; run `bun run audit:strict` for the sweep. |
| `"run-dynamic"`  | Static is clean. Run `bun run audit:dynamic` + `audit:tests`. |
| `"done"`         | Every check ran and the codebase is clean. Stop here.         |

### Running a check group via npm scripts

The root `package.json` has convenience scripts:

```bash
bun run audit:all              # full suite
bun run audit:strict           # full suite, fails on drift (CI)
bun run audit:mobile           # full mobile browser audit
bun run audit:mobile:static    # source-only mobile audit
bun run audit:css-dedupe       # CSS deduplication
bun run audit:css-dedupe:strict
bun run audit:public-css-cascade
bun run audit:workspace-interactions:full-matrix  # pairwise workspace tab-switch perf sweep
```

For focused workspace tab-switch iteration, filter scenarios before running the
full matrix:

```bash
WORKSPACE_INTERACTION_SCENARIOS='to-contacts,contacts-to' bun packages/connections-arkitect/runners/workspace-interaction-perf.mjs --full-matrix
```

The workspace interaction runner writes `todo/browser-perf-audit/workspace-interactions.json`; run
`bun packages/connections-arkitect/bin/audit.mjs --check workspace-interaction-perf`
after capture to score the result.

### Running the test suite

```bash
bun packages/connections-arkitect/bin/audit-test.mjs
```

### Running the canary (critical regression tests)

```bash
bun packages/connections-arkitect/bin/arkitect-canary.mjs
```

### Running screenshot visual regression

```bash
bun packages/connections-arkitect/bin/audit-screenshot.mjs <scenario-name>
bun packages/connections-arkitect/bin/audit-screenshot.mjs --list
```

### Running the SPL26 visual integrity check

Loads the live Shared Primitives Live page in a headless browser and inspects
every primitive's _rendered_ output (render errors, name leaks, collapsed
boxes, placeholder leaks) — the runtime complement to the static
`spl-playground-integrity` check. Requires the dev server running:

```bash
bun run dev                # in another terminal
bun run audit:spl-visual   # capture (browser scan) + check
```

`audit:spl-visual:capture` writes `todo/spl-visual-audit/scan.json`; the
`spl-visual-integrity` check scores it. Browser-based and `includeInAll:false`,
so it never runs in the CI `--all` sweep. If no browser or dev server is
available the scan writes a `skipped` artifact and the check reports an info
finding instead of failing. Override the target with `SPL_VISUAL_BASE_URL` /
`SPL_VISUAL_PATH`, or the browser with `SPL_VISUAL_CHROME`.

---

## Check Groups

Checks are organized into groups. Each group maps to a domain concern:

| Group              | What it covers                                                                       | Included in `--all`? |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------- |
| `surface`          | File size, test coverage, form coverage                                              | Yes                  |
| `designSystem`     | Design tokens, M3 guidelines, motion, icons, typography, z-index, mobile             | Yes                  |
| `architecture`     | Feature boundaries, layering, CSS architecture, imports, guards                      | Yes                  |
| `localization`     | i18n hardcoded strings, missing keys                                                 | Yes                  |
| `productContracts` | Analytics, fields, endpoints, workflows, persistence, auth, CORS                     | Yes                  |
| `intelligence`     | Dep rules, circular deps, clone blocks, unused exports, orphan files                 | Yes                  |
| `meta`             | Arkitect matrix, live smoke, report, bundle budget, feature matrix                   | Yes                  |
| `codeRisk`         | CRAP score, cyclomatic, cognitive, maintainability, churn, duplication, deep imports | **Opt-in**           |
| `qualityAgnostic`  | UI anti-patterns, rules-docs                                                         | **Opt-in**           |

> **Opt-in groups** never run in `--all`. You must explicitly request their checks.

---

## Complete Check Reference

### Surface Group

| Check ID                | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `oversized-files`       | General file size thresholds and regressions        |
| `surface-size-coverage` | Domain-focused file size tracking and test coverage |

### Design System Group

| Check ID                           | What it does                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `design-tokens`                    | Validates color tokens against semantic token scale                                                                |
| `hosted-event-responsive-contract` | Hosted-event public pages keep a capped mobile composition, desktop body at 56rem+, and compact topbar until 64rem |
| `interaction-states`               | Enforces M3 state-layer, disabled, focus, pressed tokens                                                           |
| `m3-guidelines`                    | M3 surface tier, token, typography, motion, and animation-keyframe compliance                                      |
| `workspace-surface-visibility`     | Guards workspace chrome surfaces against invisible idle/hover/focus states                                         |
| `floating-field-notch`             | Public floating-label notch mask must paint an opaque card surface, not a translucent input tint                   |
| `motion-policy`                    | Motion physics, primitives, fade-snap, banner collapse, broad transition, view transition                          |
| `icon-policy`                      | Material Symbols usage, icon optics alignment                                                                      |
| `design-system-typography`         | Font size, weight, line-height token compliance                                                                    |
| `mobile-audit`                     | Mobile form controls, viewport, fixed-width violations                                                             |
| `z-index-policy`                   | Invalid Tailwind z-\* classes, hardcoded z-index values                                                            |
| `ui-drift`                         | Token drift, shared/editor primitive chrome contracts, and shared-primitive conversion candidates                  |

### Architecture Group

| Check ID                       | What it does                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codebase-health`              | Cross-region layering, duplicates, redundancy hotspots                                                                                                                                                 |
| `perf-hot-paths`               | Deep watchers, layout reads, DOM queries, virtual list churn, active-tab heavy derivations, animation leaks                                                                                            |
| `workspace-interaction-perf`   | Dynamic tab-switch LoAF/long-task and workspace marker audit; use `bun run audit:workspace-interactions:full-matrix` for pairwise coverage, or `WORKSPACE_INTERACTION_SCENARIOS` for focused iteration |
| `boot-graph`                   | Static import chains carrying heavy deps onto boot path                                                                                                                                                |
| `feature-boundaries`           | Forbidden cross-feature imports                                                                                                                                                                        |
| `shared-layer-purity`          | Shared layer import discipline                                                                                                                                                                         |
| `vue-layering`                 | Vue component layering violations                                                                                                                                                                      |
| `mode-driven-vmodel-binding`   | Input type/inputmode switches on mode but v-model is static                                                                                                                                            |
| `css-shared-utilities`         | Shared CSS declaration file size budget                                                                                                                                                                |
| `css-dedupe`                   | Duplicate CSS declarations across components                                                                                                                                                           |
| `public-css-cascade`           | Component CSS overriding route-level cascade                                                                                                                                                           |
| `orphan-css-classes`           | Dead route-CSS class selectors never applied in any template (opt-in; `managedPrefixes` scoped)                                                                                                        |
| `no-scoped-css-pseudos`        | `:deep()`/`:global()` in global `.css` — invalid in non-SFC CSS, so the browser drops the whole rule (scoped→global extraction landmine)                                                               |
| `missing-vue-imports`          | Missing Vue imports in .vue files                                                                                                                                                                      |
| `vue-immediate-watch-tdz`      | Immediate watchers accessing TDZ refs                                                                                                                                                                  |
| `idle-callback-budget`         | Idle callback scheduling patterns                                                                                                                                                                      |
| `profile-placeholder-guard`    | Profile ID placeholder sentinel guards                                                                                                                                                                 |
| `editor-model-reconcile-guard` | Controlled Tiptap editor must guard `setContent` in a `watch(() => props.*)` with `editor.isFocused` — else an async model write-back (autosave echo) resets the doc mid-edit ("rubber-banding")       |
| `browser-perf`                 | Browser performance metrics (FCP, heap, CLS, long tasks)                                                                                                                                               |
| `dead-component-events`        | Dead event handlers in components                                                                                                                                                                      |
| `har-analysis`                 | HAR file analysis for slow endpoints, broken responses, cross-page hotspots, and single-page third-party payload weight                                                                                |
| `memory-monitor`               | Memory allocation patterns                                                                                                                                                                             |

### Localization Group

| Check ID            | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `i18n-hardcoded`    | Hardcoded English strings that should use i18n       |
| `i18n-missing-keys` | i18n keys used in code but missing from locale files |

### Product Contracts Group

| Check ID                     | What it does                                             |
| ---------------------------- | -------------------------------------------------------- |
| `analytics-contracts`        | Frontend/backend analytics event parity                  |
| `runnyknows-contracts`       | Frontend/backend error source parity                     |
| `field-contracts`            | Frontend/backend field definition parity                 |
| `data-capture-contracts`     | Data capture field contracts                             |
| `workflow-outcome-contracts` | Workflow success/failure outcome contracts               |
| `product-contracts`          | Cross-cutting product invariants (routes, helpers, etc.) |
| `stripe-architecture`        | Stripe transport/webhook/secrets centralization          |
| `auth-login-methods`         | Auth login method configuration                          |

> **Moved to `@connections/devopz` (AWS operations scope).** The following
> checks ask about cloud topology, deployment posture, runtime wiring, or
> backend operational risk. They live in the `connections_devopz` package and
> run via `bun packages/connections_devopz/bin/devopz.mjs --check <id>`:
> `infra-public-exposure`, `endpoint-contracts`, `persistence-parity`, `lambda-contracts`,
> `lambda-sqs-concurrency-bounds`, `migration-ledger`, `compute-platform-tier`,
> `webhook-delivery`, `route-auth-guards`, `media-cors`. Arkitect remains the
> codebase/product-structure audit surface; DevOpz owns AWS operational reality.

### Intelligence Group (codebase-agnostic)

| Check ID         | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `dep-rules`      | dependency-cruiser-style forbidden/allowed edges |
| `circular-deps`  | madge-style import cycle detection               |
| `unused-exports` | knip/ts-prune-style unused export detection      |
| `orphan-files`   | unimported-style unreachable file detection      |

### Meta Group

| Check ID                   | What it does                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `arkitect-matrix`          | Surface coverage matrix (audit × surface mapping)                                                        |
| `arkitect-live-smoke`      | Live smoke test for critical audit paths                                                                 |
| `arkitect-report`          | Aggregated report from core contract checks                                                              |
| `bundle-size-budget`       | Client chunk + Lambda handler size budgets                                                               |
| `feature-boundary-matrix`  | Feature boundary docs regeneration                                                                       |
| `spl-playground-integrity` | SPL26 demo-hint coverage + prop-name drift (static)                                                      |
| `spl-visual-integrity`     | SPL26 rendered-DOM scan: render errors, name leaks, collapsed boxes, placeholder leaks (browser; opt-in) |

### Code Risk Group (opt-in, never in `--all`)

| Check ID                   | What it does                                     |
| -------------------------- | ------------------------------------------------ |
| `crap-score`               | CRAP = CC² · (1 − cov/100)³ + CC per function    |
| `cyclomatic-complexity`    | McCabe cyclomatic complexity per function        |
| `cognitive-complexity`     | SonarSource nesting-aware complexity             |
| `maintainability-index`    | SEI maintainability index                        |
| `churn-hotspots`           | git revisions × complexity (Tornhill/CodeScene)  |
| `code-duplication`         | Token-based clone detection (jscpd port)         |
| `no-deep-relative-imports` | Flags `../../../` imports; suggests path aliases |

### Quality Agnostic Group (opt-in, never in `--all`)

| Check ID          | What it does                                      |
| ----------------- | ------------------------------------------------- |
| `ui-antipatterns` | 29-rule UI anti-pattern scanner (impeccable port) |
| `rules-docs`      | Engineering rule deck indexer                     |

---

## CLI Flags

| Flag                            | What it does                                           |
| ------------------------------- | ------------------------------------------------------ |
| `--all`                         | Run all non-opt-in checks                              |
| `--check <id>`                  | Run a specific check                                   |
| `--check <id> --section=<name>` | Run a section within an umbrella check                 |
| `--fail-on-drift`               | Exit code 1 if any finding is an error                 |
| `--quiet`                       | Suppress output for passing checks                     |
| `--policy <path>`               | Load a policy JSON file                                |
| `--policy-dir <path>`           | Load policy from directory                             |
| `--config <path>`               | Load project config JSON                               |
| `--format <format>`             | Output format: `markdown`, `json`, `envelope`, `sarif` |
| `--output-path <path>`          | Write report to a specific file path                   |
| `list`                          | List all registered checks with titles                 |
| `help`                          | Print help text                                        |

---

## Umbrella Checks

Some checks are "umbrellas" — they delegate to multiple sub-engines:

```bash
# Motion policy has 6 sections:
bun audit.mjs --check motion-policy --section=physics
bun audit.mjs --check motion-policy --section=primitives
bun audit.mjs --check motion-policy --section=fade-snap
bun audit.mjs --check motion-policy --section=banner-collapse
bun audit.mjs --check motion-policy --section=broad-transition
bun audit.mjs --check motion-policy --section=view-transition  # flags document.startViewTransition full-page crossfades

# Icon policy has 2 sections:
bun audit.mjs --check icon-policy --section=material-symbols
bun audit.mjs --check icon-policy --section=icon-optics
```

> `icon-optics` (browser; needs `bun run dev`) measures two patterns:
> **fixed-container** icons (checkbox, icon button, circle, nav, chip — glyph
> centered in its box) and **labeled** icons (icon + adjacent text, e.g. the
> hosted section/presence headings — glyph centered against the label's
> cap-height, the case `align-items: center` silently gets ~1px wrong). Tune
> via `labelWarnOffsetPx` / `labelFailOffsetPx` / `labeledTargets` / `labeledUrl`.

> `material-symbols` also flags **hidden icon maps**: a `const` whose name
> matches `/icon/i` and whose object values are official Material Symbol names
> (e.g. `const bumpIcon = { sensors: "sensors" }` rendered as
> `<span class="ms-icon">{{ bumpIcon.sensors }}</span>`). The subset scanner
> strips `{{ }}` from `ms-icon` span bodies and only reads literals near an icon
> context, so a map-indirected glyph is silently dropped from the subset font
> and renders as ligature text. Fix by inlining the name into the span, or — for
> a genuine runtime lookup (`map[key]`) — add it to the dynamic safelist
> (`dynamicSafelistPath`). Exempt a known-good const or file via
> `allowedMappedIconConsts` (by const name or repo-relative path) in
> `material-symbols-policy.json`.

---

## Output Formats

All checks produce Markdown reports by default. Each check writes to its configured `outputPath` (usually `tmp/audits/<CHECK_NAME>.md`).

Additional formats via `--format`:

| Format     | Description                                    |
| ---------- | ---------------------------------------------- |
| `markdown` | Human-readable fix queue (default)             |
| `json`     | Raw JSON payload                               |
| `envelope` | Canonical versioned JSON envelope with scoring |
| `sarif`    | SARIF 2.1.0 for GitHub code scanning           |

### Source anchors

The runner enriches every structured finding that has a readable `filePath` +
`line` with a `sourceAnchor` object. This is inspired by omp/oh-my-pi's
hash-anchored edit harness: agents should treat file:line as a navigation hint
and `sourceAnchor.anchor` / `sourceAnchor.contextHash` as the durable identity
of the source content they are about to edit.

Shape:

```json
{
  "version": 1,
  "kind": "content-hash",
  "filePath": "src/example.ts",
  "line": 42,
  "anchor": "L42:sha256-abc123def456",
  "lineHash": "sha256-abc123def456",
  "contextStartLine": 40,
  "contextEndLine": 44,
  "contextHash": "sha256-fedcba654321"
}
```

Source anchors are emitted in `tmp/audits/findings.json`,
`tmp/audits/DECISION_BRIEF.json`, SARIF result properties, and any envelope
that carries the enriched findings. They are additive; check engines only need
to return ordinary findings.

---

## Architecture

```
packages/connections-arkitect/
├── bin/                    # CLI entry points
│   ├── audit.mjs           # Main audit CLI
│   ├── audit-test.mjs      # Fixture test runner
│   ├── arkitect-canary.mjs # Critical regression tests
│   └── audit-screenshot.mjs # Visual regression
├── src/
│   ├── cli/                # CLI args, registry, runner
│   ├── core/               # Primitives: finding, scoring, envelope, SARIF
│   ├── checks/             # Organized by domain
│   │   ├── architecture/   # Feature boundaries, layering, dependencies
│   │   ├── contracts/      # Analytics, fields, endpoints, workflows
│   │   ├── css/            # Dedupe, shared utilities, cascade
│   │   ├── design-system/  # Tokens, M3, motion, icons, typography
│   │   ├── i18n/           # Hardcoded strings, missing keys
│   │   ├── mobile/         # Mobile audit
│   │   ├── performance/    # Boot graph, bundles, browser perf
│   │   ├── code-quality/   # CRAP, complexity, duplication, deep imports
│   │   ├── surface/        # File size, coverage
│   │   ├── meta/           # Matrix, report, smoke
│   │   └── agnostic/       # UI anti-patterns, rules-docs
│   ├── engines/            # Organized by domain (mirrors checks/)
│   ├── fixtures/           # Regression harness
│   └── screenshot/         # Visual regression runner
├── arkitect-core/          # Codebase-agnostic layer
│   ├── content/            # Design vocabulary + engineering rules
│   ├── skills/             # AI auditor skill cards
│   └── ui-antipatterns/    # impeccable anti-pattern registry
├── policies/connections/   # Connections-specific policy + allowlists
├── test/                   # Test suite
└── package.json            # Self-referencing exports map
```

### Import Convention

All internal imports use stable package self-references, NOT relative paths:

```js
// ✅ Correct — stable, survives file moves
import { createFinding } from "@connections/arkitect/core/finding";
import { runBootGraphSection } from "@connections/arkitect/engines/performance/boot-graph-engine";

// ❌ Wrong — brittle, breaks when files move
import { createFinding } from "../../core/finding.mjs";
```

The `package.json` `exports` map is the single source of truth. Move a file? Update one line in the exports map, zero import updates needed.

---

## Adding a New Check

1. Create the engine in `src/engines/<domain>/` (if needed)
2. Create the check in `src/checks/<domain>/` — export an `audit` object:
   ```js
   export const audit = {
     id: "my-check",
     title: "My Check",
     category: "architecture",
     defaultConfig: {
       /* defaults */
     },
     async run(context) {
       /* ... */
     },
   };
   ```
3. Register it in `src/cli/registry.mjs` — add import + group membership
4. Add it to the exports map in `package.json` if other packages need it
5. (Optional) Add test fixtures in `test/fixtures/scenarios.generated.mjs`

---

## Path Aliases Available

These are configured in `tsconfig.json` for the main codebase:

| Alias                       | Maps to                         | Use for                                             |
| --------------------------- | ------------------------------- | --------------------------------------------------- |
| `@/*`                       | `src/*`                         | All app source (components, composables, lib, etc.) |
| `@lunawerx/ui/*`            | `packages/connections-ui/src/*` | Shared UI primitives                                |
| `@connections/arkitect/...` | `packages/connections-arkitect` | Arkitect package (self-import)                      |
| `@infra-shared/*`           | `infra/shared/*`                | Shared infra utilities (lambda tsconfig only)       |

Use these instead of `../../../` relative paths. The `no-deep-relative-imports` check enforces this.

---

## Inline suppressions (reason-bearing)

Heuristic checks over-flag — some findings are intentional KEEPs. Instead of a central baseline snapshot, the verdict is captured **at the callsite** with a reason-bearing inline directive (engine: `src/core/suppressions.mjs`):

```
// arkitect-ignore-next-line <rule>[, <rule>…] — <why>
<!-- arkitect-ignore-file <rule>[, <rule>…] — <why> -->
```

- `*` matches any rule. Comma-separates multiple rules. The reason follows a `—` / `-` / `: ` separator (rule ids never contain spaces, so interior hyphens are safe). HTML-comment directives must be **single-line**.
- Architecture checks call `applySuppressions(findings, fileTextByPath)` to drop suppressed findings.
- `ui-drift` goes further: its **Drift queue** partitions heuristic findings into **actionable** (un-annotated → the real migration queue), **justified** (directive + reason), and **invalid** (directive with no reason → the audit fails). A KEEP must declare why. This is the programmatic replacement for ad-hoc "find unmigrated primitives" sweeps, including warn-level shared-primitive conversion candidates such as local collapsible sections, menu/picker rows, status pills, alert banners, empty/loading shells, and navigation tiles.

---

## Arkitect Self-Evolution

The arkitect is a living organism — it must rapidly evolve with every run. Treat it as a system that learns from what it finds.

### The evolution loop

Every arkitect run produces findings. Every finding is a signal. Some signals reveal code problems; others reveal **arkitect gaps** — patterns the arkitect should have caught but didn't, or noise it generated that it shouldn't have.

When you encounter an arkitect gap, close it immediately:

1. **False negatives** (missed problems) → Add a new check or extend an existing engine.
2. **False positives** (incorrect findings) → Refine the detection logic to eliminate the noise.
3. **Root-cause blindness** (symptoms flagged, cause missed) → Add grouping or a root-cause detector.
4. **Repeated manual fixes** → Automate the fix detection as an arkitect check.

### When to evolve

- **Before a run:** If you anticipate a gap, add the check first.
- **During a run:** If a finding reveals a detection gap, pause and add the check.
- **After a run:** Review every finding for arkitect improvement opportunities.

### How to add a check

See [Adding a New Check](#adding-a-new-check) above. The full workflow:

1. Create the engine in `src/engines/<domain>/` (if needed)
2. Create the check in `src/checks/<domain>/`
3. Register it in `src/cli/registry.mjs`
4. Add it to `arkitect.config.json` under its group
5. Re-run `--all` to confirm it passes on the current codebase
6. Update the check reference table in this document

### Philosophy

A lightweight check that ships today and catches 80% of cases is worth more than a perfect check that never ships. The arkitect grows through iteration — each run makes it stronger for the next.

---

## AI Agent Quick Reference

When someone says "run the arkitect":

```bash
# Basic: run everything
bun packages/connections-arkitect/bin/audit.mjs --all

# List available checks
bun packages/connections-arkitect/bin/audit.mjs list

# Run a specific check
bun packages/connections-arkitect/bin/audit.mjs --check <id>

# CI mode: fail on errors, no noise
bun packages/connections-arkitect/bin/audit.mjs --all --fail-on-drift --quiet

# Test the arkitect itself
bun packages/connections-arkitect/bin/audit-test.mjs

# Canary (critical regression)
bun packages/connections-arkitect/bin/arkitect-canary.mjs
```

When someone says "run the full check" or "validate everything":

```bash
bun run check:github
# This runs: typecheck + feature boundaries + arkitect contracts + lint + tests
```
