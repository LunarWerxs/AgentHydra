---
description: The full pre-push gate for this repo - format, types, tests, guardrails, and the repo's own CI run locally
---

Run every gate this repo has, in order, and report the real verdict. Do not push, and do not
declare it green on a partial run. Extra instructions, if any: $ARGUMENTS

1. `bunx biome check --write .` - format and lint.
2. `bun run --cwd server typecheck` and `bun run --cwd web typecheck`.
3. `bun run test` - the full suite (parallel, four workers; see the workflow comment for why CI
   itself stays serial).
4. `python ~/.claude/tools/localci.py` - **the one that matters**: it reads this repo's own
   `.github/workflows/*.yml` and runs those steps here, so the workflow file IS the gate list and
   there is no second copy to drift. Includes every guardrail check.

Rules:

- **A red is not automatically yours.** These trees run many concurrent agents; before believing a
  failure, check `git status --short` and the mtimes of the named files - someone else's
  half-finished edit fails exactly like a bug. Say so rather than "fixing" work in progress.
- **A green here is ONE leg.** localci covers Windows (and Linux in a container with `--docker`);
  macOS is always GitHub's, and it says so.
- If anything fails, fix the cause. Never weaken a test or a guardrail to get green - a check that
  cries wolf gets ignored, and then it misses the real thing.
