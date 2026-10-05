// Source-frame finder: pulls every `file:line[:col]` reference out of a logged error so the
// error log can turn a stack trace from dead text into "open this line in my editor" links.
// Shared verbatim by the GUI (linkifies the error drawer), the MCP server (adds a `frames`
// array to list_errors so an agent gets the locations pre-parsed) and the daemon.
//
// Pure and dependency-free on purpose: it runs in the browser bundle too. It only FINDS
// candidates; whether one is a real file is the daemon's call (POST /api/open-in-editor
// checks the disk), so a false positive costs a "file not found" toast, never a launch.

/** One file location found in a log line. */
export interface SourceFrame {
  /** The path as logged, with a `file://` URL prefix undone. May be relative to the process cwd. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column, when the frame carried one. */
  column?: number;
  /** Offset of the linkable span (the path plus its position suffix) in the input text. */
  index: number;
  /** Length of that span. */
  length: number;
}

// A path ends in a dotted extension that starts with a letter: `app.ts`, `main.rs`, `x.vue`.
// That letter rule is what keeps `127.0.0.1:3000` and `v1.2.3:4` from reading as frames.
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]*`;
// A path may open with a file URL, a drive letter, a root slash or a ./ ../ prefix.
const LEAD = String.raw`(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?`;
// The parenthesised form admits spaces, so it demands an ABSOLUTE start (drive, root slash or
// file URL, which is all Node/Bun ever print there); otherwise `(12:05 failed in app.ts:3)`
// would read as one long path.
const ABS_LEAD = String.raw`(?:file:\/\/\/?[A-Za-z]:[\\/]|file:\/\/\/?|[A-Za-z]:[\\/]|[\\/])`;

// The frame shapes dev servers actually print, most specific first (an earlier pattern wins a
// span a later one also matches):
//  1. Node/Bun stack frame in parens: `at fn (C:\my dir\app.ts:12:5)`. Inside parens a path
//     may carry spaces, which the bare form below cannot allow.
//  2. Python: `File "/srv/app.py", line 12`.
//  3. tsc: `src/app.ts(12,5): error TS2322`.
//  4. Bare `path:line[:col]` (Node without parens, Vite, esbuild, Rust `-->`, Go, eslint).
//     The lookbehind refuses a match that starts mid-token, so the `//example.com:8080` of a
//     URL is not a frame; the lookahead refuses `a.ts:12abc` but keeps a sentence-ending `.`.
const PATTERNS: { re: RegExp; span: (m: RegExpExecArray) => [number, number] }[] = [
  {
    re: new RegExp(String.raw`\((${ABS_LEAD}[^()\n]*?${EXT}):(\d+)(?::(\d+))?\)`, "g"),
    span: (m) => [m.index + 1, m[0].length - 2],
  },
  {
    re: /File "([^"\n]+)", line (\d+)()/g,
    span: (m) => [m.index, m[0].length],
  },
  {
    re: new RegExp(String.raw`(?<![\w:/.\\-])(${LEAD}[^\s:()"'<>|*?]*${EXT})\((\d+),(\d+)\)`, "g"),
    span: (m) => [m.index, m[0].length],
  },
  {
    re: new RegExp(
      String.raw`(?<![\w:/.\\-])(${LEAD}[^\s:()"'<>|*?]*${EXT}):(\d+)(?::(\d+))?(?!\w|\.\d)`,
      "g",
    ),
    span: (m) => [m.index, m[0].length],
  },
];

/** Undo a `file://` URL prefix (`file:///C:/x%20y/a.ts` -> `C:/x y/a.ts`); plain paths pass through. */
export function frameFilePath(raw: string): string {
  if (!/^file:\/\//i.test(raw)) return raw;
  let p = raw.replace(/^file:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* a stray % in the URL: keep it as logged */
  }
  // `file:///C:/x` leaves `/C:/x`; the drive form must lose that leading slash.
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
}

/** Every source location in `text`, in order of appearance, with no two spans overlapping. */
export function findSourceFrames(text: string): SourceFrame[] {
  const found: SourceFrame[] = [];
  const taken = (start: number, len: number) =>
    found.some((f) => start < f.index + f.length && f.index < start + len);
  for (const { re, span } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const line = Number(m[2]);
      if (!Number.isInteger(line) || line < 1) continue;
      const file = frameFilePath(m[1] ?? "");
      // Runtime-internal frames (`node:internal/...`) have no file on disk to open.
      if (/^(?:node|bun|internal):/i.test(file)) continue;
      const [index, length] = span(m);
      if (taken(index, length)) continue;
      const column = m[3] ? Number(m[3]) : undefined;
      found.push({
        file,
        line,
        ...(column && column >= 1 ? { column } : {}),
        index,
        length,
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
