// server/src/open-in-editor.ts turns an HTTP body into an editor process's argv, so what it
// refuses and how it speaks to each editor are the whole contract. Pinned without spawning
// anything: the per-editor line/column flags, which running editor is chosen, and the input
// guards (non-integer lines, UNC paths, control characters, unresolvable relative paths).
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { editorArgs, pickEditor, validateOpenRequest } from "../server/src/open-in-editor";

test("each editor family gets its own line/column flags", () => {
  expect(editorArgs("C:\\Program Files\\Microsoft VS Code\\Code.exe", "/a.ts", 3, 4)).toEqual([
    "-g",
    "/a.ts:3:4",
  ]);
  expect(editorArgs("/opt/idea/bin/idea.sh", "/a.ts", 3, 4)).toEqual([
    "--line",
    "3",
    "--column",
    "4",
    "/a.ts",
  ]);
  expect(editorArgs("C:\\Tools\\notepad++.exe", "/a.ts", 3, 4)).toEqual(["-n3", "-c4", "/a.ts"]);
  // An editor we do not know is still opened, on the file alone, rather than fed a guessed flag.
  expect(editorArgs("/usr/bin/gedit", "/a.ts", 3, 4)).toEqual(["/a.ts"]);
});

test("the preferred running editor wins regardless of process order", () => {
  const listing = [
    "C:\\Windows\\explorer.exe",
    "C:\\Program Files\\Notepad++\\notepad++.exe",
    "",
    "C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  ];
  expect(pickEditor(listing, "win32")).toBe(listing[3]);
  expect(pickEditor(["C:\\Windows\\explorer.exe"], "win32")).toBeNull();
});

test("on macOS an app bundle's inner binary maps to its CLI launcher", () => {
  expect(
    pickEditor(["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"], "darwin"),
  ).toBe("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
});

test("line and column must be positive integers", () => {
  for (const line of [0, -1, 1.5, "12", Number.NaN, undefined]) {
    expect(validateOpenRequest({ file: "/a.ts", line })).toMatchObject({
      ok: false,
      reason: "bad-input",
    });
  }
  expect(validateOpenRequest({ file: "/a.ts", line: 3, column: 0 })).toMatchObject({
    ok: false,
    reason: "bad-input",
  });
});

test("UNC paths, control characters and cwd-less relative paths are refused", () => {
  for (const file of ["\\\\evil\\share\\a.ts", "//evil/share/a.ts", "/a.ts\n--x", "src/a.ts", ""]) {
    expect(validateOpenRequest({ file, line: 1 })).toMatchObject({
      ok: false,
      reason: "bad-input",
    });
  }
});

test("a relative frame resolves against the logging process's cwd; column defaults to 1", () => {
  const cwd = path.join(tmpdir(), "proj");
  expect(validateOpenRequest({ file: "src/a.ts", line: 7 }, cwd)).toEqual({
    ok: true,
    req: { file: path.resolve(cwd, "src/a.ts"), line: 7, column: 1 },
  });
});
