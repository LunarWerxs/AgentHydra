// Tests for the shared detached-spawn primitive (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/detached-spawn.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/detached-spawn.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// This is the ONE regression guard for the kit-wide Windows-detach contract: every kit app whose
// daemon spawns a child meant to survive a tray Quit (taskkill /T on the daemon) routes that launch
// through buildDetachedSpawn. Two properties must hold on win32 and each has already regressed once:
//   1. DETACH — a direct spawn, even with detached:true, stays in the daemon's tree and gets reaped
//      (verified 2026-07-12). The launch must be handed to another process creator.
//   2. NO HANDLE INHERITANCE — `cmd /c start` detached fine but CreateProcess inherits handles, so
//      the launched browser inherited the daemon's LISTENING SOCKET and pinned its port until the
//      window closed; restarting the daemon then hopped it to port+1 (verified 2026-07-15 with a
//      real msedge --app window). WMI's service-side create inherits nothing.
// These pin the spawn shape so a refactor back to either regression fails here instead of silently
// reintroducing it.
import { expect, test } from "bun:test";
import { buildDetachedSpawn, quoteWinArg } from "../../src/detached-spawn.mjs";

const EXE = "C:\\Program Files\\App\\app.exe";
const ARGS = ["--user-data-dir", "C:\\path with space\\profile"];

test("win32: hands the launch to WMI so the child escapes the tree AND inherits no handles", () => {
  const s = buildDetachedSpawn("win32", [EXE, ...ARGS]);
  expect(s.argv[0]).toBe("powershell");
  expect(s.argv).toContain("-NoProfile");
  expect(s.argv).toContain("-NonInteractive");

  const script = s.argv[s.argv.length - 1]!;
  // The WMI create is what makes this leak-free: the service, not us, calls CreateProcess.
  expect(script).toContain("Win32_Process");
  expect(script).toContain("Create");
  // The real command must survive into the CommandLine, spaced path quoted as ONE token.
  expect(script).toContain(`"${EXE}"`);
  expect(script).toContain('"C:\\path with space\\profile"');

  // The command must NOT be argv[0] on win32: a direct spawn is exactly the tree-kill regression.
  expect(s.argv[0]).not.toBe(EXE);
  // Windows detach comes from the hand-off, NOT the (ineffective) detached spawn flag.
  expect(s.detached).toBe(false);
});

test("win32: falls back to Start-Process (no cmd.exe reparse) — a leaked handle beats no launch", () => {
  const script = buildDetachedSpawn("win32", [EXE, ...ARGS]).argv[4]!;
  // The fallback is Start-Process with an argument ARRAY, NOT `cmd.exe /c <string>`. cmd would
  // re-split the string on its own metacharacters (& | ^); Start-Process passes the array straight
  // to CreateProcess with no second parser.
  expect(script).toContain("Start-Process -FilePath");
  expect(script).toContain("-ArgumentList @(");
  expect(script).not.toContain("cmd.exe");
  // The fallback only fires when WMI returned non-zero / threw.
  expect(script).toMatch(/if \(\$rc -ne 0\)/);
  // And a WMI failure must not surface as a spawn failure once the fallback has run.
  expect(script).toContain("exit 0");
});

test("win32: no-arg launch omits an empty -ArgumentList", () => {
  // Start-Process throws on an empty ArgumentList, so the single-exe case must not emit one.
  const script = buildDetachedSpawn("win32", [EXE]).argv[4]!;
  expect(script).toContain("Start-Process -FilePath");
  expect(script).not.toContain("-ArgumentList");
});

test("win32: a spaced -ArgumentList element is pre-quoted so Start-Process can't split it", () => {
  // The round-2 regression: Windows PowerShell's Start-Process space-JOINS -ArgumentList without
  // quoting elements that contain spaces, so a raw `C:\Program Files\x` reached the child as three
  // tokens — corrupting the successor daemon's args. Each element is now quoteWinArg'd, so a spaced
  // path appears in the array as a single double-quoted token that the child's CommandLineToArgvW
  // parses back to one arg. Pin that the spaced arg is quoted and NOT present bare.
  const script = buildDetachedSpawn("win32", [EXE, "C:\\path with space\\profile", "--flag"]).argv[4]!;
  expect(script).toContain('"C:\\path with space\\profile"'); // one quoted token
  // The bare (unquoted) spaced form must NOT appear as a standalone array element.
  expect(script).not.toMatch(/'C:\\path with space\\profile'/);
});

