# Arkitect Regression Fixtures

Package-owned regression scenarios that exercise audit engines with controlled inputs. Run via:

```sh
bun packages/connections-arkitect/bin/audit-test.mjs
```

or

```sh
bun run audit:test
```

## Layout

```
packages/connections-arkitect/test/fixtures/
  scenarios.generated.mjs
```

The manifest exports scenario records. Each record has:

```js
{
  engineId: "endpoint-contracts",
  scenario: "fail-frontend-only",
  config: {},      // optional — overrides merged into engine.defaultConfig
  expected: {},    // required — assertions about the result
  files: {},       // virtual source files materialized into a temp dir at runtime
}
```

`engineId` is the same id used by the runner (`oversized-files`, `lambda-contracts`, etc.). Engines without any scenario record are reported as "uncovered" but do not fail the suite — coverage is meant to grow incrementally.

## expected.json shape

```jsonc
{
  // Required: assert the boolean failure state.
  "failed": true,

  // Optional: every entry must appear in result.findings (matched by ruleId + filePath).
  // filePath is relative to the fixture's files/ dir.
  "expectFindings": [{ "ruleId": "lambda-mutating-auth-check", "filePath": "infra/lambda/src/sample/index.ts" }],

  // Optional: no entry may appear in result.findings matching these rule+file pairs.
  "forbidFindings": [{ "ruleId": "lambda-response-envelope-contract", "filePath": "infra/lambda/src/sample/index.ts" }],

  // Optional: assert the total count of findings for a given rule.
  "ruleCounts": {
    "lambda-mutating-auth-check": 1,
  },
}
```

All three assertion modes are optional individually, but at least one must be present alongside `failed`.

## Writing a new fixture

1. Pick the engine id (run `bun packages/connections-arkitect/bin/audit.mjs list` for the catalog).
2. Add a scenario record to `scenarios.generated.mjs` with the smallest virtual source tree that exercises the rule.
3. Add `expected` assertions.
4. Run `bun run audit:test` and iterate.

Keep each scenario focused: one rule (or one variant of one rule) per record.

## Adding fixtures for the rest of the suite

Coverage is intentionally incremental. The runner prints an "uncovered engines" list at the end; pick one off that list when adding fixtures becomes the priority. Engines with many rules (`ui-drift`, `m3-guidelines`, `product-contracts`) should cover the most regression-prone rules first rather than chasing 100% rule coverage.
