import assert from "node:assert/strict";
import { test } from "node:test";

import { applySuppressions, collectSuppressions, matchingSuppression } from "@saydeploy/architect/core/suppressions";

test("collectSuppressions parses a line directive with an em-dash reason", () => {
  const text = [
    "<!-- arkitect-ignore-next-line raw-button-outside-shared — branded marketing CTA -->",
    "<button>",
  ].join("\n");
  const { lines } = collectSuppressions(text);
  // directive on text line 1 (index 0) → applies to the next line (2, 1-indexed)
  const entries = lines.get(2);
  assert.ok(entries, "directive should target line 2");
  assert.deepEqual(entries[0].rules, ["raw-button-outside-shared"]);
  assert.equal(entries[0].reason, "branded marketing CTA");
});

test("an interior hyphen in a rule id is not mistaken for the reason boundary", () => {
  const { lines } = collectSuppressions(
    ["<!-- arkitect-ignore-next-line raw-button-outside-shared -->", "<button>"].join("\n"),
  );
  const entries = lines.get(2);
  assert.deepEqual(entries[0].rules, ["raw-button-outside-shared"]);
  assert.equal(entries[0].reason, "", "no separator → no reason");
});

test("a space-hyphen-space and a colon both start the reason", () => {
  const dash = collectSuppressions(["// arkitect-ignore-next-line some-rule - dash reason", "x"].join("\n")).lines.get(
    2,
  );
  assert.equal(dash[0].reason, "dash reason");
  const colon = collectSuppressions(["// arkitect-ignore-next-line some-rule: colon reason", "x"].join("\n")).lines.get(
    2,
  );
  assert.equal(colon[0].reason, "colon reason");
});

test("comma-separated rule ids are split and share the trailing reason", () => {
  const { lines } = collectSuppressions(
    ["// arkitect-ignore-next-line raw-button-outside-shared, raw-input-outside-shared — shared reason", "x"].join(
      "\n",
    ),
  );
  const entry = lines.get(2)[0];
  assert.deepEqual(entry.rules, ["raw-button-outside-shared", "raw-input-outside-shared"]);
  assert.equal(entry.reason, "shared reason");
});

test("file-level directives are collected with their reason", () => {
  const { file } = collectSuppressions("/* arkitect-ignore-file raw-button-outside-shared — whole file is bespoke */");
  assert.equal(file.length, 1);
  assert.deepEqual(file[0].rules, ["raw-button-outside-shared"]);
  assert.equal(file[0].reason, "whole file is bespoke");
});

test("matchingSuppression: line-level matches its target line and returns the reason", () => {
  const suppressions = collectSuppressions(
    ["<!-- arkitect-ignore-next-line raw-button-outside-shared — themed CTA -->", "<button>"].join("\n"),
  );
  const hit = matchingSuppression(suppressions, 2, "raw-button-outside-shared");
  assert.ok(hit);
  assert.equal(hit.reason, "themed CTA");
  assert.equal(matchingSuppression(suppressions, 2, "raw-input-outside-shared"), null, "other rule is not suppressed");
  assert.equal(matchingSuppression(suppressions, 3, "raw-button-outside-shared"), null, "other line is not suppressed");
});

test("matchingSuppression: a file-level directive wins over (and without) a line directive", () => {
  const suppressions = collectSuppressions("<!-- arkitect-ignore-file raw-button-outside-shared — bespoke page -->");
  assert.equal(matchingSuppression(suppressions, 999, "raw-button-outside-shared").reason, "bespoke page");
});

test("matchingSuppression: the * wildcard matches any rule", () => {
  const suppressions = collectSuppressions(
    ["// arkitect-ignore-next-line * — silence everything here", "x"].join("\n"),
  );
  assert.ok(matchingSuppression(suppressions, 2, "any-rule-at-all"));
});

test("a reasonless directive is collected (reason empty) so checks can flag it as invalid", () => {
  const suppressions = collectSuppressions(["// arkitect-ignore-next-line raw-button-outside-shared", "x"].join("\n"));
  const hit = matchingSuppression(suppressions, 2, "raw-button-outside-shared");
  assert.ok(hit, "still matches");
  assert.equal(hit.reason, "", "but carries no reason");
});

test("applySuppressions stays backward-compatible: it drops suppressed findings regardless of reason", () => {
  const fileText = new Map([
    [
      "src/Foo.vue",
      ["// arkitect-ignore-next-line raw-button-outside-shared — keep", "<button>", "<button>"].join("\n"),
    ],
  ]);
  const findings = [
    { filePath: "src/Foo.vue", ruleId: "raw-button-outside-shared", line: 2 }, // suppressed (reason present)
    { filePath: "src/Foo.vue", ruleId: "raw-button-outside-shared", line: 3 }, // not suppressed
    { filePath: "src/Foo.vue", ruleId: "other-rule", line: 2 }, // wrong rule, not suppressed
  ];
  const kept = applySuppressions(findings, fileText);
  assert.deepEqual(
    kept.map((f) => f.line + ":" + f.ruleId),
    ["3:raw-button-outside-shared", "2:other-rule"],
  );
});