test("win32: shell metacharacters in a path never become executable, in EITHER parser", () => {
  // Legal in an NTFS filename, and this primitive is handed repo/file paths. The `& | ^` are the
  // ones that mattered: PowerShell escaping alone left them live to cmd.exe in the old fallback.
  const nasty = "C:\\repos\\a'; calc; $(whoami)`n&echo pwned|hack\\app.exe";
  const script = buildDetachedSpawn("win32", [nasty, "arg&two", "arg|three"]).argv[4]!;
  // Strip every single-quoted PowerShell literal ('' is an escaped quote inside one). What remains
  // is the only text PowerShell parses as code, and it must be the fixed scaffold — nothing from
  // the input, and no cmd.exe to re-parse & | ^.
  const code = script.replace(/'(?:[^']|'')*'/g, "''");
  for (const payload of ["calc", "whoami", "pwned", "echo", "hack", "two", "three"]) {
    expect(code).not.toContain(payload);
  }
  expect(code).not.toContain("cmd.exe");
  expect(code).not.toContain("&e"); // the `&echo` fragment, specifically
});

test("posix: spawns the command directly with detached:true (setsid), argv unchanged", () => {
  const mac = buildDetachedSpawn("darwin", ["open", "-a", "App", "/x"]);
  expect(mac).toEqual({ argv: ["open", "-a", "App", "/x"], detached: true });
  const linux = buildDetachedSpawn("linux", ["/usr/bin/app", "--flag"]);
  expect(linux).toEqual({ argv: ["/usr/bin/app", "--flag"], detached: true });
});

test("returns a fresh argv array on every platform (never aliases the caller's input)", () => {
  const input = ["/usr/bin/app", "--flag"];
  expect(buildDetachedSpawn("linux", input).argv).not.toBe(input);
  expect(buildDetachedSpawn("win32", input).argv).not.toBe(input);
});

// WMI takes ONE CommandLine string, so argv has to be re-quoted the way CommandLineToArgvW parses
// it. Getting this wrong silently launches the wrong path (or nothing).
test("quoteWinArg follows the CommandLineToArgvW rules", () => {
  expect(quoteWinArg("plain")).toBe("plain");
  expect(quoteWinArg("has space")).toBe('"has space"');
  expect(quoteWinArg("")).toBe('""');
  // A backslash is literal EXCEPT before a quote, where it doubles.
  expect(quoteWinArg("C:\\dir\\file")).toBe("C:\\dir\\file");
  expect(quoteWinArg("C:\\path with space\\")).toBe('"C:\\path with space\\\\"');
  expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
});

test("a PowerShell-hostile path survives into the WMI CommandLine intact", () => {
  // A single quote would otherwise terminate the PS literal and let the rest be interpreted.
  const nasty = "C:\\it's a trap\\app.exe";
  const script = buildDetachedSpawn("win32", [nasty]).argv[4]!;
  expect(script).toContain("''s a trap"); // doubled inside the single-quoted literal
  expect(script).not.toMatch(/CommandLine = 'C:\\it's/); // never left unescaped
});

test("win32: a trailing flag arg survives into the WMI CommandLine", () => {
  // A caller that needs a signal to reach the launched process may carry it as a CLI flag when the
  // env block won't survive — the WMI launch does NOT inherit the caller's environment, so an
  // env-only handoff is lost (a real bug this bit: an auto-update relaunch signal). A flag rides in
  // the command line WMI does deliver. This pins that a trailing arg actually reaches it.
  const script = buildDetachedSpawn("win32", [EXE, "start", "--some-flag"]).argv[4]!;
  expect(script).toContain("--some-flag");
});

test("posix: a trailing flag arg is preserved verbatim in argv", () => {
  const plan = buildDetachedSpawn("linux", [EXE, "start", "--some-flag"]);
  expect(plan.argv).toEqual([EXE, "start", "--some-flag"]);
  expect(plan.detached).toBe(true);
});
