# Architect Base — the standard model, blank

A portable, drop-in **code guardian**: it audits a repo's *local files* (import
cycles, dead code, dependency hygiene, bloat, complexity, stale TODOs) and emits
a prioritized fix queue. It is the local-files counterpart to a **database**
guardian (the "Dark Knight" pattern). Two guardians, two jurisdictions.

This bundle is the **blank base** — `core/` (the standard model, copy-verbatim)
plus a blank `local/` template with no project specifics baked in. Drop it into
any repo and you have an Architect in ~5 minutes.

```
Architect Base/
├── core/      ← the standard model. COPY VERBATIM. Never edit per-repo.
│   ├── bin/audit.mjs          the CLI
│   ├── src/                   cli + core primitives + engines + checks (detectors)
│   ├── arkitect-core/         codebase-agnostic knowledge base
│   ├── api.mjs                stable surface local/ imports core primitives through
│   └── package.json           self-imports resolve here — leave the name as-is
└── local/     ← YOUR specialization (BLANK TEMPLATE). Each repo grows its own.
    ├── project.audit.config.json   rename to <yourproject>.audit.config.json
    ├── augment.mjs                 copy verbatim — injects your tsconfig aliases
    ├── checks/                     empty — drop bespoke detectors here later
    └── README.md                  per-workspace notes + the rename/point steps
```

## Install into a new repo (the recipe)

1. **Copy this whole folder** into the repo, e.g. `tools/architect/`. Do **not**
   edit `core/`.
2. **Customize `local/`** — follow [`local/README.md`](local/README.md): rename
   the config to `<yourproject>.audit.config.json`, set `roots` to your source
   dir(s) and `entryPatterns` to your real entry point(s).
3. **Add npm scripts** to the repo's `package.json`:
   ```json
   "architect":        "bun tools/architect/core/bin/audit.mjs --all --policy-dir tools/architect/local --policy <yourproject>",
   "architect:strict": "bun tools/architect/core/bin/audit.mjs --all --policy-dir tools/architect/local --policy <yourproject> --fail-on-drift --quiet",
   "architect:list":   "bun tools/architect/core/bin/audit.mjs list"
   ```
4. **Run** `bun run architect`. Tune `entryPatterns` / thresholds from the first
   sweep. Add `--fail-on-drift --quiet` in CI to fail the build on any
   error-severity finding.

## Requirements

- [Bun](https://bun.sh) (the CLI runs under `bun`).
- Two optional checks (`css/css-dedupe`, `mobile/mobile-audit`) need extra
  packages (`postcss-scss`, `@axe-core/playwright`). They are **not** in the
  default group, so the base runs clean without them — they simply skip with a
  one-line notice.

## The full reference

The complete model — the two-folder split, how core loops through local, writing
bespoke detectors, the self-evolution rule — lives in
[`core/ARCHITECT.md`](core/ARCHITECT.md). Read that next.

> **The one rule that keeps it sharp:** never be surprised twice by the same
> class of problem. When something rots through undetected, add a detector that
> catches that class — then it's caught forever, in this repo and (if promoted
> into `core/src/checks/`) in all of them.
