# local/ — your workspace's specialization (BLANK TEMPLATE)

This folder is the **leave-behind** half of The Architect. The portable engine
lives in the sibling [`../core/`](../core/ARCHITECT.md) and is copied verbatim
into every repo; **everything workspace-specific lives here**, and each repo
grows its own `local/`.

This is the blank starter. Three things to do:

1. **Rename the config** `project.audit.config.json` → `<yourproject>.audit.config.json`
   and set `"project": "<yourproject>"` + the group key inside it to match.
   (`--policy <name>` resolves `<local>/<name>.audit.config.json`, so the
   filename must equal the policy name you pass.)

2. **Point it at your source.** Set `roots` to your real source dir(s) and the
   `dead-code` `entryPatterns` to your real entry point(s) — `src/index.ts`,
   `src/main.ts`, `src/extension.ts`, … Multi-entry projects need *every*
   entry listed or unreached files show up as false orphans.

3. **`augment.mjs`** is copied verbatim — leave it. It injects your
   `tsconfig.json` path aliases into the import-graph checks so reachability
   resolves the same specifiers `tsc` honors. No tsconfig? It's a safe no-op.

4. **`checks/`** is empty. Drop bespoke detectors here later — one file per
   detector, importing core only through `../../core/api.mjs`. See
   [`../core/ARCHITECT.md`](../core/ARCHITECT.md) § "Writing a bespoke detector".

## Run

```bash
bun ../core/bin/audit.mjs --all --policy-dir . --policy <yourproject>
```

Or wire npm scripts (see the top-level `README.md` of this bundle). Reports land
under the config's `output.reportDir` (default `tmp/architect/`).

> The one rule that keeps it sharp: **never be surprised twice by the same class
> of problem.** When something rots through undetected, add a local detector that
> catches that class — then it's caught forever.
