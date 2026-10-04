# The Architect — Core (the standard model)

A static **code guardian**: it audits a repo's *local files* (dead code, import
cycles, dependency hygiene, bloat, and workspace-specific rot) and reports a
prioritized fix queue. It is the local-files counterpart to a **database**
guardian (the "Dark Knight" pattern). Two guardians, two jurisdictions.

> **This folder (`core/`) is the standard model. It is portable and you copy it
> verbatim into every workspace. You never edit it per-workspace.** Everything
> workspace-specific lives in a sibling `local/` folder that core reaches out to.

---

## The two-folder model (why it's split this way)

```
architect/
├── core/      ← the standard model. COPY THIS to any repo. Never edit per-repo.
│   ├── bin/audit.mjs          the CLI
│   ├── src/                   cli + core primitives + engines + checks (the detectors)
│   ├── arkitect-core/         codebase-agnostic knowledge base
│   ├── api.mjs                stable surface local/ imports core primitives through
│   └── package.json           name: @saydeploy/architect (self-imports resolve here)
└── local/     ← THIS workspace's specialization. LEAVE THIS BEHIND. Each repo grows its own.
    ├── <name>.audit.config.json   which checks run, roots, thresholds, checkDirs
    ├── augment.mjs                injects this repo's tsconfig path aliases
    ├── checks/                    bespoke detectors unique to this repo (optional)
    └── README.md                  notes for this workspace
```

The whole point: **copy `core/` to a new workspace, leave `local/` behind, write
a fresh tiny `local/` there.** Core is the reusable engine ("train"); local is the
per-repo "carts" you bolt on. This mirrors the Dark Knight's engine + local-parser
split exactly.

### How core "loops through" the local folder

Core never contains workspace specifics. Instead:

1. **Config** — you run core pointed at the local pack:
   `--policy-dir <path/to/local> --policy <name>` resolves
   `<local>/<name>.audit.config.json`. (Resolution order is in `src/core/config.mjs`.)
2. **Custom checks** — the config declares `"checkDirs": ["./checks"]` (paths
   relative to the config file). On startup `bin/audit.mjs` discovers core's own
   `src/checks/` **and** every existing `checkDir`, then merges them — so a `.mjs`
   dropped in `local/checks/<category>/` runs as if it lived inside core.
3. **Aliases** — `local/augment.mjs` calls `loadTsconfigAliases(root)` and injects
   the repo's tsconfig path aliases into the import-graph checks, so reachability
   resolves the same specifiers `tsc` honors. Single source of truth = `tsconfig.json`.

---

## Run it

```bash
bun <path>/core/bin/audit.mjs --all --policy-dir <path>/local --policy <name>
bun <path>/core/bin/audit.mjs --check <id> --policy-dir <path>/local --policy <name>
bun <path>/core/bin/audit.mjs list        # every registered check (core only)
```

Add `--fail-on-drift --quiet` for CI (exit 1 on any error-severity finding).
Reports are written under the config's `output.reportDir` (default `tmp/audits/`).

---

## Spin up the Architect in a NEW workspace (the recipe)

Any AI or human can do this in ~5 minutes:

