// ───────────────────────────────────────────────────────────────────────────────
// Data-dir isolation guard. Every module that persists under ~/.devwebui MUST resolve
// its directory through data-dir.ts's dataDir(), which honors the DEVWEBUI_HOME override
// the test preload sets. A module that instead hand-builds `path.join(os.homedir(),
// ".devwebui")` writes to the REAL user data dir even under test — exactly the leak that
// once let manager/state tests flip the live machine's autostart state and persist phantom
// error records into the GUI. This source-invariant test fails the moment such a
// construction reappears anywhere in server/src, so the leak can't be reintroduced.
// ───────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";

const SERVER_SRC = path.join(import.meta.dir, "..", "server", "src");
const ALLOWED = new Set(["data-dir.ts"]); // the ONE canonical resolver

// Matches `homedir(), ".devwebui"` — the exact ~/.devwebui path construction, any quote
// style. Deliberately NOT a bare `.devwebui` (that's also the file FORMAT's extension and
// litters comments/strings legitimately) nor a bare `homedir()` (scan roots and the
// git-clone default dir use it fine — only the join with ".devwebui" leaks the data dir).
const LEAK = /homedir\(\)\s*,\s*["'`]\.devwebui/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

test("every ~/.devwebui path resolves through data-dir.ts (no direct homedir joins)", () => {
  const offenders = sourceFiles(SERVER_SRC)
    .filter((f) => !ALLOWED.has(path.basename(f)))
    .filter((f) => LEAK.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(SERVER_SRC, f).replace(/\\/g, "/"));

  expect(
    offenders,
    `These files bypass dataDir() and would write to the REAL ~/.devwebui even under test — ` +
      `route them through data-dir.ts's dataDir(): ${offenders.join(", ")}`,
  ).toEqual([]);
});

// ───────────────────────────────────────────────────────────────────────────────
// Guard 2 — the SECOND half of the leak story. Even with every path going through
// dataDir(), isolation still hinges on DEVWEBUI_HOME being set. tests/setup.ts sets it
// as a bunfig `preload`, but bun discovers bunfig.toml RELATIVE TO THE CWD — so
// `bun test tests/foo.test.ts` launched from a parent/unrelated dir never loads the
// preload, and a test that spins up a real Manager (or writeSettings/appendLog/…) then
// persists fixtures into the LIVE ~/.devwebui. Importing ./isolate sets DEVWEBUI_HOME
// no matter the CWD. This invariant fails the moment a data-WRITING test omits it.
// ───────────────────────────────────────────────────────────────────────────────
const TESTS_DIR = import.meta.dir;

// Modules whose (value, non-type) import means the test persists something under ~/.devwebui:
// Manager (spawn/log/error pipeline), log-vault (appendLog), runtime (settings.json), state.json,
// instance pointer, connections.json, http (createApp mounts a Manager), and alerts
// (alerts-rules.json / alerts-events.ndjson). `errors`/`diagnose` are deliberately absent:
// they're imported for TYPES by pure in-memory analyzer tests.
const WRITER_MODULES = [
  "manager",
  "log-vault",
  "runtime",
  "state",
  "instance",
  "connections",
  "http",
  "alerts",
];
const WRITER_IMPORT = new RegExp(
  // A value import (`import … from`, NOT `import type …`) of one of the writer modules — the barrel
  // itself (or its /index), with an optional .ts/.js. Deliberately NOT a deep subpath: importing a
  // PURE submodule like `manager/wait-for-port` (in-memory ordering, no I/O) is not a data write.
  String.raw`^\s*import\s+(?!type\b)[^;]*?from\s*["']\.\./server/src/(?:${WRITER_MODULES.join("|")})(?:/index)?(?:\.[tj]s)?["']`,
  "m",
);
const ISOLATE_IMPORT = /import\s+["']\.\/(?:isolate|setup)["']/;

test("every data-writing test isolates its data dir (imports ./isolate)", () => {
  const offenders = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => {
      const src = readFileSync(path.join(TESTS_DIR, f), "utf8");
      return WRITER_IMPORT.test(src) && !ISOLATE_IMPORT.test(src);
    });

  expect(
    offenders,
    `These tests value-import a module that persists under ~/.devwebui but don't import ./isolate, ` +
      `so \`bun test <file>\` from a dir where bunfig.toml isn't discovered would pollute the real ` +
      `data dir — add \`import "./isolate";\` as the first import: ${offenders.join(", ")}`,
  ).toEqual([]);
});
