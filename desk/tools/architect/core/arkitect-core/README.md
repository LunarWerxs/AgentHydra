# arkitect-core

The codebase-agnostic layer of `@connections/arkitect`. Nothing in this
directory references Connections, Vue, our package layout, our policies, or our
checks. Drop it into any project and the rules / references / auditors still
make sense.

## What's in here

```
arkitect-core/
├── rules/
│   └── ui-antipatterns/    # 29 anti-pattern rules + regex source scanner
├── references/             # 20 design-vocabulary + runtime reference files
├── rules-docs/             # 15 cross-cutting engineering rule decks
└── auditors/               # 20 codebase-agnostic auditor skill cards
```

The matching runtime executables live one tree up at
[`../src/core/`](../src/core/) and are exposed via the package's `exports`
map. See [`./references/severity-scoring.md`](./references/severity-scoring.md),
[`./references/output-envelope.md`](./references/output-envelope.md),
[`./references/sarif.md`](./references/sarif.md), and
[`./references/verdict-and-confidence.md`](./references/verdict-and-confidence.md).

### `rules/ui-antipatterns/`

Hand-port of Paul Bakaus' `impeccable` anti-pattern registry + regex source
detector. Twenty-nine rules covering the most reliable tells of AI-generated UI
(side-tab borders, overused fonts, gradient text, purple/violet palettes,
nested cards, bounce easing, dark-glow accents, icon-tile stacks, …) plus
WCAG-grade quality issues (low contrast, line length, cramped padding, tight
leading, skipped headings, tiny body text, all-caps body, wide tracking, …).

The jsdom-dependent HTML and CSS-cascade engines are intentionally **not**
copied — they pull a heavy browser-shim chain and the regex scanner catches
~80% of the same rules straight off source files. Add a thin jsdom-backed
wrapper later if a project needs the full element-level analysis.

Public surface (`index.mjs`):

- `ANTIPATTERNS` — full rule catalog with id / category / name / description /
  optional `skillSection` + `skillGuideline` cross-references
- `detectText(content, filePath, ext, options?)` — regex-based file scanner
- `extractStyleBlocks`, `extractCSSinJS` — helpers
- color utilities (`contrastRatio`, `relativeLuminance`, `colorToHex`, …)
- font / tag constants (`SAFE_TAGS`, `OVERUSED_FONTS`, …)
- `finding(id, filePath, snippet, line)` — uniform finding shape

### `references/`

Design vocabulary reference files harvested from upstream projects, plus
runtime contract docs for the arkitect's core executables. LLM-facing
instruction docs, not docs about a CLI:

- **Design vocab**: `typography.md`, `color-and-contrast.md`, `layout.md`,
  `motion-design.md`, `interaction-design.md`, `responsive-design.md`,
  `spatial-design.md`, `cognitive-load.md`, `heuristics-scoring.md`,
  `polish.md`, `critique.md`, plus the brand-vs-product register split.
- **Command references**: `audit.md`, `harden.md`.
- **Runtime contracts** (paired with `../src/core/`):
  `severity-scoring.md`, `output-envelope.md`, `sarif.md`,
  `verdict-and-confidence.md`.

### `rules-docs/`

Fifteen cross-cutting engineering rule decks (`accessibility.md`,
`api-design.md`, `code-review.md`, `coding-style.md`, `database.md`,
`dependency-management.md`, `documentation.md`, `error-handling.md`,
`git-workflow.md`, `monitoring.md`, `naming.md`, `performance.md`,
`security.md`, `testing.md`, `agents.md`). Drop-in references for any
project; the `rules-docs` check loads them as arkitect findings when a
project opts in.

### `auditors/`

Twenty SKILL.md cards for codebase-agnostic auditors covering: codebase
overview, security boundaries, build & delivery gates, duplication /
over-abstraction, maintainability hotspots, dependency reuse, dead code,
diagnosability, concurrency correctness, runtime lifecycle & config,
layer-ownership boundaries, API contracts, dependency topology, project
structure, configuration boundaries, persistence performance, query
efficiency, transaction correctness, runtime performance, and resource
lifecycle.

## Attribution

See `NOTICES.md` for upstream sources and licenses.
