// Guards for the desktop-shortcut label sanitizer (server/src/shortcuts.ts).
//
// The label becomes a .lnk FILENAME on the user's Desktop, so it has to survive
// Windows' filename rules without losing meaning. Both of the first two tests pin
// real bugs caught during development, and both were silent — the shortcut still got
// created, just wrong — so they earn permanent regression guards.
import { expect, test } from "bun:test";
import { safeFileLabel } from "../src/shortcuts";

test("keeps the ' - ' separator: the label is '<project> - <process>'", () => {
  // Regression: an over-broad character class swallowed the hyphen, collapsing
  // "MyApp - Web" to "MyApp Web" and losing the project/process boundary.
  expect(safeFileLabel("MyApp - Web (Vite)")).toBe("MyApp - Web (Vite)");
});

test("strips every character Windows forbids in a filename, backslash included", () => {
  // Regression: an escaping slip left `\` out of the class, so a label containing one
  // produced a .lnk whose name Windows read as a PATH — creation failed or landed
  // somewhere unintended.
  expect(safeFileLabel('a<b>c:d"e/f\\g|h?i*j')).toBe("a b c d e f g h i j");
});

test("folds control characters to spaces rather than embedding them in a filename", () => {
  // Built with fromCharCode rather than written literally: control bytes sitting in a
  // source file are exactly the mess this sanitizer exists to keep out of filenames.
  const tab = String.fromCharCode(9);
  const nul = String.fromCharCode(0);
  const esc = String.fromCharCode(27);
  expect(safeFileLabel(`web${tab}api${nul}db${esc}`)).toBe("web api db");
});

test("collapses runs of whitespace and trims", () => {
  expect(safeFileLabel("  Web    (Vite)   ")).toBe("Web (Vite)");
});

test("drops trailing dots and spaces, which Windows silently mangles", () => {
  expect(safeFileLabel("Node.js App...")).toBe("Node.js App");
  expect(safeFileLabel("Trailing   ")).toBe("Trailing");
});

test("preserves non-ASCII: the PS layer renames via the Unicode FS API to keep it", () => {
  // safeFileLabel must NOT strip these — runShortcutPs saves to an ASCII temp and then
  // Move-Item's it to the real name precisely so the accent survives.
  expect(safeFileLabel("RēDesign - Web")).toBe("RēDesign - Web");
});

test("never returns an empty name (a .lnk must have one)", () => {
  expect(safeFileLabel("")).toBe("DevWebUI");
  expect(safeFileLabel("///")).toBe("DevWebUI");
  expect(safeFileLabel("   ")).toBe("DevWebUI");
});

test("caps length so a rambling process name can't blow the path limit", () => {
  expect(safeFileLabel("x".repeat(400)).length).toBe(96);
});
