// Prompt answers (server/src/prompt-answers.ts): the expect/send chain that types replies
// into a process's stdin. Pins the ordering contract (a required rule holds back the rest,
// an optional one does not), fire-once, spawn-time rules, escape decoding, and that two
// prompts arriving in one output chunk are both answered.
import { expect, test } from "bun:test";
import { answerText, decodeEscapes, PromptAnswerer } from "../server/src/prompt-answers";

const sends = (rules: { send: string }[]) => rules.map((r) => r.send);

test("a required rule that has not matched holds back every rule after it", () => {
  const a = new PromptAnswerer([
    { expect: "Username:", send: "me" },
    { expect: "Password:", send: "pw" },
  ]);
  // The second prompt alone must not fire: the first, required, rule is still waiting.
  expect(a.feed("Password:")).toEqual([]);
  expect(sends(a.feed("Username:"))).toEqual(["me"]);
  expect(sends(a.feed("Password:"))).toEqual(["pw"]);
  expect(a.remaining).toBe(0);
});

test("an optional rule that does not match is passed over but stays armed", () => {
  const a = new PromptAnswerer([
    { expect: "Proceed?", send: "y", optional: true },
    { expect: "Name:", send: "app" },
  ]);
  expect(sends(a.feed("Name:"))).toEqual(["app"]);
  expect(sends(a.feed("Proceed?"))).toEqual(["y"]);
});

test("a rule fires once, and one answered prompt never satisfies the next rule too", () => {
  const a = new PromptAnswerer([
    { expect: "(y/N)", send: "y" },
    { expect: "(y/N)", send: "n" },
  ]);
  expect(sends(a.feed("first? (y/N)"))).toEqual(["y"]);
  expect(a.feed("more output")).toEqual([]);
  expect(sends(a.feed("second? (y/N)"))).toEqual(["n"]);
});

// Regression: clearing the whole buffer after a match left the second prompt unseen, so the
// process hung on it.
test("two prompts in one output chunk are both answered", () => {
  const a = new PromptAnswerer([
    { expect: "Proceed? (y)", send: "y" },
    { expect: "Name:", send: "app" },
  ]);
  expect(sends(a.feed("Proceed? (y)\nName:"))).toEqual(["y", "app"]);
});

test("a prompt split across output chunks still matches, and regex rules match", () => {
  const a = new PromptAnswerer([{ expect: "port \\d+ busy", send: "y", isRegex: true }]);
  expect(a.feed("port 30")).toEqual([]);
  expect(sends(a.feed("00 busy"))).toEqual(["y"]);
});

test("leading rules without expect are sent at spawn, before any output", () => {
  const a = new PromptAnswerer([{ send: "hello" }, { expect: "x", send: "later" }]);
  expect(sends(a.start())).toEqual(["hello"]);
  expect(a.remaining).toBe(1);
});

test("escapes decode and a newline is appended only when the answer lacks one", () => {
  expect(decodeEscapes(String.raw`a\nb\x1b[BA\\`)).toBe("a\nb\x1b[BA\\");
  expect(answerText({ send: "y" })).toBe("y\n");
  expect(answerText({ send: String.raw`y\r` })).toBe("y\r");
});
