// shared/source-frames.ts decides which parts of a logged error become "open in editor" links
// (the error drawer) and which locations list_errors hands an agent. Two ways it can go wrong,
// both pinned here: MISSING a real frame (a Windows drive colon or a space in the path splitting
// it apart), and INVENTING one out of a URL, an IP:port or a runtime-internal module.
import { expect, test } from "bun:test";
import { findSourceFrames, frameFilePath } from "../shared/source-frames";

const pick = (text: string) =>
  findSourceFrames(text).map(({ file, line, column }) => ({ file, line, column }));

test("Node stack frame in parens keeps a drive letter and spaces in the path", () => {
  const text = "    at run (C:\\Users\\dev one\\app\\src\\main.ts:12:5)";
  const [f] = findSourceFrames(text);
  expect(f).toMatchObject({ file: "C:\\Users\\dev one\\app\\src\\main.ts", line: 12, column: 5 });
  // The link span is the location itself, without the surrounding parens.
  expect(text.slice(f!.index, f!.index + f!.length)).toBe(
    "C:\\Users\\dev one\\app\\src\\main.ts:12:5",
  );
});

test("a file:// URL frame becomes a plain path", () => {
  expect(pick("    at file:///C:/proj/src/app.mjs:3:7")).toEqual([
    { file: "C:/proj/src/app.mjs", line: 3, column: 7 },
  ]);
  expect(frameFilePath("file:///home/u/my%20app/a.ts")).toBe("/home/u/my app/a.ts");
});

test("tsc, Python, Vite and bare relative frames are all found", () => {
  expect(pick("src/app.ts(12,5): error TS2322: Type 'x' is not assignable")).toEqual([
    { file: "src/app.ts", line: 12, column: 5 },
  ]);
  expect(pick('  File "/srv/app/main.py", line 42, in <module>')).toEqual([
    { file: "/srv/app/main.py", line: 42, column: undefined },
  ]);
  expect(pick("[vite] Internal server error: /home/u/app/src/App.vue:12:3")).toEqual([
    { file: "/home/u/app/src/App.vue", line: 12, column: 3 },
  ]);
  expect(pick("see src/a.ts:12.")).toEqual([{ file: "src/a.ts", line: 12, column: undefined }]);
});

test("URLs, IP:port pairs and runtime-internal modules are not frames", () => {
  expect(pick("listen EADDRINUSE: address already in use 127.0.0.1:3000")).toEqual([]);
  expect(pick("proxy error: http://example.com:8080/api failed")).toEqual([]);
  expect(pick("    at Module._compile (node:internal/modules/cjs/loader:1105:14)")).toEqual([]);
  expect(pick("a.ts:12abc")).toEqual([]);
});

test("several frames come back in order without overlapping", () => {
  const frames = findSourceFrames(
    "Error: boom\n    at a (/app/src/a.ts:1:2)\n    at /app/src/b.ts:3:4",
  );
  expect(frames.map((f) => f.file)).toEqual(["/app/src/a.ts", "/app/src/b.ts"]);
  expect(frames[0]!.index + frames[0]!.length).toBeLessThanOrEqual(frames[1]!.index);
});
