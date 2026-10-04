# Using `@connections/arkitect` on a non-Connections codebase

The arkitect ships with two layers:

- **Codebase-agnostic core** — `src/cli/`, `src/core/`, the runner, the
  reusable engines in `src/engines/`, and the knowledge base under
  `arkitect-core/`. Nothing in here knows about Connections.
- **Connections policy pack** — `policies/connections/` (audit config,
  sidecar JSONs) plus a small set of Connections-product-specific
  checks under `src/checks/` (e.g. `auth-login-methods`,
  `vocabulary-contracts`, `forms-surface`).

A new project plugs in by writing its own **policy pack**: a directory with
one audit config JSON, optional sidecar JSONs (allow-lists, target lists),
and optional augment hooks. No core code changes.

## Resolution order

The runner looks for a config in this order:

1. `--config <path>` CLI flag.
2. `--policy-dir <dir>` + `--policy <name>`.
3. `ARKITECT_POLICY_DIR` env var.
4. `<root>/.arkitect/<policy>/<policy>.audit.config.json`.
5. `<root>/.arkitect/arkitect.audit.config.json`.
6. `<root>/arkitect.config.json`.
7. Legacy Connections fallback at
   `packages/connections-arkitect/policies/connections/connections.audit.config.json`
   (kept for backward compatibility — new projects do NOT use this).

A new project usually places its pack at `<root>/.arkitect/`.

## The minimal "hello world" pack

```
.arkitect/
└── arkitect.audit.config.json
```

`.arkitect/arkitect.audit.config.json`:

```json
{
  "version": 1,
  "project": "my-app",
  "suite": {
    "mode": "configured"
  },

  "output": {
    "reportDir": "tmp/audits"
  },

  "groups": {
    "portable": {
      "checks": [
        "oversized-files",
        "cyclomatic-complexity",
        "cognitive-complexity",
        "code-duplication",
        "circular-deps",
        "orphan-files"
      ]
    }
  },

  "checks": {
    "oversized-files": {
      "enabled": true,
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      "warnLines": 1000,
      "errorLines": 2000,
      "outputPath": "tmp/audits/OVERSIZED_FILES_AUDIT.md"
    },
    "cyclomatic-complexity": {
      "enabled": true,
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    },
    "cognitive-complexity": {
      "enabled": true,
      "roots": ["src"]
    },
    "code-duplication": {
      "enabled": true,
      "roots": ["src"]
    },
    "circular-deps": {
      "enabled": true,
      "roots": ["src"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    },
    "orphan-files": {
      "enabled": true,
      "roots": ["src"]
    }
  }
}
```

Run it:

```sh
bunx connections-arkitect --all --policy-dir .arkitect
```

`suite.mode: "configured"` is the portability switch: `--all` runs only the
checks named in `groups` / `checks`, so a new codebase does not inherit
Connections-specific audits by accident. The Connections repo leaves this as
the default `"discovered"` mode so its existing full sweep still runs every
static check.

Checks can also declare a built-in `requires` gate, such as
`{ "projectNames": ["connections"] }` or `{ "frameworks": ["vue"] }`. A policy
pack may override that gate per check with `checks.<id>.requires`; use `{}` to
run a built-in project-gated check in a different codebase after you have
provided matching config.

## Which checks are codebase-agnostic out of the box

Generic engines that ship today:

- `bundle-size-budget`, `churn-hotspots`, `circular-deps`, `clone-blocks`,
  `code-duplication`, `cognitive-complexity`, `crap-score`,
  `cyclomatic-complexity`, `code-metrics`, `maintainability-index`,
  `migration-ledger`, `orphan-files`, `oversized-files`,
  `surface-size-coverage`, `unused-exports`.

Generic-with-config (work anywhere if you provide a config / allowlist):

- `dep-rules`, `feature-boundaries`, `i18n-hardcoded`, `i18n-missing-keys`,
  `material-symbols` (icon-set is configurable), `motion-physics`,
  `mobile-audit` (Playwright-driven, needs a target URL).

Vue-flavoured (need a Vue project to apply):

- `missing-vue-imports`, `vue-layering`, `perf-hot-paths`,
  `design-system-typography`.

Connections-specific defaults (guarded with `requires.projectNames:
["connections"]` because they expect Connections contracts, paths, or runtime
captures):