1. **Copy `core/`** into the new repo, e.g. `tools/architect/core/`. Do not edit it.
2. **Create the sibling `local/`** (`tools/architect/local/`) with three things:

   **`local/<project>.audit.config.json`** — start from this minimal pack:
   ```json
   {
     "version": 1,
     "project": "<project>",
     "suite": { "mode": "configured" },
     "output": { "reportDir": "tmp/architect" },
     "augments": ["./augment.mjs"],
     "checkDirs": ["./checks"],
     "groups": {
       "<project>": {
         "checks": ["circular-deps", "dead-code", "dependency-hygiene",
                    "code-duplication", "oversized-files", "cyclomatic-complexity",
                    "cognitive-complexity", "maintainability-index",
                    "no-deep-relative-imports", "stale-todos"]
       }
     },
     "checks": {
       "circular-deps": { "enabled": true, "requires": {}, "roots": ["src"],
                          "extensions": [".ts",".tsx",".js",".jsx",".mjs",".cjs"] },
       "dead-code": { "enabled": true, "requires": {},
         "orphanFiles":  { "roots": ["src"], "extensions": [".ts",".tsx",".js",".mjs"],
                           "entryPatterns": ["^src/<entry>\\.ts$"],
                           "ignorePatterns": ["\\.test\\.","\\.spec\\.","\\.d\\.ts$"] },
         "unusedExports":{ "roots": ["src"], "extensions": [".ts",".tsx",".js",".mjs"],
                           "entryPatterns": ["^src/<entry>\\.ts$"],
                           "ignoreNames": ["^activate$","^deactivate$"] } },
       "dependency-hygiene": { "enabled": true, "requires": {}, "roots": ["src"] }
     }
   }
   ```
   - `suite.mode: "configured"` ⇒ `--all` runs ONLY the checks you list (no inherited
     audits from other ecosystems). This is the portability switch — keep it.
   - Set `roots` to the repo's source dir(s). Set the orphan/unused `entryPatterns`
     to the real entry point(s) (`src/extension.ts`, `src/main.ts`, `src/index.ts`, …).
     Multi-entry projects need every entry, or unreached files show as false orphans.
   - `requires: {}` overrides a check's built-in project gate so it runs anywhere.

   **`local/augment.mjs`** — copy verbatim; it makes reachability honor tsconfig:
   ```js
   import { loadTsconfigAliases } from "../core/api.mjs";
   const GRAPH_CHECK_IDS = ["circular-deps","dead-code","dep-rules","boot-graph",
     "unused-exports","orphan-files","module-rules","feature-boundaries","dependency-hygiene"];
   export default async function augment(config, { root }) {
     const aliases = await loadTsconfigAliases(root, "tsconfig.json");
     if (!aliases || !Object.keys(aliases).length) return config;
     config.checks = config.checks || {};
     for (const id of GRAPH_CHECK_IDS) {
       const c = config.checks[id]; if (!c) continue;
       if (id === "dead-code") {           // umbrella: reads NESTED aliases
         if (c.orphanFiles)  c.orphanFiles.aliases  = { ...aliases, ...(c.orphanFiles.aliases||{}) };
         if (c.unusedExports) c.unusedExports.aliases = { ...aliases, ...(c.unusedExports.aliases||{}) };
         continue;
       }
       c.aliases = { ...aliases, ...(c.aliases||{}) };
     }
     return config;
   }
   ```

   **`local/checks/`** — empty to start. Add bespoke detectors later (below).

3. **Add npm scripts** to the repo's `package.json`:
   ```json
   "architect":        "bun tools/architect/core/bin/audit.mjs --all --policy-dir tools/architect/local --policy <project>",
   "architect:strict": "bun tools/architect/core/bin/audit.mjs --all --policy-dir tools/architect/local --policy <project> --fail-on-drift --quiet",
   "architect:list":   "bun tools/architect/core/bin/audit.mjs list"
   ```
4. **Run** `bun run architect`. Tune `entryPatterns`/thresholds from the first sweep.

That's it. Same core everywhere; only `local/` differs.

---

## Writing a bespoke (local) detector

Drop a file in `local/checks/<category>/<id>.mjs`:

```js
import { createFinding } from "../../../core/api.mjs"; // sibling-core relative path
export const audit = {
  id: "my-check",
  title: "My Check",
  group: "architecture",          // or any group; used for ordering
  defaultConfig: { enabled: true, includeInAll: true, requires: {} },
  async run(context) {
    // context = { root, checkConfig, config, baseline }
    const findings = [/* createFinding({ ruleId, severity, filePath, line, message }) */];
    return { failed: findings.some(f => f.severity === "error"), findings,
             report: `# My Check\n\n${findings.length} finding(s).`,
             outputPath: "tmp/architect/MY_CHECK.md" };
  },
};
```

Then add `"my-check"` to the config's `groups.<project>.checks` so `--all` runs it.
**Import core only through `../../../core/api.mjs`** (the stable surface) — never via
the package name (bare `@…/architect` specifiers don't resolve from outside core)
and never by reaching into `core/src/...` (brittle). Need a primitive that isn't
re-exported from `api.mjs`? Add it there.

The contract a check's `run(context)` returns: `{ failed, findings, report,
outputPath, jsonPayload?, baselineDocument? }`. See any file under
`core/src/checks/` for worked examples, and `core/docs/INSTRUCTION_MANUAL.md` for
the full reference (groups, umbrella checks, suppressions, output formats).

---

## The one rule that keeps it sharp

**Never be surprised twice by the same class of problem.** When something rots
through undetected (the reason this exists: dead code a database guardian can't
see), add a local detector that catches that class — then it's caught forever, in
this workspace and, if you promote it into `core/src/checks/`, in all of them.
