// Proves scripts/check-spawn-test-timeout.mjs actually WORKS, not merely that this repo currently
// passes it. A check that silently matches nothing and a check that legitimately finds nothing print
// the identical green line, and both of that check's own predecessors got this wrong in production:
// its first cut in AgentHydra was a no-op (a regex literal carrying a `"` desynced its string
// tracking, so every comment for the next sixty lines read as string content), and its second called
// a sibling repo 230 times broken because it did not know a repo-wide `bun test --timeout` counts.
// So the rule is asserted from both ends here: it must FIRE on the shapes it claims to catch, and
// STAY QUIET on the ones it must not.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CHECK = join(import.meta.dir, "..", "scripts", "check-spawn-test-timeout.mjs");
const load = () => import(pathToFileURL(CHECK).href);
const REPO_ROOT = join(import.meta.dir, "..");

describe("fires on a test that spawns without an allowance", () => {
  test.each([
    [
      "an inline spawn",
      `test("regenerates the shortcut", () => {
        const gen = Bun.spawnSync(["powershell", "-File", script], { cwd: ROOT });
        must(gen.exitCode === 0, "failed");
      });`,
    ],
    [
      "the curried test.skipIf(cond)(...) form, which otherwise reads as bodyless",
      `test.skipIf(!isWin)("tray self-test passes", () => {
        const r = Bun.spawnSync(["powershell", "-File", TRAY, "-SelfTest"]);
        must(r.exitCode === 0, "no");
      });`,
    ],
    // The gap that made this check report ✓ on a real outage. ReDesign's tray-launcher beforeAll
    // regenerates a .lnk through PowerShell + COM: 0.35s locally, 5057ms on windows-latest, and it
    // held that repo's daemon job red. Hooks are the worse case, because bun blames the timeout on an
    // unnamed test and the run never names the hook.
    [
      "a lifecycle hook that spawns, which was invisible to this check until 2026-08-12",
      `beforeAll(() => {
        cp.execFileSync("powershell", ["-NoProfile", "-File", CREATE_SHORTCUT], { stdio: "ignore" });
      });`,
    ],
    // Two bugs in one line, and the second is why the fixture has to be the REAL shape: with only the
    // hook gap closed this still passed, because `cp.execFileSync` is dotted and the spawn pattern's
    // lookbehind threw out any qualifier.
    [
      'a namespaced child_process call, e.g. `import cp from "node:child_process"`',
      `test("regenerates the shortcut", () => {
        cp.execFileSync("powershell", ["-File", CREATE_SHORTCUT]);
      });`,
    ],
  ])("%s", async (_name, text) => {
    const { findViolations } = await load();
    expect(findViolations(text).length).toBe(1);
  });

  test("a spawn one helper hop away — the tracked() shape this repo actually shipped", async () => {
    const { findViolations } = await load();
    // Reads as pure existsSync assertions; tracked() shells out to `git ls-files` per file.
    const text = `function tracked(rel) {
        return Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", rel]).exitCode === 0;
      }
      test("launcher machinery exists and is COMMITTED", () => {
        for (const name of REQUIRED) must(tracked("misc/" + name), "not committed");
      });`;
    const hits = findViolations(text);
    expect(hits.length).toBe(1);
    expect(hits[0]!.via).toBe("tracked");
  });
});

describe("stays quiet where it must", () => {
  test.each([
    // A hook states its allowance SECOND, not third. Reading it as third would report every
    // compliant hook as broken, which is the one way extending this rule could have made things worse.
    [
      "hooks that state an allowance, whose timeout is the second argument",
      `beforeAll(() => {
        cp.execFileSync("powershell", ["-File", CREATE_SHORTCUT]);
      }, 60000);
      afterEach(() => { Bun.spawnSync(["taskkill", "/f", "/im", "x.exe"]); }, 20000);`,
    ],
    [
      "the same tests, each stating an allowance",
      `function tracked(rel) {
        return Bun.spawnSync(["git", "ls-files", "--", rel]).exitCode === 0;
      }
      test("inline", () => { Bun.spawnSync(["powershell"]); }, 20000);
      test("via helper", () => { must(tracked("misc/x")); }, 20000);
      test.skipIf(!isWin)("curried", () => { Bun.spawnSync(["powershell"]); }, 20000);`,
    ],
    [
      "a test that does no subprocess work at all",
      `test("the tray icon is a real .ico file", () => {
        const buf = readFileSync(join(MISC, "DevWebUI.ico"));
        expect(buf.length).toBeGreaterThan(0);
      });`,
    ],
  ])("%s", async (_name, text) => {
    const { findViolations } = await load();
    expect(findViolations(text).length).toBe(0);
  });

  test("a spawn named only in a comment or inside a string is not a spawn", async () => {
    const { findViolations } = await load();
    // This suite embeds PowerShell and VBS source in template literals as a matter of course, and
    // describes its own spawns in prose. Both must read as inert.
    const text = `test("the adapter is a thin wrapper, not a re-inlined fork", () => {
        // was: asserted the old Bun.spawnSync(["powershell", ...]) hand-off inline.
        const ps = readFileSync(CREATE_SHORTCUT, "utf8");
        expect(ps).toContain('Bun.spawnSync(["powershell"])');
      });`;
    expect(findViolations(text).length).toBe(0);
  });

  test("a regex carrying a quote does not desync the scan for the rest of the file", async () => {
    const { findViolations } = await load();
    // The exact defect that made this check's first cut a silent no-op elsewhere: the `"` inside a
    // character class opened a string that never closed, so every later comment looked like string
    // content and the real violation below went unreported.
    const text = `function q(arg) {
        if (arg.length > 0 && !/[ \\t\\n\\v"]/.test(arg)) return arg;
      }
      test("spawns for real", () => { Bun.spawnSync(["powershell"]); });`;
    expect(findViolations(text).length).toBe(1);
  });
});

// Every scratch root this file creates is registered here and reaped by the file-wide
// afterAll below, so a failing (or crashing) test cannot leave one behind.
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a repo-wide timeout stands the whole check down", () => {
  const withRoot = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "devwebui-guardrail-"));
    scratchDirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  };

  test("a --timeout in the test script", async () => {
    const { audit, globalTimeoutMs } = await load();
    const root = withRoot({
      "package.json": JSON.stringify({ scripts: { test: "bun test tests --timeout 20000" } }),
    });
    expect(globalTimeoutMs(root)).toBe(20000);
    const res = audit.run({ root });
    expect(res.failed).toBe(false);
    expect(res.report).toContain("20000");
  });

  test("a [test] timeout in bunfig.toml", async () => {
    const { globalTimeoutMs } = await load();
    const root = withRoot({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bunfig.toml": '[install]\nregistry = "x"\n\n[test]\ntimeout = 15000\n',
    });
    expect(globalTimeoutMs(root)).toBe(15000);
  });

  test("this repo sets none, so the per-test rule still applies", async () => {
    // If devwebui ever gains a global --timeout, this flips — which should be a deliberate,
    // visible change rather than a quiet loss of enforcement.
    const { globalTimeoutMs } = await load();
    expect(globalTimeoutMs(REPO_ROOT)).toBeNull();
  });
});

test("the check resolves clean against this repo (the regression net)", async () => {
  const { audit } = await load();
  const res = audit.run({ root: REPO_ROOT });
  expect(res.failed).toBe(false);
  expect(res.report.length).toBeGreaterThan(0);
});