- `auth-login-methods`, `data-capture-contracts`, `endpoint-contracts`,
  `forms-surface`, `host-header-chip-wiring`,
  `hosted-event-responsive-contract`, `lambda-contracts`, `motion-policy`,
  `persistence-parity`, `product-contracts`, `profile-placeholder-guard`,
  `public-css-cascade`, `spl-playground-integrity`, `ui-drift`,
  `vocabulary-contracts`, `vue-layering`, `webhook-delivery`,
  `workflow-outcome-contracts`, `workspace-surface-visibility`,
  `arkitect-{matrix,report,live-smoke}`.

## Plugging in project-specific behaviour

### Custom "actionable" key vocabulary

If your checks emit non-universal jsonPayload keys (e.g. `myCustomViolations`)
that should make the runner write a markdown fix-queue when non-empty:

```json
{
  "actionableArrayKeys": ["myCustomViolations"],
  "actionableCountKeys": ["myCustomFailureCount"]
}
```

These get merged with the universal set (`findings`, `regressions`, `issues`,
`actionable`, `uncovered`, `unknown`, `unapproved`, `blockingRegressions`,
plus `errors`, `warnings`, `totalFindings`, etc).

### Augment hooks

For deeper customisation — modify the loaded config based on detected project
state — declare `augments`:

```json
{
  "augments": ["./augment.mjs"]
}
```

Each augment is an ESM module:

```js
// .arkitect/augment.mjs
export default function augment(config, { configDir, root, configPath }) {
  // Mutate or return a new config. Examples:
  //  - inject extra roots for any check that scans a known dir
  //  - skip checks based on detected frameworks
  //  - rewrite output paths
  return config;
}
```

The Connections pack uses this exclusively for the `packages/connections-ui`
primitive-surface injection — see [policies/connections/augment.mjs](../policies/connections/augment.mjs).

## Codebase-agnostic primitives available to check authors

Use these in any check you write (import from the `@connections/arkitect`
package's `exports`):

| Module                   | Import                                                         | What it gives you                                                                   |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `./core/scoring`         | `scoreFindings`, `applyBlastRadius`                            | 0–10 / 0–100 / A–F scoring with code-quality or security weights                    |
| `./core/envelope`        | `buildEnvelope`                                                | Versioned JSON envelope wrapping findings + scoring + project                       |
| `./core/sarif`           | `buildSarifLog`                                                | SARIF 2.1.0 output for GitHub Code Scanning / VS Code SARIF viewer                  |
| `./core/confidence`      | `filterByConfidence`, `applyVerdictDowngrade`, `betaBernoulli` | 0–100 confidence with 80-cutoff and three-valued verdict lattice                    |
| `./core/findings-filter` | `filterFindings`                                               | Two-stage suppression (hard regex rules → semantic predicate)                       |
| `./core/project-detect`  | `detectProject`, `checkAppliesToProject`                       | Language / framework / ecosystem detection; per-check `requires` gating             |
| `./core/checklist`       | `scoreChecklist`, `combineCategoryScores`                      | Weighted-checklist rubric scoring (READMEs, dependency hygiene, release process, …) |
| `./core/files`           | `walkFiles`, `pathExists`, `toPosixPath`                       | Filesystem walker with the arkitect's default skip set                             |
| `./core/finding`         | `createFinding`, `countFindingsByRuleAndFile`                  | Uniform `Finding` shape                                                             |

Each module's contract is documented under
[`../arkitect-core/references/`](../arkitect-core/references/).

## Reference docs harvested from peer projects

See [`../arkitect-core/NOTICES.md`](../arkitect-core/NOTICES.md) for upstream
sources and license credits. The core patterns were harvested from:

- [obra/superpowers](https://github.com/obra/superpowers) — skills authoring discipline
- [anthropics/claude-code](https://github.com/anthropics/claude-code) — code-review confidence rubric
- [itsmesherry/claude-audit](https://github.com/itsmesherry/claude-audit) — language/framework detection + security weight table
- [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) — two-stage findings filter
- [3stoneBrother/code-audit](https://github.com/3stoneBrother/code-audit) — per-language × per-framework checklist split
- [avalonreset/claude-github](https://github.com/avalonreset/claude-github) — weighted-checklist scoring primitive
- [gadievron/raptor](https://github.com/gadievron/raptor) — SARIF format + three-valued verdict lattice
- [levnikolaevich/claude-code-skills](https://github.com/levnikolaevich/claude-code-skills) — JSON envelope + worker contract + scoring formula
- [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) — dependency-auditor patterns
