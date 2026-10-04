import assert from "node:assert/strict";
import { test } from "node:test";

import { compileRule, filterFindings, matchesHardRule } from "@saydeploy/architect/core/findings-filter";

test("matchesHardRule needs at least one clause", () => {
  const compiled = compileRule({ id: "empty" });
  assert.equal(matchesHardRule({ ruleId: "anything", filePath: "anywhere", message: "ok" }, compiled), false);
});

test("matchesHardRule by filePath regex", () => {
  const compiled = compileRule({ id: "tests", filePath: "^test/" });
  assert.equal(matchesHardRule({ filePath: "test/foo.spec.ts" }, compiled), true);
  assert.equal(matchesHardRule({ filePath: "src/foo.ts" }, compiled), false);
});

test("matchesHardRule by severityAtMost", () => {
  const compiled = compileRule({ id: "lowOnly", filePath: "src", severityAtMost: "low" });
  assert.equal(matchesHardRule({ filePath: "src/a.ts", severity: "low" }, compiled), true);
  assert.equal(matchesHardRule({ filePath: "src/a.ts", severity: "medium" }, compiled), false);
});

test("filterFindings drops hard-matched and reports stats", async () => {
  const { kept, dropped, stats } = await filterFindings(
    [
      { ruleId: "a", filePath: "src/foo.ts" },
      { ruleId: "b", filePath: "test/foo.ts" },
      { ruleId: "c", filePath: "test/bar.ts" },
    ],
    {
      hardRules: [{ id: "tests", filePath: "^test/" }],
    },
  );

  assert.equal(kept.length, 1);
  assert.equal(kept[0].ruleId, "a");
  assert.equal(dropped.length, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.hardDropped, 2);
  assert.equal(stats.byRuleId.tests, 2);
});

test("filterFindings applies async semantic predicate after hard rules", async () => {
  const { kept, stats } = await filterFindings(
    [
      { ruleId: "a", filePath: "src/foo.ts", message: "real bug" },
      { ruleId: "b", filePath: "src/bar.ts", message: "FIXME: known" },
    ],
    {
      semanticPredicate: (finding) => !finding.message.startsWith("FIXME"),
    },
  );

  assert.equal(kept.length, 1);
  assert.equal(stats.semanticDropped, 1);
});
