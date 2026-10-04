# Third-party notices

`arkitect-core` bundles harvested material from the following projects.
Source-of-truth copies live under `scratch/arkitect-sources/`; see the
upstream repos for full license text.

## impeccable (Apache-2.0)

- Repo: https://github.com/pbakaus/impeccable
- Copyright: 2026 Paul Bakaus

Files derived:

- `rules/ui-antipatterns/registry.mjs` — verbatim copy of
  `cli/engine/registry/antipatterns.mjs`
- `rules/ui-antipatterns/detect-text.mjs` — verbatim copy of
  `cli/engine/engines/regex/detect-text.mjs`, with import paths rewritten to
  match the flat folder layout used here
- `rules/ui-antipatterns/color.mjs` — verbatim copy of
  `cli/engine/shared/color.mjs`
- `rules/ui-antipatterns/constants.mjs` — verbatim copy of
  `cli/engine/shared/constants.mjs`
- `rules/ui-antipatterns/page.mjs` — verbatim copy of
  `cli/engine/shared/page.mjs`
- `rules/ui-antipatterns/findings.mjs` — verbatim copy of
  `cli/engine/findings.mjs`, with the registry import path rewritten
- `references/*.md` (16 files) — copied from `skill/reference/`
- `rules/ui-antipatterns/profiler.mjs` — local no-op shim that replaces
  `cli/engine/profile/profiler.mjs` (the upstream profiler reports timings the
  arkitect runner does not surface)

## levnikolaevich/claude-code-skills (MIT)

- Repo: https://github.com/levnikolaevich/claude-code-skills
- Copyright: Lev Nikolaev

Files derived:

- `auditors/ln-6XX-*/SKILL.md` (20 files) — verbatim copies from
  `plugins/codebase-audit-suite/skills/`

## rohitg00/awesome-claude-code-toolkit (license per upstream repo)

- Repo: https://github.com/rohitg00/awesome-claude-code-toolkit

Files derived:

- `rules-docs/*.md` (15 files) — verbatim copies from `rules/`

## levnikolaevich/claude-code-skills — runtime contracts (MIT)

- Repo: https://github.com/levnikolaevich/claude-code-skills

Patterns adopted (paraphrased, not verbatim):

- `references/severity-scoring.md` and `../src/core/scoring.mjs` —
  `penalty = C*2.0 + H*1.0 + M*0.5 + L*0.2` formula from
  `plugins/codebase-audit-suite/shared/references/audit_scoring.md`.
- `references/output-envelope.md` and `../src/core/envelope.mjs` —
  versioned JSON envelope shape from
  `shared/references/audit_summary_contract.md` and the worker contract from
  `shared/references/audit_worker_core_contract.md`.

## itsmesherry/claude-audit (MIT)

- Repo: https://github.com/itsmesherry/claude-audit

Patterns adopted:

- `../src/core/scoring.mjs` `SECURITY_WEIGHTS` — `critical=15, high=8,
medium=4, low=2` table from `src/core/auditor.ts:mergeStaticIntoCategories`.
- `../src/core/project-detect.mjs` `LANGUAGE_MAP`, `NPM_FRAMEWORK_PATTERNS`,
  `ECOSYSTEM_MANIFESTS` — adapted from `src/core/scanner.ts`'s `LANGUAGE_MAP`
  / `FRAMEWORK_PATTERNS` / `TEST_PATTERNS`.

## anthropics/claude-code (Apache-2.0)

- Repo: https://github.com/anthropics/claude-code

Patterns adopted:

- `references/verdict-and-confidence.md` and `../src/core/confidence.mjs`
  0–100 confidence rubric and 80-cutoff convention — from
  `plugins/pr-review-toolkit/agents/code-reviewer.md`.

## anthropics/claude-code-security-review (per upstream repo)

- Repo: https://github.com/anthropics/claude-code-security-review

Patterns adopted:

- `../src/core/findings-filter.mjs` two-stage filter (hard regex rules →
  semantic predicate) and `FilterStats` telemetry — from
  `claudecode/findings_filter.py:HardExclusionRules`.

## gadievron/raptor (per upstream repo)

- Repo: https://github.com/gadievron/raptor

Patterns adopted:

- `references/sarif.md` and `../src/core/sarif.mjs` — SARIF 2.1.0 writer shape
  adapted from `core/sarif/parser.py`.
- `references/verdict-and-confidence.md` and `../src/core/confidence.mjs`
  three-valued verdict lattice and Beta-Bernoulli posterior aggregation —
  from `packages/hypothesis_validation/{verdict,posterior,runner}.py`.

## avalonreset/claude-github (per upstream repo)

- Repo: https://github.com/avalonreset/claude-github

Patterns adopted:

- `../src/core/checklist.mjs` weighted-checklist scoring primitive
  (`score_from_checks`, `score_rating`, `RATING_BANDS`) — from
  `github/scripts/audit_repo.py`.
